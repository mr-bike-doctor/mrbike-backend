const crypto = require("crypto");
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

async function checkSlotAvailability({ booking, scheduleDate, timeSlot }) {
  if (!(await reservationsReady())) throw new SlotUnavailableError();
  if (booking.scheduleDate === scheduleDate && booking.timeSlot === timeSlot) return;
  const current = await BookingSlotReservation.findOne({ bookingId: booking._id }).lean();
  if ((booking.scheduleDate || booking.timeSlot) && !current) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "This booking has no verified garage slot reservation. Schedule changes are disabled until existing bookings are reconciled.");
  }
  const capacity = await GarageSlotCapacity.findOne({ _id: capacityId(booking.dealer_id, scheduleDate, timeSlot), dealerId: booking.dealer_id, scheduleDate, timeSlot, active: true }).lean();
  if (!capacity || !Number.isInteger(capacity.capacity) || capacity.capacity < 1 || !Number.isInteger(capacity.reservedCount) || capacity.reservedCount < 0) {
    throw new SlotUnavailableError();
  }
  const sameSlot = slotKeyMatches(current, booking.dealer_id, scheduleDate, timeSlot);
  if (!sameSlot && capacity.reservedCount >= capacity.capacity) {
    throw new SlotUnavailableError("SCHEDULE_SLOT_UNAVAILABLE", "That garage slot is full. Choose another available date or time.");
  }
}

async function reserveBookingSlot({ booking, scheduleDate, timeSlot, hadPreviousSchedule, session }) {
  if (!(await reservationsReady())) throw new SlotUnavailableError();

  const old = await BookingSlotReservation.findOne({ bookingId: booking._id }).session(session);
  if (hadPreviousSchedule && !old) {
    throw new SlotUnavailableError("SCHEDULE_RESERVATION_BASELINE_MISSING", "This booking has no verified garage slot reservation. Schedule changes are disabled until existing bookings are reconciled.");
  }
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

module.exports = { SlotUnavailableError, reservationsEnabled, reservationsReady, capacityId, checkSlotAvailability, reserveBookingSlot };
