const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { redactSensitive, createAdminBookingAuditEvent } = require("../services/bookingAudit");
const AdminBookingAudit = require("../models/AdminBookingAudit");

const redacted = redactSensitive({
  status: "confirmed", pickupOtp: "1234", deliveryOtp: "5678", accessToken: "secret",
  customer: { name: "A", device_token: "device-secret" },
});
assert.deepStrictEqual(redacted, { status: "confirmed", customer: { name: "A" } });

const event = createAdminBookingAuditEvent({
  bookingId: "000000000000000000000001", adminId: "000000000000000000000002",
  adminRole: "Admin", action: "booking.update", reason: "Correction", requestId: "req-1",
  before: { pickupOtp: 1111, pickupAddress: "Old" }, after: { pickupAddress: "New", paymentToken: "hidden" },
});
assert.strictEqual(event.requestId, "req-1");
assert.deepStrictEqual(event.before, { pickupAddress: "Old" });
assert.deepStrictEqual(event.after, { pickupAddress: "New" });

const hooks = AdminBookingAudit.schema.s.hooks._pres;
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete", "remove", "bulkWrite"]) {
  assert((hooks.get(operation) || []).length > 0, `${operation} has append-only middleware`);
}
assert.match(fs.readFileSync(path.join(__dirname, "../routes/bookingRoutes.js"), "utf8"), /:bookingId\/audit.*booking\.audit_read/);

console.log("Booking audit integrity tests passed");
