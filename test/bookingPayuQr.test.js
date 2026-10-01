/**
 * Booking PayU Dynamic UPI QR (DBQR). PayU and Mongo are stubbed —
 * nothing here talks to the network or creates a real transaction.
 */
const assert = require("assert")
const crypto = require("crypto")
const axios = require("axios")
const Payment = require("../models/Payment")
const Booking = require("../models/Booking")

process.env.PAYU_KEY = "testkey"
process.env.PAYU_SALT = "testsalt"
process.env.PAYU_ENV = "test"

let posts = []
let postHandler = () => Promise.reject(new Error("unstubbed post"))
axios.post = async (url, body, config) => {
  const fields = Object.fromEntries(new URLSearchParams(body))
  posts.push({ url, fields, headers: config?.headers })
  return postHandler(url, fields)
}

const payu = require("../services/payuService")
const { __testing } = require("../controller/payuQRController")
const { reconcilePayuPayment } = __testing

const sha512 = (value) => crypto.createHash("sha512").update(value).digest("hex")
const verifyResponse = (txnid, row) => ({ data: { status: 1, transaction_details: { [txnid]: row } } })

const run = async () => {
  // ── Config + txnid ────────────────────────────────────────────────────────
  {
    assert.deepStrictEqual(payu.getPayuConfig(), { key: "testkey", salt: "testsalt" })
    const id = "64b7f0c2a1b2c3d4e5f60718"
    assert.strictEqual(payu.buildTxnId(id, 1), payu.buildTxnId(id, 1), "txnid is deterministic")
    assert.notStrictEqual(payu.buildTxnId(id, 1), payu.buildTxnId(id, 2))
    assert.ok(payu.buildTxnId(id, 999).length <= 25, "fits PayU's txnid limit")
  }

  // ── Hashes follow PayU's documented formulas ──────────────────────────────
  {
    const config = payu.getPayuConfig()
    const p = { txnid: "T1", amount: "499.00", productinfo: "P", firstname: "A", email: "a@b.c", udf1: "b1", udf2: "d1" }
    assert.strictEqual(
      payu.paymentRequestHash(config, p),
      sha512("testkey|T1|499.00|P|A|a@b.c|b1|d1|||" + "||||||testsalt"),
    )
    assert.strictEqual(payu.commandHash(config, "verify_payment", "T1"), sha512("testkey|verify_payment|T1|testsalt"))

    const callback = { status: "success", txnid: "T1", amount: "499.00", productinfo: "P", firstname: "A", email: "a@b.c", udf1: "b1", udf2: "d1" }
    callback.hash = sha512("testsalt|success||||||" + "|||d1|b1|a@b.c|A|P|499.00|T1|testkey")
    assert.ok(payu.verifyResponseHash(config, callback), "valid reverse hash accepted")
    assert.ok(!payu.verifyResponseHash(config, { ...callback, amount: "1.00" }), "tampered amount rejected")
    assert.ok(!payu.verifyResponseHash(config, { ...callback, hash: "nothex" }), "malformed hash rejected")
  }

  // ── Create QR: DBQR request, qrString rendered to a PNG data URI ──────────
  {
    posts = []
    postHandler = async () => ({
      data: {
        result: { paymentId: "22095839016", merchantVpa: "m.payu@indus", qrString: "upi://pay?pa=m.payu@indus&am=499.00&tr=x" },
        metaData: { txnId: "T1", txnStatus: "pending" },
      },
    })
    const qr = await payu.createDynamicQr({
      txnid: "T1", amount: 499, bookingId: "b1", dealerId: "d1",
      customer: { name: "Ravi K.", email: "r@x.in", phone: "9876543210" }, clientIp: "1.2.3.4", deviceInfo: "UA",
    })
    const call = posts[0]
    assert.ok(call.url.startsWith("https://test.payu.in/_payment"))
    assert.strictEqual(call.fields.pg, "DBQR")
    assert.strictEqual(call.fields.bankcode, "UPIDBQR")
    assert.strictEqual(call.fields.txn_s2s_flow, "4")
    assert.strictEqual(call.fields.amount, "499.00")
    assert.strictEqual(call.fields.udf1, "b1")
    assert.strictEqual(call.fields.hash, payu.paymentRequestHash(payu.getPayuConfig(), call.fields))
    assert.ok(qr.qrCode.startsWith("data:image/png;base64,"), "QR is rendered as an image")
    assert.strictEqual(qr.paymentId, "22095839016")

    postHandler = async () => ({ data: { result: { qrString: "upi://pay?pa=m@x&am=1.00" }, metaData: { txnStatus: "pending" } } })
    await assert.rejects(
      payu.createDynamicQr({ txnid: "T2", amount: 499, bookingId: "b1", customer: {} }),
      (error) => error.code === "PAYU_QR_UNAVAILABLE",
      "QR for a different amount is refused",
    )
    postHandler = async () => ({ data: { metaData: { txnStatus: "failed", message: "DBQR not enabled" } } })
    await assert.rejects(
      payu.createDynamicQr({ txnid: "T3", amount: 499, bookingId: "b1", customer: {} }),
      (error) => error.code === "PAYU_QR_UNAVAILABLE" && /DBQR not enabled/.test(error.message),
    )
    // Real sandbox shape when DBQR is not configured on the merchant.
    postHandler = async () => ({ data: { result: null, status: "failed", error: "E308", message: "  pgMerchantId should not be empty. But, received value  " } })
    await assert.rejects(
      payu.createDynamicQr({ txnid: "T4", amount: 499, bookingId: "b1", customer: {} }),
      (error) => error.code === "PAYU_QR_UNAVAILABLE" && /pgMerchantId/.test(error.message) && /E308/.test(error.message),
      "top-level PayU failure reason is surfaced",
    )
  }

  // ── Cancel never hides a payment ──────────────────────────────────────────
  {
    postHandler = async (_url, fields) =>
      fields.command === "cancel_qr_payment"
        ? { data: { status: "failed", errorCode: "E2019" } }
        : verifyResponse("T1", { status: "success", amt: "499.00" })
    await assert.rejects(payu.cancelQr("T1"), (error) => error.code === "PAYU_ALREADY_PAID")

    postHandler = async (_url, fields) =>
      fields.command === "cancel_qr_payment"
        ? { data: { status: "success" } }
        : verifyResponse("T1", { status: "pending" })
    await payu.cancelQr("T1")

    postHandler = async (_url, fields) =>
      fields.command === "cancel_qr_payment"
        ? { data: { status: "failed" } }
        : verifyResponse("T1", { status: "pending" })
    await assert.rejects(payu.cancelQr("T1"), /did not cancel/, "still-pending after refused cancel is unsafe")
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
    orderId: "T1",
    booking_id: "b1",
    orderAmount: 499,
    order_status: "PENDING",
    expires_at: new Date(Date.now() + 60000),
    metadata: { gateway: "PAYU", expiry_time: new Date(Date.now() + 60000).toISOString() },
    ...overrides,
  })

  postHandler = async () => verifyResponse("T1", { status: "success", amt: "499.00", transaction_amount: "499.00", mihpayid: "403993715", bank_ref_num: "UTR1" })
  let verdict = await reconcilePayuPayment(basePayment())
  assert.deepStrictEqual(verdict, { state: "PAID", isPaid: true })
  assert.strictEqual(bookingAdvanced, 1, "paid in full advances the booking")

  bookingAmountDue = 599
  verdict = await reconcilePayuPayment(basePayment())
  assert.deepStrictEqual(verdict, { state: "PAID", isPaid: false }, "amount mismatch never advances")
  assert.strictEqual(bookingAdvanced, 1)
  bookingAmountDue = 499

  verdict = await reconcilePayuPayment(basePayment({ order_status: "CANCELLED" }))
  assert.deepStrictEqual(verdict, { state: "PAID", isPaid: false }, "paid after retire is flagged, not advanced")

  postHandler = async () => verifyResponse("T1", { status: "pending" })
  verdict = await reconcilePayuPayment(basePayment())
  assert.deepStrictEqual(verdict, { state: "PENDING", isPaid: false })
  verdict = await reconcilePayuPayment(basePayment({ expires_at: new Date(Date.now() - 1000) }))
  assert.deepStrictEqual(verdict, { state: "EXPIRED", isPaid: false })
  assert.ok(!updates.at(-1).update.$set.order_status, "a still-pending QR is never closed locally")

  postHandler = async () => verifyResponse("T1", { status: "failure" })
  verdict = await reconcilePayuPayment(basePayment())
  assert.deepStrictEqual(verdict, { state: "FAILED", isPaid: false })
  assert.strictEqual(updates.at(-1).update.$set.order_status, "FAILED")

  console.log("bookingPayuQr tests passed")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
