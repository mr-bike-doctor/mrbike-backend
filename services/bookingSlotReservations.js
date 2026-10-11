const crypto = require("crypto");
const Booking = require("../models/Booking");
const GarageSlotCapacity = require("../models/GarageSlotCapacity");
const BookingSlotReservation = require("../models/BookingSlotReservation");

class SlotUnavailableError extends Error {
  constructor(code = "SCHEDULE_AVAILABILITY_UNVERIFIED", message = "Schedule changes are unavailable until garage slot capacity and existing reservations are configured.") {
    super(message);
    this.code = code;
    this.status = code === "SCHEDULE_SLOT_UNAVAILABLE" ? 409 : 503;
  }
}

function reservationsEnabled() {
  return process.env.ENABLE_BOOKING_SLOT_RESERVATIONS === "true" &&
    process.env.BOOKING_SLOT_RESERVATIONS_READY === "true";
}

async function reservationsReady() {
  if (!reservationsEnabled()) return false;
  try {
    const indexes = await BookingSlotReservation.collection.indexes();
    return indexes.some((index) => index.unique === true && index.key?.bookingId === 1);
  } catch (_error) {
    return false;
  }
}

function capacityId(dealerId, scheduleDate, timeSlot) {
  return `slot_${crypto.createHash("sha256").update(`${dealerId}|${scheduleDate}|${timeSlot}`).digest("hex")}`;
}

function slotKeyMatches(record, dealerId, scheduleDate, timeSlot) {
  return record && String(record.dealerId) === String(dealerId) &&
    record.scheduleDate === scheduleDate && record.timeSlot === timeSlot;
}

const SLOT_TERMINAL_STATUSES = ["rejected", "user_cancelled", "cancelled", "expired", "delivered"];

async function inspectAuthoritativeSlot({ dealerId, scheduleDate, timeSlot, session }) {
  const [capacity, bookings, reservations] = await Promise.all([
    GarageSlotCapacity.findOne({ _id: capacityId(dealerId, scheduleDate, timeSlot), dealerId, scheduleDate, timeSlot, active: true }).session(session || null).lean(),
    Booking.find({ dealer_id: dealerId, scheduleDate, timeSlot, status: { $nin: SLOT_TERMINAL_STATUSES } }).select("_id").session(session || null).lean(),
    BookingSlotReservation.find({ dealerId, scheduleDate, timeSlot }).select("bookingId dealerId scheduleDate timeSlot").session(session || null).lean(),
  ]);
  if (!capacity || !Number.isInteger(capacity.capacity) || capacity.capacity < 1 || !Number.isInteger(capacity.reservedCount) || capacity.reservedCount < 0) {
    throw new SlotUnavailableError("SCHEDULE_AVAILABILITY_UNVERIFIED", "Garage capacity for this date and time is missing or invalid.");
  }
  const bookingIds = new Set(bookings.map((booking) => String(booking._id)));
  const reservationIds = new Set(reservations.map((reservation) => String(reservation.bookingId)));
  if (reservations.some((reservation) => !bookingIds.has(String(reservation.bookingId)))) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_INCONSISTENT", "A slot reservation does not match an active booking. Availability needs reconciliation before rescheduling.");
  }
  if (capacity.reservedCount !== bookingIds.size || capacity.reservedCount > capacity.capacity) {
    throw new SlotUnavailableError("SCHEDULE_RECONCILIATION_REQUIRED", "Configured slot occupancy does not match active booking records. Rescheduling is disabled until the garage slot is reconciled.");
  }
  return { capacity, bookings, reservations, bookingIds, reservationIds };
}

async function reconcileAuthoritativeSlot({ dealerId, scheduleDate, timeSlot, session }) {
  const slot = await inspectAuthoritativeSlot({ dealerId, scheduleDate, timeSlot, session });
  const missing = slot.bookings.filter((booking) => !slot.reservationIds.has(String(booking._id)));
  if (missing.length) {
    await BookingSlotReservation.create(missing.map((booking) => ({
      bookingId: booking._id,
      dealerId,
      scheduleDate,
      timeSlot,
    })), { session });
  }
  return slot;
}

async function checkSlotAvailability({ booking, scheduleDate, timeSlot }) {
  if (!(await reservationsReady())) throw new SlotUnavailableError();
  if (booking.scheduleDate === scheduleDate && booking.timeSlot === timeSlot) return;
  let current = await BookingSlotReservation.findOne({ bookingId: booking._id }).lean();
  if ((booking.scheduleDate || booking.timeSlot) && !current) {
    if (!booking.scheduleDate || !booking.timeSlot) throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "This booking has an incomplete schedule, so its existing capacity reservation cannot be verified.");
    const oldSlot = await inspectAuthoritativeSlot({ dealerId: booking.dealer_id, scheduleDate: booking.scheduleDate, timeSlot: booking.timeSlot });
    if (!oldSlot.bookingIds.has(String(booking._id))) throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "The booking is not present in authoritative occupancy for its existing slot.");
  }
  if (current && !slotKeyMatches(current, booking.dealer_id, booking.scheduleDate, booking.timeSlot)) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_INCONSISTENT", "This booking's reservation does not match its current schedule.");
  }
  const target = await inspectAuthoritativeSlot({ dealerId: booking.dealer_id, scheduleDate, timeSlot });
  const sameSlot = slotKeyMatches(current, booking.dealer_id, scheduleDate, timeSlot);
  if (!sameSlot && target.capacity.reservedCount >= target.capacity.capacity) {
    throw new SlotUnavailableError("SCHEDULE_SLOT_UNAVAILABLE", "That garage slot is full. Choose another available date or time.");
  }
}

async function checkBookingScheduleReadiness(booking) {
  if (!(await reservationsReady())) throw new SlotUnavailableError();
  if (!booking.scheduleDate && !booking.timeSlot) return true;
  if (!booking.scheduleDate || !booking.timeSlot) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "This booking has an incomplete current schedule, so its slot occupancy cannot be verified.");
  }
  const current = await inspectAuthoritativeSlot({ dealerId: booking.dealer_id, scheduleDate: booking.scheduleDate, timeSlot: booking.timeSlot });
  if (!current.bookingIds.has(String(booking._id))) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "This booking is missing from authoritative occupancy for its current slot.");
  }
  const reservation = await BookingSlotReservation.findOne({ bookingId: booking._id }).lean();
  if (reservation && !slotKeyMatches(reservation, booking.dealer_id, booking.scheduleDate, booking.timeSlot)) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_INCONSISTENT", "This booking's reservation does not match its current schedule.");
  }
  return true;
}

async function reserveBookingSlot({ booking, scheduleDate, timeSlot, hadPreviousSchedule, previousScheduleDate, previousTimeSlot, session }) {
  if (!(await reservationsReady())) throw new SlotUnavailableError();

  let old = await BookingSlotReservation.findOne({ bookingId: booking._id }).session(session);
  if (hadPreviousSchedule && !old) {
    const priorDate = previousScheduleDate || booking.scheduleDate;
    const priorTimeSlot = previousTimeSlot || booking.timeSlot;
    if (!priorDate || !priorTimeSlot) throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "This booking has an incomplete schedule, so its existing capacity reservation cannot be verified.");
    const oldSlot = await reconcileAuthoritativeSlot({ dealerId: booking.dealer_id, scheduleDate: priorDate, timeSlot: priorTimeSlot, session });
    if (!oldSlot.bookingIds.has(String(booking._id))) throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "The booking is not present in authoritative occupancy for its existing slot.");
    old = await BookingSlotReservation.findOne({ bookingId: booking._id }).session(session);
    if (!old) throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING");
  }
  await reconcileAuthoritativeSlot({ dealerId: booking.dealer_id, scheduleDate, timeSlot, session });
  const oldIsTarget = slotKeyMatches(old, booking.dealer_id, scheduleDate, timeSlot);
  if (oldIsTarget) return;

  const target = await GarageSlotCapacity.findOneAndUpdate(
    { _id: capacityId(booking.dealer_id, scheduleDate, timeSlot), dealerId: booking.dealer_id, scheduleDate, timeSlot, active: true, $expr: { $lt: ["$reservedCount", "$capacity"] } },
    { $inc: { reservedCount: 1 } },
    { new: true, session },
  );
  if (!target) throw new SlotUnavailableError("SCHEDULE_SLOT_UNAVAILABLE", "That garage slot is full or not configured. Choose another available date or time.");

  if (old) {
    const released = await GarageSlotCapacity.updateOne(
      { _id: capacityId(old.dealerId, old.scheduleDate, old.timeSlot), dealerId: old.dealerId, scheduleDate: old.scheduleDate, timeSlot: old.timeSlot, reservedCount: { $gt: 0 } },
      { $inc: { reservedCount: -1 } }, { session },
    );
    if (released.modifiedCount !== 1) throw new SlotUnavailableError("SCHEDULE_RESERVATION_INCONSISTENT", "The existing garage reservation could not be safely released. No changes were saved.");
    old.dealerId = booking.dealer_id;
    old.scheduleDate = scheduleDate;
    old.timeSlot = timeSlot;
    await old.save({ session });
  } else {
    await BookingSlotReservation.create([{ bookingId: booking._id, dealerId: booking.dealer_id, scheduleDate, timeSlot }], { session });
  }
}

module.exports = { SlotUnavailableError, reservationsEnabled, reservationsReady, capacityId, checkSlotAvailability, checkBookingScheduleReadiness, reserveBookingSlot, inspectAuthoritativeSlot, reconcileAuthoritativeSlot };
