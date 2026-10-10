const assert = require("assert");
const { _test } = require("../controller/adminBookingModificationController");

const { normalizeLocation, editableState, planFromBody, requiresConsent, assertPlanPermissions, changesHash, requestedChanges, ModificationError } = _test;

function rejectsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ModificationError && error.code === code);
}

assert.deepStrictEqual(normalizeLocation({ address: "12 MG Road", latitude: 12.97, longitude: 77.59 }, "pickupLocation"), {
  address: "12 MG Road", latitude: 12.97, longitude: 77.59,
});
rejectsCode(() => normalizeLocation({ address: "", latitude: 12, longitude: 77 }, "pickupLocation"), "INVALID_LOCATION");
rejectsCode(() => normalizeLocation({ address: "Somewhere", latitude: 120, longitude: 77 }, "pickupLocation"), "INVALID_LOCATION");

assert.deepStrictEqual(planFromBody({ scheduleDate: "2026-10-20", timeSlot: "10:00-12:00" }), { schedule: true });
rejectsCode(() => planFromBody({ status: "delivered" }), "UNSUPPORTED_FIELDS");
rejectsCode(() => planFromBody({ totalBill: 1 }), "UNSUPPORTED_FIELDS");
const slotReservations = require("../services/bookingSlotReservations");
assert.strictEqual(slotReservations.reservationsEnabled(), false, "slot reservations stay disabled without both explicit readiness gates");
assert.throws(() => { throw new slotReservations.SlotUnavailableError(); }, (error) => error.code === "SCHEDULE_AVAILABILITY_UNVERIFIED");

editableState({ status: "confirmed", pickupStatus: "pending" }, { schedule: true, vehicle: true });
rejectsCode(() => editableState({ status: "delivered" }, { schedule: true }), "BOOKING_CLOSED");
rejectsCode(() => editableState({ status: "payment_selected", billStatus: "pending" }, { services: true }), "PAYMENT_SELECTION_LOCKED");
rejectsCode(() => editableState({ status: "completed", billStatus: "pending" }, { services: true }), "SERVICES_LOCKED");
rejectsCode(() => editableState({ status: "confirmed", pickupStatus: "BIKE_PICKED_UP" }, { vehicle: true }), "VEHICLE_LOCKED");
rejectsCode(() => editableState({ status: "confirmed", pickupStatus: "BIKE_PICKED_UP" }, { pickupLocation: true }), "PICKUP_LOCATION_LOCKED");

assert.strictEqual(requiresConsent({ amountDue: 100 }, { amountDue: 125 }), true);
assert.strictEqual(requiresConsent({ scheduleDate: "2026-10-20" }, { scheduleDate: "2026-10-21" }), true);
assertPlanPermissions({ auth: { adminRole: "Manager" } }, { services: true });
rejectsCode(() => assertPlanPermissions({ auth: { adminRole: "Subadmin" } }, { services: true }), "BOOKING_PERMISSION_DENIED");
rejectsCode(() => assertPlanPermissions({ auth: { adminRole: "Executive" } }, { pickupLocation: true }), "BOOKING_PERMISSION_DENIED");
const proposed = { scheduleDate: "2026-10-20", timeSlot: "10:00-12:00", reason: "support", consentReference: "not included" };
assert.deepStrictEqual(requestedChanges(proposed), { scheduleDate: "2026-10-20", timeSlot: "10:00-12:00" });
assert.strictEqual(changesHash({ a: 1, b: 2 }), changesHash({ b: 2, a: 1 }), "consent hash ignores object key order");
assert.notStrictEqual(changesHash({ scheduleDate: "2026-10-20" }), changesHash({ scheduleDate: "2026-10-21" }), "consent is bound to exact changes");

console.log("Admin booking modification policy checks passed.");
