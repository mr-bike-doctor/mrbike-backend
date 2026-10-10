const DELIVERY_OTP_TTL_MS = 15 * 60 * 1000;
const MAX_DELIVERY_OTP_ATTEMPTS = 5;
const MAX_DELIVERY_OTP_REGENERATIONS = 5;

function generateDeliveryOtp() {
  return require("crypto").randomInt(1000, 10000);
}

function deliveryOtpExpiry(now = new Date()) {
  return new Date(new Date(now).getTime() + DELIVERY_OTP_TTL_MS);
}

function deliveryOtpState(booking, now = new Date()) {
  if (booking?.deliveryOtp == null) return "MISSING";
  if (!booking.deliveryOtpExpiresAt) return "REGENERATION_REQUIRED";
  if (new Date(booking.deliveryOtpExpiresAt).getTime() <= new Date(now).getTime()) return "EXPIRED";
  return "AVAILABLE";
}

function activeDeliveryOtpFilter({ bookingId, dealerId, paymentMethod, now = new Date() }) {
  const filter = {
    _id: bookingId,
    dealer_id: dealerId,
    status: "ready_for_delivery",
    deliveryOtp: { $ne: null },
    $and: [{
      $or: [
        { otp_failed_attempts: { $lt: MAX_DELIVERY_OTP_ATTEMPTS } },
        { otp_failed_attempts: { $exists: false } },
      ],
    }],
    deliveryTransportStatus: { $ne: "OUT_FOR_DELIVERY" },
  };
  if (paymentMethod === "CASH") filter.deliveryOtpExpiresAt = { $gt: now };
  return filter;
}

async function confirmCashReceipt(Booking, { bookingId, dealerId, otp, now = new Date() }) {
  return Booking.findOneAndUpdate(
    {
      _id: bookingId,
      dealer_id: dealerId,
      status: "payment_selected",
      payment_method: "CASH",
      payment_status: { $ne: "completed" },
      payment_verified: { $ne: true },
    },
    {
      $set: {
        payment_status: "completed",
        payment_verified: true,
        deliveryOtp: otp,
        deliveryOtpExpiresAt: deliveryOtpExpiry(now),
        otp_failed_attempts: 0,
        status: "ready_for_delivery",
        billStatus: "paid",
      },
    },
    { new: true, runValidators: true },
  );
}

async function recordInvalidDeliveryOtp(Booking, { bookingId, dealerId, paymentMethod, storedOtp, now = new Date() }) {
  return Booking.findOneAndUpdate(
    { ...activeDeliveryOtpFilter({ bookingId, dealerId, paymentMethod, now }), deliveryOtp: storedOtp },
    { $inc: { otp_failed_attempts: 1 } },
    { new: true },
  );
}

async function consumeDeliveryOtp(Booking, { bookingId, dealerId, paymentMethod, storedOtp, now = new Date() }) {
  const deliveredAt = new Date(now);
  return Booking.findOneAndUpdate(
    { ...activeDeliveryOtpFilter({ bookingId, dealerId, paymentMethod, now }), deliveryOtp: storedOtp },
    {
      $set: {
        deliveryOtp: null,
        deliveryOtpExpiresAt: null,
        otp_verified: true,
        delivered_at: deliveredAt,
        status: "delivered",
        deliveryTransportStatus: "DELIVERED",
        deliveryTransportCompletedAt: deliveredAt,
        reviewStatus: "pending",
        reviewEligibleAt: deliveredAt,
      },
    },
    { new: true, runValidators: true },
  );
}

async function regenerateDeliveryOtp(Booking, { bookingId, dealerId, otp, expiresAt, resetAttempts = false, now = new Date() }) {
  const set = { deliveryOtp: otp };
  if (expiresAt) set.deliveryOtpExpiresAt = expiresAt;
  if (resetAttempts) set.otp_failed_attempts = 0;
  return Booking.findOneAndUpdate(
    {
      _id: bookingId,
      dealer_id: dealerId,
      status: "ready_for_delivery",
      $or: [
        { otp_regen_count: { $lt: MAX_DELIVERY_OTP_REGENERATIONS } },
        { otp_regen_count: { $exists: false } },
      ],
    },
    {
      $set: set,
      $inc: { otp_regen_count: 1 },
    },
    { new: true, runValidators: true },
  );
}

module.exports = {
  DELIVERY_OTP_TTL_MS,
  MAX_DELIVERY_OTP_ATTEMPTS,
  MAX_DELIVERY_OTP_REGENERATIONS,
  generateDeliveryOtp,
  deliveryOtpExpiry,
  deliveryOtpState,
  activeDeliveryOtpFilter,
  confirmCashReceipt,
  recordInvalidDeliveryOtp,
  consumeDeliveryOtp,
  regenerateDeliveryOtp,
};
