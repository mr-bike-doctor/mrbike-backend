const Payment = require("../models/Payment");
const Booking = require("../models/Booking");
const axios = require("axios");
const crypto = require("crypto");

const CASHFREE_ORDERS_URL = "https://api.cashfree.com/pg/orders";
const CASHFREE_LINKS_URL = "https://api.cashfree.com/pg/links";
const ORDER_LOCK_MS = 60 * 1000;

const cashfreeHeaders = (idempotencyKey) => ({
  "x-client-id": process.env.CASHFREE_APP_ID,
  "x-client-secret": process.env.CASHFREE_SECRET_KEY,
  "x-api-version": process.env.CASHFREE_API_VERSION || "2023-08-01",
  "x-idempotency-key": idempotencyKey,
  "Content-Type": "application/json",
});

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

// Cashfree's 4xx codes for "cannot cancel" are not a fixed set, so we never
// branch on the status. What matters is a single question: is the remote
// resource STILL PAYABLE? A link/order that is already expired, cancelled,
// terminated — or that Cashfree no longer knows about — is exactly the state
// the cleanup wanted, so it has already succeeded.
const PAYABLE_LINK_STATUSES = ["ACTIVE"];
const PAYABLE_ORDER_STATUSES = ["ACTIVE"];
const RESOURCE_GONE = "__GONE__";

// Read the remote state after a cancel/terminate was refused. A 404 means the
// resource does not exist, which is terminal and safe. Anything else is
// unverifiable, so the original refusal is re-thrown by the caller.
async function readRemoteStatus(url, headers, field) {
  try {
    const response = await axios.get(url, { headers });
    return response.data?.[field] || null;
  } catch (error) {
    if (error.response?.status === 404) return RESOURCE_GONE;
    return null;
  }
}

async function terminateCashfreeOrder(payment) {
  if (!payment?.orderId) return;
  const idempotencyHex = crypto
    .createHash("sha256")
    .update(`terminate:${payment.orderId}`)
    .digest("hex");
  const idempotencyKey = `${idempotencyHex.slice(0, 8)}-${idempotencyHex.slice(8, 12)}-4${idempotencyHex.slice(13, 16)}-a${idempotencyHex.slice(17, 20)}-${idempotencyHex.slice(20, 32)}`;
  const headers = cashfreeHeaders(idempotencyKey);

  const isPaymentLink = payment?.metadata?.cashfree_resource === "PAYMENT_LINK";
  const baseUrl = isPaymentLink
    ? `${CASHFREE_LINKS_URL}/${encodeURIComponent(payment.orderId)}`
    : `${CASHFREE_ORDERS_URL}/${encodeURIComponent(payment.orderId)}`;
  const statusField = isPaymentLink ? "link_status" : "order_status";
  const payableStatuses = isPaymentLink ? PAYABLE_LINK_STATUSES : PAYABLE_ORDER_STATUSES;

  let status = null;
  let refusal = null;
  try {
    const response = isPaymentLink
      ? await axios.post(`${baseUrl}/cancel`, {}, { headers })
      : await axios.patch(baseUrl, { order_status: "TERMINATED" }, { headers });
    status = response.data?.[statusField] || null;
  } catch (error) {
    // A transport failure or a 5xx is a genuine outage — surface it. Any 4xx
    // is Cashfree telling us the resource is not in a cancellable state, so
    // ask what state it IS in rather than aborting the whole QR flow. This is
    // the path an already-expired PAYMENT_LINK takes: /links/{id}/cancel
    // answers 400 "Payment request expired.", which used to escape this
    // helper and surface to the dealer app as a 422 on generate-qr.
    const upstreamStatus = error.response?.status;
    if (!upstreamStatus || upstreamStatus >= 500) throw error;
    console.warn("[CASHFREE] Cancel refused, verifying remote state", {
      orderId: payment.orderId,
      resource: isPaymentLink ? "PAYMENT_LINK" : "PG_ORDER",
      status: upstreamStatus,
      code: error.response?.data?.code,
      type: error.response?.data?.type,
      message: error.response?.data?.message,
    });
    refusal = error;
    status = await readRemoteStatus(baseUrl, headers, statusField);
  }

  if (status === "PAID") {
    const error = new Error(
      `Cashfree ${isPaymentLink ? "payment link" : "order"} ${payment.orderId} is already paid`,
    );
    error.code = "CASHFREE_ORDER_ALREADY_PAID";
    throw error;
  }
  // Gone, expired, cancelled, terminated, termination-requested: not payable,
  // so the cleanup is done and a fresh order may be minted.
  if (status === RESOURCE_GONE) return;
  if (status && !payableStatuses.includes(status)) return;
  // Either Cashfree still considers it payable, or we could not read its
  // state at all. Both are unsafe — two live payables for one booking.
  if (refusal) throw refusal;
  throw new Error(`Cashfree did not cancel ${payment.orderId} (status: ${status || "unknown"})`);
}

/**
 * Cancel any still-PENDING Cashfree payment sessions for a booking.
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
    await terminateCashfreeOrder(payment);
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
      cashfree_termination_requested: true,
    };
    await payment.save();
  }
  return pendingPayments.length;
}

module.exports = {
  acquirePaymentOrderLock,
  releasePaymentOrderLock,
  terminateCashfreeOrder,
  cancelPendingPaymentSessions,
  __testing: { readRemoteStatus, RESOURCE_GONE },
};
