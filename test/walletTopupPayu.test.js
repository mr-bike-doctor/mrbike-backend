/**
 * Dealer wallet top-up through PayU hosted checkout. PayU is stubbed —
 * nothing here talks to the network.
 */
const assert = require("assert")
const axios = require("axios")

process.env.PAYU_KEY = "testkey"
process.env.PAYU_SALT = "testsalt"
process.env.PAYU_ENV = "test"
delete process.env.PAYU_CALLBACK_BASE_URL

let verifyRow = { status: "pending" }
axios.post = async (_url, body) => {
  const fields = Object.fromEntries(new URLSearchParams(body))
  return { data: { status: 1, transaction_details: { [fields.var1]: verifyRow } } }
}

const payu = require("../services/payuService")
const { verifyAndRecordWalletTopup, mapPayuMode } = require("../controller/payment")

const topup = (overrides = {}) => ({
  orderId: "WTOP1",
  orderAmount: 500,
  order_currency: "INR",
  order_status: "PENDING",
  payment_type: "WALLET_TOPUP",
  metadata: { gateway: "PAYU" },
  saves: 0,
  async save() { this.saves += 1 },
  ...overrides,
})

const run = async () => {
  // Hosted checkout request: hash over the posted fields, callbacks on the live host.
  {
    const req = payu.buildCheckoutRequest({
      txnid: "WTOP1", amount: 500, productinfo: "Wallet Topup",
      customer: { name: "Shop & Co.", email: "d@x.in", phone: "9876543210" },
      udf1: "dealer1", surl: "https://api.mrbikedoctor.cloud/bikedoctor/payu/webhook", furl: "https://api.mrbikedoctor.cloud/bikedoctor/payu/webhook",
    })
    assert.strictEqual(req.action, "https://test.payu.in/_payment")
    assert.strictEqual(req.fields.amount, "500.00")
    assert.strictEqual(req.fields.firstname, "Shop  Co", "firstname stripped to PayU-safe characters")
    assert.strictEqual(req.fields.hash, payu.paymentRequestHash(payu.getPayuConfig(), req.fields))
    assert.ok(!JSON.stringify(req).includes("testsalt"), "salt never leaves the server")
    assert.strictEqual(payu.getCallbackBaseUrl(), "https://api.mrbikedoctor.cloud", "callbacks never use BACKEND_URL")
  }

  // Not yet submitted → stays PENDING.
  verifyRow = { status: "Not Found" }
  let p = topup()
  let r = await verifyAndRecordWalletTopup(p)
  assert.strictEqual(r.status, "PENDING")

  // Paid in full → SUCCESS with PayU references.
  verifyRow = { status: "success", amt: "500.00", transaction_amount: "500.00", mihpayid: "4039", bank_ref_num: "UTR9", mode: "UPI" }
  p = topup()
  r = await verifyAndRecordWalletTopup(p)
  assert.strictEqual(r.status, "SUCCESS")
  assert.strictEqual(p.order_status, "SUCCESS")
  assert.strictEqual(p.transaction_id, "4039")
  assert.strictEqual(p.utr_number, "UTR9")
  assert.strictEqual(p.payment_method, "upi")

  // Amount mismatch → never credited.
  verifyRow = { status: "success", amt: "5.00", transaction_amount: "5.00" }
  await assert.rejects(verifyAndRecordWalletTopup(topup()), /amount mismatch/)

  // Failed payment → FAILED.
  verifyRow = { status: "failure", amt: "500.00" }
  p = topup()
  r = await verifyAndRecordWalletTopup(p)
  assert.strictEqual(r.status, "FAILED")

  // A confirmed top-up is never downgraded by a later read.
  verifyRow = { status: "pending" }
  p = topup({ order_status: "SUCCESS" })
  r = await verifyAndRecordWalletTopup(p)
  assert.strictEqual(p.order_status, "SUCCESS")

  assert.strictEqual(mapPayuMode("CC"), "card")
  assert.strictEqual(mapPayuMode("NB"), "netbanking")
  assert.strictEqual(mapPayuMode("weird"), null)

  console.log("walletTopupPayu.test.js: all assertions passed")
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
