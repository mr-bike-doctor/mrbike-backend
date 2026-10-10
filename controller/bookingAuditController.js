const mongoose = require("mongoose");
const AdminBookingAudit = require("../models/AdminBookingAudit");

async function getBookingAuditHistory(req, res) {
  const { bookingId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    return res.status(400).json({ success: false, message: "Invalid booking ID" });
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  try {
    const filter = { bookingId };
    const [data, total] = await Promise.all([
      AdminBookingAudit.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AdminBookingAudit.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      data,
      meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error("Booking audit history read failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to retrieve booking audit history" });
  }
}

module.exports = { getBookingAuditHistory };
