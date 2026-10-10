// Uses only a loopback MongoDB and a uniquely named test database. Transaction
// assertions are skipped on standalone mongod because it cannot run transactions.
const assert = require("assert");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const AdminBookingAudit = require("../models/AdminBookingAudit");
const { saveBookingWithAdminAudit } = require("../services/bookingAudit");

const USER_ID = new mongoose.Types.ObjectId();
const DEALER_ID = new mongoose.Types.ObjectId();
const BIKE_ID = new mongoose.Types.ObjectId();
const ADMIN_ID = new mongoose.Types.ObjectId();
const TEST_RUN = new mongoose.Types.ObjectId();

async function verifyUnsupportedFailsClosed() {
  const originalStartSession = mongoose.startSession;
  let bookingSaveCalls = 0;
  mongoose.startSession = async () => ({
    withTransaction: async () => { throw new Error("Transaction numbers are only allowed on a replica set member"); },
    endSession: async () => {},
  });
  try {
    await assert.rejects(saveBookingWithAdminAudit({ save: async () => { bookingSaveCalls += 1; } }, {}), /replica set member/);
    assert.strictEqual(bookingSaveCalls, 0, "booking save must not run when transaction support is unavailable");
  } finally {
    mongoose.startSession = originalStartSession;
  }
}

async function verifyRealTransactionIfAvailable() {
  const uri = process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:27017/mrbike_booking_audit_test";
  const parsed = new URL(uri);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("TEST_MONGO_URL must point to loopback; refusing non-local database access");
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 1500 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") {
    console.log("bookingAuditTransaction.integration.test.js — transaction test SKIPPED (loopback MongoDB is standalone)");
    return;
  }

  const bookingCollection = Booking.collection;
  const auditCollection = AdminBookingAudit.collection;
  await Booking.createCollection().catch((error) => { if (error.codeName !== "NamespaceExists") throw error; });
  await AdminBookingAudit.createCollection().catch((error) => { if (error.codeName !== "NamespaceExists") throw error; });

  const booking = new Booking({
    user_id: USER_ID, dealer_id: DEALER_ID, userBike_id: BIKE_ID,
    status: "pending", bookingId: `AUDIT-TEST-${TEST_RUN}`,
  });
  const validAudit = {
    bookingId: booking._id, adminId: ADMIN_ID, adminRole: "Admin", action: "test.update",
    reason: "transaction integration test", occurredAt: new Date(), before: { status: "pending" },
    after: { status: "confirmed" }, requestId: String(TEST_RUN),
  };

  try {
    await saveBookingWithAdminAudit(booking, validAudit);
    const savedAudit = await AdminBookingAudit.findOne({ bookingId: booking._id }).lean();
    assert(savedAudit, "booking update and audit record commit together");

    const changed = await Booking.findById(booking._id);
    changed.status = "completed";
    const invalidAudit = { ...validAudit, action: undefined, requestId: `${TEST_RUN}-invalid` };
    await assert.rejects(saveBookingWithAdminAudit(changed, invalidAudit));
    const persisted = await Booking.findById(booking._id).lean();
    const invalidRecord = await AdminBookingAudit.findOne({ requestId: `${TEST_RUN}-invalid` }).lean();
    assert.strictEqual(persisted.status, "pending", "booking write rolls back if audit insert fails");
    assert.strictEqual(invalidRecord, null, "failed audit insert leaves no audit record");
    console.log("bookingAuditTransaction.integration.test.js — transaction commit/rollback assertions passed");
  } finally {
    await bookingCollection.deleteMany({ _id: booking._id });
    await auditCollection.deleteMany({ bookingId: booking._id });
  }
}

(async () => {
  try {
    await verifyUnsupportedFailsClosed();
    await verifyRealTransactionIfAvailable();
  } catch (error) {
    if (error.name === "MongoServerSelectionError") {
      console.log("bookingAuditTransaction.integration.test.js — database transaction test SKIPPED (loopback mongod unavailable)");
    } else {
      throw error;
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
