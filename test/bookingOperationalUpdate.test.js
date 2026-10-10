const assert = require("assert");
const {
  validateOperationalUpdate,
  BookingOperationalUpdateError,
} = require("../services/bookingOperationalUpdate");

const base = {
  status: "confirmed",
  pickupStatus: "BOOKING_CONFIRMED",
  transportOption: "PICKUP_ONLY",
  billStatus: "pending",
  payment_status: "pending",
  billGenerated: false,
};

assert.doesNotThrow(() => validateOperationalUpdate({
  booking: base,
  nextTransportOption: "PICKUP_AND_DROP",
  conditionChanged: true,
}));

assert.doesNotThrow(() => validateOperationalUpdate({
  booking: {...base, pickupStatus: "BIKE_PICKED_UP"},
  nextTransportOption: "PICKUP_AND_DROP",
  conditionChanged: false,
}), "drop may be added after pickup");

assert.throws(
  () => validateOperationalUpdate({
    booking: {...base, pickupStatus: "BIKE_PICKED_UP"},
    nextTransportOption: "DROP_ONLY",
    conditionChanged: false,
  }),
  (error) => error instanceof BookingOperationalUpdateError && error.code === "PICKUP_LEG_LOCKED"
);

assert.throws(
  () => validateOperationalUpdate({
    booking: {...base, status: "completed"},
    nextTransportOption: "PICKUP_AND_DROP",
    conditionChanged: true,
  }),
  (error) => error.code === "BIKE_CONDITION_LOCKED"
);

for (const closed of [
  {...base, billStatus: "paid"},
  {...base, payment_status: "completed"},
  {...base, status: "delivered"},
]) {
  assert.throws(
    () => validateOperationalUpdate({ booking: closed, nextTransportOption: closed.transportOption, conditionChanged: true }),
    BookingOperationalUpdateError
  );
}

console.log("bookingOperationalUpdate.test.js: all assertions passed");
