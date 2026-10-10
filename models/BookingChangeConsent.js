const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "customers", required: true, index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "admin", required: true },
  adminRole: { type: String, required: true, maxlength: 40 },
  reason: { type: String, required: true, maxlength: 500 },
  changes: { type: mongoose.Schema.Types.Mixed, required: true },
  changesHash: { type: String, required: true, maxlength: 64 },
  expectedUpdatedAt: { type: Date, required: true },
  pricePreview: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ["pending", "approved", "rejected", "applied", "expired"], default: "pending", index: true },
  createdAt: { type: Date, default: Date.now, required: true },
  expiresAt: { type: Date, required: true, index: true },
  respondedAt: { type: Date, default: null },
}, { versionKey: false, strict: true });

schema.index({ bookingId: 1, customerId: 1, status: 1, createdAt: -1 });
module.exports = mongoose.models.BookingChangeConsent || mongoose.model("BookingChangeConsent", schema);
