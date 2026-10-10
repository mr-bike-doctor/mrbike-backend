const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  dealerId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },
  scheduleDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  timeSlot: { type: String, required: true, trim: true, maxlength: 80 },
  capacity: { type: Number, required: true, min: 1, validate: Number.isInteger },
  reservedCount: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
  active: { type: Boolean, default: true, required: true },
}, { timestamps: true, optimisticConcurrency: true, id: false });

schema.index({ dealerId: 1, scheduleDate: 1, timeSlot: 1 }, { unique: true });
module.exports = mongoose.models.GarageSlotCapacity || mongoose.model("GarageSlotCapacity", schema);
