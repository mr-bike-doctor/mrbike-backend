const AdminService = require("../models/adminService");
const Vendor = require("../models/dealerModel");
const Customer = require("../models/customer_model");
const {
  computePriceBreakdown,
  computeTransportCharges,
  resolveServiceAmount,
  resolveTowingCharge,
  isTowingRequired,
  round2,
  PricingError,
} = require("../services/pricingEngine");
const { validatePromoCode } = require("../services/promoService");
const { getPricingSettings } = require("../services/appSettingsService");
const { resolveBikeContextById } = require("../v1-api/helpers/serviceEligibility");
const {
  calculateMrBikeMoneyRedemption,
  getServiceRedemptionLimit,
} = require("../services/mrBikeMoneyService");

// POST /pricing/quote
//
// Live pricing preview — NO database writes. Any client (User App, Dealer
// App, Admin UI, or this backend itself) calls this to know what a booking
// would cost before committing to createBooking(). Also doubles as the
// "Apply Promo" call: pass `promoCode` to validate a code and see the
// discounted total before confirming — this never writes usage/PromoCodeUsage,
// it's a preview only (see controller/booking.js#createBooking for where a
// promo is actually locked onto a booking, and services/invoiceService.js
// for where its usage is finally counted, only after payment succeeds).
//
// Body: { dealerId, serviceIds: [AdminServiceId], additionalServiceIds?, transportOption, bikeCC, bikeId?, promoCode?, bikeCondition? }
// bikeCondition (RIDEABLE | NOT_RIDEABLE | COMPLETELY_DEAD) is optional and
// defaults to RIDEABLE, so clients that predate it keep getting the same
// quote they always did. The two non-rideable values add the dealer's towing
// charge as its own line in the breakdown — but only for a transportOption
// under which the garage collects the bike; a customer bringing a dead bike in
// themselves is never quoted for towing.
// bikeCC is required to resolve per-CC service pricing (AdminService.bikes is
// keyed by cc) — not called out explicitly in the original spec's input list,
// but there is no way to price a service without it.
const getPricingQuote = async (req, res) => {
  try {
    const { dealerId, serviceIds, additionalServiceIds, transportOption, bikeCC, bikeId, promoCode, bikeCondition } = req.body;
    const useMrBikeMoney = req.body.useMrBikeMoney === true;

    const userId = req.user_id || null;
    if (useMrBikeMoney && !userId) {
      return res.status(401).json({ success: false, message: "Login is required to use MR Bike Money" });
    }

    if (!dealerId) {
      return res.status(400).json({ success: false, message: "dealerId is required" });
    }
    if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
      return res.status(400).json({ success: false, message: "serviceIds must be a non-empty array" });
    }
    if (!transportOption) {
      return res.status(400).json({ success: false, message: "transportOption is required" });
    }
    if (bikeCC === undefined || bikeCC === null || bikeCC === "") {
      return res.status(400).json({ success: false, message: "bikeCC is required to resolve service pricing" });
    }

    const dealer = await Vendor.findById(dealerId)
      .select("tax commission pickupCharges dropCharges providesPickup providesDrop providesTowing towingCharges")
      .lean();
    if (!dealer) {
      return res.status(404).json({ success: false, message: "Dealer not found" });
    }

    // Prefer AdminService ids, but also accept BaseService ids from older app
    // builds/dealer-service responses. Always scope the resolution to this
    // dealer so a catalog id can never select another garage's pricing row.
    const services = await AdminService.find({
      dealer_id: dealerId,
      isActive: true,
      $or: [
        { _id: { $in: serviceIds } },
        { base_service_id: { $in: serviceIds } },
      ],
    })
      .select("bikes base_service_id")
      .populate("base_service_id", "mrBikeMoneyMaxRedeem")
      .lean();

    if (services.length === 0) {
      return res.status(400).json({ success: false, message: "No valid services found for this dealer" });
    }

    let additionalServices = [];
    if (Array.isArray(additionalServiceIds) && additionalServiceIds.length > 0) {
      const AdditionalService = require("../models/additionalServiceSchema");
      additionalServices = await AdditionalService.find({ _id: { $in: additionalServiceIds } })
        .select("bikes")
        .lean();
    }

    let bikeContext = null;
    if (bikeId) {
      if (!userId) {
        return res.status(401).json({ success: false, message: "Authentication is required for selected-bike pricing" });
      }
      bikeContext = await resolveBikeContextById(bikeId, userId);
      if (!bikeContext) {
        return res.status(400).json({ success: false, message: "Selected user bike was not found" });
      }
    }

    // The populated catalog variant is authoritative. UserBike.bike_cc and a
    // client-supplied bikeCC are legacy denormalized values and may be stale.
    const resolvedBikeCC = bikeContext?.cc ?? bikeCC;
    const serviceAmount = resolveServiceAmount({
      services,
      additionalServices,
      bikeCC: resolvedBikeCC,
      bikeContext,
    });

    let promo = null;
    if (promoCode) {
      // Resolve the real subtotal (service + pickup/drop + towing) the same way
      // computePriceBreakdown will, so the minOrder/discount check below
      // matches exactly what the breakdown call further down computes.
      const { pickupCharges, dropCharges } = computeTransportCharges({ transportOption, dealer });
      const towingCharge = resolveTowingCharge({
        towingRequired: isTowingRequired(bikeCondition, transportOption),
        dealer,
      });
      const subtotal = round2(serviceAmount + pickupCharges + dropCharges + towingCharge);
      const validated = await validatePromoCode({ code: promoCode, userId, subtotal });
      promo = validated.promo;
    }

    // MR Bike's own admin-configured numbers — the platform fee the customer
    // pays, and the GST rate on the commission the dealer pays. Read here so
    // the quote is the same one createBooking() will lock onto the booking a
    // moment later.
    const { platformFeeConfig, commissionTaxRate } = await getPricingSettings();

    const baseBreakdown = computePriceBreakdown({
      serviceAmount,
      transportOption,
      dealer,
      promo,
      bikeCondition,
      platformFeeConfig,
      commissionTaxRate,
    });

    const wallet = userId
      ? await Customer.findById(userId).select("mrBikeMoneyBalance").lean()
      : null;
    const serviceLimit = getServiceRedemptionLimit(services);
    const redemption = calculateMrBikeMoneyRedemption({
      balance: wallet?.mrBikeMoneyBalance || 0,
      serviceLimit,
      amountDueBeforeMoney: round2(baseBreakdown.customerTotal - baseBreakdown.discountAmount),
    });
    const mrBikeMoneyAmount = useMrBikeMoney ? redemption.maxRedeemable : 0;

    const breakdown = computePriceBreakdown({
      serviceAmount,
      transportOption,
      dealer,
      promo,
      mrBikeMoneyAmount,
      bikeCondition,
      platformFeeConfig,
      commissionTaxRate,
    });

    return res.status(200).json({
      success: true,
      data: {
        ...breakdown,
        mrBikeMoneyBalance: redemption.balance,
        mrBikeMoneyLimit: redemption.serviceLimit,
        mrBikeMoneyMaxRedeemable: redemption.maxRedeemable,
      },
    });
  } catch (error) {
    if (error instanceof PricingError) {
      return res.status(400).json({ success: false, message: error.message, code: error.code });
    }
    console.error("[getPricingQuote] error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = { getPricingQuote };
