const mongoose = require("mongoose");

const adminBookingAuditSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "admin", required: true, index: true },
  adminRole: { type: String, required: true, maxlength: 40 },
  action: { type: String, required: true, maxlength: 100 },
  reason: { type: String, required: true, maxlength: 500 },
  occurredAt: { type: Date, required: true, default: Date.now, index: true },
  before: { type: mongoose.Schema.Types.Mixed, default: {} },
  after: { type: mongoose.Schema.Types.Mixed, default: {} },
  approvalReference: { type: String, default: null, maxlength: 200 },
  consentReference: { type: String, default: null, maxlength: 200 },
  requestId: { type: String, required: true, maxlength: 128, index: true },
}, { versionKey: false, strict: true });

for (const path of Object.keys(adminBookingAuditSchema.paths)) {
  if (path !== "_id") adminBookingAuditSchema.path(path).immutable(true);
}

adminBookingAuditSchema.index({ bookingId:  1, occurredAt: -1, _id: -1 });

const IMMUTABLE_ERROR = new Error("Booking audit records are append-only");
adminBookingAuditSchema.pre("save", function (next) {
  if (!this.isNew) return next(IMMUTABLE_ERROR);
  next();
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  adminBookingAuditSchema.pre(operation, function (next) { next(IMMUTABLE_ERROR); });
}
adminBookingAuditSchema.pre("remove", function (next) { next(IMMUTABLE_ERROR); });
adminBookingAuditSchema.pre("deleteOne", { document: true, query: false }, function (next) { next(IMMUTABLE_ERROR); });
adminBookingAuditSchema.pre("bulkWrite", function (next) { next(IMMUTABLE_ERROR); });

module.exports = mongoose.models.AdminBookingAudit || mongoose.model("AdminBookingAudit", adminBookingAuditSchema);
