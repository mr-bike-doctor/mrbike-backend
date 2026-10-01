const Payment = require("../models/Payment")
const Booking = require("../models/Booking")
const Customer = require("../models/customer_model")
const { generateBill, verifyAndRecordWalletTopup } = require("./payment")
const { finalizeWalletTopup } = require("../services/walletTopupService")
const { settleBookingWallet } = require("../helper/walletSettlement")
const { sendBookingNotification } = require("../helper/pushNotification")
const {
  acquirePaymentOrderLock,
  releasePaymentOrderLock,
  cancelPendingPaymentSessions,
  terminatePaymentSession,
} = require("../helper/paymentSession")
const payu = require("../services/payuService")
const { PAYU_GATEWAY, PAYU_RESOURCE_DBQR } = payu
const {
  enqueuePaymentReconciliation,
  completeReconciliationTask,
} = require("../services/paymentReconciliationService")

const genDeliveryOtp = () => Math.floor(1000 + Math.random() * 9000)
const AMOUNT_TOLERANCE = 0.01

const isPayuQr = (payment) => payment?.metadata?.gateway === PAYU_GATEWAY

const isExpired = (payment) => {
  const expiry = new Date(payment?.expires_at || payment?.metadata?.expiry_time || 0).getTime()
  return !Number.isFinite(expiry) || expiry <= Date.now()
}

// PayU is the authority on what was paid; the booking is the authority on
// what was owed. A confirmation whose amount does not match must never
// advance a booking — it is a reconciliation case, not a payment.
const amountMatches = (expected, actual) => {
  const expectedNumber = Number(expected)
  const actualNumber = Number(actual)
  if (!Number.isFinite(expectedNumber) || !Number.isFinite(actualNumber)) return false
  return Math.abs(expectedNumber - actualNumber) <= AMOUNT_TOLERANCE
}

// Advance a booking to ready_for_delivery once its QR payment is confirmed
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
    console.log(`[PAYU_QR] Booking ${payment.booking_id} was already finalized or its payment method changed; skipping duplicate confirmation.`)
    return false
  }

  await enqueuePaymentReconciliation(payment)
  await completeReconciliationTask(payment, "BOOKING_SYNC")

  console.log(`[PAYU_QR] Booking ${payment.booking_id} → ready_for_delivery`)

  try {
    await generateBill({
      booking_id: payment.booking_id,
      payment_method: "ONLINE",
      transaction_id: payment.transaction_id || null,
      _id: payment._id,
    })
    await completeReconciliationTask(payment, "INVOICE")
  } catch (billErr) {
    console.error("[PAYU_QR] Bill generation failed:", billErr.message)
  }

  try {
    const settlement = await settleBookingWallet(currentBooking._id, "ONLINE")
    if (settlement) {
      console.log(`[PAYU_QR] Wallet settled: ₹${settlement.txnAmount} credited (commission ${settlement.commissionRate}%)`)
    }
    await completeReconciliationTask(payment, "WALLET")
  } catch (settlErr) {
    console.error("[PAYU_QR] Wallet settlement failed:", settlErr.message)
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
    console.error("[PAYU_QR] User FCM error:", notifyErr.message)
  }

  if (io) {
    io.to(`user:${currentBooking.user_id}`).emit("booking:ready_for_delivery", {
      bookingId: currentBooking._id,
      status: "ready_for_delivery",
    })
  }
  return true
}

/**
 * Server-side verdict on one PayU DBQR attempt, shared by the status poll,
 * the webhook and generate-qr. PayU's verify_payment API is the only source
 * of truth; nothing a client or a webhook body says is trusted.
 *
 * Returns { state, isPaid } where state is one of
 *   PAID     — PayU says success (isPaid only if every amount check passed)
 *   PENDING  — QR still live and payable
 *   EXPIRED  — QR lifetime passed (PayU may still report pending until cancelled)
 *   FAILED   — PayU says the transaction failed
 *   CLOSED   — PayU has no payable transaction for it
 *
 * A PENDING row is never closed here while PayU still reports it pending: a
 * late UPI confirmation must still land on a PENDING row and complete the
 * booking. Retiring a live-but-expired QR is done only by
 * cancelPendingPaymentSessions, which cancels at PayU first and refuses if
 * it turns out to be paid.
 */
const reconcilePayuPayment = async (payment, io) => {
  const details = await payu.verifyPayment(payment.orderId)
  const verdict = payu.mapPayuStatus(details.status)
  const now = new Date()
  const baseMeta = {
    "metadata.last_status_check": now,
    "metadata.payu_status": details.status || null,
    "metadata.payu_unmapped_status": details.unmappedstatus || null,
  }

  if (verdict === "SUCCESS") {
    const booking = await Booking.findById(payment.booking_id).select("customerTotal discountAmount")
    const paidAmount = Number(details.transaction_amount ?? details.amt)
    const amountVerified =
      amountMatches(payment.orderAmount, paidAmount) &&
      Boolean(booking) &&
      amountMatches(booking.amountDue, paidAmount)

    const wasRetired = ["CANCELLED", "EXPIRED", "FAILED"].includes(payment.order_status)
    const mihpayid = details.mihpayid != null ? String(details.mihpayid) : null
    const verifiedFields = {
      order_status: "SUCCESS",
      transaction_id: mihpayid || payment.transaction_id,
      utr_number: details.bank_ref_num || null,
      payment_method: "upi",
      gateway_status: "SUCCESS",
      verified_amount: paidAmount,
      verified_timestamp: now,
      ...baseMeta,
      "metadata.mihpayid": mihpayid,
      "metadata.payu_mode": details.mode || null,
      "metadata.verified_via": "payu_verify_payment",
      "metadata.verified_at": now,
      ...(amountVerified ? {} : { "metadata.amount_mismatch": true, "metadata.amount_mismatch_at": now }),
      ...(wasRetired ? { "metadata.orphaned_after_method_switch": true } : {}),
    }

    // Claim the → SUCCESS transition atomically. A concurrent webhook and
    // poll both land here; the unique one_successful_payment_per_booking
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
        `[PAYU_QR] Booking ${payment.booking_id} already has a SUCCESS payment; ${payment.orderId} flagged for reconciliation (possible double payment).`,
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
        `[PAYU_QR] ${payment.orderId} was PAID after being retired — flagged for manual reconciliation, booking not auto-advanced.`,
      )
      return { state: "PAID", isPaid: false }
    }
    if (!amountVerified || current?.metadata?.amount_mismatch === true) {
      console.error(
        `[PAYU_QR] Amount mismatch on ${payment.orderId} (booking ${payment.booking_id}): order ₹${payment.orderAmount}, due ₹${booking?.amountDue}, paid ₹${paidAmount} — booking NOT advanced.`,
      )
      return { state: "PAID", isPaid: false }
    }

    // Idempotent: only the caller that flips payment_verified advances it.
    // Re-running it after a crash between the two writes is what finishes
    // a half-processed confirmation.
    await advanceBookingAfterOnlinePayment(current, io)
    return { state: "PAID", isPaid: true }
  }

  if (verdict === "PENDING") {
    await Payment.updateOne({ _id: payment._id }, { $set: baseMeta })
    return { state: isExpired(payment) ? "EXPIRED" : "PENDING", isPaid: false }
  }

  // PayU says nothing is payable (failed / never reached PayU), so a PENDING
  // row may be closed locally without risk of hiding a payment.
  const closedStatus = verdict === "FAILED" ? "FAILED" : isExpired(payment) ? "EXPIRED" : "CANCELLED"
  await Payment.updateOne(
    { _id: payment._id, order_status: "PENDING" },
    { $set: { ...baseMeta, order_status: closedStatus, gateway_status: String(details.status || "").toUpperCase() } },
  )
  return { state: verdict === "FAILED" ? "FAILED" : "CLOSED", isPaid: false }
}

const qrResponseData = (payment, extra = {}) => ({
  order_id: payment.orderId,
  payment_id: payment._id,
  payment_attempt: payment.payment_attempt,
  amount: payment.orderAmount,
  currency: "INR",
  qr_code: payment.metadata?.qr_code || null,
  upi_intent: payment.metadata?.qr_string || null,
  expiry_time: payment.metadata?.expiry_time || null,
  gateway: PAYU_GATEWAY,
  status: "PENDING",
  booking_id: payment.booking_id,
  ...extra,
})

/**
 * Mint one PayU DBQR attempt. The local row is written FIRST with its
 * deterministic txnid, so a crash or network loss at any later step leaves
 * a PENDING row that the next request will cancel at PayU before it may
 * create attempt N+1 — never an untracked payable QR.
 */
const createPayuAttempt = async ({ booking, bookingId, amount, customer, clientIp, deviceInfo }) => {
  const latest = await Payment.findOne({ booking_id: bookingId, "metadata.gateway": PAYU_GATEWAY })
    .sort({ payment_attempt: -1 })
    .select("payment_attempt")
    .lean()
  const attempt = (Number(latest?.payment_attempt) || 0) + 1
  const txnid = payu.buildTxnId(bookingId, attempt)
  const provisionalExpiry = new Date(Date.now() + payu.getQrExpiryMinutes() * 60 * 1000)

  const payment = await Payment.create({
    orderId: txnid,
    booking_id: bookingId,
    dealer_id: booking.dealer_id?._id,
    user_id: booking.user_id?._id,
    orderAmount: Number(amount),
    payment_type: "UPI_QR",
    order_currency: "INR",
    order_status: "PENDING",
    payment_by: "user",
    payment_attempt: attempt,
    expires_at: provisionalExpiry,
    metadata: {
      gateway: PAYU_GATEWAY,
      payu_resource: PAYU_RESOURCE_DBQR,
      payment_attempt: attempt,
      payu_stage: "CREATING_QR",
      expiry_time: provisionalExpiry.toISOString(),
    },
  })

  try {
    const qr = await payu.createDynamicQr({
      txnid,
      amount,
      bookingId,
      dealerId: booking.dealer_id?._id,
      customer,
      clientIp,
      deviceInfo,
    })
    payment.expires_at = qr.expiresAt
    payment.metadata = {
      ...payment.metadata,
      qr_code: qr.qrCode,
      qr_string: qr.qrString,
      payu_payment_id: qr.paymentId,
      merchant_vpa: qr.merchantVpa,
      qr_generated_at: new Date(),
      payu_stage: "QR_ISSUED",
      expiry_time: qr.expiresAt.toISOString(),
    }
    await payment.save()
    return payment
  } catch (error) {
    // Close whatever may exist remotely. Only once PayU confirms nothing is
    // payable may the row leave PENDING; otherwise it stays PENDING and the
    // next generate-qr retries the cancellation first.
    try {
      await payu.cancelQr(txnid)
      await Payment.updateOne(
        { _id: payment._id, order_status: "PENDING" },
        {
          $set: {
            order_status: "FAILED",
            gateway_status: "CANCELLED",
            "metadata.failure_reason": error.message,
            "metadata.failed_at": new Date(),
          },
        },
      )
    } catch (cleanupError) {
      console.error("[PAYU_QR] Could not close failed attempt; left PENDING for retry", {
        txnid,
        message: cleanupError.message,
      })
      if (cleanupError.code === "PAYU_ALREADY_PAID") {
        cleanupError.code = "PAYMENT_ALREADY_PAID"
        throw cleanupError
      }
    }
    throw error
  }
}

/**
 * Generate UPI QR Code for Payment
 * Called by Dealer App after ONLINE is selected
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

    if (!booking_id) {
      return res.status(400).json({ success: false, message: "booking_id is required" })
    }

    const booking = await Booking.findById(booking_id)
      .populate("user_id", "first_name last_name email phone")
      .populate("dealer_id", "name email")

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" })
    }

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

    if (!payu.getPayuConfig()) {
      console.error("[PAYU_QR] PAYU_KEY / PAYU_SALT are not configured")
      return res.status(503).json({
        success: false,
        code: "PAYU_NOT_CONFIGURED",
        message: "UPI QR payments are not configured yet. Please collect cash or try again later.",
      })
    }

    lockedBookingId = booking_id
    paymentOrderLockToken = await acquirePaymentOrderLock(booking_id)

    const existingPayment = await Payment.findOne({ booking_id, order_status: "SUCCESS" })
    if (existingPayment) {
      return res.status(400).json({ success: false, message: "Payment already completed for this booking" })
    }

    // Reuse before re-mint. The dealer app opens this screen on every mount;
    // a live PayU QR is handed back as-is. `force` is honoured only once the
    // current QR is verifiably dead — a still-payable QR is never replaced
    // while the customer might be scanning it.
    const pending = await Payment.findOne({ booking_id, order_status: "PENDING" })
    if (pending && isPayuQr(pending)) {
      let verdict
      try {
        verdict = await reconcilePayuPayment(pending, req.app.get("io"))
      } catch (verifyError) {
        console.error("[PAYU_QR] Could not verify the existing attempt", {
          orderId: pending.orderId,
          message: verifyError.message,
        })
        const blocked = new Error("Could not verify the current QR with PayU. Please check status again.")
        blocked.code = "PAYU_CLEANUP_FAILED"
        throw blocked
      }

      if (verdict.state === "PAID") {
        const fresh = await Payment.findById(pending._id)
        return res.status(200).json({
          success: true,
          message: verdict.isPaid ? "Payment already received" : "Payment received — pending reconciliation",
          data: qrResponseData(fresh, { status: "SUCCESS", is_paid: verdict.isPaid, qr_code: null, upi_intent: null }),
        })
      }
      if (verdict.state === "PENDING" && pending.metadata?.qr_code && amountMatches(amount, pending.orderAmount)) {
        if (force) console.log(`[PAYU_QR] force ignored — ${pending.orderId} is still live`)
        return res.status(200).json({
          success: true,
          message: "Existing UPI QR reused",
          data: qrResponseData(pending, { reused: true }),
        })
      }
    }

    // Retire whatever PENDING attempt remains (expired/failed PayU QR, or a
    // historical Cashfree row). The gateway is asked first and the cleanup
    // refuses if it says the attempt was paid.
    try {
      await cancelPendingPaymentSessions(booking_id, "qr_regenerated")
    } catch (cleanupError) {
      if (cleanupError.code === "PAYMENT_ALREADY_PAID") throw cleanupError
      console.error("[PAYU_QR] Could not retire the previous payment attempt", {
        bookingId: booking_id,
        message: cleanupError.message,
      })
      const blocked = new Error(`The previous payment attempt is still live and could not be closed: ${cleanupError.message}`)
      blocked.code = "PAYU_CLEANUP_FAILED"
      throw blocked
    }

    const customer = {
      name:
        customer_name ||
        `${booking.user_id?.first_name || ""} ${booking.user_id?.last_name || ""}`.trim() ||
        "Customer",
      email: customer_email || booking.user_id?.email || "customer@bikedoctor.com",
      phone: customer_phone || booking.user_id?.phone || "9999999999",
    }

    const payment = await createPayuAttempt({
      booking,
      bookingId: booking_id,
      amount,
      customer,
      clientIp: req.ip,
      deviceInfo: req.get("user-agent"),
    })
    console.log("[PAYU_QR] QR issued", {
      paymentId: String(payment._id),
      orderId: payment.orderId,
      attempt: payment.payment_attempt,
      expires_at: payment.metadata?.expiry_time,
    })

    await Booking.findByIdAndUpdate(booking_id, { $set: { billStatus: "pending" } })

    res.status(200).json({
      success: true,
      message: "UPI QR Code generated successfully",
      data: qrResponseData(payment, {
        reused: false,
        customer: { name: customer.name, phone: customer.phone },
      }),
    })
  } catch (error) {
    console.error("Generate UPI QR Error:", error.message)

    if (error.code === "PAYMENT_ORDER_LOCKED" || error.code === "PAYMENT_ALREADY_PAID") {
      return res.status(409).json({ success: false, message: error.message })
    }
    if (["PAYU_QR_UNAVAILABLE", "PAYU_CLEANUP_FAILED", "PAYU_NOT_CONFIGURED"].includes(error.code)) {
      return res.status(502).json({
        success: false,
        code: error.code,
        message: error.message || "PayU could not generate a UPI QR. Please try again or collect cash.",
      })
    }
    res.status(500).json({ success: false, message: "Failed to generate UPI QR Code" })
  } finally {
    if (paymentOrderLockToken && lockedBookingId) {
      await releasePaymentOrderLock(lockedBookingId, paymentOrderLockToken).catch((lockError) => {
        console.error("[PAYU_QR] Failed to release payment order lock", { message: lockError.message })
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
    const payment = await Payment.findOne({ orderId: order_id })
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" })
    }

    if (!isPayuQr(payment)) {
      // Historical Cashfree QR rows are no longer polled remotely.
      return res.status(200).json({
        success: true,
        message: "Payment status fetched successfully",
        data: {
          order_id,
          order_status: payment.order_status === "SUCCESS" ? "PAID" : payment.order_status,
          local_status: payment.order_status,
          amount: payment.orderAmount,
          is_paid: payment.order_status === "SUCCESS" && payment.metadata?.amount_mismatch !== true,
        },
      })
    }

    const verdict = await reconcilePayuPayment(payment, req.app.get("io"))
    const fresh = await Payment.findById(payment._id)
    // Same response shape the dealer app already understands.
    const appStatus = {
      PAID: "PAID",
      PENDING: "ACTIVE",
      EXPIRED: "EXPIRED",
      FAILED: "FAILED",
      CLOSED: fresh?.order_status === "EXPIRED" ? "EXPIRED" : "CANCELLED",
    }[verdict.state]

    res.status(200).json({
      success: true,
      message: "Payment status fetched successfully",
      data: {
        order_id,
        order_status: appStatus,
        local_status: fresh?.order_status || payment.order_status,
        amount: payment.orderAmount,
        payment_method: fresh?.payment_method || null,
        transaction_id: fresh?.transaction_id || null,
        expiry_time: payment.metadata?.expiry_time || null,
        gateway: PAYU_GATEWAY,
        is_paid: verdict.isPaid,
      },
    })
  } catch (error) {
    console.error("Check Payment Status Error:", error.message)
    res.status(500).json({ success: false, message: "Failed to check payment status" })
  }
}

/**
 * PayU Transaction Callback (webhook / surl / furl) for booking QR and
 * dealer wallet top-up
 *
 * SECURITY: the reverse hash is checked first; the verdict itself always
 * comes from verify_payment inside reconcilePayuPayment.
 */
const payuWebhook = async (req, res) => {
  try {
    const body = req.body || {}
    const config = payu.getPayuConfig()
    if (!config || !body.txnid || !payu.verifyResponseHash(config, body)) {
      console.warn("[PAYU_WEBHOOK] Verification rejected", { txnid: body.txnid || null })
      return res.status(401).json({ success: false, message: "Webhook verification failed" })
    }
    if (body.key && body.key !== config.key) {
      return res.status(401).json({ success: false, message: "Webhook verification failed" })
    }

    const payment = await Payment.findOne({ orderId: String(body.txnid) })
    // PayU has one merchant-wide webhook, so wallet top-ups land here too.
    if (payment?.payment_type === "WALLET_TOPUP" && payment.metadata?.gateway === PAYU_GATEWAY) {
      try {
        const verified = await verifyAndRecordWalletTopup(payment)
        if (verified.status === "SUCCESS") await finalizeWalletTopup(payment._id)
        console.log(`[PAYU_WEBHOOK] Wallet top-up ${payment.orderId} → ${verified.status}`)
        return res.status(200).json({ success: true, message: "Wallet top-up webhook processed" })
      } catch (topupError) {
        console.error("[PAYU_WEBHOOK] Wallet top-up verification/finalization failed", { orderId: payment.orderId, message: topupError.message })
        return res.status(500).json({ success: false, message: "Wallet top-up processing failed" })
      }
    }
    if (!payment || !isPayuQr(payment)) {
      console.error(`[PAYU_WEBHOOK] Payment not found for txnid ${body.txnid}`)
      return res.status(404).json({ success: false, message: "Payment not found" })
    }

    let verdict
    try {
      verdict = await reconcilePayuPayment(payment, req.app.get("io"))
    } catch (verifyError) {
      console.error(`[PAYU_WEBHOOK] Verification failed for ${payment.orderId}:`, verifyError.message)
      return res.status(502).json({ success: false, message: "Payment verification failed" })
    }
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { "metadata.webhook_received_at": new Date(), "metadata.webhook_status": body.status || null } },
    )
    console.log(`[PAYU_WEBHOOK] ${payment.orderId} → ${verdict.state} (paid=${verdict.isPaid})`)

    const io = req.app.get("io")
    if (verdict.isPaid && io) {
      io.emit("payment:success", {
        order_id: payment.orderId,
        booking_id: payment.booking_id,
        amount: payment.orderAmount,
        status: "SUCCESS",
      })
    }
    res.status(200).json({ success: true, message: "Webhook processed" })
  } catch (error) {
    console.error("[PAYU_WEBHOOK] Error:", error.message)
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
      return res.status(404).json({ success: false, message: "No payment found for this booking" })
    }
    res.status(200).json({ success: true, message: "Payment details fetched successfully", data: payment })
  } catch (error) {
    console.error("Get Payment Error:", error)
    res.status(500).json({ success: false, message: "Failed to fetch payment details" })
  }
}

/**
 * Re-serve the QR of a still-live attempt. A fresh QR means a fresh PayU
 * transaction, which only POST /generate-qr (with force) may create.
 */
const regenerateQRCode = async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.payment_id)
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found" })
    }
    if (payment.order_status === "SUCCESS") {
      return res.status(400).json({ success: false, message: "Payment already completed" })
    }
    if (!isPayuQr(payment) || payment.order_status !== "PENDING" || isExpired(payment) || !payment.metadata?.qr_code) {
      return res.status(400).json({
        success: false,
        message: "QR Code expired. Please generate a new payment.",
        expired: true,
      })
    }
    res.status(200).json({
      success: true,
      message: "QR Code regenerated successfully",
      data: {
        order_id: payment.orderId,
        qr_code: payment.metadata.qr_code,
        upi_intent: payment.metadata.qr_string || null,
        amount: payment.orderAmount,
        expiry_time: payment.metadata?.expiry_time || null,
        status: payment.order_status,
      },
    })
  } catch (error) {
    console.error("Regenerate QR Error:", error.message)
    res.status(500).json({ success: false, message: "Failed to regenerate QR Code" })
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
      return res.status(404).json({ success: false, message: "Payment not found" })
    }
    if (payment.order_status === "SUCCESS") {
      return res.status(400).json({ success: false, message: "Cannot cancel completed payment" })
    }

    await terminatePaymentSession(payment)

    payment.order_status = "CANCELLED"
    payment.metadata = { ...payment.metadata, cancelled_at: new Date() }
    await payment.save()

    await Booking.findByIdAndUpdate(payment.booking_id, { $set: { billStatus: "cancelled" } })

    res.status(200).json({
      success: true,
      message: "Payment cancelled successfully",
      data: { order_id, status: "CANCELLED" },
    })
  } catch (error) {
    console.error("Cancel Payment Error:", error.message)
    if (error.code === "PAYMENT_ALREADY_PAID") {
      return res.status(409).json({ success: false, message: error.message })
    }
    res.status(500).json({ success: false, message: "Failed to cancel payment" })
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
    res.status(500).json({ success: false, message: "Failed to fetch payments" })
  }
}

module.exports = {
  generateUPIQRCode,
  checkPaymentStatus,
  payuWebhook,
  getPaymentByBooking,
  regenerateQRCode,
  cancelPayment,
  getAllQRPayments,
  // Exported for test/bookingPayuQr.test.js only.
  __testing: {
    reconcilePayuPayment,
    createPayuAttempt,
    amountMatches,
    isExpired,
  },
}
