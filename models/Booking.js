// const mongoose = require("mongoose");
// const AutoIncrement = require("mongoose-sequence")(mongoose);

// const bookingSchema = new mongoose.Schema(
//   {
//     id: { type: Number },
//     user_id: { type: mongoose.Schema.Types.ObjectId, ref: "customers", required: true },
//     dealer_id: { type: mongoose.Schema.Types.ObjectId, ref: "dealer", required: true },
//     services: [{ type: mongoose.Schema.Types.ObjectId, ref: "service" }],
//     pickupAndDropId: { type: mongoose.Schema.Types.ObjectId, ref: "PicknDrop", default: null },
//     additionalServices: {
//       type: [{ type: mongoose.Schema.Types.ObjectId, ref: "additionalServices" }],
//       default: [],
//     },
//     status: {
//       type: String,
//       enum: ["pending", "confirmed", "completed", "Payment", "rejected", "user_cancelled", "cash received"],
//       default: "pending"
//     },
//     userBike_id: { type: mongoose.Schema.Types.ObjectId, ref: "UserBike", required: true },
//     pickupStatus: {
//       type: String,
//       default: "pending"
//     },
//     serviceDate: { type: Date },
//     billGenerated: { type: Boolean, default: false },
//     lastServiceKm: { type: Number, default: 0 },
//     serviceSummary: [{
//       serviceName: { type: String, default: "" },
//       price: { type: Number, default: 0 }
//     }],
//     otp: { type: Number, default: null },
//     tax: { type: Number, default: 0 },
//     totalBill: { type: Number, default: 0 },

//     billStatus: {
//       type: String,
//       enum: ["pending", "paid", "cancelled"],
//       default: "pending"
//     },
//     additionalNotes: { type: [String], default: [] },


//     pickupDate: { type: Date, default: null },
//     create_date: { type: Date, default: Date.now },
//     dealer_id: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Vendor'
//     },
//     services: [{ type: mongoose.Schema.Types.ObjectId, ref: 'service' }],
//     // services: {
//     //   type: mongoose.Schema.Types.ObjectId,
//     //   ref: 'service'
//     // },
//   },

//   { timestamps: true }
// );

// bookingSchema.plugin(AutoIncrement, { id: "booking_seq", inc_field: "id" });
// bookingSchema.virtual("bookingId").get(function () {
//   return `B-${this.id.toString().padStart(2, "0")}`;
// });
// bookingSchema.set("toJSON", { virtuals: true });

// module.exports = mongoose.model("Booking", bookingSchema);

// models/Booking.js
const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const {
  PRICING_SNAPSHOT_FIELDS,
  PRICING_WRITE_BYPASS_FLAG,
  BIKE_CONDITIONS,
  round2,
} = require("../services/pricingEngine");

// Any update-query operator whose payload might carry a locked field name.
const UPDATE_OPERATORS_TO_INSPECT = ["$set", "$inc", "$push", "$addToSet", "$pull", "$setOnInsert"];

function updateTouchesLockedField(update) {
  const flatKeys = { ...update };
  for (const op of UPDATE_OPERATORS_TO_INSPECT) {
    if (update && update[op]) Object.assign(flatKeys, update[op]);
  }
  return PRICING_SNAPSHOT_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(flatKeys, field));
}

const bookingSchema = new mongoose.Schema(
  {
    id: { type: Number },

    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "customers", required: true },
    dealer_id: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },

    services: [{ type: mongoose.Schema.Types.ObjectId, ref: "AdminService" }],
    additionalServices: [{ type: mongoose.Schema.Types.ObjectId, ref: "additionalServices" }],

    pickupAndDropId: { type: mongoose.Schema.Types.ObjectId, ref: "PicknDrop", default: null },

    status: {
      type: String,
      enum: [
        "pending",
        "confirmed",
        "completed",
        "awaiting_payment",
        "payment_selected",
        "ready_for_delivery",
        "delivered",
        "Payment",
        "rejected",
        "user_cancelled",
        "cancelled",
        "cash received",
        "expired",
      ],
      default: "pending",
    },

    // Customer cancellation audit trail. These fields are intentionally kept
    // on the booking so support/admin clients can explain why a request ended.
    cancellationReasonCode: {
      type: String,
      enum: [
        "CHANGE_OF_PLANS",
        "BOOKED_BY_MISTAKE",
        "NEED_TO_RESCHEDULE",
        "FOUND_ANOTHER_GARAGE",
        "PRICE_CONCERN",
        "LOCATION_CONCERN",
        "OTHER",
        null,
      ],
      default: null,
    },
    cancellationReason: {type: String, default: null, trim: true, maxlength: 120},
    cancelledAt: {type: Date, default: null},
    cancelledBy: {type: mongoose.Schema.Types.ObjectId, ref: "customers", default: null},

    dealerResponseStatus: {
      type: String,
      enum: ["awaiting", "accepted", "rejected", "expired"],
      default: "awaiting",
    },

    timerExpiresAt: { type: Date, default: null },

    userBike_id: { type: mongoose.Schema.Types.ObjectId, ref: "UserBike", required: true },

    // Pickup is a sub-lifecycle of a confirmed booking. Legacy lowercase
    // values remain accepted so old rows can still be read and completed.
    pickupStatus: {
      type: String,
      enum: [
        "pending",
        "arriving",
        "arrived",
        "pickedup",
        "completed",
        "BOOKING_CONFIRMED",
        "PICKUP_STARTED",
        "RIDER_NEARBY",
        "ARRIVED",
        "PICKUP_OTP_VERIFIED",
        "BIKE_PICKED_UP",
      ],
      default: "pending",
    },

    pickupStartedAt: { type: Date, default: null },
    riderNearbyAt: { type: Date, default: null },
    pickupNearbyNotifiedAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    pickupOtpVerifiedAt: { type: Date, default: null },
    pickupOtpExpiresAt: { type: Date, default: null, select: false },
    pickupCompletedAt: { type: Date, default: null },
    pickupTrackingActive: { type: Boolean, default: false },
    pickupCurrentLocation: {
      latitude: { type: Number, min: -90, max: 90, default: null },
      longitude: { type: Number, min: -180, max: 180, default: null },
      updatedAt: { type: Date, default: null },
    },

    serviceDate: { type: Date },
    billGenerated: { type: Boolean, default: false },
    lastServiceKm: { type: Number, default: 0 },

    serviceSummary: [
      {
        serviceName: { type: String, default: "" },
        price: { type: Number, default: 0 },
      },
    ],

    // 🔄 replaced single 'otp' with two distinct OTPs
    pickupOtp: { type: Number, default: null, select: false },
    deliveryOtp: { type: Number, default: null },

    // Legacy fields — kept for backward compatibility with code that reads
    // them directly (wallet settlement, admin finance/reporting). Populated
    // from the pricing snapshot below (totalBill = subtotal, tax = taxAmount).
    tax: { type: Number, default: 0 },
    totalBill: { type: Number, default: 0 },

    // Snapshotted from Dealer.pickupCharges/dropCharges at pricing time —
    // only non-zero when the chosen transportOption actually includes them.
    pickupCharges: { type: Number, default: 0 },
    dropCharges: { type: Number, default: 0 },

    // ── Bike condition & towing requirement ──────────────────────────────────
    // Declared by the customer during booking. `towingRequired` is always
    // derived server-side from `bikeCondition` AND `transportOption` together
    // (see pricingEngine.isTowingRequired) and never accepted from a client:
    // a bike that cannot be ridden is only towed when the GARAGE is the one
    // collecting it, so a customer who brings a dead bike in themselves is
    // never charged for towing. All three are set once at creation and are not
    // editable afterwards — they are what the customer declared, and the
    // towing charge is priced off them.
    //
    // The RIDEABLE/false defaults are what every booking created before this
    // feature implicitly was, so existing bookings read back correctly with
    // no migration.
    bikeCondition: {
      type: String,
      enum: Object.values(BIKE_CONDITIONS),
      default: BIKE_CONDITIONS.RIDEABLE,
    },
    towingRequired: { type: Boolean, default: false },
    // Optional short note from the customer describing the problem, only
    // captured when towing is required.
    towingNote: { type: String, default: null, maxlength: 500 },

    // ── Pricing snapshot (services/pricingEngine.js) ──────────────────────────
    // Computed once by pricingEngine.computePriceBreakdown() at booking
    // creation and stored permanently. These values are immutable: later
    // edits to the dealer's tax/commission/charge rates must NEVER change
    // an already-created booking's pricing.
    transportOption: {
      type: String,
      enum: ["SELF_VISIT", "PICKUP_ONLY", "DROP_ONLY", "PICKUP_AND_DROP"],
      default: "SELF_VISIT",
    },
    serviceAmount: { type: Number, default: 0 },
    // Part of the pricing snapshot (and therefore of the subtotal, tax and
    // commission base), but unlike the other snapshot fields it may be
    // revised after creation by the dealer/admin while the booking is still
    // unpaid — see controller/booking.js#updateTowingCharge, which recomputes
    // the WHOLE breakdown through pricingEngine rather than patching a total.
    towingCharge: { type: Number, default: 0 },
    towingChargeUpdatedAt: { type: Date, default: null },
    towingChargeUpdatedByRole: {
      type: String,
      enum: ["dealer", "admin", null],
      default: null,
    },
    subtotal: { type: Number, default: 0 },
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    // MR Bike's admin-configured convenience fee, charged on top of the
    // garage's amount and the tax on it. Part of customerTotal (and therefore
    // of what the customer actually pays) but NOT of subtotal, so it never
    // touches commissionAmount or dealerEarnings. 0 on every booking created
    // before the fee existed and on every booking taken while it is switched
    // off. `platformFeeLabel` is the wording the customer saw, snapshotted
    // alongside the amount so a later rename can't rewrite an old bill.
    platformFee: { type: Number, default: 0 },
    platformFeeLabel: { type: String, default: null },
    customerTotal: { type: Number, default: 0 },
    commissionRate: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    // GST MR Bike charges the dealer on top of that commission. Recovered
    // from the dealer together with the commission (a ₹100 commission at 18%
    // is a ₹118 deduction, already reflected in dealerEarnings below) and
    // never added to what the customer pays. 0 on every booking created
    // before this existed, which keeps their payout exactly as settled.
    commissionTaxRate: { type: Number, default: 0 },
    commissionTaxAmount: { type: Number, default: 0 },
    // Net payout: subtotal − commission − commission tax.
    dealerEarnings: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    pricingVersion: { type: Number, default: null },
    priceSnapshotAt: { type: Date, default: null },

    // ── Promo Code snapshot ────────────────────────────────────────────────
    // Set once at booking creation via pricingEngine.applyBreakdownToBooking()
    // when a valid promo code is supplied. Immutable after creation (locked
    // fields, see PRICING_SNAPSHOT_FIELDS below) — a promo can't be swapped
    // or removed once the booking exists, matching "promo cannot change
    // after payment" and keeping the discount consistent with what the
    // customer actually saw before confirming.
    promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "PromoCode", default: null },
    promoCode: { type: String, default: null },
    promoName: { type: String, default: null },
    promoDiscountType: { type: String, enum: ["percentage", "flat", null], default: null },
    promoDiscountValue: { type: Number, default: null },
    promoDiscountAmount: { type: Number, default: 0 },

    // MR Bike Money is a customer-funded discount. It never reduces the
    // garage subtotal or dealer earnings; it only reduces amountDue.
    mrBikeMoneyUsed: { type: Number, default: 0, min: 0 },
    mrBikeMoneyLimit: { type: Number, default: 0, min: 0 },

    billStatus: {
      type: String,
      enum: ["pending", "paid", "cancelled"],
      default: "pending",
    },

    additionalNotes: { type: [String], default: [] },

    pickupDate: { type: Date, default: null },

    // Optional scheduling preferences
    scheduleDate: { type: String, default: null },   // e.g. "2026-05-10"
    timeSlot: { type: String, default: null },        // e.g. "10:00 AM - 12:00 PM"
    pickupAddress: { type: String, default: null },   // e.g. "123 MG Road, Bangalore"

    bookingId: { type: String, unique: true },

    create_date: { type: Date, default: Date.now },
    walletSettled: { type: Boolean, default: false },

    payment_method: {
      type: String,
      default: null,
      // Mongoose 6 enum validator rejects null even for non-required String fields.
      // Custom validator explicitly allows null (payment not yet selected) while
      // still rejecting any value that is not ONLINE or CASH.
      validate: {
        validator: function (v) {
          return v === null || v === undefined || v === "ONLINE" || v === "CASH";
        },
        message: "payment_method must be 'ONLINE' or 'CASH'",
      },
    },
    payment_status:      { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    payment_verified:    { type: Boolean, default: false },
    paymentOrderLockToken: { type: String, default: null, select: false },
    paymentOrderLockUntil: { type: Date, default: null, select: false },

    otp_verified:        { type: Boolean, default: false },
    delivered_at:        { type: Date, default: null },

    // Review lifecycle is denormalised here so booking clients can decide
    // whether to show the rating CTA without an additional query.
    reviewStatus: {
      type: String,
      enum: ["ineligible", "pending", "submitted"],
      default: "ineligible",
      index: true,
    },
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "rating", default: null },
    reviewEligibleAt: { type: Date, default: null },
    reviewSubmittedAt: { type: Date, default: null },
    reviewReminder24hSentAt: { type: Date, default: null },
    reviewReminder3dSentAt: { type: Date, default: null },

    otp_regen_count:     { type: Number, default: 0 },
    otp_failed_attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

bookingSchema.pre("save", async function (next) {
  if (!this.isNew || this.bookingId) return next();

  try {
    // 1. Get current time in IST (UTC + 5:30)
    const ISTOffset = 5.5 * 60 * 60 * 1000;
    const now = new Date();
    const istNow = new Date(now.getTime() + ISTOffset);
    
    // Month and Day in IST
    const mm = String(istNow.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(istNow.getUTCDate()).padStart(2, "0");
    const dateStr = mm + dd;

    // 2. Define range for "today" in IST boundaries, converted to UTC
    const startOfIstTodayUTC = new Date(istNow);
    startOfIstTodayUTC.setUTCHours(0, 0, 0, 0);
    // Move from IST 00:00 to UTC equivalent
    const startOfTodayUTC = new Date(startOfIstTodayUTC.getTime() - ISTOffset);
    
    const endOfIstTodayUTC = new Date(istNow);
    endOfIstTodayUTC.setUTCHours(23, 59, 59, 999);
    // Move from IST 23:59 to UTC equivalent
    const endOfTodayUTC = new Date(endOfIstTodayUTC.getTime() - ISTOffset);

    const count = await this.constructor.countDocuments({
      create_date: { $gte: startOfTodayUTC, $lte: endOfTodayUTC },
    });

    const sequence = String(count + 1).padStart(2, "0");
    this.bookingId = `MRB${dateStr}${sequence}`;
    next();
  } catch (error) {
    next(error);
  }
});

// ── Immutable pricing snapshot guard ────────────────────────────────────────
// Once a booking exists, its pricing snapshot fields (see
// services/pricingEngine.js#PRICING_SNAPSHOT_FIELDS) may only change through
// pricingEngine.applyBreakdownToBooking()/applyRewardDiscount(), which flip
// $locals.allowPricingWrite right before save(). Any other attempt to set
// these fields — via mass assignment, a stray `.field = x`, or a raw
// findOneAndUpdate — is rejected here, regardless of where in the backend it
// originates. First creation (isNew) is always allowed: that is the one
// legitimate moment the snapshot is established.
bookingSchema.pre("save", function (next) {
  if (this.isNew) return next();
  if (this.$locals && this.$locals[PRICING_WRITE_BYPASS_FLAG]) return next();

  const lockedField = PRICING_SNAPSHOT_FIELDS.find((field) => this.isModified(field));
  if (lockedField) {
    return next(
      new Error(
        `Pricing field "${lockedField}" is immutable after booking creation. ` +
          `Use pricingEngine.applyBreakdownToBooking()/applyRewardDiscount() instead of setting it directly.`
      )
    );
  }
  next();
});

// The bypass flag authorizes exactly ONE upcoming save — clear it immediately
// after every save so a document instance that is held onto and mutated
// again later in the same request doesn't silently inherit authorization it
// was never granted for that second write.
bookingSchema.post("save", function (doc) {
  if (doc && doc.$locals) {
    doc.$locals[PRICING_WRITE_BYPASS_FLAG] = false;
  }
});

bookingSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
  const options = this.getOptions() || {};
  if (options[PRICING_WRITE_BYPASS_FLAG]) return next();

  const lockedField = updateTouchesLockedField(this.getUpdate());
  if (lockedField) {
    return next(
      new Error(
        `Pricing field "${lockedField}" is immutable after booking creation and cannot be set via ` +
          `findOneAndUpdate/updateOne/updateMany. Use pricingEngine.applyBreakdownToBooking() on a ` +
          `loaded document, or pass { ${PRICING_WRITE_BYPASS_FLAG}: true } as an explicit, reviewed exception.`
      )
    );
  }
  next();
});

bookingSchema.plugin(AutoIncrement, { id: "booking_seq", inc_field: "id" });

// amountDue is always derived, never stored — customerTotal and discountAmount
// are the only two numbers that can move it, and both are already guarded.
bookingSchema.virtual("amountDue").get(function () {
  return round2((this.customerTotal || 0) - (this.discountAmount || 0));
});

bookingSchema.virtual("vehicleLifecycleStatus").get(function () {
  // 1. Cancelled / terminal states
  if (["rejected", "user_cancelled", "cancelled"].includes(this.status)) {
    return "Cancelled";
  }

  if (this.status === "expired") return "Dealer Did Not Respond";

  // 2. Initial Booking
  if (this.status === "pending") return "Booking Created";

  // 3. Pre-Service & In Service
  if (this.status === "confirmed") {
    // If it's a Pickup & Drop service
    if (this.pickupAndDropId) {
      if (["pending", "BOOKING_CONFIRMED", "PICKUP_STARTED", "RIDER_NEARBY", "ARRIVED"].includes(this.pickupStatus))
        return "Pickup Scheduled";
      if (["pickedup", "completed", "arrived", "PICKUP_OTP_VERIFIED", "BIKE_PICKED_UP"].includes(this.pickupStatus))
        return "Service In Progress";
    } else {
      // If it's a direct customer visit to the shop
      return "Awaiting Customer Drop-off";
    }
  }

  // 4. Post-Service & Billing
  if (this.status === "completed") {
    if (!this.billGenerated) return "Service Completed (Pending Bill)";
    if (this.billStatus === "pending")
      return "Bill Generated (Pending Payment)";
  }

  // 5. Payment selection
  if (this.status === "awaiting_payment") {
    return "Service Completed — Select Payment Method";
  }

  if (this.status === "payment_selected") {
    return this.payment_method === "CASH"
      ? "Cash Payment — Awaiting Dealer Confirmation"
      : "Online Payment — Awaiting Confirmation";
  }

  // 6. Payment & Delivery closure (legacy paths)
  if (
    this.billStatus === "paid" ||
    ["Payment", "cash received"].includes(this.status)
  ) {
    return "Payment Completed (Ready for Delivery)";
  }

  // 7. Post-payment delivery
  if (this.status === "ready_for_delivery") {
    return "Payment Confirmed — Awaiting Handover OTP";
  }

  if (this.status === "delivered") {
    return "Bike Delivered";
  }

  return "Unknown Status";
});

bookingSchema.set("toJSON", { virtuals: true });
bookingSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
