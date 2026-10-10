const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { canTransitionBookingStatus } = require("../services/bookingStatusPolicy");

assert.strictEqual(canTransitionBookingStatus("dealer", "pending", "confirmed"), true);
assert.strictEqual(canTransitionBookingStatus("dealer", "pending", "rejected"), true);
assert.strictEqual(canTransitionBookingStatus("dealer", "confirmed", "completed"), false);
assert.strictEqual(canTransitionBookingStatus("dealer", "pending", "cash received"), false);
assert.strictEqual(canTransitionBookingStatus("customer", "pending", "user_cancelled"), false);
assert.strictEqual(canTransitionBookingStatus("admin", "pending", "delivered"), false);
assert.strictEqual(canTransitionBookingStatus("unknown", "pending", "confirmed"), false);

const routes = fs.readFileSync(path.join(__dirname, "../routes/bookingRoutes.js"), "utf8");
const statusRoute = routes.match(/router\.post\('\/updateBookingStatus[^\n]+/);
assert(statusRoute, "status endpoint route exists");
assert.match(statusRoute[0], /requireActorRole\("dealer"\)/, "status route is dealer-only");
assert.match(routes, /router\.put\('\/updatebooking[^\n]+requireActorRole\("dealer"\)/, "legacy update route cannot be used by customers or admins");
const controller = fs.readFileSync(path.join(__dirname, "../controller/booking.js"), "utf8");
assert.match(controller, /LEGACY_BOOKING_UPDATE_RETIRED/);
const allowedFields = controller.match(/const UPDATE_BOOKING_ALLOWED_FIELDS = \[([\s\S]*?)\];/)[1];
assert.doesNotMatch(allowedFields, /pickupStatus|billGenerated/, "generic update cannot mutate lifecycle or invoice state");

console.log("Booking status authorization tests passed");
