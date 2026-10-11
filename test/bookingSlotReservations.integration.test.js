// Slot reservation transactions run only on a dedicated loopback replica set.
const assert = require("assert");
const mongoose = require("mongoose");
const GarageSlotCapacity = require("../models/GarageSlotCapacity");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const Booking = require("../models/Booking");
const { reserveBookingSlot, checkSlotAvailability, capacityId, SlotUnavailableError } = require("../services/bookingSlotReservations");

if (!process.env.TEST_MONGO_URL) {
  console.log("bookingSlotReservations.integration.test.js — SKIPPED (set TEST_MONGO_URL to a dedicated loopback replica set)");
  process.exit(0);
}
const url = new URL(process.env.TEST_MONGO_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("TEST_MONGO_URL must be loopback");
url.pathname = `/mrbike_booking_slot_test_${new mongoose.Types.ObjectId()}`;

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}

async function reserveAndPersist(booking, dealerId, scheduleDate, timeSlot, hadPreviousSchedule) {
  return inTransaction(async (session) => {
    await reserveBookingSlot({ booking, scheduleDate, timeSlot, hadPreviousSchedule, session });
    await Booking.updateOne({ _id: booking._id }, { $set: { dealer_id: dealerId, scheduleDate, timeSlot, status: "confirmed" } }, { upsert: true, session });
  });
}

(async () => {
  const originalEnable = process.env.ENABLE_BOOKING_SLOT_RESERVATIONS;
  const originalReady = process.env.BOOKING_SLOT_RESERVATIONS_READY;
  const dealerId = new mongoose.Types.ObjectId();
  const bookingIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const day = "2031-06-18";
  const oldSlot = "09:00-10:00";
  const targetSlot = "10:00-11:00";
  const raceSlot = "11:00-12:00";
  const rollbackSlot = "12:00-13:00";
  try {
    await mongoose.connect(url.toString(), { serverSelectionTimeoutMS: 3000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("A local replica set is required for transaction tests");
    await GarageSlotCapacity.create([
      { _id: capacityId(dealerId, day, oldSlot), dealerId, scheduleDate: day, timeSlot: oldSlot, capacity: 1, reservedCount: 1 },
      { _id: capacityId(dealerId, day, targetSlot), dealerId, scheduleDate: day, timeSlot: targetSlot, capacity: 1, reservedCount: 0 },
      { _id: capacityId(dealerId, day, raceSlot), dealerId, scheduleDate: day, timeSlot: raceSlot, capacity: 1, reservedCount: 0 },
      { _id: capacityId(dealerId, day, rollbackSlot), dealerId, scheduleDate: day, timeSlot: rollbackSlot, capacity: 1, reservedCount: 0 },
    ]);
    const booking = { _id: bookingIds[0], dealer_id: dealerId };
    await Booking.collection.insertOne({ _id: booking._id, bookingId: `TEST-${booking._id}`, dealer_id: dealerId, scheduleDate: day, timeSlot: oldSlot, status: "confirmed" });
    await BookingSlotReservation.create({ bookingId: booking._id, dealerId, scheduleDate: day, timeSlot: oldSlot });

    process.env.ENABLE_BOOKING_SLOT_RESERVATIONS = "true";
    process.env.BOOKING_SLOT_RESERVATIONS_READY = "true";
    await assert.rejects(checkSlotAvailability({ booking: { _id: bookingIds[1], dealer_id: dealerId }, scheduleDate: day, timeSlot: "unconfigured" }), (error) => error instanceof SlotUnavailableError && error.code === "SCHEDULE_AVAILABILITY_UNVERIFIED");
    await assert.rejects(checkSlotAvailability({ booking: { _id: bookingIds[1], dealer_id: dealerId }, scheduleDate: day, timeSlot: oldSlot }), (error) => error instanceof SlotUnavailableError && error.code === "SCHEDULE_SLOT_UNAVAILABLE");
    await assert.rejects(checkSlotAvailability({ booking: { _id: bookingIds[1], dealer_id: dealerId, scheduleDate: day, timeSlot: oldSlot }, scheduleDate: day, timeSlot: targetSlot }), (error) => error instanceof SlotUnavailableError && error.code === "SCHEDULE_RESERVATION_BASELINE_MISSING");
    await reserveAndPersist(booking, dealerId, day, targetSlot, true);
    const [releasedOld, claimedTarget, movedReservation] = await Promise.all([
      GarageSlotCapacity.findById(capacityId(dealerId, day, oldSlot)).lean(),
      GarageSlotCapacity.findById(capacityId(dealerId, day, targetSlot)).lean(),
      BookingSlotReservation.findOne({ bookingId: booking._id }).lean(),
    ]);
    assert.strictEqual(releasedOld.reservedCount, 0, "old slot occupancy is released atomically");
    assert.strictEqual(claimedTarget.reservedCount, 1, "new slot is reserved atomically");
    assert.strictEqual(movedReservation.timeSlot, targetSlot);

    const raceBookings = [bookingIds[1], bookingIds[2]];
    await Booking.collection.insertMany(raceBookings.map((bookingId) => ({ _id: bookingId, bookingId: `TEST-${bookingId}`, dealer_id: dealerId, status: "pending" })));
    const raced = await Promise.allSettled(raceBookings.map((bookingId) => reserveAndPersist({ _id: bookingId, dealer_id: dealerId }, dealerId, day, raceSlot, false)));
    assert.strictEqual(raced.filter((result) => result.status === "fulfilled").length, 1, `capacity-one slot admits only one concurrent reservation: ${JSON.stringify(raced.map((result) => result.status === "rejected" ? String(result.reason?.stack || result.reason) : "committed"))}`);
    const [raceCapacity, raceReservations] = await Promise.all([
      GarageSlotCapacity.findById(capacityId(dealerId, day, raceSlot)).lean(),
      BookingSlotReservation.countDocuments({ dealerId, scheduleDate: day, timeSlot: raceSlot }),
    ]);
    assert.strictEqual(raceCapacity.reservedCount, 1);
    assert.strictEqual(raceReservations, 1);

    const rollbackId = new mongoose.Types.ObjectId();
    bookingIds.push(rollbackId);
    await Booking.collection.insertOne({ _id: rollbackId, bookingId: `TEST-${rollbackId}`, dealer_id: dealerId, status: "pending" });
    await assert.rejects(inTransaction(async (session) => {
      await reserveBookingSlot({ booking: { _id: rollbackId, dealer_id: dealerId }, scheduleDate: day, timeSlot: rollbackSlot, hadPreviousSchedule: false, session });
      await Booking.updateOne({ _id: rollbackId }, { $set: { dealer_id: dealerId, scheduleDate: day, timeSlot: rollbackSlot, status: "pending" } }, { session });
      throw new Error("force transaction rollback");
    }));
    assert.strictEqual((await GarageSlotCapacity.findById(capacityId(dealerId, day, rollbackSlot)).lean()).reservedCount, 0, "failed surrounding transaction rolls back slot increment");
    assert.strictEqual(await BookingSlotReservation.exists({ bookingId: rollbackId }), null);
    console.log("bookingSlotReservations.integration.test.js — gated configuration, atomic reserve/release, capacity race and rollback passed");
  } finally {
    if (mongoose.connection.readyState === 1) {
      await Promise.all([
        GarageSlotCapacity.deleteMany({ dealerId }),
        BookingSlotReservation.deleteMany({ bookingId: { $in: bookingIds } }),
        Booking.deleteMany({ _id: { $in: bookingIds } }),
      ]);
    }
    await mongoose.disconnect();
    if (originalEnable === undefined) delete process.env.ENABLE_BOOKING_SLOT_RESERVATIONS;
    else process.env.ENABLE_BOOKING_SLOT_RESERVATIONS = originalEnable;
    if (originalReady === undefined) delete process.env.BOOKING_SLOT_RESERVATIONS_READY;
    else process.env.BOOKING_SLOT_RESERVATIONS_READY = originalReady;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
