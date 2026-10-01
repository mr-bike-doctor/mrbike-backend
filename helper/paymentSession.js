const Payment = require("../models/Payment");
const Booking = require("../models/Booking");
const crypto = require("crypto");
const payu = require("../services/payuService");

const ORDER_LOCK_MS = 60 * 1000;

async function acquirePaymentOrderLock(bookingId) {
  const token = crypto.randomUUID();
  const now = new Date();
  const booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      payment_status: { $ne: "completed" },
      $or: [
        { paymentOrderLockUntil: null },
        { paymentOrderLockUntil: { $exists: false } },
        { paymentOrderLockUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        paymentOrderLockToken: token,
        paymentOrderLockUntil: new Date(now.getTime() + ORDER_LOCK_MS),
      },
    },
    { new: true },
  ).select("+paymentOrderLockToken +paymentOrderLockUntil");

  if (!booking) {
    const error = new Error("A payment order is already being created or payment is complete");
    error.code = "PAYMENT_ORDER_LOCKED";
    throw error;
  }
  return token;
}

async function releasePaymentOrderLock(bookingId, token) {
  if (!token) return;
  await Booking.updateOne(
    { _id: bookingId, paymentOrderLockToken: token },
    { $unset: { paymentOrderLockToken: 1, paymentOrderLockUntil: 1 } },
  );
}

// Close one PENDING payment at PayU before it is retired locally. Throws
// code PAYMENT_ALREADY_PAID when PayU says the attempt was paid. Rows from
// the retired Cashfree integration have no live gateway left to call and
// are closed locally only.
async function terminatePaymentSession(payment) {
  if (payment?.metadata?.gateway !== payu.PAYU_GATEWAY || !payment.orderId) return;
  try {
    await payu.cancelQr(payment.orderId);
  } catch (error) {
    if (error.code === "PAYU_ALREADY_PAID") error.code = "PAYMENT_ALREADY_PAID";
    throw error;
  }
}

/**
 * Cancel any still-PENDING payment sessions for a booking.
 *
 * Called whenever the dealer (re)selects a payment method or generates a
 * fresh QR, so a stale/abandoned order can never be paid later and get
 * mistaken by the webhook for the customer's current, active session.
 * SUCCESS/FAILED/CANCELLED/EXPIRED payments are left untouched.
 *
 * @param {string|ObjectId} bookingId
 * @returns {number} how many pending sessions were cancelled
 */
async function cancelPendingPaymentSessions(bookingId, reason = "payment_method_changed") {
  const pendingPayments = await Payment.find({ booking_id: bookingId, order_status: "PENDING" });
  for (const payment of pendingPayments) {
    await terminatePaymentSession(payment);
    // A row whose own QR lifetime already elapsed is recorded as EXPIRED so
    // the history says what actually happened; anything else we tore down
    // deliberately is CANCELLED. Either way it leaves PENDING, which is what
    // frees the one_pending_payment_per_booking index for the fresh order.
    const expiresAt = new Date(payment.metadata?.expiry_time || 0).getTime();
    const lapsed = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
    payment.order_status = lapsed ? "EXPIRED" : "CANCELLED";
    payment.gateway_status = "TERMINATED";
    payment.metadata = {
      ...payment.metadata,
      cancelled_at: new Date(),
      cancelled_reason: reason,
      gateway_termination_requested: true,
    };
    await payment.save();
  }
  return pendingPayments.length;
}

module.exports = {
  acquirePaymentOrderLock,
  releasePaymentOrderLock,
  terminatePaymentSession,
  cancelPendingPaymentSessions,
};
