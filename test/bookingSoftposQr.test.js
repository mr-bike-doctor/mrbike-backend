/**
 * Booking softPOS Dynamic QR (SOFTPOS_QR). Cashfree and Mongo are stubbed —
 * nothing here talks to the network or creates a real transaction.
 */
const assert = require("assert")
const axios = require("axios")
const Payment = require("../models/Payment")
const Booking = require("../models/Booking")

let gets = {}
let posts = []
let postHandler = () => Promise.reject(new Error("unstubbed post"))
axios.get = async (url) => {
  const key = Object.keys(gets).find((suffix) => url.endsWith(suffix))
  if (!key) throw new Error(`unstubbed GET ${url}`)
  return { data: gets[key] }
}
axios.post = async (url, body, config) => {
  posts.push({ url, body, headers: config?.headers })
  return postHandler(url, body)
}

const softpos = require("../services/cashfreeSoftposService")
const { __testing } = require("../controller/cashfreeQRController")
const { reconcileSoftposPayment } = __testing

const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDol"
const TERMINAL = { cfTerminalId: 54321, terminalPhoneNo: "9898989898" }

const run = async () => {
  // ── Terminal configuration comes only from the environment ────────────────
  {
    const saved = { ...process.env }
    delete process.env.CASHFREE_SOFTPOS_TERMINAL_ID
    assert.strictEqual(softpos.getSoftposTerminalConfig(), null, "unset terminal id disables softPOS")
    process.env.CASHFREE_SOFTPOS_TERMINAL_ID = "abc"
    assert.strictEqual(softpos.getSoftposTerminalConfig(), null, "non-numeric id is rejected")
    process.env.CASHFREE_SOFTPOS_TERMINAL_ID = "54321"
    process.env.CASHFREE_SOFTPOS_TERMINAL_PHONE = "123"
    assert.deepStrictEqual(softpos.getSoftposTerminalConfig(), { cfTerminalId: 54321, terminalPhoneNo: null })
    process.env.CASHFREE_SOFTPOS_TERMINAL_PHONE = "9898989898"
    assert.deepStrictEqual(softpos.getSoftposTerminalConfig(), TERMINAL)
    process.env = saved
  }

  // ── Deterministic order id per attempt ────────────────────────────────────
  {
    const id = "64b7f0c2a1b2c3d4e5f60718"
    assert.strictEqual(softpos.buildSoftposOrderId(id, 1), softpos.buildSoftposOrderId(id, 1))
    assert.notStrictEqual(softpos.buildSoftposOrderId(id, 1), softpos.buildSoftposOrderId(id, 2))
    assert.ok(softpos.buildSoftposOrderId(id, 999).length <= 45, "fits Cashfree's order_id limit")
  }

  // ── Order carries the terminal; transaction asks for QR_CODE ──────────────
  {
    posts = []
    postHandler = async (url) =>
      url.endsWith("/orders")
        ? { data: { cf_order_id: 777, order_status: "ACTIVE" } }
        : { data: { cf_payment_id: 42887, payment_amount: 499, payment_method: "QR_CODE", payment_url: "https://payments.cashfree.com/x", qrcode: QR, timeout: "300000" } }

    await softpos.createSoftposOrder({
      orderId: "BDSP_x_A1", amount: 499, bookingId: "x", customerDetails: {}, expiryIso: "2026-01-01T00:00:00+05:30", terminal: TERMINAL,
    })
    const orderCall = posts[0]
    assert.deepStrictEqual(orderCall.body.terminal, { terminal_type: "SPOS", cf_terminal_id: 54321, terminal_phone_no: "9898989898" })
    assert.strictEqual(orderCall.body.order_amount, 499)
    assert.strictEqual(orderCall.headers["x-api-version"], "2026-01-01", "softPOS pins its own API version")
    assert.ok(orderCall.headers["x-idempotency-key"])

    const txn = await softpos.createTerminalQrTransaction({ cfOrderId: 777, orderId: "BDSP_x_A1", terminal: TERMINAL })
    const txnCall = posts[1]
    assert.ok(txnCall.url.endsWith("/terminal/transactions"))
    assert.deepStrictEqual(txnCall.body, {
      cf_order_id: "777", cf_terminal_id: 54321, payment_method: "QR_CODE", terminal_phone_no: "9898989898", add_invoice: false,
    })
    assert.strictEqual(txn.qrcode, QR, "Cashfree's qrcode is used exactly as returned")
    assert.strictEqual(txn.timeoutMs, 300000)
    assert.strictEqual(txn.cfPaymentId, "42887")

    // A payment_url is never an acceptable substitute for the QR image.
    postHandler = async () => ({ data: { cf_payment_id: 1, payment_url: "https://payments.cashfree.com/x", qrcode: "https://payments.cashfree.com/x" } })
    await assert.rejects(
      softpos.createTerminalQrTransaction({ cfOrderId: 777, orderId: "BDSP_x_A1", terminal: TERMINAL }),
      (error) => error.code === "CASHFREE_QR_UNAVAILABLE",
    )
  }

  // ── Reconciliation: server-side verdicts ──────────────────────────────────
  const updates = []
  let bookingAdvanced = 0
  let bookingAmountDue = 499
  Payment.updateOne = async (filter, update) => { updates.push({ filter, update }); return {} }
  Payment.findOneAndUpdate = async (filter, update) => ({ ...basePayment(), ...update.$set, metadata: {} })
  Payment.findById = async () => basePayment()
  Booking.findById = () => ({ select: async () => ({ amountDue: bookingAmountDue }) })
  // advanceBookingAfterOnlinePayment's atomic claim; null = "already finalized"
  // so the test stops before invoices/wallet/notifications.
  Booking.findOneAndUpdate = async () => { bookingAdvanced += 1; return null }

  const basePayment = (overrides = {}) => ({
    _id: "p1",
    orderId: "BDSP_b1_A1",
    booking_id: "b1",
    orderAmount: 499,
    order_status: "PENDING",
    cf_terminal_id: "54321",
    metadata: {
      cashfree_resource: "SOFTPOS_QR",
      cf_payment_id: "42887",
      expiry_time: new Date(Date.now() + 60000).toISOString(),
    },
    ...overrides,
  })

  // Paid in full → booking advances.
  gets = {
    "/orders/BDSP_b1_A1": { order_status: "PAID", order_amount: 499 },
    "/orders/BDSP_b1_A1/payments": [{ cf_payment_id: 42887, payment_status: "SUCCESS", payment_amount: 499, payment_group: "upi" }],
  }
  let verdict = await reconcileSoftposPayment(basePayment(), null)
  assert.deepStrictEqual(verdict, { state: "PAID", isPaid: true })
  assert.strictEqual(bookingAdvanced, 1)

  // Short payment → never advances the booking.
  bookingAdvanced = 0
  gets["/orders/BDSP_b1_A1/payments"] = [{ cf_payment_id: 42887, payment_status: "SUCCESS", payment_amount: 1 }]
  verdict = await reconcileSoftposPayment(basePayment(), null)
  assert.deepStrictEqual(verdict, { state: "PAID", isPaid: false })
  assert.strictEqual(bookingAdvanced, 0, "amount mismatch must not advance")

  // Booking amountDue changed since the QR was issued → not accepted.
  gets["/orders/BDSP_b1_A1/payments"] = [{ cf_payment_id: 42887, payment_status: "SUCCESS", payment_amount: 499 }]
  bookingAmountDue = 599
  verdict = await reconcileSoftposPayment(basePayment(), null)
  assert.strictEqual(verdict.isPaid, false, "payment must equal booking.amountDue")
  assert.strictEqual(bookingAdvanced, 0)
  bookingAmountDue = 499

  // Paid after the attempt was retired → flagged, never auto-advanced.
  verdict = await reconcileSoftposPayment(basePayment({ order_status: "CANCELLED" }), null)
  assert.deepStrictEqual(verdict, { state: "PAID", isPaid: false })
  assert.strictEqual(bookingAdvanced, 0)

  // QR timed out but order still ACTIVE → EXPIRED verdict, row stays PENDING.
  updates.length = 0
  gets = { "/orders/BDSP_b1_A1": { order_status: "ACTIVE" }, "/orders/BDSP_b1_A1/payments": [] }
  verdict = await reconcileSoftposPayment(
    basePayment({ metadata: { cashfree_resource: "SOFTPOS_QR", expiry_time: new Date(Date.now() - 1000).toISOString() } }),
    null,
  )
  assert.strictEqual(verdict.state, "EXPIRED")
  assert.ok(updates.every((u) => u.update.$set.order_status === undefined), "no local expiry while Cashfree order is ACTIVE")

  // Terminal transaction failed → FAILED verdict so the dealer can retry.
  gets["/orders/BDSP_b1_A1/payments"] = [{ cf_payment_id: 42887, payment_status: "USER_DROPPED" }]
  verdict = await reconcileSoftposPayment(basePayment(), null)
  assert.strictEqual(verdict.state, "FAILED")

  // Live and unpaid → PENDING.
  gets["/orders/BDSP_b1_A1/payments"] = [{ cf_payment_id: 42887, payment_status: "PENDING" }]
  verdict = await reconcileSoftposPayment(basePayment(), null)
  assert.deepStrictEqual(verdict, { state: "PENDING", isPaid: false })

  // Cashfree terminated/expired the order → closed locally.
  updates.length = 0
  gets = { "/orders/BDSP_b1_A1": { order_status: "EXPIRED" } }
  verdict = await reconcileSoftposPayment(basePayment(), null)
  assert.strictEqual(verdict.state, "CLOSED")
  assert.strictEqual(updates[0].filter.order_status, "PENDING")
  assert.strictEqual(updates[0].update.$set.order_status, "EXPIRED")

  console.log("bookingSoftposQr.test.js: all assertions passed")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
