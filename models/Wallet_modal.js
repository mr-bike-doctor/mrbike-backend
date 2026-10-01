const mongoose = require("mongoose");
const AutoIncrement = require('mongoose-sequence')(mongoose);

const walletSchema = new mongoose.Schema({
    orderId: {
        type: String,
        required: true,
    },
    dealer_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Vendor"
    },
    Amount: {
        type: Number
    },
    Type: {
        type: String,
        enum: ["Credit", "Debit", "Pending"],
    },
    Note: {
        type: String
    },
    Total: {
        type: Number
    },
    order_status: {
        type: String,
        enum: ["ACTIVE", "PAID", "PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "EXPIRED", "APPROVED", "REJECTED"],
        default: "PENDING",
    },
    // settlement_online | settlement_cash | withdrawal | deposit | manual | reconciliation | rollback
    transaction_type: {
        type: String,
        enum: ["settlement_online", "settlement_cash", "withdrawal", "deposit", "manual", "reconciliation", "rollback"],
        default: "manual",
    },
    pre_balance: {
        type: Number,
    },
    booking_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Booking",
    },
    performed_by: {
        type: mongoose.Schema.Types.ObjectId,
    },
    // Keep optional unique-indexed fields absent rather than explicitly null.
    // This is also compatible with the legacy sparse indexes that may still
    // exist while an environment is waiting for the partial-index migration.
    idempotency_key: { type: String },
    payout_reference: { type: String, default: null },
    rollback_of: { type: mongoose.Schema.Types.ObjectId, ref: "Wallet" },
}, {
    timestamps: true,
});

walletSchema.plugin(AutoIncrement, { id: "wallet_seq", inc_field: "id" });
walletSchema.index(
    { booking_id: 1, transaction_type: 1 },
    {
        unique: true,
        partialFilterExpression: {
            booking_id: { $type: "objectId" },
            transaction_type: { $in: ["settlement_online", "settlement_cash"] },
        },
        name: "one_wallet_settlement_per_booking_method",
    },
);
walletSchema.index(
    { dealer_id: 1, idempotency_key: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotency_key: { $type: "string" } },
        name: "one_wallet_request_per_dealer_idempotency_key",
    },
);
walletSchema.index(
    { rollback_of: 1 },
    {
        unique: true,
        partialFilterExpression: { rollback_of: { $type: "objectId" } },
        name: "one_wallet_rollback_per_source_transaction",
    },
);
// A wallet top-up order is an idempotency key. This also protects the
// standalone-Mongo fallback in services/walletTopupService.js.
walletSchema.index(
    { orderId: 1, transaction_type: 1 },
    {
        unique: true,
        partialFilterExpression: { transaction_type: "deposit" },
        name: "one_deposit_ledger_per_order",
    },
);

module.exports = mongoose.model("Wallet", walletSchema);
