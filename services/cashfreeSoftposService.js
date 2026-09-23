/**
 * Cashfree softPOS (Agent terminal) Dynamic QR — booking payments only.
 *
 * Flow for one payment attempt:
 *   POST /pg/orders                 order carrying `terminal` (SPOS + cf_terminal_id)
 *   POST /pg/terminal/transactions  payment_method QR_CODE → `qrcode` data URI
 *   GET  /pg/orders/{id}            authoritative order status
 *   GET  /pg/orders/{id}/payments   authoritative payment amount / status
 *
 * Wallet top-ups do NOT use this module and keep their own Cashfree
 * integration and API version. softPOS calls pin their own x-api-version
 * (CASHFREE_SOFTPOS_API_VERSION) so bumping it can never change wallet
 * behaviour.
 *
 * The one terminal is configured once (CASHFREE_SOFTPOS_TERMINAL_ID). It is
 * never created on the payment path — see scripts/cashfreeSoftposTerminal.js.
 */
const axios = require("axios")
const crypto = require("crypto")

const CASHFREE_RESOURCE_SOFTPOS_QR = "SOFTPOS_QR"

// Cashfree payment statuses after which a terminal QR can no longer be paid.
const DEAD_TRANSACTION_STATUSES = ["FAILED", "USER_DROPPED", "VOID", "CANCELLED"]

const getBaseUrl = () =>
  (process.env.CASHFREE_BASE_URL || "https://api.cashfree.com/pg").replace(/\/+$/, "")

const getSoftposApiVersion = () => process.env.CASHFREE_SOFTPOS_API_VERSION || "2026-01-01"

// Returns the configured terminal, or null when softPOS is not set up. The
// id must be a positive integer — Cashfree types cf_terminal_id as int64.
const getSoftposTerminalConfig = () => {
  const rawId = String(process.env.CASHFREE_SOFTPOS_TERMINAL_ID || "").trim()
  if (!/^\d+$/.test(rawId) || Number(rawId) <= 0) return null
  const phone = String(process.env.CASHFREE_SOFTPOS_TERMINAL_PHONE || "").trim()
  return {
    cfTerminalId: Number(rawId),
    terminalPhoneNo: /^\d{10}$/.test(phone) ? phone : null,
  }
}

const headers = (idempotencyKey) => ({
  "x-client-id": process.env.CASHFREE_APP_ID,
  "x-client-secret": process.env.CASHFREE_SECRET_KEY,
  "x-api-version": getSoftposApiVersion(),
  "Content-Type": "application/json",
  ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
})

// UUID-shaped key derived from our own identifiers, so a network retry of
// the same call for the same attempt is replayed by Cashfree, not repeated.
const idempotencyKeyFor = (scope, value) => {
  const hex = crypto.createHash("sha256").update(`softpos:${scope}:${value}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// One order id per (booking, attempt). Deterministic, so the id itself is
// the idempotency anchor: the same attempt can never become two orders.
// 24-char ObjectId + prefix stays well inside Cashfree's 45-char limit.
const buildSoftposOrderId = (bookingId, attempt) => `BDSP_${String(bookingId)}_A${attempt}`

const upstreamMessage = (error) =>
  error.response?.data?.message || error.response?.data?.type || error.response?.data?.code || error.message

const wrapError = (error, code, prefix) => {
  const wrapped = new Error(`${prefix}: ${upstreamMessage(error)}`)
  wrapped.code = code
  wrapped.status = error.response?.status
  return wrapped
}

const fetchOrder = async (orderId) => {
  const response = await axios.get(`${getBaseUrl()}/orders/${encodeURIComponent(orderId)}`, {
    headers: headers(),
  })
  return response.data || {}
}

const fetchOrderPayments = async (orderId) => {
  const response = await axios.get(`${getBaseUrl()}/orders/${encodeURIComponent(orderId)}/payments`, {
    headers: headers(),
  })
  return Array.isArray(response.data) ? response.data : response.data?.data || []
}

/**
 * Create (or, for a retried request, recover) the PG order for one attempt.
 * A 409 means this exact deterministic order id already exists at Cashfree;
 * it is adopted only if it is still ACTIVE for the same amount and booking.
 */
const createSoftposOrder = async ({ orderId, amount, bookingId, bookingRef, dealerId, customerDetails, expiryIso, terminal }) => {
  const payload = {
    order_id: orderId,
    order_amount: Number(amount),
    order_currency: "INR",
    customer_details: customerDetails,
    terminal: {
      terminal_type: "SPOS",
      cf_terminal_id: terminal.cfTerminalId,
      ...(terminal.terminalPhoneNo ? { terminal_phone_no: terminal.terminalPhoneNo } : {}),
    },
    order_meta: {
      notify_url: `${process.env.BACKEND_URL || "https://api.bikedoctor.app"}/bikedoctor/cashfree/webhook`,
    },
    order_expiry_time: expiryIso,
    order_note: `Payment for Booking ${bookingRef || bookingId}`,
    order_tags: {
      booking_id: String(bookingId),
      dealer_id: dealerId ? String(dealerId) : "",
      payment_channel: CASHFREE_RESOURCE_SOFTPOS_QR,
    },
  }

  try {
    const response = await axios.post(`${getBaseUrl()}/orders`, payload, {
      headers: headers(idempotencyKeyFor("order", orderId)),
    })
    return response.data || {}
  } catch (error) {
    if (error.response?.status === 409) {
      const existing = await fetchOrder(orderId).catch(() => null)
      if (
        existing?.order_status === "ACTIVE" &&
        existing?.order_tags?.booking_id === String(bookingId) &&
        Math.abs(Number(existing.order_amount) - Number(amount)) <= 0.01
      ) {
        return existing
      }
    }
    console.error("[CASHFREE_SOFTPOS] Create order failed", {
      orderId,
      status: error.response?.status,
      code: error.response?.data?.code,
      type: error.response?.data?.type,
      message: error.response?.data?.message || error.message,
    })
    throw wrapError(error, "CASHFREE_ORDER_CREATE_FAILED", "Cashfree rejected the payment order")
  }
}

/**
 * POST /pg/terminal/transactions with payment_method QR_CODE.
 * Returns Cashfree's own `qrcode` (a data:image/png;base64 URI) untouched —
 * it is never regenerated from `payment_url`.
 */
const createTerminalQrTransaction = async ({ cfOrderId, orderId, terminal }) => {
  const body = {
    cf_order_id: String(cfOrderId),
    cf_terminal_id: terminal.cfTerminalId,
    payment_method: "QR_CODE",
    ...(terminal.terminalPhoneNo ? { terminal_phone_no: terminal.terminalPhoneNo } : {}),
    add_invoice: false,
  }
  let data
  try {
    const response = await axios.post(`${getBaseUrl()}/terminal/transactions`, body, {
      headers: headers(idempotencyKeyFor("terminal-txn", orderId)),
    })
    data = response.data || {}
  } catch (error) {
    console.error("[CASHFREE_SOFTPOS] Create terminal transaction failed", {
      orderId,
      cfOrderId,
      status: error.response?.status,
      code: error.response?.data?.code,
      type: error.response?.data?.type,
      message: error.response?.data?.message || error.message,
    })
    throw wrapError(error, "CASHFREE_QR_UNAVAILABLE", "Cashfree could not create the softPOS QR")
  }

  const qrcode = typeof data.qrcode === "string" ? data.qrcode.trim() : ""
  if (!qrcode.startsWith("data:image/")) {
    console.error("[CASHFREE_SOFTPOS] Terminal transaction returned no QR image", {
      orderId,
      keys: Object.keys(data),
    })
    const missing = new Error("Cashfree did not return a softPOS QR for this order")
    missing.code = "CASHFREE_QR_UNAVAILABLE"
    throw missing
  }

  const timeoutMs = Number.parseInt(data.timeout, 10)
  return {
    cfPaymentId: data.cf_payment_id != null ? String(data.cf_payment_id) : null,
    paymentAmount: data.payment_amount,
    qrcode,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
  }
}

// ── Admin/setup only. Never called on the payment path. ──────────────────────
const getTerminalByPhone = async (phone) => {
  const response = await axios.get(`${getBaseUrl()}/terminal/${encodeURIComponent(phone)}`, {
    headers: headers(),
  })
  return response.data || {}
}

const createAgentTerminal = async ({ terminalId, name, email, phone, note }) => {
  const response = await axios.post(
    `${getBaseUrl()}/terminal`,
    {
      terminal_id: terminalId,
      terminal_name: name,
      terminal_email: email,
      terminal_phone_no: phone,
      terminal_type: "AGENT",
      ...(note ? { terminal_note: note } : {}),
    },
    { headers: headers(idempotencyKeyFor("terminal", terminalId)) },
  )
  return response.data || {}
}

module.exports = {
  CASHFREE_RESOURCE_SOFTPOS_QR,
  DEAD_TRANSACTION_STATUSES,
  getSoftposTerminalConfig,
  buildSoftposOrderId,
  createSoftposOrder,
  createTerminalQrTransaction,
  fetchOrder,
  fetchOrderPayments,
  getTerminalByPhone,
  createAgentTerminal,
}
