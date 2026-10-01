/**
 * PayU client: booking Dynamic UPI QR (DBQR, S2S) and dealer wallet top-up
 * (hosted checkout).
 *
 * Flow for one payment attempt:
 *   POST {secure}/_payment                    pg=DBQR, bankcode=UPIDBQR, txn_s2s_flow=4
 *                                             → result.qrString (upi://pay?...)
 *   POST {info}/merchant/postservice.php      command=verify_payment  (authoritative status)
 *   POST {info}/merchant/postservice.php      command=cancel_qr_payment (retire a live QR)
 *
 * PayU returns the UPI intent string, not an image; it is rendered to a PNG
 * data URI here so the dealer app keeps receiving `qr_code` as before.
 *
 * Env: PAYU_KEY, PAYU_SALT, PAYU_ENV ("production" | anything else = test),
 *      PAYU_QR_EXPIRY_MINUTES (default 30),
 *      PAYU_CALLBACK_BASE_URL (default https://api.mrbikedoctor.cloud).
 */
const axios = require("axios")
const crypto = require("crypto")
const QRCode = require("qrcode")

const PAYU_GATEWAY = "PAYU"
const PAYU_RESOURCE_DBQR = "PAYU_DBQR"

const isProduction = () => String(process.env.PAYU_ENV || "").toLowerCase() === "production"

const getPaymentUrl = () =>
  isProduction() ? "https://secure.payu.in/_payment" : "https://test.payu.in/_payment"

const getPostServiceUrl = () =>
  isProduction()
    ? "https://info.payu.in/merchant/postservice.php?form=2"
    : "https://test.payu.in/merchant/postservice.php?form=2"

// Returns the merchant credentials, or null when PayU is not set up.
const getPayuConfig = () => {
  const key = String(process.env.PAYU_KEY || "").trim()
  const salt = String(process.env.PAYU_SALT || "").trim()
  if (!key || !salt) return null
  return { key, salt }
}

// Gateway callbacks are never derived from BACKEND_URL: that value has
// pointed at the retired .com host, which would send PayU callbacks nowhere.
const getCallbackBaseUrl = () =>
  (process.env.PAYU_CALLBACK_BASE_URL || "https://api.mrbikedoctor.cloud").replace(/\/+$/, "")

const getQrExpiryMinutes = () => {
  const configured = Number.parseInt(process.env.PAYU_QR_EXPIRY_MINUTES, 10)
  return Number.isFinite(configured) && configured > 0 ? configured : 30
}

const sha512 = (value) => crypto.createHash("sha512").update(value).digest("hex")

// PayU hashes the amount exactly as it was posted, so it is formatted once.
const formatAmount = (amount) => Number(amount).toFixed(2)

// sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
const paymentRequestHash = ({ key, salt }, p) =>
  sha512(
    [
      key,
      p.txnid,
      p.amount,
      p.productinfo,
      p.firstname,
      p.email,
      p.udf1 || "",
      p.udf2 || "",
      p.udf3 || "",
      p.udf4 || "",
      p.udf5 || "",
      "", "", "", "", "",
      salt,
    ].join("|"),
  )

// sha512(key|command|var1|salt)
const commandHash = ({ key, salt }, command, var1) => sha512(`${key}|${command}|${var1}|${salt}`)

// Reverse hash PayU sends on the callback:
// [additional_charges|]salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
const expectedResponseHash = ({ key, salt }, body) => {
  const parts = [
    salt,
    body.status || "",
    "", "", "", "", "",
    body.udf5 || "",
    body.udf4 || "",
    body.udf3 || "",
    body.udf2 || "",
    body.udf1 || "",
    body.email || "",
    body.firstname || "",
    body.productinfo || "",
    body.amount || "",
    body.txnid || "",
    key,
  ]
  if (body.additional_charges || body.additionalCharges) {
    parts.unshift(body.additional_charges || body.additionalCharges)
  }
  return sha512(parts.join("|"))
}

const verifyResponseHash = (config, body) => {
  const received = String(body?.hash || "").toLowerCase()
  if (!/^[0-9a-f]{128}$/.test(received)) return false
  const expected = expectedResponseHash(config, body)
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
}

// One txnid per (booking, attempt). Deterministic so a retried request for
// the same attempt reuses the same id instead of minting a second payable.
// PayU caps txnid at 25 characters, so the booking id is hashed down.
const buildTxnId = (bookingId, attempt) =>
  `BDQ${crypto.createHash("sha256").update(`${bookingId}:${attempt}`).digest("hex").slice(0, 20).toUpperCase()}`

// PayU verify_payment `status` → local verdict. Anything not clearly
// terminal is treated as still payable.
const DEAD_STATUSES = ["failure", "failed", "cancelled", "usercancelled", "dropped", "bounced"]
const mapPayuStatus = (status) => {
  const value = String(status || "").toLowerCase()
  if (value === "success") return "SUCCESS"
  if (value === "not found") return "NOT_FOUND"
  if (DEAD_STATUSES.includes(value)) return "FAILED"
  return "PENDING"
}

const form = (fields) => new URLSearchParams(fields).toString()

const postForm = (url, fields) =>
  axios.post(url, form(fields), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    timeout: 20000,
  })

const upstreamMessage = (error) =>
  error.response?.data?.error ||
  error.response?.data?.message ||
  error.response?.data?.metaData?.message ||
  error.message

const qrError = (message, code = "PAYU_QR_UNAVAILABLE") => {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Create a Dynamic UPI QR. Returns { qrString, qrCode (PNG data URI),
 * paymentId, merchantVpa, expiresAt }.
 */
const createDynamicQr = async ({ txnid, amount, bookingId, dealerId, customer, clientIp, deviceInfo }) => {
  const config = getPayuConfig()
  if (!config) throw qrError("PayU is not configured", "PAYU_NOT_CONFIGURED")

  const backendUrl = getCallbackBaseUrl()
  const expirySeconds = getQrExpiryMinutes() * 60
  const fields = {
    key: config.key,
    txnid,
    amount: formatAmount(amount),
    productinfo: "Bike Service Booking",
    firstname: (customer.name || "Customer").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 60) || "Customer",
    email: customer.email || "customer@bikedoctor.com",
    phone: customer.phone || "9999999999",
    udf1: String(bookingId),
    udf2: dealerId ? String(dealerId) : "",
    surl: `${backendUrl}/bikedoctor/payu/webhook`,
    furl: `${backendUrl}/bikedoctor/payu/webhook`,
    pg: "DBQR",
    bankcode: "UPIDBQR",
    txn_s2s_flow: "4",
    s2s_client_ip: clientIp || "127.0.0.1",
    s2s_device_info: deviceInfo || "BikeDoctorDealerApp",
    expiry_time: String(expirySeconds),
  }
  fields.hash = paymentRequestHash(config, fields)

  let data
  try {
    const response = await postForm(getPaymentUrl(), fields)
    data = typeof response.data === "string" ? JSON.parse(response.data) : response.data || {}
  } catch (error) {
    console.error("[PAYU_QR] Create QR failed", {
      txnid,
      status: error.response?.status,
      message: upstreamMessage(error),
    })
    throw qrError(`PayU could not create the UPI QR: ${upstreamMessage(error)}`)
  }

  const qrString = typeof data?.result?.qrString === "string" ? data.result.qrString.trim() : ""
  const txnStatus = String(data?.metaData?.txnStatus || data?.status || "").toLowerCase()
  if (!qrString.startsWith("upi://") || (txnStatus && txnStatus !== "pending")) {
    // Failures come either as metaData.message or as top-level
    // { status: "failed", error: "E308", message: "..." }.
    const reason = String(data?.metaData?.message || data?.message || "").trim()
    const errorCode = data?.error || data?.metaData?.errorCode || null
    console.error("[PAYU_QR] Response carried no usable QR", {
      txnid,
      txnStatus,
      errorCode,
      message: reason || null,
      keys: Object.keys(data || {}),
    })
    throw qrError(
      `PayU did not return a UPI QR${reason ? `: ${reason}` : ""}${errorCode ? ` (${errorCode})` : ""}`,
    )
  }

  // The amount inside the intent must be what we asked for.
  const intentAmount = new URL(qrString.replace(/^upi:\/\//, "https://upi/")).searchParams.get("am")
  if (intentAmount != null && Math.abs(Number(intentAmount) - Number(amount)) > 0.01) {
    throw qrError(`PayU QR amount ₹${intentAmount} does not match booking amount ₹${amount}`)
  }

  const qrCode = await QRCode.toDataURL(qrString, { width: 400, margin: 2, errorCorrectionLevel: "M" })
  return {
    qrString,
    qrCode,
    paymentId: data.result.paymentId != null ? String(data.result.paymentId) : null,
    merchantVpa: data.result.merchantVpa || null,
    expiresAt: new Date(Date.now() + expirySeconds * 1000),
  }
}

/**
 * Fields for a PayU hosted-checkout POST (wallet top-up). The client posts
 * them to `action`; the hash is a request hash and never reveals the salt.
 */
const buildCheckoutRequest = ({ txnid, amount, productinfo, customer, udf1 = "", udf2 = "", surl, furl }) => {
  const config = getPayuConfig()
  if (!config) throw qrError("PayU is not configured", "PAYU_NOT_CONFIGURED")
  const fields = {
    key: config.key,
    txnid,
    amount: formatAmount(amount),
    productinfo,
    firstname: (customer.name || "Dealer").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 60) || "Dealer",
    email: customer.email || "dealer@mrbikedoctor.com",
    phone: customer.phone || "9999999999",
    udf1: String(udf1),
    udf2: String(udf2),
    surl,
    furl,
  }
  fields.hash = paymentRequestHash(config, fields)
  return { action: getPaymentUrl(), fields }
}

/**
 * verify_payment for one txnid. Returns the transaction_details row, or
 * { status: "not found" } when PayU has no record of it.
 */
const verifyPayment = async (txnid) => {
  const config = getPayuConfig()
  if (!config) throw qrError("PayU is not configured", "PAYU_NOT_CONFIGURED")
  const command = "verify_payment"
  const response = await postForm(getPostServiceUrl(), {
    key: config.key,
    command,
    var1: txnid,
    hash: commandHash(config, command, txnid),
  })
  const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data || {}
  const details = data?.transaction_details?.[txnid]
  if (!details || String(details.status || "").toLowerCase() === "not found") {
    return { status: "not found" }
  }
  return details
}

/**
 * cancel_qr_payment. Resolves when the QR is no longer payable (cancelled
 * now, or PayU has no in-progress transaction for it). Throws with
 * code PAYU_ALREADY_PAID if verification shows it was paid.
 */
const cancelQr = async (txnid) => {
  const config = getPayuConfig()
  if (!config) throw qrError("PayU is not configured", "PAYU_NOT_CONFIGURED")
  const command = "cancel_qr_payment"
  const var1 = JSON.stringify({ transactionId: txnid, product_type: "DBQR" })

  let cancelled = false
  try {
    const response = await postForm(getPostServiceUrl(), {
      key: config.key,
      command,
      var1,
      hash: commandHash(config, command, var1),
    })
    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data || {}
    cancelled = String(data?.status || "").toLowerCase() === "success"
    if (!cancelled) {
      console.warn("[PAYU_QR] Cancel refused, verifying remote state", {
        txnid,
        errorCode: data?.errorCode,
        message: data?.message,
      })
    }
  } catch (error) {
    // Transport failure / 5xx is an outage — never assume the QR is dead.
    if (!error.response || error.response.status >= 500) throw error
  }

  // Whatever cancel said, PayU's own verdict decides whether it is safe.
  const details = await verifyPayment(txnid)
  const verdict = mapPayuStatus(details.status)
  if (verdict === "SUCCESS") {
    const paid = new Error(`PayU transaction ${txnid} is already paid`)
    paid.code = "PAYU_ALREADY_PAID"
    throw paid
  }
  if (cancelled || verdict !== "PENDING") return
  throw new Error(`PayU did not cancel ${txnid} (status: ${details.status || "unknown"})`)
}

module.exports = {
  PAYU_GATEWAY,
  PAYU_RESOURCE_DBQR,
  getPayuConfig,
  getCallbackBaseUrl,
  buildCheckoutRequest,
  getQrExpiryMinutes,
  formatAmount,
  buildTxnId,
  mapPayuStatus,
  paymentRequestHash,
  commandHash,
  expectedResponseHash,
  verifyResponseHash,
  createDynamicQr,
  verifyPayment,
  cancelQr,
}
