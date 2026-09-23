const mongoose = require("mongoose")

const paymentSchema = new mongoose.Schema(
  {
    cf_order_id: {
      type: String,
      required: false,
      unique: true,
      sparse: true, // Allow null values for unique field
    },
    orderId: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
    },
    booking_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: false,
      default: null,
    },
    dealer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "customers",
      required: false,
      default: null,
    },
    orderAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    payment_type: {
      type: String,
      required: true,
      enum: ["ONLINE", "OFFLINE", "WALLET", "UPI_QR", "UPI", "CARD", "NETBANKING", "WALLET_TOPUP"],
    },
    order_currency: {
      type: String,
      default: "INR",
      enum: ["INR", "USD"],
    },
    order_status: {
      type: String,
      required: true,
      enum: ["PENDING", "SUCCESS", "FAILED", "CANCELLED", "EXPIRED"], // Added EXPIRED as order status option
    },
    order_token: {
      type: String,
      default: "temp_token",
    },
    payment_by: {
      type: String,
      enum: ["dealer", "user"],
      default: "dealer",
      required: true,
    },
    payment_method: {
      type: String,
      enum: ["card", "netbanking", "upi", "wallet", "emi", "qrcode", null], // Added fields for Cashfree UPI QR payments
      default: null,
    },
    cf_payment_id: {
      type: String,
      default: null,
    },
    transaction_id: {
      type: String,
      default: null,
    },
    utr_number: {
      type: String,
      default: null,
    },
    gateway_status: {
      type: String,
      default: null,
    },
    verified_amount: {
      type: Number,
      default: null,
    },
    verified_timestamp: {
      type: Date,
      default: null,
    },
    // Booking softPOS Dynamic QR (metadata.cashfree_resource = "SOFTPOS_QR")
    // only. Null on wallet top-ups and historical PG_ORDER / PAYMENT_LINK rows.
    cf_terminal_id: {
      type: String,
      default: null,
    },
    payment_attempt: {
      type: Number,
      default: null,
    },
    expires_at: {
      type: Date,
      default: null,
    },
    // Top-up only: guards a single Vendor.wallet + Wallet ledger credit for a
    // successful Cashfree order across webhooks and authenticated status polls.
    wallet_credit_state: {
      type: String,
      enum: ["PENDING", "PROCESSING", "CREDITED"],
      default: "PENDING",
    },
    wallet_credited_at: { type: Date, default: null },
    refund_amount: {
      type: Number,
      default: 0,
    },
    refund_status: {
      type: String,
      enum: ["NONE", "PENDING", "PROCESSED", "FAILED"],
      default: "NONE",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed, // Metadata for storing QR code info, webhook data, etc.
      default: {},
    },
    create_date: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
)

// Add indexes for better query performance
paymentSchema.index({ cf_order_id: 1 })
paymentSchema.index({ orderId: 1 })
paymentSchema.index({ booking_id: 1 })
paymentSchema.index({ dealer_id: 1 })
paymentSchema.index({ user_id: 1 })
paymentSchema.index({ order_status: 1 })
paymentSchema.index({ payment_type: 1 }) // Added index for payment_type
paymentSchema.index({ create_date: -1 })
paymentSchema.index(
  { booking_id: 1 },
  {
    unique: true,
    partialFilterExpression: { booking_id: { $type: "objectId" }, order_status: "SUCCESS" },
    name: "one_successful_payment_per_booking",
  },
)
paymentSchema.index(
  { booking_id: 1 },
  {
    unique: true,
    partialFilterExpression: { booking_id: { $type: "objectId" }, order_status: "PENDING" },
    name: "one_pending_payment_per_booking",
  },
)

module.exports = mongoose.model("Payment", paymentSchema)
