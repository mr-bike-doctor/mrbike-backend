/**
 * Retiring PENDING booking payment sessions (dealer switches method or
 * generates a fresh QR).
 *
 * The rule locked in here: a PayU QR is closed at PayU before the row leaves
 * PENDING, and a paid attempt is never cancelled. Rows from the retired
 * Cashfree integration have no gateway to call and are closed locally.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");

const inject = (id, exports) => {
  const resolved = require.resolve(id);
  const stub = new Module(resolved, null);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
};

let pending = [];
const saved = [];
inject(path.join(__dirname, "../models/Payment.js"), { find: async () => pending });
inject(path.join(__dirname, "../models/Booking.js"), { findOneAndUpdate: async () => null, updateOne: async () => ({}) });

let cancelBehaviour = async () => {};
const cancelCalls = [];
inject(path.join(__dirname, "../services/payuService.js"), {
  PAYU_GATEWAY: "PAYU",
  cancelQr: async (txnid) => {
    cancelCalls.push(txnid);
    return cancelBehaviour(txnid);
  },
});

const { terminatePaymentSession, cancelPendingPaymentSessions } = require("../helper/paymentSession");

const row = (orderId, metadata) => ({
  orderId,
  order_status: "PENDING",
  metadata,
  async save() { saved.push({ orderId: this.orderId, status: this.order_status, reason: this.metadata.cancelled_reason }); },
});

(async () => {
  // PayU row → cancelled at PayU.
  await terminatePaymentSession(row("BDQ1", { gateway: "PAYU" }));
  assert.deepStrictEqual(cancelCalls, ["BDQ1"], "PayU QR is cancelled at PayU");

  // Legacy Cashfree row → no gateway call.
  await terminatePaymentSession(row("BDSP_old_A1", { cashfree_resource: "SOFTPOS_QR" }));
  assert.deepStrictEqual(cancelCalls, ["BDQ1"], "legacy row makes no gateway call");

  // Paid at PayU → PAYMENT_ALREADY_PAID, never retired.
  cancelBehaviour = async () => { const e = new Error("paid"); e.code = "PAYU_ALREADY_PAID"; throw e; };
  await assert.rejects(terminatePaymentSession(row("BDQ2", { gateway: "PAYU" })), (e) => e.code === "PAYMENT_ALREADY_PAID");

  pending = [row("BDQ3", { gateway: "PAYU", expiry_time: new Date(Date.now() + 60000).toISOString() })];
  await assert.rejects(cancelPendingPaymentSessions("b1"), (e) => e.code === "PAYMENT_ALREADY_PAID");
  assert.strictEqual(saved.length, 0, "a paid attempt is never marked cancelled");

  // Outage → propagates, row stays PENDING.
  cancelBehaviour = async () => { throw new Error("socket hang up"); };
  await assert.rejects(cancelPendingPaymentSessions("b1"), /socket hang up/);
  assert.strictEqual(saved.length, 0);

  // Live QR cancelled → CANCELLED; lapsed QR → EXPIRED; legacy → closed locally.
  cancelBehaviour = async () => {};
  pending = [
    row("BDQ4", { gateway: "PAYU", expiry_time: new Date(Date.now() + 60000).toISOString() }),
    row("BDQ5", { gateway: "PAYU", expiry_time: new Date(Date.now() - 60000).toISOString() }),
    row("LEGACY1", { cashfree_resource: "PG_ORDER", expiry_time: new Date(Date.now() + 60000).toISOString() }),
  ];
  const count = await cancelPendingPaymentSessions("b1", "qr_regenerated");
  assert.strictEqual(count, 3);
  assert.deepStrictEqual(saved, [
    { orderId: "BDQ4", status: "CANCELLED", reason: "qr_regenerated" },
    { orderId: "BDQ5", status: "EXPIRED", reason: "qr_regenerated" },
    { orderId: "LEGACY1", status: "CANCELLED", reason: "qr_regenerated" },
  ]);

  console.log("paymentSessionCleanup.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
