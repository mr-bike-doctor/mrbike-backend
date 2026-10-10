const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
  dealerId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },
  scheduleDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  timeSlot: { type: String, required: true, trim: true, maxlength: 80 },
}, { timestamps: true });

schema.index({ bookingId: 1 }, { unique: true });
schema.index({ dealerId: 1, scheduleDate: 1, timeSlot: 1 });
module.exports = mongoose.models.BookingSlotReservation || mongoose.model("BookingSlotReservation", schema);
