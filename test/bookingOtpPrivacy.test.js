const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { removeAdminBookingOtpFields, removeBookingOtpFields } = require("../services/bookingResponsePrivacy");

const payload = {
  bookingId: "MRB-1", pickupOtp: 1234, pickupOtpExpiresAt: new Date(), deliveryOtp: 5678,
  nested: { deliveryOtp: 9999 },
};
const safe = removeAdminBookingOtpFields(payload);
assert.deepStrictEqual(safe, { bookingId: "MRB-1", nested: {} });
assert.deepStrictEqual(removeBookingOtpFields(payload), { bookingId: "MRB-1", nested: {} });

const controller = fs.readFileSync(path.join(__dirname, "../controller/booking.js"), "utf8");
const schema = fs.readFileSync(path.join(__dirname, "../models/Booking.js"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "../routes/bookingRoutes.js"), "utf8");
assert.match(controller, /removeAdminBookingOtpFields\(doc\.toObject\(\{ virtuals: true \}\)\)/, "admin list strips OTP fields");
assert.match(controller, /removeBookingOtpFields\(bookingresponce\.toObject\(\)\)/, "non-customer detail responses strip OTP fields");
assert.match(controller, /req\.auth\?\.role === "customer" \? result : removeBookingOtpFields\(result\)/, "non-customer booking details strip OTP fields");
assert.match(controller, /req\.auth\?\.role === "customer" \? rawBooking : removeBookingOtpFields\(rawBooking\)/, "non-customer booking lists strip OTP fields");
assert.match(schema, /deliveryOtp:\s*\{\s*type:\s*Number,\s*default:\s*null,\s*select:\s*false\s*\}/, "delivery OTP is excluded from default queries");
assert.match(schema, /deliveryOtpExpiresAt:\s*\{\s*type:\s*Date,\s*default:\s*null,\s*select:\s*false\s*\}/, "delivery OTP expiry is excluded from default queries");
assert.match(controller, /req\.auth\?\.role === "customer"\) bookingQuery = bookingQuery\.select\("\+deliveryOtp"\)/, "single booking read explicitly selects OTP only for authenticated customers");
assert.match(controller, /req\.auth\?\.role === "customer" \? "\+deliveryOtp" : "-deliveryOtp"/, "booking list explicitly selects OTP only for authenticated customers");
const createBookingHandler = controller.slice(controller.indexOf("const createBooking ="), controller.indexOf("async function getBookingDetails"));
assert.doesNotMatch(createBookingHandler, /deliveryOtp,\s*timerExpiresAt/, "booking creation never returns a delivery OTP before payment confirmation");
assert.doesNotMatch(createBookingHandler, /deliveryOtp,\s*status:\s*"pending"/, "pending booking documents do not get delivery OTPs");
assert.match(routes, /post\('\/:bookingId\/confirm-cash-received', requireBookingParticipant\([^\n]+\), requireActorRole\("dealer"\)/, "cash confirmation requires authenticated booking dealer");
assert.match(routes, /post\('\/verify-delivery-otp', requireBookingParticipant\([^\n]+\), requireActorRole\("dealer"\)/, "delivery verification requires authenticated booking dealer");
assert.match(controller, /if \(stage === "delivery"\) return verifyDeliveryOtp\(req, res\)/, "legacy delivery verification delegates to expiry and atomic verification checks");
const adminDetails = fs.readFileSync(path.join(__dirname, "../../mrbike-admin-ui/src/components/Booking/BookingDetailsDialog.jsx"), "utf8");
assert.doesNotMatch(adminDetails, /booking\.(pickupOtp|deliveryOtp)/, "admin details UI does not render OTP values");

console.log("Booking OTP privacy tests passed");
