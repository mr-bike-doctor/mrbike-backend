const axios = require("axios")
const QRCode = require("qrcode")
const Payment = require("../models/Payment")
const Booking = require("../models/Booking")
const Customer = require("../models/customer_model")
const Dealer = require("../models/dealerModel")
const { generateBill } = require("./payment")
const { settleBookingWallet } = require("../helper/walletSettlement")
const { sendBookingNotification } = require("../helper/pushNotification")
const {
  acquirePaymentOrderLock,
  releasePaymentOrderLock,
  cancelPendingPaymentSessions,
  terminateCashfreeOrder,
} = require("../helper/paymentSession")
const softpos = require("../services/cashfreeSoftposService")
const { CASHFREE_RESOURCE_SOFTPOS_QR } = softpos
const {
  enqueuePaymentReconciliation,
  completeReconciliationTask,
} = require("../services/paymentReconciliationService")

const genDeliveryOtp = () => Math.floor(1000 + Math.random() * 9000)

const QR_DATA_URI_PREFIX = "data:image/png;base64,"
// Legacy booking payments from the window where the QR encoded a Cashfree
// Payment Link URL. Kept only so historical rows stay readable and
// checkable — nothing new is ever created with this resource type.
const CASHFREE_RESOURCE_PAYMENT_LINK = "PAYMENT_LINK"
// Legacy booking payments: a PG order paid through Order Pay's UPI "qrcode"
// channel. Also read-only now — new attempts are SOFTPOS_QR (see
// services/cashfreeSoftposService.js). Historical rows keep their status,
// webhook and cancel paths.
const CASHFREE_RESOURCE_PG_ORDER = "PG_ORDER"
const AMOUNT_TOLERANCE = 0.01

// Cashfree's session/payments APIs are inconsistent about whether
// payload.qrcode / default_qr_code is pure base64 or already a full data
// URI — normalize once here so we never double-prepend the prefix.
const normalizeQrCode = (value) => {
  if (!value) return { qrCodeDataUrl: null, qrCodeBase64: null }
  const base64 = value.startsWith(QR_DATA_URI_PREFIX) ? value.slice(QR_DATA_URI_PREFIX.length) : value
  return { qrCodeDataUrl: `${QR_DATA_URI_PREFIX}${base64}`, qrCodeBase64: base64 }
}

const isPaymentLink = (payment) =>
  payment?.metadata?.cashfree_resource === CASHFREE_RESOURCE_PAYMENT_LINK

const isSoftposQr = (payment) =>
  payment?.metadata?.cashfree_resource === CASHFREE_RESOURCE_SOFTPOS_QR

const getQrExpiryMinutes = () => {
  const configured = Number.parseInt(process.env.CASHFREE_QR_EXPIRY_MINUTES, 10)
  return Number.isFinite(configured) && configured > 0 ? configured : 30
}

// Cashfree stores timestamps in IST and accepts any valid ISO 8601 value.
// Emit the documented offset form ("2021-07-02T10:20:12+05:30") rather than a
// bare "...Z" so there is no room for a UTC instant to be read as IST — that
// would put the expiry 5h30m in the past and the order would be born expired.
const buildExpiryIso = (minutesFromNow) => {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
  const target = new Date(Date.now() + minutesFromNow * 60 * 1000)
  return `${new Date(target.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`
}

const isExpired = (payment) => {
  const expiry = new Date(payment?.metadata?.expiry_time || 0).getTime()
  return !Number.isFinite(expiry) || expiry <= Date.now()
}

// Cashfree is the authority on what was paid; the booking is the authority on
// what was owed. A confirmation whose amount does not match the order must
// never advance a booking — it is a reconciliation case, not a payment.
const amountMatches = (expected, actual) => {
  const expectedNumber = Number(expected)
  const actualNumber = Number(actual)
  if (!Number.isFinite(expectedNumber) || !Number.isFinite(actualNumber)) return false
  return Math.abs(expectedNumber - actualNumber) <= AMOUNT_TOLERANCE
}

const mapCashfreeStatus = (status) => {
  switch (String(status || "").toUpperCase()) {
    case "PAID":
    case "SUCCESS":
      return "SUCCESS"
    case "EXPIRED":
      return "EXPIRED"
    case "FAILED":
      return "FAILED"
    case "CANCELLED":
    case "TERMINATED":
    case "TERMINATION_REQUESTED":
      return "CANCELLED"
    default:
      return "PENDING"
  }
}

// Advance a booking to ready_for_delivery once its QR/UPI payment is confirmed
// SUCCESS — mirrors confirmCashReceived so both payment methods land in the
// same place: invoice generated, wallet settled, delivery OTP issued.
//
// The atomic update is deliberately the first state-changing operation. A
// status poll and a webhook can arrive together; only the caller that claims
// payment_verified:false may issue an OTP, invoice, or wallet settlement.
const advanceBookingAfterOnlinePayment = async (payment, io) => {
  const freshOtp = genDeliveryOtp()
  const currentBooking = await Booking.findOneAndUpdate(
    {
      _id: payment.booking_id,
      status: "payment_selected",
      payment_verified: { $ne: true },
      $or: [{ payment_method: "ONLINE" }, { payment_method: null }, { payment_method: { $exists: false } }],
    },
    {
      $set: {
        payment_method: "ONLINE",
        payment_status: "completed",
        payment_verified: true,
        deliveryOtp: freshOtp,
        status: "ready_for_delivery",
        billStatus: "paid",
        paymentStatus: "completed",
        paymentDate: new Date(),
      },
    },
    { new: true },
  )

  if (!currentBooking) {
    console.log(`[CASHFREE] Booking ${payment.booking_id} was already finalized or its payment method changed; skipping duplicate confirmation.`)
    return false
  }

  await enqueuePaymentReconciliation(payment)
  await completeReconciliationTask(payment, "BOOKING_SYNC")

  console.log(`[CASHFREE] Booking ${payment.booking_id} → ready_for_delivery | OTP: ${freshOtp}`)

  try {
    await generateBill({
      booking_id: payment.booking_id,
      payment_method: payment.payment_method || "ONLINE",
      transaction_id: payment.transaction_id || payment.cf_order_id || null,
      _id: payment._id,
    })
    await completeReconciliationTask(payment, "INVOICE")
  } catch (billErr) {
    console.error("[CASHFREE] Bill generation failed:", billErr.message)
  }

  try {
    const settlement = await settleBookingWallet(currentBooking._id, "ONLINE")
    if (settlement) {
      console.log(`[CASHFREE] Wallet settled: ₹${settlement.txnAmount} credited (commission ${settlement.commissionRate}%)`)
    }
    await completeReconciliationTask(payment, "WALLET")
  } catch (settlErr) {
    console.error("[CASHFREE] Wallet settlement failed:", settlErr.message)
  }

  try {
    const user = await Customer.findById(currentBooking.user_id).select("device_token ftoken").lean()
    const userToken = user?.device_token || user?.ftoken
    if (userToken) {
      await sendBookingNotification({
        token: userToken,
        title: "Payment Received — Show OTP to Dealer",
        body: "Your payment has been confirmed. Show the OTP to the dealer to collect your bike.",
        data: {
          type: "otp_ready",
          bookingId: currentBooking._id.toString(),
          otp: String(freshOtp),
        },
        receiverId: currentBooking.user_id,
        receiverType: "user",
        bookingId: currentBooking._id,
      })
    }
    await completeReconciliationTask(payment, "NOTIFICATION")
  } catch (notifyErr) {
    console.error("[CASHFREE] User FCM error:", notifyErr.message)
  }

  if (io) {
    io.to(`user:${currentBooking.user_id}`).emit("booking:ready_for_delivery", {
      bookingId: currentBooking._id,
      status: "ready_for_delivery",
    })
  }
  return true
}

// Cashfree API Configuration
const getCashfreeBaseUrl = () =>
  (process.env.CASHFREE_BASE_URL || "https://api.cashfree.com/pg").replace(/\/+$/, "");

const getCashfreeApiVersion = () => process.env.CASHFREE_API_VERSION || "2023-08-01";

const getCashfreeHeaders = (additionalHeaders = {}) => ({
  "x-client-id": process.env.CASHFREE_APP_ID,
  "x-client-secret": process.env.CASHFREE_SECRET_KEY,
  "x-api-version": getCashfreeApiVersion(),
  "Content-Type": "application/json",
  ...additionalHeaders,
});

const sanitizeCashfreeError = (error) =>
  error.response?.data?.message ||
  error.response?.data?.type ||
  error.response?.data?.code ||
  error.message

const getVerifiedPaymentDetails = async (orderId, fallback = {}) => {
  try {
    const response = await axios.get(
      `${getCashfreeBaseUrl()}/orders/${encodeURIComponent(orderId)}/payments`,
      { headers: getCashfreeHeaders() },
    )
    const payments = Array.isArray(response.data) ? response.data : response.data?.data || []
    return payments.find((item) => item.payment_status === "SUCCESS") || payments[0] || fallback
  } catch (error) {
    console.error("[CASHFREE] Unable to fetch verified payment details", {
      orderId,
      message: error.response?.data?.message || error.message,
    })
    return fallback
  }
}

const getCashfreePaymentLink = async (linkId) => {
  const response = await axios.get(
    // Cashfree links create one or more underlying PG orders. The documented
    // orders endpoint is the authoritative way to verify a link payment; a
    // link can stay ACTIVE after failed attempts, so link state alone is not
    // enough to mark a booking paid.
    `${getCashfreeBaseUrl()}/links/${encodeURIComponent(linkId)}/orders`,
    { headers: getCashfreeHeaders() },
  )
  const orders = Array.isArray(response.data) ? response.data : response.data?.data || []
  const successfulOrder = orders.find((item) => item?.order_status === "PAID")
  const latestOrder = successfulOrder || orders[0] || null
  return {
    link_status: successfulOrder ? "PAID" : "ACTIVE",
    order_amount: latestOrder?.order_amount,
    cf_order_id: latestOrder?.cf_order_id,
    cf_payment_id: latestOrder?.cf_payment_id,
    payment_group: latestOrder?.payment_group,
    bank_reference: latestOrder?.bank_reference,
  }
}

const PAYMENT_METHOD_VALUES = ["card", "netbanking", "upi", "wallet", "emi", "qrcode"]

/**
 * Server-side verdict on one SOFTPOS_QR attempt, shared by the status poll,
 * the webhook and generate-qr. Cashfree's Orders API is the only source of
 * truth; nothing a client or a webhook body says is trusted.
 *
 * Returns { state, isPaid } where state is one of
 *   PAID     — Cashfree order PAID (isPaid only if every amount check passed)
 *   PENDING  — QR still live and payable
 *   EXPIRED  — QR timeout passed (order may still be ACTIVE until retired)
 *   FAILED   — the terminal transaction failed / was dropped
 *   CLOSED   — Cashfree order itself expired/terminated
 *
 * A PENDING row is never moved to EXPIRED/CANCELLED here while Cashfree still
 * reports the order ACTIVE: a late UPI confirmation must still land on a
 * PENDING row and complete the booking. Retiring a live-but-dead attempt is
 * done only by cancelPendingPaymentSessions, which terminates the order at
 * Cashfree first and refuses if it turns out to be PAID.
 */
const reconcileSoftposPayment = async (payment, io) => {
  const order = await softpos.fetchOrder(payment.orderId)
  const orderStatus = String(order.order_status || "").toUpperCase()
  const now = new Date()
  const baseMeta = {
    "metadata.last_status_check": now,
    "metadata.cashfree_status": orderStatus || null,
  }

  if (orderStatus === "PAID") {
    const payments = await softpos.fetchOrderPayments(payment.orderId)
    const successful = payments.find((item) => item?.payment_status === "SUCCESS")
    if (!successful) {
      // PAID order without a SUCCESS payment is not something we act on.
      await Payment.updateOne({ _id: payment._id }, { $set: baseMeta })
      return { state: "PENDING", isPaid: false }
    }

    // Money owed is decided by the booking, not by the order we created and
    // not by Cashfree: all three must agree before the booking advances.
    const booking = await Booking.findById(payment.booking_id).select("customerTotal discountAmount")
    const paidAmount = Number(successful.payment_amount)
    const amountVerified =
      amountMatches(payment.orderAmount, paidAmount) &&
      amountMatches(payment.orderAmount, order.order_amount) &&
      Boolean(booking) &&
      amountMatches(booking.amountDue, paidAmount)

    const wasRetired = ["CANCELLED", "EXPIRED", "FAILED"].includes(payment.order_status)
    const paymentGroup = String(successful.payment_group || "").toLowerCase()
    const verifiedFields = {
      order_status: "SUCCESS",
      cf_payment_id: successful.cf_payment_id != null ? String(successful.cf_payment_id) : payment.cf_payment_id,
      transaction_id: successful.cf_payment_id != null ? String(successful.cf_payment_id) : payment.transaction_id,
      utr_number: successful.bank_reference || null,
      payment_method: PAYMENT_METHOD_VALUES.includes(paymentGroup) ? paymentGroup : "upi",
      gateway_status: "SUCCESS",
      verified_amount: paidAmount,
      verified_timestamp: now,
      ...baseMeta,
      "metadata.verified_via": "orders_api",
      "metadata.verified_at": now,
      "metadata.softpos_txn_status": "SUCCESS",
      ...(successful.cf_payment_id != null && String(successful.cf_payment_id) !== String(payment.metadata?.cf_payment_id || "")
        ? { "metadata.paid_cf_payment_id_differs": true }
        : {}),
      ...(amountVerified ? {} : { "metadata.amount_mismatch": true, "metadata.amount_mismatch_at": now }),
      ...(wasRetired ? { "metadata.orphaned_after_method_switch": true } : {}),
    }

    // Claim the PENDING → SUCCESS transition atomically. A concurrent webhook
    // and poll both land here; the unique one_successful_payment_per_booking
    // index additionally forbids a second SUCCESS row for the booking.
    let claimed = null
    try {
      claimed = await Payment.findOneAndUpdate(
        { _id: payment._id, order_status: { $ne: "SUCCESS" } },
        { $set: verifiedFields },
        { new: true },
      )
    } catch (error) {
      if (error?.code !== 11000) throw error
      console.error(
        `[CASHFREE_SOFTPOS] Booking ${payment.booking_id} already has a SUCCESS payment; ${payment.orderId} flagged for reconciliation (possible double payment).`,
      )
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { ...baseMeta, "metadata.duplicate_paid_attempt": true, "metadata.verified_amount": paidAmount } },
      )
      return { state: "PAID", isPaid: false }
    }
    const current = claimed || (await Payment.findById(payment._id))

    if (wasRetired) {
      console.warn(
        `[CASHFREE_SOFTPOS] ${payment.orderId} was PAID after being retired — flagged for manual reconciliation, booking not auto-advanced.`,
      )
      return { state: "PAID", isPaid: false }
    }
    if (!amountVerified || current?.metadata?.amount_mismatch === true) {
      console.error(
        `[CASHFREE_SOFTPOS] Amount mismatch on ${payment.orderId} (booking ${payment.booking_id}): order ₹${payment.orderAmount}, due ₹${booking?.amountDue}, paid ₹${paidAmount} — booking NOT advanced.`,
      )
      return { state: "PAID", isPaid: false }
    }

    // Idempotent: only the caller that flips payment_verified advances it.
    // Re-running it after a crash between the two writes is what finishes
    // a half-processed confirmation.
    await advanceBookingAfterOnlinePayment(current, io)
    return { state: "PAID", isPaid: true }
  }

  if (orderStatus === "ACTIVE") {
    let txnStatus = null
    try {
      const payments = await softpos.fetchOrderPayments(payment.orderId)
      const ours =
        payments.find((item) => String(item?.cf_payment_id) === String(payment.metadata?.cf_payment_id)) ||
        payments[0]
      txnStatus = ours?.payment_status ? String(ours.payment_status).toUpperCase() : null
    } catch (lookupError) {
      console.error("[CASHFREE_SOFTPOS] Could not read order payments", {
        orderId: payment.orderId,
        message: sanitizeCashfreeError(lookupError),
      })
    }
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { ...baseMeta, ...(txnStatus ? { "metadata.softpos_txn_status": txnStatus } : {}) } },
    )
    if (txnStatus && softpos.DEAD_TRANSACTION_STATUSES.includes(txnStatus)) return { state: "FAILED", isPaid: false }
    if (isExpired(payment)) return { state: "EXPIRED", isPaid: false }
    return { state: "PENDING", isPaid: false }
  }

  // Cashfree says the order can no longer be paid, so a PENDING row may be
  // closed locally without risk of hiding a payment.
  const localStatus = orderStatus === "EXPIRED" ? "EXPIRED" : mapCashfreeStatus(orderStatus)
  const closedStatus = localStatus === "PENDING" ? null : localStatus
  await Payment.updateOne(
    { _id: payment._id, order_status: "PENDING" },
    { $set: { ...baseMeta, ...(closedStatus ? { order_status: closedStatus, gateway_status: orderStatus } : {}) } },
  )
  return closedStatus ? { state: "CLOSED", isPaid: false } : { state: "PENDING", isPaid: false }
}

const softposResponseData = (payment, extra = {}) => ({
  order_id: payment.orderId,
  cf_order_id: payment.cf_order_id || null,
  cf_payment_id: payment.metadata?.cf_payment_id || null,
  payment_id: payment._id,
  payment_attempt: payment.payment_attempt,
  amount: payment.orderAmount,
  currency: "INR",
  qr_code: payment.metadata?.qr_code || null,
  expiry_time: payment.metadata?.expiry_time || null,
  timeout_ms: payment.metadata?.softpos_timeout_ms || null,
  cashfree_resource: CASHFREE_RESOURCE_SOFTPOS_QR,
  status: "PENDING",
  booking_id: payment.booking_id,
  ...extra,
})

/**
 * Mint one SOFTPOS_QR attempt. The local row is written FIRST with its
 * deterministic order id, so a crash or network loss at any later step leaves
 * a PENDING row that the next request will terminate at Cashfree before it
 * may create attempt N+1 — never an untracked payable order.
 */
const createSoftposAttempt = async ({ booking, bookingId, amount, customerDetails, terminal }) => {
  const latest = await Payment.findOne({
    booking_id: bookingId,
    "metadata.cashfree_resource": CASHFREE_RESOURCE_SOFTPOS_QR,
  })
    .sort({ payment_attempt: -1 })
    .select("payment_attempt")
    .lean()
  const attempt = (Number(latest?.payment_attempt) || 0) + 1
  const orderId = softpos.buildSoftposOrderId(bookingId, attempt)
  const orderExpiryIso = buildExpiryIso(getQrExpiryMinutes())

  const payment = await Payment.create({
    orderId,
    booking_id: bookingId,
    dealer_id: booking.dealer_id?._id,
    user_id: booking.user_id?._id,
    orderAmount: Number(amount),
    payment_type: "UPI_QR",
    order_currency: "INR",
    order_status: "PENDING",
    payment_by: "user",
    payment_attempt: attempt,
    cf_terminal_id: String(terminal.cfTerminalId),
    metadata: {
      cashfree_resource: CASHFREE_RESOURCE_SOFTPOS_QR,
      cf_terminal_id: String(terminal.cfTerminalId),
      payment_attempt: attempt,
      softpos_stage: "CREATING_ORDER",
      // Provisional: replaced by the terminal transaction's own timeout.
      expiry_time: orderExpiryIso,
    },
  })

  try {
    const order = await softpos.createSoftposOrder({
      orderId,
      amount,
      bookingId,
      bookingRef: booking.bookingId,
      dealerId: booking.dealer_id?._id,
      customerDetails,
      expiryIso: orderExpiryIso,
      terminal,
    })
    if (!order.cf_order_id) {
      const missing = new Error("Cashfree did not return cf_order_id")
      missing.code = "CASHFREE_ORDER_CREATE_FAILED"
      throw missing
    }
    payment.cf_order_id = String(order.cf_order_id)
    payment.metadata = {
      ...payment.metadata,
      cf_order_id: String(order.cf_order_id),
      order_expiry_time: order.order_expiry_time || orderExpiryIso,
      softpos_stage: "CREATING_TRANSACTION",
    }
    await payment.save()

    const txn = await softpos.createTerminalQrTransaction({ cfOrderId: order.cf_order_id, orderId, terminal })
    if (txn.paymentAmount != null && !amountMatches(amount, txn.paymentAmount)) {
      const mismatch = new Error(
        `Cashfree softPOS QR amount ₹${txn.paymentAmount} does not match booking amount ₹${amount}`,
      )
      mismatch.code = "CASHFREE_QR_UNAVAILABLE"
      throw mismatch
    }

    // The QR lives for Cashfree's `timeout`, never past the order itself.
    const orderExpiryMs = new Date(order.order_expiry_time || orderExpiryIso).getTime()
    const txnExpiryMs = txn.timeoutMs ? Date.now() + txn.timeoutMs : orderExpiryMs
    const expiresAt = new Date(Math.min(txnExpiryMs, orderExpiryMs))

    payment.cf_payment_id = txn.cfPaymentId
    payment.expires_at = expiresAt
    payment.metadata = {
      ...payment.metadata,
      cf_payment_id: txn.cfPaymentId,
      qr_code: txn.qrcode,
      qr_source: "softpos_terminal_transaction",
      qr_generated_at: new Date(),
      softpos_timeout_ms: txn.timeoutMs,
      softpos_payment_amount: txn.paymentAmount,
      softpos_stage: "QR_ISSUED",
      expiry_time: expiresAt.toISOString(),
    }
    await payment.save()
    return payment
  } catch (error) {
    // Close whatever may exist remotely. Only once Cashfree confirms the
    // order is not payable may the row leave PENDING; otherwise it stays
    // PENDING and the next generate-qr retries the termination first.
    try {
      await terminateCashfreeOrder({ orderId })
      await Payment.updateOne(
        { _id: payment._id, order_status: "PENDING" },
        {
          $set: {
            order_status: "FAILED",
            gateway_status: "TERMINATED",
            "metadata.failure_reason": error.message,
            "metadata.failed_at": new Date(),
          },
        },
      )
    } catch (cleanupError) {
      console.error("[CASHFREE_SOFTPOS] Could not close failed attempt; left PENDING for retry", {
        orderId,
        message: cleanupError.message,
      })
      if (cleanupError.code === "CASHFREE_ORDER_ALREADY_PAID") throw cleanupError
    }
    throw error
  }
}

/**
 * Generate UPI QR Code for Payment
 * Called by Dealer App after booking is confirmed
 * Flow: Dealer generates QR -> User scans with any UPI app -> Payment completed
 */
const generateUPIQRCode = async (req, res) => {
  let paymentOrderLockToken = null
  let lockedBookingId = null
  try {
    // `amount` is intentionally NOT read from req.body — the server is the
    // only authority on what a booking costs. See services/pricingEngine.js.
    const { booking_id, customer_email, customer_phone, customer_name } = req.body
    // The dealer pressing "Generate New QR" is the only thing that discards a
    // live QR; simply re-opening the screen must not.
    const force = req.body.force === true || req.body.force === "true"

    // Validation
    if (!booking_id) {
      return res.status(400).json({
        success: false,
        message: "booking_id is required",
      })
    }

    // Get booking details
    const booking = await Booking.findById(booking_id)
      .populate("user_id", "first_name last_name email phone")
      .populate("dealer_id", "name email")

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      })
    }

    // Entry-point guard — the dealer must have selected ONLINE via
    // /bookings/:bookingId/select-payment-method before a QR can be generated.
    if (booking.payment_method !== "ONLINE" || booking.status !== "payment_selected") {
      return res.status(400).json({
        success: false,
        message: "Select ONLINE payment method via /bookings/:bookingId/select-payment-method before generating a QR",
      })
    }

    // Server always charges Booking.customerTotal - Booking.discountAmount
    // (the `amountDue` virtual) — never a client-supplied amount.
    const amount = booking.amountDue
    if (!(amount >= 1)) {
      return res.status(400).json({
        success: false,
        message: "Booking has no amount due — pricing snapshot missing or already fully discounted",
      })
    }

    lockedBookingId = booking_id
    paymentOrderLockToken = await acquirePaymentOrderLock(booking_id)

    // Check if payment already exists and is successful
    const existingPayment = await Payment.findOne({
      booking_id: booking_id,
      order_status: "SUCCESS",
    })

    if (existingPayment) {
      return res.status(400).json({
        success: false,
        message: "Payment already completed for this booking",
      })
    }

    const terminal = softpos.getSoftposTerminalConfig()
    if (!terminal) {
      console.error("[CASHFREE_SOFTPOS] CASHFREE_SOFTPOS_TERMINAL_ID is not configured")
      return res.status(503).json({
        success: false,
        code: "SOFTPOS_TERMINAL_NOT_CONFIGURED",
        message: "UPI QR payments are not configured yet. Please collect cash or try again later.",
      })
    }

    // Reuse before re-mint. The dealer app opens this screen on every mount;
    // a live SOFTPOS_QR attempt is handed back as-is. `force` is honoured only
    // once the current QR is verifiably dead — a still-payable QR is never
    // replaced while the customer might be scanning it.
    const pending = await Payment.findOne({ booking_id: booking_id, order_status: "PENDING" })
    if (pending && pending.metadata?.cashfree_resource === CASHFREE_RESOURCE_SOFTPOS_QR) {
      let verdict
      try {
        verdict = await reconcileSoftposPayment(pending, req.app.get("io"))
      } catch (verifyError) {
        // 404: the attempt never reached Cashfree (crash before create-order
        // landed). Nothing is payable, so the retire step below may close it.
        // Anything else is unverifiable — never mint over it.
        if (verifyError.response?.status !== 404) {
          console.error("[CASHFREE_SOFTPOS] Could not verify the existing attempt", {
            orderId: pending.orderId,
            message: sanitizeCashfreeError(verifyError),
          })
          const blocked = new Error("Could not verify the current QR with Cashfree. Please check status again.")
          blocked.code = "CASHFREE_CLEANUP_FAILED"
          throw blocked
        }
        verdict = { state: "CLOSED", isPaid: false }
      }

      if (verdict.state === "PAID") {
        const fresh = await Payment.findById(pending._id)
        return res.status(200).json({
          success: true,
          message: verdict.isPaid ? "Payment already received" : "Payment received — pending reconciliation",
          data: softposResponseData(fresh, { status: "SUCCESS", is_paid: verdict.isPaid, qr_code: null }),
        })
      }
      if (
        verdict.state === "PENDING" &&
        pending.metadata?.qr_code &&
        amountMatches(amount, pending.orderAmount)
      ) {
        if (force) {
          console.log(`[CASHFREE_SOFTPOS] force ignored — ${pending.orderId} is still live`)
        }
        return res.status(200).json({
          success: true,
          message: "Existing UPI QR reused",
          data: softposResponseData(pending, { reused: true }),
        })
      }
    }

    // Retire whatever PENDING attempt remains (expired/failed SOFTPOS_QR, or a
    // historical PG_ORDER / PAYMENT_LINK row). terminateCashfreeOrder closes
    // it at Cashfree first and refuses if Cashfree says it was PAID, so a
    // successful payment is never cancelled here.
    try {
      await cancelPendingPaymentSessions(booking_id, "qr_regenerated")
    } catch (cleanupError) {
      if (cleanupError.code === "CASHFREE_ORDER_ALREADY_PAID") throw cleanupError
      console.error("[CASHFREE] Could not retire the previous payment attempt", {
        bookingId: booking_id,
        status: cleanupError.response?.status,
        code: cleanupError.response?.data?.code,
        type: cleanupError.response?.data?.type,
        message: cleanupError.response?.data?.message || cleanupError.message,
      })
      const blocked = new Error(
        `The previous payment attempt is still live and could not be closed: ${sanitizeCashfreeError(cleanupError)}`,
      )
      blocked.code = "CASHFREE_CLEANUP_FAILED"
      throw blocked
    }

    // Customer details from booking or request
    const customerDetails = {
      customer_id: booking.user_id?._id?.toString() || `CUST_${Date.now()}`,
      customer_email: customer_email || booking.user_id?.email || "customer@bikedoctor.com",
      customer_phone: customer_phone || booking.user_id?.phone || "9999999999",
      customer_name:
        customer_name ||
        `${booking.user_id?.first_name || ""} ${booking.user_id?.last_name || ""}`.trim() ||
        "Customer",
    }

    const payment = await createSoftposAttempt({
      booking,
      bookingId: booking_id,
      amount,
      customerDetails,
      terminal,
    })
    console.log("[CASHFREE_SOFTPOS] QR issued", {
      paymentId: String(payment._id),
      orderId: payment.orderId,
      cf_order_id: payment.cf_order_id,
      cf_payment_id: payment.cf_payment_id,
      attempt: payment.payment_attempt,
      expires_at: payment.metadata?.expiry_time,
    })

    // Pricing fields are never touched here; they were fixed at booking
    // creation (services/pricingEngine.js).
    await Booking.findByIdAndUpdate(booking_id, {
      $set: {
        billStatus: "pending",
      },
    })

    res.status(200).json({
      success: true,
      message: "UPI QR Code generated successfully",
      data: softposResponseData(payment, {
        reused: false,
        customer: {
          name: customerDetails.customer_name,
          phone: customerDetails.customer_phone,
        },
      }),
    })
  } catch (error) {
    console.error("Generate UPI QR Error:", error.response?.data || error.message)

    if (error.code === "PAYMENT_ORDER_LOCKED" || error.code === "CASHFREE_ORDER_ALREADY_PAID") {
      return res.status(409).json({
        success: false,
        message: error.message,
      })
    }
    // Cashfree refused to produce a Dynamic UPI QR. Surface the real reason
    // to the dealer app — there is no hosted-checkout substitute.
    if (
      error.code === "CASHFREE_QR_UNAVAILABLE" ||
      error.code === "CASHFREE_SESSION_MISSING" ||
      error.code === "CASHFREE_ORDER_CREATE_FAILED" ||
      error.code === "CASHFREE_CLEANUP_FAILED"
    ) {
      return res.status(502).json({
        success: false,
        code: error.code,
        message: error.message || "Cashfree could not generate a UPI QR. Please try again or collect cash.",
      })
    }
    // Return Cashfree's validation message to the authenticated dealer app so
    // a configuration/validation failure is diagnosable, without exposing
    // credentials or the upstream response body.
    // The upstream text is kept as detail, never as the whole message: a
    // gateway phrase such as "Payment request expired." read as this
    // endpoint's own verdict is what made a recoverable cleanup failure look
    // like a dead booking to the dealer app.
    const upstreamMessage = error.response?.data?.message || error.response?.data?.type
    res.status(error.response?.status >= 400 && error.response?.status < 500 ? 422 : 500).json({
      success: false,
      message: upstreamMessage
        ? `Failed to generate UPI QR Code: ${upstreamMessage}`
        : "Failed to generate UPI QR Code",
    })
  } finally {
    if (paymentOrderLockToken && lockedBookingId) {
      await releasePaymentOrderLock(lockedBookingId, paymentOrderLockToken).catch((lockError) => {
        console.error("[CASHFREE] Failed to release payment order lock", { message: lockError.message })
      })
    }
  }
}

/**
 * Check Payment Status
 * Called by Dealer App to poll payment status after QR is shown
 */
const checkPaymentStatus = async (req, res) => {
  try {
    const { order_id } = req.params

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "order_id is required",
      })
    }

    const payment = await Payment.findOne({ orderId: order_id })
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" })
    }

    if (isSoftposQr(payment)) {
      const verdict = await reconcileSoftposPayment(payment, req.app.get("io"))
      const fresh = await Payment.findById(payment._id)
      // Same response shape the dealer app already understands; order_status
      // is the attempt's state, not Cashfree's raw ACTIVE for a dead QR.
      const appStatus = {
        PAID: "PAID",
        PENDING: "ACTIVE",
        EXPIRED: "EXPIRED",
        FAILED: "FAILED",
        CLOSED: fresh?.order_status === "EXPIRED" ? "EXPIRED" : "CANCELLED",
      }[verdict.state]
      return res.status(200).json({
        success: true,
        message: "Payment status fetched successfully",
        data: {
          order_id: order_id,
          order_status: appStatus,
          local_status: fresh?.order_status || payment.order_status,
          amount: payment.orderAmount,
          payment_method: fresh?.payment_method || null,
          transaction_id: fresh?.cf_payment_id || null,
          cf_order_id: payment.cf_order_id || null,
          expiry_time: payment.metadata?.expiry_time || null,
          cashfree_resource: CASHFREE_RESOURCE_SOFTPOS_QR,
          is_paid: verdict.isPaid,
        },
      })
    }

    const paymentLink = isPaymentLink(payment)
    // Payment links are verified from the Links API; legacy QR orders retain
    // their existing Orders API status path for backward compatibility.
    const remoteData = paymentLink
      ? await getCashfreePaymentLink(order_id)
      : (await axios.get(`${getCashfreeBaseUrl()}/orders/${encodeURIComponent(order_id)}`, { headers: getCashfreeHeaders() })).data
    let remoteStatus = paymentLink ? remoteData.link_status : remoteData.order_status
    if (remoteStatus === "ACTIVE" && isExpired(payment)) {
      remoteStatus = "EXPIRED"
    }
    const mappedStatus = mapCashfreeStatus(remoteStatus)

    if (payment) {
      const verifiedPayment = !paymentLink && remoteStatus === "PAID"
        ? await getVerifiedPaymentDetails(order_id)
        : null

      // Update payment if status changed
      if (payment.order_status !== mappedStatus) {
        // This exact session was superseded by a later method switch / fresh
        // QR (see cancelPendingPaymentSessions) — a late PAID confirmation
        // must not resurrect it into advancing the booking.
        const wasSupersededByDealerSwitch = payment.order_status === "CANCELLED"

        payment.order_status = mappedStatus
        payment.cf_payment_id = verifiedPayment?.cf_payment_id?.toString() || payment.cf_payment_id
        payment.transaction_id = verifiedPayment?.cf_payment_id?.toString() || payment.transaction_id || remoteData.cf_link_id?.toString()
        payment.utr_number = verifiedPayment?.bank_reference || payment.utr_number
        payment.payment_method = verifiedPayment?.payment_group || payment.payment_method || (paymentLink ? "upi" : null)
        payment.gateway_status = verifiedPayment?.payment_status || remoteStatus
        payment.verified_amount = Number(paymentLink ? remoteData.order_amount ?? payment.orderAmount : remoteData.order_amount)
        payment.verified_timestamp = new Date()

        // What Cashfree says was paid must equal what this order asked for.
        const amountVerified =
          mappedStatus !== "SUCCESS" || amountMatches(payment.orderAmount, payment.verified_amount)

        payment.metadata = {
          ...payment.metadata,
          last_status_check: new Date(),
          cashfree_status: remoteStatus,
          ...(wasSupersededByDealerSwitch && mappedStatus === "SUCCESS"
            ? { orphaned_after_method_switch: true }
            : {}),
          ...(amountVerified ? {} : { amount_mismatch: true, amount_mismatch_at: new Date() }),
        }
        await payment.save()

        // Update booking if payment successful
        if (mappedStatus === "SUCCESS" && !wasSupersededByDealerSwitch && amountVerified) {
          await advanceBookingAfterOnlinePayment(payment, req.app.get("io"))
        } else if (mappedStatus === "SUCCESS" && !amountVerified) {
          console.error(
            `[CASHFREE] Amount mismatch on payment ${payment._id} (booking ${payment.booking_id}): expected ₹${payment.orderAmount}, Cashfree reported ₹${payment.verified_amount} — booking NOT advanced, manual reconciliation required.`,
          )
        } else if (mappedStatus === "SUCCESS" && wasSupersededByDealerSwitch) {
          console.warn(
            `[CASHFREE] Payment ${payment._id} for booking ${payment.booking_id} confirmed PAID after being superseded — flagged for manual reconciliation, booking not auto-advanced.`,
          )
        }
      }
    }

    res.status(200).json({
      success: true,
      message: "Payment status fetched successfully",
      data: {
        order_id: order_id,
        order_status: remoteStatus,
        local_status: payment.order_status,
        amount: paymentLink ? remoteData.order_amount ?? payment.orderAmount : remoteData.order_amount,
        payment_method: payment.payment_method || null,
        transaction_id: paymentLink ? remoteData.cf_link_id || null : remoteData.cf_order_id,
        expiry_time: payment.metadata?.expiry_time || null,
        // A mismatched amount is never reported to the app as paid, so the
        // dealer screen cannot flip to PAID on a payment we refused to accept.
        is_paid:
          mappedStatus === "SUCCESS" &&
          amountMatches(payment.orderAmount, payment.verified_amount ?? payment.orderAmount) &&
          payment.metadata?.amount_mismatch !== true,
      },
    })
  } catch (error) {
    console.error("Check Payment Status Error:", error.response?.data || error.message)
    res.status(500).json({
      success: false,
      message: "Failed to check payment status",
    })
  }
}

/**
 * Cashfree Webhook Handler
 * Called by Cashfree when payment status changes
 *
 * SECURITY: Route middleware verifies Cashfree's signature, timestamp and
 * idempotency key before this handler runs. Orders API verification remains
 * as defense in depth and as the authoritative payment-status check.
 */
const cashfreeWebhook = async (req, res) => {
  try {
    console.log("Cashfree webhook received")

    const eventType = req.body.type
    const data = req.body.data
    const linkId = data?.link?.link_id || data?.payment_link?.link_id || null
    const orderId = data?.order?.order_id || null
    const resourceId = linkId || orderId
    // softPOS failure / user-dropped events can omit data.order entirely and
    // carry only the terminal transaction's cf_payment_id.
    const softposPaymentId = !resourceId && data?.terminal_details && data?.payment?.cf_payment_id != null
      ? String(data.payment.cf_payment_id)
      : null

    if (!data || (!resourceId && !softposPaymentId)) {
      console.log("Invalid webhook payload")
      return res.status(400).json({ success: false, message: "Invalid payload" })
    }

    const payment = resourceId
      ? await Payment.findOne({ orderId: resourceId })
      : await Payment.findOne({
          "metadata.cashfree_resource": CASHFREE_RESOURCE_SOFTPOS_QR,
          $or: [{ cf_payment_id: softposPaymentId }, { "metadata.cf_payment_id": softposPaymentId }],
        })
    if (!payment) {
      console.error(`Payment not found for Cashfree resource: ${resourceId || `payment ${softposPaymentId}`}`)
      return res.status(404).json({ success: false, message: "Payment not found" })
    }

    if (isSoftposQr(payment)) {
      const webhookTerminalId = data?.terminal_details?.cf_terminal_id
      if (webhookTerminalId != null && payment.cf_terminal_id && String(webhookTerminalId) !== String(payment.cf_terminal_id)) {
        console.warn(`[CASHFREE_SOFTPOS] Webhook terminal ${webhookTerminalId} does not match ${payment.orderId}'s terminal; ignored.`)
        return res.status(200).json({ success: true, message: "Webhook ignored (terminal mismatch)" })
      }
      // The webhook only says "look at this order"; the verdict comes from
      // Cashfree's Orders API inside reconcileSoftposPayment.
      let verdict
      try {
        verdict = await reconcileSoftposPayment(payment, req.app.get("io"))
      } catch (verifyError) {
        console.error(`[CASHFREE_SOFTPOS] Webhook verification failed for ${payment.orderId}:`, sanitizeCashfreeError(verifyError))
        return res.status(502).json({ success: false, message: "Payment verification failed" })
      }
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { "metadata.webhook_received_at": new Date(), "metadata.webhook_event": eventType } },
      )
      console.log(`[CASHFREE_SOFTPOS] Webhook ${eventType} for ${payment.orderId} → ${verdict.state} (paid=${verdict.isPaid})`)
      const io = req.app.get("io")
      if (verdict.isPaid && io) {
        io.emit("payment:success", {
          order_id: payment.orderId,
          booking_id: payment.booking_id,
          amount: payment.orderAmount,
          status: "SUCCESS",
        })
      }
      return res.status(200).json({ success: true, message: "Webhook processed" })
    }

    // Do not trust webhook status fields. Verify the corresponding resource
    // with Cashfree before writing local payment or booking state.
    const paymentLink = isPaymentLink(payment)
    let verifiedData
    try {
      verifiedData = paymentLink
        ? await getCashfreePaymentLink(resourceId)
        : (await axios.get(`${getCashfreeBaseUrl()}/orders/${encodeURIComponent(resourceId)}`, { headers: getCashfreeHeaders() })).data
      console.log(`Verified Cashfree ${paymentLink ? "link" : "order"} ${resourceId}:`, paymentLink ? verifiedData.link_status : verifiedData.order_status)
    } catch (verifyError) {
      console.error(`Failed to verify Cashfree ${paymentLink ? "link" : "order"} ${resourceId}:`, verifyError.response?.data || verifyError.message)
      return res.status(401).json({
        success: false,
        message: "Payment verification failed",
      })
    }

    // Use verified status from API, not webhook payload (security)
    const remoteStatus = paymentLink ? verifiedData.link_status : verifiedData.order_status
    const verifiedPayment = paymentLink ? {} : await getVerifiedPaymentDetails(resourceId, data.payment || {})
    const paymentMethodGroup = verifiedPayment.payment_group || payment.payment_method || (paymentLink ? "upi" : null)
    const transactionId = verifiedPayment.cf_payment_id
    const utr = verifiedPayment.payment_group === "upi" ? verifiedPayment.bank_reference : null
    const mappedStatus = mapCashfreeStatus(remoteStatus)

    console.log(`Webhook: resource_id=${resourceId}, verified_status=${remoteStatus}, event=${eventType}`)

    // This exact session was superseded by a later method switch / fresh QR
    // (see cancelPendingPaymentSessions) — a late webhook must not resurrect
    // it into advancing the booking or re-settling the wallet.
    const wasSupersededByDealerSwitch = payment.order_status === "CANCELLED"

    // A delayed non-success event must never downgrade a confirmed payment.
    if (payment.order_status !== "SUCCESS" || mappedStatus === "SUCCESS") {
      payment.order_status = mappedStatus
    }
    payment.payment_method = paymentMethodGroup
    payment.cf_payment_id = transactionId?.toString() || payment.cf_payment_id
    payment.transaction_id = transactionId || utr || payment.transaction_id || verifiedData.cf_link_id?.toString()
    payment.utr_number = utr
    payment.gateway_status = verifiedPayment.payment_status || remoteStatus
    payment.verified_amount = Number(paymentLink ? verifiedData.order_amount ?? payment.orderAmount : verifiedData.order_amount)
    payment.verified_timestamp = new Date()

    // Cashfree is the authority on what was paid; this Payment row is the
    // authority on what was owed. They must agree before a booking advances.
    const amountVerified =
      mappedStatus !== "SUCCESS" || amountMatches(payment.orderAmount, payment.verified_amount)

    payment.metadata = {
      ...payment.metadata,
      webhook_received_at: new Date(),
      webhook_event: eventType,
      utr_number: utr,
      cf_payment_id: transactionId,
      payment_group: data.payment?.payment_group,
      verified_via: paymentLink ? "links_api" : "orders_api",
      verified_at: new Date(),
      ...(wasSupersededByDealerSwitch && mappedStatus === "SUCCESS"
        ? { orphaned_after_method_switch: true }
        : {}),
      ...(amountVerified ? {} : { amount_mismatch: true, amount_mismatch_at: new Date() }),
    }

    await payment.save()
    console.log(`Payment updated: ${resourceId} -> ${mappedStatus}`)

    if (mappedStatus === "SUCCESS" && !amountVerified) {
      console.error(
        `[CASHFREE] Webhook amount mismatch for ${resourceId} (booking ${payment.booking_id}): expected ₹${payment.orderAmount}, Cashfree reported ₹${payment.verified_amount} — booking NOT advanced, manual reconciliation required.`,
      )
      return res.status(200).json({ success: true, message: "Webhook processed (amount mismatch flagged)" })
    }

    // Update booking if payment successful
    if (mappedStatus === "SUCCESS" && !wasSupersededByDealerSwitch) {
      const io = req.app.get("io")
      await advanceBookingAfterOnlinePayment(payment, io)
      console.log(`Booking ${payment.booking_id} marked as paid`)

      // Emit socket event for real-time update
      if (io) {
        io.emit("payment:success", {
          order_id: resourceId,
          booking_id: payment.booking_id,
          amount: payment.orderAmount,
          status: "SUCCESS",
        })
      }
    } else if (mappedStatus === "SUCCESS" && wasSupersededByDealerSwitch) {
      console.warn(
        `[CASHFREE] Webhook confirmed PAID for superseded order ${orderId} (booking ${payment.booking_id}) — flagged for manual reconciliation, booking not auto-advanced.`,
      )
    }

    res.status(200).json({ success: true, message: "Webhook processed" })
  } catch (error) {
    console.error("Webhook Error:", error)
    res.status(500).json({ success: false, message: "Webhook processing failed" })
  }
}

/**
 * Get Payment Details by Booking ID
 */
const getPaymentByBooking = async (req, res) => {
  try {
    const { booking_id } = req.params

    const payment = await Payment.findOne({ booking_id })
      .populate("booking_id")
      .populate("user_id", "first_name last_name email phone")
      .populate("dealer_id", "name email phone")
      .sort({ createdAt: -1 })

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "No payment found for this booking",
      })
    }

    res.status(200).json({
      success: true,
      message: "Payment details fetched successfully",
      data: payment,
    })
  } catch (error) {
    console.error("Get Payment Error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch payment details",
    })
  }
}

/**
 * Regenerate QR Code for existing pending payment
 */
const regenerateQRCode = async (req, res) => {
  try {
    const { payment_id } = req.params

    const payment = await Payment.findById(payment_id)

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      })
    }

    if (payment.order_status === "SUCCESS") {
      return res.status(400).json({
        success: false,
        message: "Payment already completed",
      })
    }

    if (isPaymentLink(payment)) {
      const linkData = await getCashfreePaymentLink(payment.orderId)
      const linkStatus =
        linkData.link_status === "ACTIVE" && new Date(payment.metadata?.expiry_time || 0).getTime() <= Date.now()
          ? "EXPIRED"
          : linkData.link_status
      const mappedStatus = mapCashfreeStatus(linkStatus)
      if (mappedStatus !== "PENDING") {
        payment.order_status = mappedStatus
        payment.gateway_status = linkData.link_status
        await payment.save()
        return res.status(400).json({
          success: false,
          message: mappedStatus === "EXPIRED" ? "QR Code expired. Please generate a new payment." : "Payment link is no longer active.",
          expired: mappedStatus === "EXPIRED",
        })
      }

      const linkUrl = payment.metadata?.link_url
      if (typeof linkUrl !== "string" || !linkUrl) {
        return res.status(500).json({ success: false, message: "Payment link URL is unavailable. Please generate a new payment." })
      }
      const generatedDataUrl = await QRCode.toDataURL(linkUrl, { width: 400, margin: 2, errorCorrectionLevel: "M" })
      const { qrCodeDataUrl, qrCodeBase64 } = normalizeQrCode(generatedDataUrl)
      return res.status(200).json({
        success: true,
        message: "QR Code regenerated successfully",
        data: {
          order_id: payment.orderId,
          qr_code: qrCodeDataUrl,
          qr_code_raw: qrCodeBase64,
          amount: payment.orderAmount,
          status: payment.order_status,
        },
      })
    }

    // PG order flow: the Dynamic UPI QR belongs to the order that is still
    // live, so "regenerate" re-serves that QR. A fresh QR means a fresh
    // order, which only POST /generate-qr (with force) may create — that is
    // the single place where the old order gets terminated first.
    const response = await axios.get(
      `${getCashfreeBaseUrl()}/orders/${encodeURIComponent(payment.orderId)}`,
      { headers: getCashfreeHeaders() },
    )
    const orderData = response.data || {}

    if (orderData.order_status !== "ACTIVE" || isExpired(payment)) {
      const mappedStatus = orderData.order_status === "ACTIVE" ? "EXPIRED" : mapCashfreeStatus(orderData.order_status)
      if (payment.order_status !== mappedStatus && mappedStatus !== "PENDING") {
        payment.order_status = mappedStatus
        payment.gateway_status = orderData.order_status
        await payment.save()
      }
      return res.status(400).json({
        success: false,
        message:
          mappedStatus === "EXPIRED"
            ? "QR Code expired. Please generate a new payment."
            : "This payment order is no longer active. Please generate a new payment.",
        expired: mappedStatus === "EXPIRED",
      })
    }

    const storedQr = payment.metadata?.qr_code
    if (typeof storedQr !== "string" || !storedQr) {
      return res.status(409).json({
        success: false,
        message: "No stored UPI QR for this order. Please generate a new payment.",
        expired: true,
      })
    }
    const { qrCodeDataUrl, qrCodeBase64 } = normalizeQrCode(storedQr)

    res.status(200).json({
      success: true,
      message: "QR Code regenerated successfully",
      data: {
        order_id: payment.orderId,
        qr_code: qrCodeDataUrl,
        qr_code_raw: qrCodeBase64,
        amount: payment.orderAmount,
        expiry_time: payment.metadata?.expiry_time || null,
        status: payment.order_status,
      },
    })
  } catch (error) {
    console.error("Regenerate QR Error:", error.response?.data || error.message)
    res.status(500).json({
      success: false,
      message: "Failed to regenerate QR Code",
    })
  }
}

/**
 * Cancel pending payment
 */
const cancelPayment = async (req, res) => {
  try {
    const { order_id } = req.params

    const payment = await Payment.findOne({ orderId: order_id })

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      })
    }

    if (payment.order_status === "SUCCESS") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel completed payment",
      })
    }

    await terminateCashfreeOrder(payment)

    // Update local status
    payment.order_status = "CANCELLED"
    payment.metadata = {
      ...payment.metadata,
      cancelled_at: new Date(),
    }
    await payment.save()

    // Update booking
    await Booking.findByIdAndUpdate(payment.booking_id, {
      $set: {
        billStatus: "cancelled",
      },
    })

    res.status(200).json({
      success: true,
      message: "Payment cancelled successfully",
      data: {
        order_id: order_id,
        status: "CANCELLED",
      },
    })
  } catch (error) {
    console.error("Cancel Payment Error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to cancel payment",
    })
  }
}

/**
 * Get all UPI QR payments with filters
 */
const getAllQRPayments = async (req, res) => {
  try {
    const { status, dealer_id, page = 1, limit = 20, startDate, endDate } = req.query

    const filters = { payment_type: "UPI_QR" }

    if (status) filters.order_status = status.toUpperCase()
    if (dealer_id) filters.dealer_id = dealer_id

    if (startDate || endDate) {
      filters.createdAt = {}
      if (startDate) filters.createdAt.$gte = new Date(startDate)
      if (endDate) {
        const end = new Date(endDate)
        end.setHours(23, 59, 59, 999)
        filters.createdAt.$lte = end
      }
    }

    const payments = await Payment.find(filters)
      .populate("booking_id", "bookingId status serviceDate")
      .populate("user_id", "first_name last_name phone")
      .populate("dealer_id", "name")
      .sort({ createdAt: -1 })
      .limit(Number.parseInt(limit))
      .skip((Number.parseInt(page) - 1) * Number.parseInt(limit))

    const total = await Payment.countDocuments(filters)

    res.status(200).json({
      success: true,
      message: "QR Payments fetched successfully",
      data: {
        payments,
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(total / Number.parseInt(limit)),
          totalRecords: total,
        },
      },
    })
  } catch (error) {
    console.error("Get All QR Payments Error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch payments",
    })
  }
}

module.exports = {
  generateUPIQRCode,
  checkPaymentStatus,
  cashfreeWebhook,
  getPaymentByBooking,
  regenerateQRCode,
  cancelPayment,
  getAllQRPayments,
  // Pure helpers, exported for test/bookingDynamicUpiQr.test.js only.
  __testing: {
    reconcileSoftposPayment,
    createSoftposAttempt,
    amountMatches,
    buildExpiryIso,
    isExpired,
    getQrExpiryMinutes,
    CASHFREE_RESOURCE_PG_ORDER,
    CASHFREE_RESOURCE_PAYMENT_LINK,
    CASHFREE_RESOURCE_SOFTPOS_QR,
  },
}
