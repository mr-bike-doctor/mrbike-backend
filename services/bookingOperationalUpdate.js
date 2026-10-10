const TRANSPORT_LEGS = Object.freeze({
  SELF_VISIT: { pickup: false, drop: false },
  PICKUP_ONLY: { pickup: true, drop: false },
  DROP_ONLY: { pickup: false, drop: true },
  PICKUP_AND_DROP: { pickup: true, drop: true },
});

const TERMINAL_STATUSES = new Set([
  "rejected", "user_cancelled", "cancelled", "expired", "delivered",
]);
const SERVICE_FINISHED_STATUSES = new Set([
  "completed", "awaiting_payment", "payment_selected", "ready_for_delivery", "delivered",
]);
const PICKUP_COMPLETED_STATUSES = new Set([
  "pickedup", "completed", "PICKUP_OTP_VERIFIED", "BIKE_PICKED_UP",
]);

class BookingOperationalUpdateError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = "BookingOperationalUpdateError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function transportLegs(option) {
  const legs = TRANSPORT_LEGS[option];
  if (!legs) {
    throw new BookingOperationalUpdateError(
      `Unsupported transport option: ${option}`,
      "INVALID_TRANSPORT_OPTION",
      400
    );
  }
  return legs;
}

function pickupHasHappened(booking) {
  return Boolean(
    PICKUP_COMPLETED_STATUSES.has(booking?.pickupStatus) ||
    SERVICE_FINISHED_STATUSES.has(booking?.status)
  );
}

function pricingIsClosed(booking) {
  return Boolean(
    booking?.billGenerated === true ||
    booking?.billStatus === "paid" ||
    booking?.payment_status === "completed" ||
    booking?.payment_method ||
    ["payment_selected", "ready_for_delivery"].includes(booking?.status) ||
    TERMINAL_STATUSES.has(booking?.status)
  );
}

function validateOperationalUpdate({ booking, nextTransportOption, conditionChanged }) {
  if (!booking) {
    throw new BookingOperationalUpdateError("Booking not found", "BOOKING_NOT_FOUND", 404);
  }
  if (TERMINAL_STATUSES.has(booking.status)) {
    throw new BookingOperationalUpdateError(
      "This booking is already closed and can no longer be updated.",
      "BOOKING_CLOSED"
    );
  }
  if (pricingIsClosed(booking)) {
    throw new BookingOperationalUpdateError(
      "Bike condition or transport cannot be changed after payment or billing.",
      "BOOKING_CLOSED_FOR_PRICING"
    );
  }
  if (conditionChanged) {
    if (booking.status === "pending") {
      throw new BookingOperationalUpdateError(
        "Accept the booking before recording the inspected bike condition.",
        "BOOKING_NOT_ACCEPTED"
      );
    }
    if (SERVICE_FINISHED_STATUSES.has(booking.status)) {
      throw new BookingOperationalUpdateError(
        "Bike condition is locked after service completion.",
        "BIKE_CONDITION_LOCKED"
      );
    }
  }

  const previous = transportLegs(booking.transportOption || "SELF_VISIT");
  const next = transportLegs(nextTransportOption);
  if (pickupHasHappened(booking) && previous.pickup !== next.pickup) {
    throw new BookingOperationalUpdateError(
      "The pickup leg has already happened and cannot be added or removed. You may still change the return drop.",
      "PICKUP_LEG_LOCKED"
    );
  }
  return { previous, next };
}

module.exports = {
  TRANSPORT_LEGS,
  BookingOperationalUpdateError,
  transportLegs,
  pickupHasHappened,
  pricingIsClosed,
  validateOperationalUpdate,
};
