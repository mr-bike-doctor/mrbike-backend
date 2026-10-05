// Editing a booking between Complete Service and delivery
// (controller/booking.js#editCompletedBooking, rules in services/postServiceEdit.js).
//
// Part 1 is pure. Part 2 drives the real controller against a throwaway local
// database (never the configured DATABASE_URL) and skips itself with exit
// code 0 when no local mongod is reachable. Point it elsewhere with
// TEST_MONGO_URL.
const assert = require("assert");
const mongoose = require("mongoose");

const {
  resolvePostServiceEditWindow,
  normalizeOdometer,
  normalizeNotes,
  diffIds,
  PostServiceEditError,
  MAX_NOTES,
} = require("../services/postServiceEdit");

// ── Part 1: rules ───────────────────────────────────────────────────────────
const open = { status: "awaiting_payment", billStatus: "pending", payment_status: "pending" };

assert.deepStrictEqual(
  [resolvePostServiceEditWindow(open).canEdit, resolvePostServiceEditWindow(open).canEditServices],
  [true, true]
);
assert.strictEqual(resolvePostServiceEditWindow({ ...open, status: "payment_selected" }).canEditServices, true);
assert.strictEqual(resolvePostServiceEditWindow({ ...open, status: "completed" }).canEditServices, true);

// Paid, awaiting handover: only the service record stays editable.
const paid = { status: "ready_for_delivery", billStatus: "paid", payment_status: "completed", billGenerated: true };
assert.strictEqual(resolvePostServiceEditWindow(paid).canEdit, true);
assert.strictEqual(resolvePostServiceEditWindow(paid).canEditServices, false);
assert.strictEqual(resolvePostServiceEditWindow(paid).code, "PAYMENT_ALREADY_COLLECTED");

// Payment collected but the status somehow still pre-payment: still locked.
assert.strictEqual(resolvePostServiceEditWindow({ ...open, payment_status: "completed" }).canEditServices, false);
assert.strictEqual(resolvePostServiceEditWindow({ ...open, billGenerated: true }).canEditServices, false);

for (const status of ["pending", "confirmed", "delivered", "cancelled", "user_cancelled", "rejected", "expired"]) {
  assert.strictEqual(resolvePostServiceEditWindow({ ...open, status }).canEdit, false, status);
}
assert.strictEqual(resolvePostServiceEditWindow({ status: "delivered" }).code, "BOOKING_DELIVERED");

assert.strictEqual(normalizeOdometer("12,452"), 12452);
assert.strictEqual(normalizeOdometer(800), 800);
assert.strictEqual(normalizeOdometer(""), 0);
assert.strictEqual(normalizeOdometer(null), 0);
for (const bad of [-1, 12.5, "abc", 1e7, "1e3x"]) {
  assert.throws(() => normalizeOdometer(bad), PostServiceEditError, String(bad));
}

assert.deepStrictEqual(normalizeNotes(["  chain lubed ", "", "   ", "belt replaced"]), ["chain lubed", "belt replaced"]);
assert.throws(() => normalizeNotes("note"), PostServiceEditError);
assert.throws(() => normalizeNotes(new Array(MAX_NOTES + 1).fill("x")), PostServiceEditError);
assert.throws(() => normalizeNotes(["x".repeat(501)]), PostServiceEditError);

assert.deepStrictEqual(diffIds(["a", "b"], ["b", "c"]), { added: ["c"], removed: ["a"] });
assert.deepStrictEqual(diffIds(["a", "b"], ["b", "a"]), { added: [], removed: [] });

console.log("postServiceEdit.test.js — rules: all assertions passed");

// ── Part 2: controller against a local DB ───────────────────────────────────
const TEST_URL = process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:27017/mrbike_post_service_edit_test";

const Booking = require("../models/Booking");
const Vendor = require("../models/dealerModel");
const UserBike = require("../models/userBikeModel");
const AdminService = require("../models/adminService");
const AdditionalService = require("../models/additionalServiceSchema");
const Payment = require("../models/Payment");
require("../models/customer_model");
require("../models/baseAdditionalServiceSchema");
const { computePriceBreakdown, applyBreakdownToBooking } = require("../services/pricingEngine");
const { editCompletedBooking, getBookingAdditionalServiceOptions } = require("../controller/booking");

const id = (n) => new mongoose.Types.ObjectId(String(n).padStart(24, "0"));
const DEALER = id(1), OTHER_DEALER = id(2), USER = id(3), BIKE = id(4);
const MAIN = id(10), BELT = id(11), OIL = id(12), FOREIGN = id(13), UNPRICED = id(14), INACTIVE = id(15);
// Priced only for some other bike MODEL — the case that showed ₹150 in the
// app's picker but was refused on save.
const MODEL_SCOPED = id(16), OTHER_MODEL = id(77);

function call(bookingId, body, dealerId = DEALER) {
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(payload) { captured.body = payload; return this; },
  };
  const req = {
    params: { bookingId: String(bookingId) },
    body,
    user_id: String(dealerId),
    auth: { role: "dealer", id: String(dealerId) },
    app: { get: () => null },
  };
  return editCompletedBooking(req, res).then(() => captured);
}

const dealer = { tax: 18, commission: 10, pickupCharges: 0, dropCharges: 0, providesPickup: false, providesDrop: false };

async function seed() {
  await Vendor.collection.insertOne({ _id: DEALER, shopName: "Test Garage", ...dealer });
  await UserBike.collection.insertOne({ _id: BIKE, user_id: USER, bike_cc: 125 });
  await AdminService.collection.insertOne({ _id: MAIN, bikes: [{ cc: 125, price: 450 }] });
  let seq = 0;
  const addl = (_id, extra = {}) => ({
    _id,
    id: ++seq,
    serviceId: `TEST-${seq}`,
    dealer_id: DEALER,
    base_additional_service_id: id(99),
    bikes: [{ cc: 125, price: 200 }],
    isActive: true,
    ...extra,
  });
  await AdditionalService.collection.insertMany([
    addl(BELT),
    addl(OIL, { bikes: [{ cc: 125, price: 300 }] }),
    addl(FOREIGN, { dealer_id: OTHER_DEALER }),
    addl(UNPRICED, { bikes: [{ cc: 150, price: 999 }] }),
    addl(INACTIVE, { isActive: false }),
    addl(MODEL_SCOPED, { bikes: [{ cc: 125, price: 150, model_id: OTHER_MODEL }] }),
  ]);
}

async function makeBooking(extra = {}) {
  const doc = new Booking({
    user_id: USER,
    dealer_id: DEALER,
    userBike_id: BIKE,
    services: [MAIN],
    additionalServices: [],
    transportOption: "SELF_VISIT",
    status: "awaiting_payment",
    billStatus: "pending",
    payment_status: "pending",
    lastServiceKm: 12000,
    additionalNotes: ["All services completed"],
    ...extra,
  });
  applyBreakdownToBooking(doc, computePriceBreakdown({ serviceAmount: 450, transportOption: "SELF_VISIT", dealer }), {
    serviceLines: [{ kind: "service", ref: MAIN, price: 450 }],
  });
  await doc.save();
  return doc;
}

async function run() {
  await seed();

  // ── Awaiting payment: add a service, fix the km, edit notes ──────────────
  const b1 = await makeBooking();
  const before = b1.amountDue;

  // Dry run re-prices but saves nothing.
  const preview = await call(b1._id, { services: [String(BELT)], dryRun: true });
  assert.strictEqual(preview.code, 200, JSON.stringify(preview.body));
  assert.strictEqual(preview.body.dryRun, true);
  assert.ok(preview.body.data.amountDue > before);
  const untouched = await Booking.findById(b1._id);
  assert.strictEqual(untouched.additionalServices.length, 0);
  assert.strictEqual(untouched.amountDue, before);

  const saved = await call(b1._id, {
    services: [String(BELT)],
    lastServiceKm: "12,452",
    notes: ["All services completed", "Belt replaced at customer request"],
  });
  assert.strictEqual(saved.code, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.summary.servicesChanged, true);
  assert.strictEqual(saved.body.summary.paymentReset, false);
  const after = await Booking.findById(b1._id).select("+postServiceEdits");
  assert.deepStrictEqual(after.additionalServices.map(String), [String(BELT)]);
  assert.strictEqual(after.serviceAmount, 650);
  assert.strictEqual(after.amountDue, preview.body.data.amountDue);
  assert.strictEqual(after.lastServiceKm, 12452);
  assert.deepStrictEqual([...after.additionalNotes], ["All services completed", "Belt replaced at customer request"]);
  assert.strictEqual(after.status, "awaiting_payment");
  assert.strictEqual(after.postServiceEdits.length, 1);
  assert.strictEqual(after.postServiceEdits[0].previousLastServiceKm, 12000);
  assert.strictEqual(after.postServiceEdits[0].newLastServiceKm, 12452);
  assert.strictEqual(after.postServiceEdits[0].previousAmountDue, before);

  // Re-sending the same values is a no-op, not a second audit entry.
  const noop = await call(b1._id, { services: [String(BELT)], lastServiceKm: 12452 });
  assert.strictEqual(noop.code, 200);
  assert.strictEqual(noop.body.changed, false);
  assert.strictEqual((await Booking.findById(b1._id).select("+postServiceEdits")).postServiceEdits.length, 1);

  // Removing the service brings the price back down.
  const removed = await call(b1._id, { services: [] });
  assert.strictEqual(removed.code, 200);
  assert.strictEqual((await Booking.findById(b1._id)).amountDue, before);

  // ── Server-priced catalog for this booking's bike ────────────────────────
  const options = await new Promise((resolve) => {
    const captured = {};
    const res = {
      status(code) { captured.code = code; return this; },
      json(payload) { captured.body = payload; resolve(captured); return this; },
    };
    getBookingAdditionalServiceOptions(
      { params: { bookingId: String(b1._id) }, user_id: String(DEALER), auth: { role: "dealer" } },
      res
    );
  });
  assert.strictEqual(options.code, 200);
  const priceById = Object.fromEntries(options.body.data.map((d) => [String(d._id), d.bookingPrice]));
  assert.strictEqual(priceById[String(BELT)], 200);
  assert.strictEqual(priceById[String(OIL)], 300);
  assert.ok(!(String(UNPRICED) in priceById), "a service priced only for another CC is not listed");
  assert.ok(!(String(MODEL_SCOPED) in priceById), "a service priced only for another model is not listed");
  for (const d of options.body.data) assert.strictEqual(d.bikes.length, 1);
  assert.ok(!(String(FOREIGN) in priceById), "other garages' services are not listed");
  assert.ok(!(String(INACTIVE) in priceById), "inactive services are not listed");
  // …and the save agrees with it.
  const modelScoped = await call(b1._id, { services: [String(MODEL_SCOPED)] });
  assert.strictEqual(modelScoped.body.code, "ADDITIONAL_SERVICE_UNPRICED");
  assert.deepStrictEqual(modelScoped.body.unpriced, [String(MODEL_SCOPED)]);

  // ── Catalog guards ───────────────────────────────────────────────────────
  for (const [svc, code] of [
    [FOREIGN, "SERVICE_NOT_IN_CATALOG"],
    [INACTIVE, "SERVICE_NOT_IN_CATALOG"],
    [UNPRICED, "ADDITIONAL_SERVICE_UNPRICED"],
  ]) {
    const r = await call(b1._id, { services: [String(svc)] });
    assert.strictEqual(r.code, 400, code);
    assert.strictEqual(r.body.code, code);
  }
  assert.strictEqual((await call(b1._id, { services: ["nope"] })).code, 400);
  assert.strictEqual((await call(b1._id, { lastServiceKm: -5 })).body.code, "INVALID_ODOMETER");
  assert.strictEqual((await call(b1._id, {})).body.code, "NOTHING_TO_UPDATE");
  // Another garage cannot touch it.
  assert.strictEqual((await call(b1._id, { lastServiceKm: 1 }, OTHER_DEALER)).code, 404);

  // ── Payment already selected: a price change voids the method + QR ───────
  const b2 = await makeBooking({ status: "payment_selected", payment_method: "ONLINE" });
  await Payment.collection.insertOne({
    booking_id: b2._id,
    dealer_id: DEALER,
    user_id: USER,
    orderAmount: b2.amountDue,
    payment_type: "UPI_QR",
    payment_by: "user",
    order_status: "PENDING",
    orderId: "TEST-ORDER-1",
    metadata: { gateway: "legacy" },
  });
  const reset = await call(b2._id, { services: [String(OIL)] });
  assert.strictEqual(reset.code, 200, JSON.stringify(reset.body));
  assert.strictEqual(reset.body.summary.paymentReset, true);
  const b2After = await Booking.findById(b2._id).select("+paymentOrderLockToken +paymentOrderLockUntil");
  assert.strictEqual(b2After.status, "awaiting_payment");
  assert.strictEqual(b2After.payment_method, null);
  assert.strictEqual(b2After.serviceAmount, 750);
  assert.ok(!b2After.paymentOrderLockToken, "payment order lock released");
  const stale = await Payment.findOne({ booking_id: b2._id });
  assert.notStrictEqual(stale.order_status, "PENDING");

  // Odometer-only edit while a method is selected leaves payment alone.
  const b3 = await makeBooking({ status: "payment_selected", payment_method: "CASH" });
  const kmOnly = await call(b3._id, { lastServiceKm: 15000 });
  assert.strictEqual(kmOnly.code, 200);
  const b3After = await Booking.findById(b3._id);
  assert.strictEqual(b3After.status, "payment_selected");
  assert.strictEqual(b3After.payment_method, "CASH");

  // A QR mint in flight holds the lock — the edit backs off.
  await Booking.collection.updateOne(
    { _id: b3._id },
    { $set: { paymentOrderLockToken: "x", paymentOrderLockUntil: new Date(Date.now() + 60000) } }
  );
  const locked = await call(b3._id, { services: [String(BELT)] });
  assert.strictEqual(locked.code, 409);
  assert.strictEqual(locked.body.code, "PAYMENT_IN_PROGRESS");
  assert.strictEqual((await Booking.findById(b3._id)).additionalServices.length, 0);

  // ── Paid, awaiting handover: record fields only ──────────────────────────
  const b4 = await makeBooking({
    status: "ready_for_delivery",
    billStatus: "paid",
    payment_status: "completed",
    payment_verified: true,
    billGenerated: true,
    payment_method: "CASH",
  });
  const lockedServices = await call(b4._id, { services: [String(BELT)] });
  assert.strictEqual(lockedServices.code, 409);
  assert.strictEqual(lockedServices.body.code, "PAYMENT_ALREADY_COLLECTED");
  const paidKm = await call(b4._id, { lastServiceKm: 13000, notes: ["Rear brake pads at 30%"] });
  assert.strictEqual(paidKm.code, 200, JSON.stringify(paidKm.body));
  const b4After = await Booking.findById(b4._id);
  assert.strictEqual(b4After.lastServiceKm, 13000);
  assert.strictEqual(b4After.amountDue, b4.amountDue);
  assert.strictEqual(b4After.status, "ready_for_delivery");

  // ── Delivered: nothing ───────────────────────────────────────────────────
  const b5 = await makeBooking({ status: "delivered", billStatus: "paid", payment_status: "completed" });
  const delivered = await call(b5._id, { lastServiceKm: 1 });
  assert.strictEqual(delivered.code, 409);
  assert.strictEqual(delivered.body.code, "BOOKING_DELIVERED");

  // ── Race: payment lands between our read and our write ───────────────────
  const b6 = await makeBooking({ status: "payment_selected", payment_method: "CASH" });
  const originalUpdateOne = Booking.updateOne.bind(Booking);
  Booking.updateOne = async (filter, ...rest) => {
    if (String(filter?._id) === String(b6._id) && filter.status) {
      await Booking.collection.updateOne(
        { _id: b6._id },
        { $set: { status: "ready_for_delivery", payment_status: "completed", billStatus: "paid" } }
      );
    }
    return originalUpdateOne(filter, ...rest);
  };
  try {
    const raced = await call(b6._id, { lastServiceKm: 999 });
    assert.strictEqual(raced.code, 409);
    assert.strictEqual(raced.body.code, "BOOKING_CHANGED");
  } finally {
    Booking.updateOne = originalUpdateOne;
  }
  const b6After = await Booking.findById(b6._id);
  assert.strictEqual(b6After.status, "ready_for_delivery");
  assert.notStrictEqual(b6After.lastServiceKm, 999);
}

(async () => {
  try {
    await mongoose.connect(TEST_URL, { serverSelectionTimeoutMS: 2000 });
  } catch (err) {
    console.log(`postServiceEdit.test.js — controller: SKIPPED (no mongod at ${TEST_URL})`);
    process.exit(0);
  }

  try {
    await mongoose.connection.dropDatabase();
    await run();
    console.log("postServiceEdit.test.js — controller: all assertions passed");
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
