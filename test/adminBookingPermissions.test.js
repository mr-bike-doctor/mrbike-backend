const assert = require("assert");
const { ROLE_PERMISSIONS, hasAdminBookingPermission, requireAdminBookingPermission } = require("../middlewares/adminBookingPermissions");

const permissions = [
  "booking.view", "booking.service_modify", "booking.location_correct", "booking.reassign",
  "booking.cancel", "booking.charge_review", "booking.complaint_manage", "booking.live_gps", "booking.audit_read",
];
for (const role of ["Admin", "Subadmin", "Manager", "Executive", "Telecaller"]) {
  assert(ROLE_PERMISSIONS[role], `${role} permission set exists`);
  assert.strictEqual(hasAdminBookingPermission(role, "booking.view"), true);
}
assert.strictEqual(hasAdminBookingPermission("Subadmin", "booking.service_modify"), false);
assert.strictEqual(hasAdminBookingPermission("Telecaller", "booking.live_gps"), false);
assert.strictEqual(hasAdminBookingPermission("Unknown", "booking.view"), false);
assert.strictEqual(hasAdminBookingPermission("Admin", "unknown.permission"), false);
for (const permission of permissions) assert.strictEqual(hasAdminBookingPermission("Admin", permission), true);

let nextCalled = false;
let responseCode;
requireAdminBookingPermission("booking.live_gps")(
  { auth: { role: "admin", adminRole: "Telecaller" } },
  { status(code) { responseCode = code; return this; }, json() {} },
  () => { nextCalled = true; },
);
assert.strictEqual(nextCalled, false);
assert.strictEqual(responseCode, 403);

console.log("Admin booking permission tests passed");
