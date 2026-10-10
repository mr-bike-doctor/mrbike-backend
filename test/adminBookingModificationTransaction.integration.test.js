// Transaction integration uses only a unique test database on loopback.
// TEST_MONGO_URL must point to a dedicated local replica set, never production.
const assert = require("assert");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const BookingChangeConsent = require("../models/BookingChangeConsent");
const AdminBookingAudit = require("../models/AdminBookingAudit");
const { persistApprovedBookingModification, ConsentAlreadyResolvedError } = require("../services/adminBookingModificationTransaction");

const runId = new mongoose.Types.ObjectId();
if (!process.env.TEST_MONGO_URL) {
  console.log("adminBookingModificationTransaction.integration.test.js — SKIPPED (set TEST_MONGO_URL to a dedicated loopback replica set)");
  process.exit(0);
}
const url = new URL(process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:27027/mrbike_admin_modification_test");
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
  throw new Error("TEST_MONGO_URL must be loopback; refusing any remote database");
}
url.pathname = `/mrbike_admin_modification_test_${runId}`;

function auditFor(bookingId, requestId, _id) {
  return {
    ...( _id ? { _id } : {}), bookingId, adminId: new mongoose.Types.ObjectId(), adminRole: "Admin",
    action: "booking.admin_modification", reason: "integration test", occurredAt: new Date(),
    before: { status: "pending" }, after: { status: "confirmed" }, requestId,
  };
}

async function withTransaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

(async () => {
  const bookingIds = [];
  try {
    await mongoose.connect(url.toString(), { serverSelectionTimeoutMS: 3000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("Dedicated local MongoDB is not a replica set; transaction proof cannot run");

    const fixture = async (suffix) => {
      const booking = await Booking.create({
        user_id: new mongoose.Types.ObjectId(), dealer_id: new mongoose.Types.ObjectId(),
        userBike_id: new mongoose.Types.ObjectId(), status: "pending", bookingId: `ADMIN-MOD-${runId}-${suffix}`,
      });
      bookingIds.push(booking._id);
      const consent = await BookingChangeConsent.create({
        bookingId: booking._id, customerId: booking.user_id, requestedBy: new mongoose.Types.ObjectId(),
        adminRole: "Admin", reason: "integration test", changes: { status: "confirmed" },
        changesHash: "a".repeat(64), expectedUpdatedAt: booking.updatedAt,
        status: "approved", expiresAt: new Date(Date.now() + 60_000),
      });
      return { booking, consent };
    };

    const first = await fixture("commit");
    const originalVersion = first.booking.updatedAt;
    const committedAudit = auditFor(first.booking._id, `commit-${runId}`);
    await withTransaction(async (session) => {
      const booking = await Booking.findOne({ _id: first.booking._id, updatedAt: originalVersion }).session(session);
      assert(booking, "expected booking version is available");
      booking.status = "confirmed";
      await persistApprovedBookingModification({ booking, consent: first.consent, auditEvent: committedAudit, session });
    });
    const [committedBooking, committedConsent, savedAudit] = await Promise.all([
      Booking.findById(first.booking._id).lean(),
      BookingChangeConsent.findById(first.consent._id).lean(),
      AdminBookingAudit.findOne({ requestId: committedAudit.requestId }).lean(),
    ]);
    assert.strictEqual(committedBooking.status, "confirmed");
    assert.strictEqual(committedConsent.status, "applied");
    assert(savedAudit, "audit commits with booking and consent");
    assert.strictEqual(await Booking.findOne({ _id: first.booking._id, updatedAt: originalVersion }).lean(), null, "stale booking version is rejected");

    await assert.rejects(withTransaction(async (session) => {
      const booking = await Booking.findById(first.booking._id).session(session);
      const consent = await BookingChangeConsent.findById(first.consent._id).session(session);
      booking.status = "delivered";
      await persistApprovedBookingModification({ booking, consent, auditEvent: auditFor(first.booking._id, `duplicate-${runId}`), session });
    }), ConsentAlreadyResolvedError, "a duplicate approval cannot be applied twice");

    const concurrent = await fixture("concurrent");
    const attempts = ["confirmed", "payment_selected"].map((status, index) => withTransaction(async (session) => {
      const booking = await Booking.findById(concurrent.booking._id).session(session);
      const consent = await BookingChangeConsent.findById(concurrent.consent._id).session(session);
      booking.status = status;
      await persistApprovedBookingModification({ booking, consent, auditEvent: auditFor(concurrent.booking._id, `race-${runId}-${index}`), session });
    }));
    const raceResults = await Promise.allSettled(attempts);
    assert.strictEqual(raceResults.filter((result) => result.status === "fulfilled").length, 1, "only one concurrent approval can commit");
    assert.strictEqual(await AdminBookingAudit.countDocuments({ bookingId: concurrent.booking._id }), 1, "concurrent duplicate leaves exactly one audit event");

    const rollback = await fixture("rollback");
    const badAudit = auditFor(rollback.booking._id, `rollback-${runId}`, savedAudit._id);
    await assert.rejects(withTransaction(async (session) => {
      const booking = await Booking.findById(rollback.booking._id).session(session);
      const consent = await BookingChangeConsent.findById(rollback.consent._id).session(session);
      booking.status = "confirmed";
      await persistApprovedBookingModification({ booking, consent, auditEvent: badAudit, session });
    }), "duplicate audit _id forces transaction rollback");
    const [rolledBackBooking, rolledBackConsent, rolledBackAudit] = await Promise.all([
      Booking.findById(rollback.booking._id).lean(),
      BookingChangeConsent.findById(rollback.consent._id).lean(),
      AdminBookingAudit.findOne({ bookingId: rollback.booking._id }).lean(),
    ]);
    assert.strictEqual(rolledBackBooking.status, "pending", "booking mutation rolled back");
    assert.strictEqual(rolledBackConsent.status, "approved", "consent remains available after rollback");
    assert.strictEqual(rolledBackAudit, null, "failed transaction leaves no audit record");
    console.log("adminBookingModificationTransaction.integration.test.js — commit, rollback, stale version, duplicate and concurrent approvals passed");
  } finally {
    if (mongoose.connection.readyState === 1 && bookingIds.length) {
      await Promise.all([
        Booking.deleteMany({ _id: { $in: bookingIds } }),
        BookingChangeConsent.deleteMany({ bookingId: { $in: bookingIds } }),
        // The audit model intentionally rejects ordinary deletion; raw
        // collection cleanup is confined to these unique throwaway fixture IDs.
        AdminBookingAudit.collection.deleteMany({ bookingId: { $in: bookingIds } }),
      ]);
    }
    await mongoose.disconnect();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
