/**
 * Pricing Engine — single source of truth for all monetary calculations.
 *
 * Formula:
 *   Subtotal        = Service Amount + Pickup Charges + Drop Charges + Towing Charge
 *   Tax             = Subtotal × Dealer.tax %
 *   Platform Fee    = flat amount configured by admin (AppSettings)
 *   Customer Total  = Subtotal + Tax + Platform Fee
 *   Commission      = Subtotal × Dealer.commission %
 *   Commission Tax  = Commission × commissionTaxRate %   (GST on commission)
 *   Dealer Earnings = Subtotal − Commission − Commission Tax
 *
 * MR Bike's commission is itself a taxable supply to the garage, so GST is
 * charged on top of it and recovered from the dealer along with it: a ₹100
 * commission at 18% is a ₹118 deduction. That tax is charged BY the platform
 * TO the dealer and never reaches the customer's total — it is a different
 * thing entirely from `Tax` above, which is the customer's tax on the
 * garage's service.
 *
 * Tax is collected from the customer but belongs to platform accounting —
 * it is never part of Dealer Earnings.
 *
 * The Platform Fee sits OUTSIDE the subtotal on purpose: it is MR Bike's own
 * convenience charge, not the garage's, so it is never taxed at the dealer's
 * rate, never enters the commission base, and never moves Dealer Earnings.
 * It is admin-configured globally (services/appSettingsService.js), never
 * per-dealer, and is snapshotted onto the booking like every other number
 * here so changing the setting can't re-price an existing booking.
 *
 * No values here are ever hardcoded — tax %, commission %, pickupCharges,
 * dropCharges and towingCharges always come from the Dealer document passed
 * in by the caller (or, for towing, from an explicit dealer/admin override on
 * an existing booking — see resolveTowingCharge()), and the platform fee
 * always comes from the `platformFeeConfig` the caller reads out of
 * AppSettings, as does the commission tax rate.
 *
 * Every caller in the backend (booking creation, live quote, bill generation,
 * wallet settlement) MUST route through this module instead of re-deriving
 * these numbers itself.
 */

const PRICING_VERSION = 1;

const TRANSPORT_OPTIONS = Object.freeze({
  SELF_VISIT: "SELF_VISIT",
  PICKUP_ONLY: "PICKUP_ONLY",
  DROP_ONLY: "DROP_ONLY",
  PICKUP_AND_DROP: "PICKUP_AND_DROP",
});

/**
 * Condition the customer declares for their bike during booking. Only
 * RIDEABLE can reach the garage under its own power — the other two mean the
 * bike has to be carried there, which drives the towing charge below whenever
 * the garage is the one carrying it (see TOWING_TRANSPORT_OPTIONS).
 *
 * RIDEABLE is the default for any booking (and every booking created before
 * this field existed), so legacy bookings read back as "no towing required".
 */
const BIKE_CONDITIONS = Object.freeze({
  RIDEABLE: "RIDEABLE",
  NOT_RIDEABLE: "NOT_RIDEABLE",
  COMPLETELY_DEAD: "COMPLETELY_DEAD",
});

const TOWING_REQUIRED_CONDITIONS = Object.freeze([
  BIKE_CONDITIONS.NOT_RIDEABLE,
  BIKE_CONDITIONS.COMPLETELY_DEAD,
]);

/**
 * Transport options under which the GARAGE is the one moving the bike to the
 * workshop, and is therefore the party that has to tow a bike that cannot be
 * ridden there.
 *
 * SELF_VISIT and DROP_ONLY both mean the customer brings the bike in
 * themselves — on a truck, a friend's help, whatever — so the garage never
 * tows it and must not charge for towing, however bad the bike's condition is.
 * (DROP_ONLY only covers the return leg, which is what dropCharges pay for.)
 */
const TOWING_TRANSPORT_OPTIONS = Object.freeze([
  TRANSPORT_OPTIONS.PICKUP_ONLY,
  TRANSPORT_OPTIONS.PICKUP_AND_DROP,
]);

// Upper bound for a manually entered towing charge. Purely a typo guard
// (a dealer fat-fingering an extra zero); the real authority on what is
// charged stays the dealer's configured rate.
const MAX_TOWING_CHARGE = 100000;

// Same idea for the admin-configured platform fee — a flat convenience fee
// above this is a mistyped amount, not a business decision. Kept in sync with
// services/appSettingsService.js#MAX_PLATFORM_FEE, which guards the write.
const MAX_PLATFORM_FEE = 10000;

const DEFAULT_PLATFORM_FEE_LABEL = "Platform Fee";

// GST on commission is a percentage, so anything outside 0–100 is a data
// error rather than a rate.
const MAX_COMMISSION_TAX_RATE = 100;

class PricingError extends Error {
  constructor(message, code = "PRICING_ERROR") {
    super(message);
    this.name = "PricingError";
    this.code = code;
    this.statusCode = 400;
  }
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Find the price row of a single AdminService/additional-service document
 * that applies to a bike, or null when the dealer has priced it for no row
 * this bike qualifies for. Legacy callers may supply only CC; bike-aware
 * callers must also pass model/variant IDs so another variant with the same
 * engine size cannot lend its price to the selected bike.
 */
function findPriceRowForCC(doc, bikeCC, bikeContext = null) {
  if (!doc || !Array.isArray(doc.bikes)) return null;
  const cc = Number(bikeCC);
  const priced = doc.bikes.filter((row) => Number.isFinite(Number(row.price)));
  // Exact CC first. Rows and bikes have historically disagreed on decimals
  // (a 109.7cc variant priced at 109.7 but read back as parseInt → 109, or
  // the other way round), so a whole-number match is the fallback.
  let ccMatches = priced.filter((row) => Number(row.cc) === cc);
  if (ccMatches.length === 0 && Number.isFinite(cc) && cc > 0) {
    ccMatches = priced.filter((row) => Math.trunc(Number(row.cc)) === Math.trunc(cc));
  }

  // Keep old non-bike-aware integrations working, while all user booking
  // paths below provide the selected variant context.
  if (!bikeContext) {
    return ccMatches[0] || null;
  }

  const variantId = bikeContext.variantId || bikeContext.variant_id;
  const modelId = bikeContext.modelId || bikeContext.model_id;
  const matches = ccMatches.filter((row) => {
    if (row.variant_id && String(row.variant_id) !== String(variantId || "")) return false;
    if (row.model_id && String(row.model_id) !== String(modelId || "")) return false;
    return true;
  });

  // Exact variant > model-specific generic > company/CC generic.
  matches.sort((a, b) => {
    const specificity = (row) => Number(Boolean(row.variant_id)) + Number(Boolean(row.model_id));
    return specificity(b) - specificity(a) || Number(a.price) - Number(b.price);
  });
  return matches[0] || null;
}

/** Price of that row, or 0 when none applies. */
function resolvePriceForCC(doc, bikeCC, bikeContext = null) {
  const row = findPriceRowForCC(doc, bikeCC, bikeContext);
  return row ? Number(row.price) || 0 : 0;
}

/**
 * The CC a bike is priced against: the variant's engine_cc, else the
 * denormalized UserBike.bike_cc. parseFloat (not parseInt) so a decimal
 * engine_cc still matches its rows exactly; findPriceRowForCC falls back to
 * a whole-number match either way.
 */
function resolveBikeCC(userBike) {
  const cc = parseFloat(userBike?.variant_id?.engine_cc || userBike?.bike_cc || 0);
  return Number.isFinite(cc) ? cc : 0;
}

/**
 * Sum the CC-matched price of every main + additional service. This is the
 * single place service pricing is resolved — replaces the duplicated
 * per-service-loop that used to live in controller/booking.js and
 * controller/payment.js.
 */
function resolveServiceAmount({ services = [], additionalServices = [], bikeCC, bikeContext = null }) {
  const lines = resolveServiceLines({ services, additionalServices, bikeCC, bikeContext });
  return round2(lines.reduce((sum, line) => sum + line.price, 0));
}

/**
 * The same prices, one row per service, in booking order: main services
 * first, then additional ones. Stored on the booking as `serviceLines` so the
 * invoice and the apps can show what each service was actually charged at,
 * instead of re-pricing it later against a catalog that may have moved.
 */
function resolveServiceLines({ services = [], additionalServices = [], bikeCC, bikeContext = null }) {
  const line = (kind) => (doc) => ({
    kind,
    ref: doc?._id || null,
    price: round2(resolvePriceForCC(doc, bikeCC, bikeContext)),
  });
  return [...services.map(line("service")), ...additionalServices.map(line("additional"))];
}

/**
 * Apply the dealer's pickup/drop charges for the requested transport option.
 * Rejects any option the dealer does not actually support.
 */
function computeTransportCharges({ transportOption, dealer }) {
  if (!transportOption || !TRANSPORT_OPTIONS[transportOption]) {
    throw new PricingError(
      `Unsupported transportOption: ${transportOption}`,
      "INVALID_TRANSPORT_OPTION"
    );
  }

  const dealerPickupCharges = Number(dealer?.pickupCharges) || 0;
  const dealerDropCharges = Number(dealer?.dropCharges) || 0;
  const providesPickup = Boolean(dealer?.providesPickup);
  const providesDrop = Boolean(dealer?.providesDrop);

  switch (transportOption) {
    case TRANSPORT_OPTIONS.SELF_VISIT:
      return { pickupCharges: 0, dropCharges: 0 };

    case TRANSPORT_OPTIONS.PICKUP_ONLY:
      if (!providesPickup) {
        throw new PricingError(
          "This dealer does not offer pickup service",
          "PICKUP_NOT_SUPPORTED"
        );
      }
      return { pickupCharges: dealerPickupCharges, dropCharges: 0 };

    case TRANSPORT_OPTIONS.DROP_ONLY:
      if (!providesDrop) {
        throw new PricingError(
          "This dealer does not offer drop service",
          "DROP_NOT_SUPPORTED"
        );
      }
      return { pickupCharges: 0, dropCharges: dealerDropCharges };

    case TRANSPORT_OPTIONS.PICKUP_AND_DROP:
      if (!providesPickup || !providesDrop) {
        throw new PricingError(
          "This dealer does not offer pickup & drop service",
          "PICKUP_DROP_NOT_SUPPORTED"
        );
      }
      return { pickupCharges: dealerPickupCharges, dropCharges: dealerDropCharges };

    default:
      throw new PricingError(
        `Unsupported transportOption: ${transportOption}`,
        "INVALID_TRANSPORT_OPTION"
      );
  }
}

/**
 * Normalise whatever a client sent as `bikeCondition` into a supported value.
 * Missing/empty means RIDEABLE — that is what every booking created before
 * this field existed implicitly was, so legacy clients keep working unchanged.
 * Anything else present but unrecognised is a client bug, not a default.
 */
function normalizeBikeCondition(bikeCondition) {
  if (bikeCondition === undefined || bikeCondition === null || bikeCondition === "") {
    return BIKE_CONDITIONS.RIDEABLE;
  }
  const value = String(bikeCondition).trim().toUpperCase();
  if (!BIKE_CONDITIONS[value]) {
    throw new PricingError(
      `Unsupported bikeCondition: ${bikeCondition}`,
      "INVALID_BIKE_CONDITION"
    );
  }
  return value;
}

/** Whether the garage is the party collecting the bike under this option. */
function transportNeedsTowing(transportOption) {
  return TOWING_TRANSPORT_OPTIONS.includes(transportOption);
}

/**
 * Towing is required by the declared condition of the bike AND by who is
 * bringing it in — never by a client-supplied boolean, which a customer app
 * could otherwise flip off to dodge the charge. Always derive it here.
 *
 * A bike that cannot be ridden only has to be towed when the GARAGE is the one
 * fetching it (see TOWING_TRANSPORT_OPTIONS). A customer who declares a dead
 * bike and then chooses to bring it to the shop themselves is doing the towing
 * job the garage would have charged for, so there is nothing to charge.
 *
 * `transportOption` is always known by the time this is called — every caller
 * either validated it through computeTransportCharges() or read it off an
 * existing booking — so an absent one means "no garage collection", not
 * "unknown".
 */
function isTowingRequired(bikeCondition, transportOption) {
  return (
    TOWING_REQUIRED_CONDITIONS.includes(normalizeBikeCondition(bikeCondition)) &&
    transportNeedsTowing(transportOption)
  );
}

/**
 * Resolve the towing charge for a booking.
 *
 * - No towing required (rideable bike, or a customer bringing it in
 *   themselves) -> always 0, whatever anyone passes.
 * - `override` (a dealer/admin editing the charge on an existing booking,
 *   see controller/booking.js#updateTowingCharge) wins when supplied.
 * - Otherwise it is the dealer's configured rate, and only when the dealer
 *   actually offers towing. A dealer who hasn't enabled it starts at 0 and
 *   can add the real amount later once they have quoted the customer —
 *   the booking is never blocked over it.
 */
function resolveTowingCharge({ towingRequired, dealer, override = null }) {
  if (!towingRequired) return 0;

  if (override !== null && override !== undefined && override !== "") {
    const value = Number(override);
    if (!Number.isFinite(value) || value < 0) {
      throw new PricingError("Towing charge must be a non-negative number", "INVALID_TOWING_CHARGE");
    }
    if (value > MAX_TOWING_CHARGE) {
      throw new PricingError(
        `Towing charge cannot exceed ₹${MAX_TOWING_CHARGE}`,
        "TOWING_CHARGE_TOO_LARGE"
      );
    }
    return round2(value);
  }

  if (!dealer?.providesTowing) return 0;
  return round2(Number(dealer?.towingCharges) || 0);
}

/**
 * Resolve MR Bike's platform/convenience fee for a booking.
 *
 * - `override` wins when supplied. That is how an EXISTING booking keeps the
 *   fee it was created with: every recompute path (a changed service list, a
 *   revised towing charge) passes the booking's own stored platformFee back
 *   in, so the fee is frozen at creation exactly like the rest of the pricing
 *   snapshot and an admin changing the setting never re-prices old bookings.
 *   Legacy bookings created before this feature carry 0 and stay at 0.
 * - Otherwise it is the admin's current flat amount, and only while the fee
 *   is switched on. No config, or the fee switched off, means no fee at all.
 */
function resolvePlatformFee({ platformFeeConfig = null, override = null }) {
  if (override !== null && override !== undefined && override !== "") {
    const value = Number(override);
    if (!Number.isFinite(value) || value < 0) {
      throw new PricingError(
        "Platform fee must be a non-negative number",
        "INVALID_PLATFORM_FEE"
      );
    }
    if (value > MAX_PLATFORM_FEE) {
      throw new PricingError(
        `Platform fee cannot exceed ₹${MAX_PLATFORM_FEE}`,
        "PLATFORM_FEE_TOO_LARGE"
      );
    }
    return round2(value);
  }

  if (!platformFeeConfig?.enabled) return 0;

  const amount = Number(platformFeeConfig.amount) || 0;
  if (amount < 0) return 0;
  return round2(Math.min(amount, MAX_PLATFORM_FEE));
}

/**
 * The label the customer app prints next to the platform fee. Only ever
 * meaningful when the fee itself is non-zero.
 */
function resolvePlatformFeeLabel({ platformFee, platformFeeConfig = null, override = null }) {
  if (!platformFee) return null;
  const label = String(override || platformFeeConfig?.label || "").trim();
  return label || DEFAULT_PLATFORM_FEE_LABEL;
}

/**
 * Resolve the GST rate applied to MR Bike's commission.
 *
 * `override` is how an EXISTING booking replays the rate it was created with,
 * exactly like resolvePlatformFee() — a statutory rate change must never
 * re-rate a booking that has already been settled or invoiced. Bookings that
 * predate this feature carry 0 and stay at 0.
 */
function resolveCommissionTaxRate({ commissionTaxRate = 0, override = null }) {
  const raw = override !== null && override !== undefined && override !== ""
    ? override
    : commissionTaxRate;

  const rate = Number(raw) || 0;
  if (!Number.isFinite(rate) || rate < 0) {
    throw new PricingError(
      "Commission tax rate must be a non-negative percentage",
      "INVALID_COMMISSION_TAX_RATE"
    );
  }
  if (rate > MAX_COMMISSION_TAX_RATE) {
    throw new PricingError(
      `Commission tax rate cannot exceed ${MAX_COMMISSION_TAX_RATE}%`,
      "COMMISSION_TAX_RATE_TOO_LARGE"
    );
  }
  return rate;
}

/**
 * Compute the discount a promo code is worth against a given subtotal. Pure —
 * takes an already-fetched PromoCode document/lean object and performs no DB
 * access itself. Usage-limit / per-user-limit checks require querying
 * PromoCodeUsage, so those live in services/promoService.js and must pass
 * BEFORE this is called; everything checkable from the promo document alone
 * (active flag, validity window, minimum order) is enforced here so it can
 * never be bypassed by a caller that forgets to check.
 *
 * Throws PricingError with a specific `code` for every rule violated — the
 * caller returns `error.message` verbatim to the client. The frontend must
 * never compute a discount itself; this is the single source of truth.
 */
function computePromoDiscountAmount({ promo, subtotal }) {
  if (!promo || promo.isDeleted) {
    throw new PricingError("Invalid promo code", "PROMO_NOT_FOUND");
  }
  if (!promo.isActive) {
    throw new PricingError("This promo code is not active", "PROMO_INACTIVE");
  }

  const now = new Date();
  if (promo.validFrom && now < new Date(promo.validFrom)) {
    throw new PricingError("This promo code is not valid yet", "PROMO_NOT_STARTED");
  }
  if (promo.validTo && now > new Date(promo.validTo)) {
    throw new PricingError("This promo code has expired", "PROMO_EXPIRED");
  }

  const amount = round2(Number(subtotal) || 0);
  if (promo.minOrder !== null && promo.minOrder !== undefined && amount < Number(promo.minOrder)) {
    throw new PricingError(
      `Minimum booking amount of ₹${promo.minOrder} required for this promo code`,
      "PROMO_MIN_ORDER_NOT_MET"
    );
  }

  let discount =
    promo.discountType === "percentage"
      ? round2((amount * Number(promo.discountValue)) / 100)
      : round2(Number(promo.discountValue));

  if (promo.maxDiscount !== null && promo.maxDiscount !== undefined) {
    discount = Math.min(discount, round2(Number(promo.maxDiscount)));
  }
  // Never discount more than the booking is actually worth.
  discount = Math.min(discount, amount);

  if (discount <= 0) {
    throw new PricingError("This promo code does not apply any discount", "PROMO_ZERO_DISCOUNT");
  }

  return discount;
}

/**
 * Compute the full price breakdown for a booking or a live quote.
 *
 * `discountAmount` is accepted directly for callers that already know a
 * discount (kept for applyRewardDiscount's use elsewhere). Passing `promo`
 * (an already-fetched PromoCode doc) folds a promo-code discount into the
 * same `discountAmount`/`amountDue` mechanism and stamps the promo snapshot
 * fields onto the returned breakdown so applyBreakdownToBooking() can lock
 * them onto the Booking at creation time.
 *
 * `platformFeeConfig` is the admin's current setting, read by the caller via
 * services/appSettingsService.js#getPlatformFeeConfig(). Omit it and the fee
 * is 0 — which is exactly right for every recompute of an existing booking,
 * where `platformFeeOverride` (the booking's own stored fee) is passed
 * instead to keep the fee frozen at what the customer already agreed to.
 */
function computePriceBreakdown({
  serviceAmount,
  transportOption,
  dealer,
  discountAmount = 0,
  promo = null,
  mrBikeMoneyAmount = null,
  bikeCondition = BIKE_CONDITIONS.RIDEABLE,
  towingRequiredOverride = null,
  towingChargeOverride = null,
  platformFeeConfig = null,
  platformFeeOverride = null,
  platformFeeLabelOverride = null,
  commissionTaxRate = 0,
  commissionTaxRateOverride = null,
}) {
  const amount = round2(Number(serviceAmount) || 0);

  const { pickupCharges, dropCharges } = computeTransportCharges({ transportOption, dealer });

  // Towing sits alongside pickup/drop: a transport charge that is part of the
  // subtotal, so it is taxed and commissioned exactly like they are, and shows
  // as its own line on the bill rather than being folded into the service.
  //
  // It takes BOTH a bike that cannot be ridden and a transport option under
  // which the garage collects it — a customer bringing a dead bike in on their
  // own is not being towed by anyone and is never charged for it.
  //
  // `towingRequiredOverride` replays what an EXISTING booking was created with,
  // exactly like platformFeeOverride: a recompute (an edited service list, a
  // revised towing charge) must never re-derive this and quietly drop a towing
  // charge the customer already agreed to under the rule of the day.
  const condition = normalizeBikeCondition(bikeCondition);
  const towingRequired =
    towingRequiredOverride === null || towingRequiredOverride === undefined
      ? isTowingRequired(condition, transportOption)
      : Boolean(towingRequiredOverride);
  const towingCharge = resolveTowingCharge({
    towingRequired,
    dealer,
    override: towingChargeOverride,
  });

  const subtotal = round2(amount + pickupCharges + dropCharges + towingCharge);

  const taxRate = Number(dealer?.tax) || 0;
  const taxAmount = round2((subtotal * taxRate) / 100);

  // MR Bike's own convenience charge. Deliberately added AFTER tax and left
  // out of the subtotal: it is not the garage's revenue, so it must not be
  // taxed at the dealer's rate nor widen the commission/earnings base below.
  const platformFee = resolvePlatformFee({
    platformFeeConfig,
    override: platformFeeOverride,
  });
  const platformFeeLabel = resolvePlatformFeeLabel({
    platformFee,
    platformFeeConfig,
    override: platformFeeLabelOverride,
  });

  const customerTotal = round2(subtotal + taxAmount + platformFee);

  const commissionRate = Number(dealer?.commission) || 0;
  const commissionAmount = round2((subtotal * commissionRate) / 100);

  // GST on that commission — MR Bike's commission is a taxable supply to the
  // garage, so the dealer is charged commission + GST on it. The customer's
  // total is untouched by this: it moves money between MR Bike and the
  // dealer only, which is why it is deducted from dealerEarnings rather than
  // added to customerTotal.
  const resolvedCommissionTaxRate = resolveCommissionTaxRate({
    commissionTaxRate,
    override: commissionTaxRateOverride,
  });
  const commissionTaxAmount = round2((commissionAmount * resolvedCommissionTaxRate) / 100);
  // What actually leaves the dealer: ₹100 commission at 18% is a ₹118 debit.
  const commissionTotal = round2(commissionAmount + commissionTaxAmount);

  const dealerEarnings = round2(subtotal - commissionTotal);

  // Promo discounts are computed against the subtotal, so the platform fee is
  // never discounted away — the customer always pays it in full.
  let promoDiscountAmount = 0;
  let promoCodeId = null;
  let promoCode = null;
  let promoName = null;
  let promoDiscountType = null;
  let promoDiscountValue = null;

  if (promo) {
    promoDiscountAmount = computePromoDiscountAmount({ promo, subtotal });
    promoCodeId = promo._id;
    promoCode = promo.code;
    promoName = promo.name;
    promoDiscountType = promo.discountType;
    promoDiscountValue = promo.discountValue;
  }

  const normalizedMrBikeMoney = mrBikeMoneyAmount === null || mrBikeMoneyAmount === undefined
    ? null
    : Math.max(0, round2(Number(mrBikeMoneyAmount) || 0));
  const discount = round2(
    (Number(discountAmount) || 0) + promoDiscountAmount + (normalizedMrBikeMoney || 0)
  );

  return {
    transportOption,
    serviceAmount: amount,
    pickupCharges: round2(pickupCharges),
    dropCharges: round2(dropCharges),
    bikeCondition: condition,
    towingRequired,
    towingCharge,
    subtotal,
    taxRate,
    taxAmount,
    platformFee,
    platformFeeLabel,
    customerTotal,
    commissionRate,
    commissionAmount,
    commissionTaxRate: resolvedCommissionTaxRate,
    commissionTaxAmount,
    commissionTotal,
    dealerEarnings,
    discountAmount: discount,
    pricingVersion: PRICING_VERSION,
    promoCodeId,
    promoCode,
    promoName,
    promoDiscountType,
    promoDiscountValue,
    promoDiscountAmount,
    mrBikeMoneyUsed: normalizedMrBikeMoney === null ? undefined : normalizedMrBikeMoney,
  };
}

/**
 * Every Booking field that holds a money/rate value computed by this engine.
 * These are locked at the schema level (models/Booking.js) once a booking
 * exists — no controller may set them via generic field assignment. The
 * ONLY way to legitimately change them post-creation is through
 * applyBreakdownToBooking()/applyRewardDiscount() below, which flip the
 * document's internal bypass flag the schema guard checks for.
 */
const PRICING_SNAPSHOT_FIELDS = Object.freeze([
  "serviceAmount",
  "pickupCharges",
  "dropCharges",
  "towingCharge",
  "subtotal",
  "taxRate",
  "taxAmount",
  "platformFee",
  "platformFeeLabel",
  "customerTotal",
  "commissionRate",
  "commissionAmount",
  "commissionTaxRate",
  "commissionTaxAmount",
  "dealerEarnings",
  "discountAmount",
  "pricingVersion",
  "priceSnapshotAt",
  "serviceLines",
  // Promo code snapshot — set once at creation via applyBreakdownToBooking()
  // when a promo was supplied; immutable for the same reason as every other
  // field here (a promo can't be swapped after the customer saw the price).
  "promoCodeId",
  "promoCode",
  "promoName",
  "promoDiscountType",
  "promoDiscountValue",
  "promoDiscountAmount",
  "mrBikeMoneyUsed",
  "mrBikeMoneyLimit",
  // Legacy mirrors kept for backward-compatible readers (walletSettlement,
  // adminFinance/adminTransactions reporting) — same lock applies to them.
  "totalBill",
  "tax",
]);

// Internal flag name the Booking schema's pre-save/pre-update guards look
// for to allow a write to a locked field. Never set this directly from a
// controller — always go through applyBreakdownToBooking()/applyRewardDiscount().
const PRICING_WRITE_BYPASS_FLAG = "allowPricingWrite";

/**
 * Write a full computePriceBreakdown() result onto a Mongoose Booking
 * document (new or existing) and authorize the write past the schema's
 * immutability guard. This is the ONLY sanctioned way to set the pricing
 * snapshot fields on an existing booking (e.g. updateBooking() recomputing
 * after a service-list change). For brand-new documents this is optional —
 * the guard already allows first-save writes — but calling it keeps every
 * write site consistent.
 */
function applyBreakdownToBooking(bookingDoc, breakdown, { serviceLines } = {}) {
  // Per-service prices behind `serviceAmount` (resolveServiceLines). Optional
  // so a caller that only has the total keeps whatever lines are already
  // stored — but every caller that re-prices the service list passes them.
  if (Array.isArray(serviceLines)) bookingDoc.serviceLines = serviceLines;
  bookingDoc.transportOption = breakdown.transportOption;
  bookingDoc.serviceAmount = breakdown.serviceAmount;
  bookingDoc.pickupCharges = breakdown.pickupCharges;
  bookingDoc.dropCharges = breakdown.dropCharges;
  bookingDoc.towingCharge = breakdown.towingCharge;
  bookingDoc.subtotal = breakdown.subtotal;
  bookingDoc.taxRate = breakdown.taxRate;
  bookingDoc.taxAmount = breakdown.taxAmount;
  bookingDoc.platformFee = breakdown.platformFee;
  bookingDoc.platformFeeLabel = breakdown.platformFeeLabel;
  bookingDoc.customerTotal = breakdown.customerTotal;
  bookingDoc.commissionRate = breakdown.commissionRate;
  bookingDoc.commissionAmount = breakdown.commissionAmount;
  bookingDoc.commissionTaxRate = breakdown.commissionTaxRate;
  bookingDoc.commissionTaxAmount = breakdown.commissionTaxAmount;
  bookingDoc.dealerEarnings = breakdown.dealerEarnings;
  bookingDoc.discountAmount = breakdown.discountAmount;
  bookingDoc.pricingVersion = breakdown.pricingVersion;
  bookingDoc.priceSnapshotAt = new Date();

  if (breakdown.promoCodeId) {
    bookingDoc.promoCodeId = breakdown.promoCodeId;
    bookingDoc.promoCode = breakdown.promoCode;
    bookingDoc.promoName = breakdown.promoName;
    bookingDoc.promoDiscountType = breakdown.promoDiscountType;
    bookingDoc.promoDiscountValue = breakdown.promoDiscountValue;
    bookingDoc.promoDiscountAmount = breakdown.promoDiscountAmount;
  }

  if (breakdown.mrBikeMoneyUsed !== undefined) {
    bookingDoc.mrBikeMoneyUsed = breakdown.mrBikeMoneyUsed;
  }

  // Legacy mirrors — kept for backward-compatible readers.
  bookingDoc.tax = breakdown.taxAmount;
  bookingDoc.totalBill = breakdown.subtotal;

  if (typeof bookingDoc.$locals === "object" && bookingDoc.$locals !== null) {
    bookingDoc.$locals[PRICING_WRITE_BYPASS_FLAG] = true;
  }
  return bookingDoc;
}

/**
 * Apply a reward-points (or any future coupon/offer) discount to an existing
 * booking WITHOUT touching subtotal, serviceAmount, commission or dealer
 * earnings — those are computed once at booking creation and never move.
 * Only discountAmount changes; amountDue (a virtual, see models/Booking.js)
 * recomputes automatically as customerTotal - discountAmount.
 *
 * Throws PricingError if the discount would exceed the amount still due.
 */
function applyRewardDiscount(bookingDoc, additionalDiscount) {
  const addition = round2(Number(additionalDiscount) || 0);
  if (addition <= 0) {
    throw new PricingError("Discount amount must be greater than zero", "INVALID_DISCOUNT");
  }

  const customerTotal = Number(bookingDoc.customerTotal) || 0;
  const existingDiscount = Number(bookingDoc.discountAmount) || 0;
  const amountDue = round2(customerTotal - existingDiscount);

  if (addition > amountDue) {
    throw new PricingError(
      `Discount (${addition}) exceeds the amount still due (${amountDue})`,
      "DISCOUNT_EXCEEDS_AMOUNT_DUE"
    );
  }

  bookingDoc.discountAmount = round2(existingDiscount + addition);

  if (typeof bookingDoc.$locals === "object" && bookingDoc.$locals !== null) {
    bookingDoc.$locals[PRICING_WRITE_BYPASS_FLAG] = true;
  }
  return bookingDoc;
}

module.exports = {
  PRICING_VERSION,
  TRANSPORT_OPTIONS,
  BIKE_CONDITIONS,
  TOWING_REQUIRED_CONDITIONS,
  TOWING_TRANSPORT_OPTIONS,
  MAX_TOWING_CHARGE,
  MAX_PLATFORM_FEE,
  MAX_COMMISSION_TAX_RATE,
  DEFAULT_PLATFORM_FEE_LABEL,
  PricingError,
  PRICING_SNAPSHOT_FIELDS,
  PRICING_WRITE_BYPASS_FLAG,
  round2,
  findPriceRowForCC,
  resolvePriceForCC,
  resolveBikeCC,
  resolveServiceAmount,
  resolveServiceLines,
  computeTransportCharges,
  normalizeBikeCondition,
  isTowingRequired,
  transportNeedsTowing,
  resolveTowingCharge,
  resolvePlatformFee,
  resolveCommissionTaxRate,
  computePromoDiscountAmount,
  computePriceBreakdown,
  applyBreakdownToBooking,
  applyRewardDiscount,
};
