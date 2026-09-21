const assert = require("assert");
const {
  CANCELLATION_REASONS,
  resolveCancellationReason,
  canCustomerCancel,
} = require("../utils/bookingCancellation");

assert.strictEqual(canCustomerCancel("pending", "awaiting"), true);
assert.strictEqual(canCustomerCancel("pending", "expired"), false);
assert.strictEqual(canCustomerCancel("confirmed", "accepted"), false);
assert.deepStrictEqual(resolveCancellationReason("need_to_reschedule"), {
  code: "NEED_TO_RESCHEDULE",
  label: "I need to reschedule",
});
assert.strictEqual(resolveCancellationReason("not-valid"), null);
assert.strictEqual(Object.keys(CANCELLATION_REASONS).length, 7);

console.log("Booking cancellation tests passed");
