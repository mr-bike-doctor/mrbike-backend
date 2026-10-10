const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { removeAdminBookingOtpFields } = require("../services/bookingResponsePrivacy");

const payload = {
  bookingId: "MRB-1", pickupOtp: 1234, pickupOtpExpiresAt: new Date(), deliveryOtp: 5678,
  nested: { deliveryOtp: 9999 },
};
const safe = removeAdminBookingOtpFields(payload);
assert.deepStrictEqual(safe, { bookingId: "MRB-1", nested: {} });

const controller = fs.readFileSync(path.join(__dirname, "../controller/booking.js"), "utf8");
assert.match(controller, /removeAdminBookingOtpFields\(doc\.toObject\(\{ virtuals: true \}\)\)/, "admin list strips OTP fields");
assert.match(controller, /removeAdminBookingOtpFields\(bookingresponce\.toObject\(\)\)/, "legacy admin details strip OTP fields");
assert.match(controller, /removeAdminBookingOtpFields\(result\)/, "admin booking details strip OTP fields");
assert.match(controller, /removeAdminBookingOtpFields\(rawBooking\)/, "admin user/dealer booking list strips OTP fields");
const adminDetails = fs.readFileSync(path.join(__dirname, "../../mrbike-admin-ui/src/components/Booking/BookingDetailsDialog.jsx"), "utf8");
assert.doesNotMatch(adminDetails, /booking\.(pickupOtp|deliveryOtp)/, "admin details UI does not render OTP values");

console.log("Booking OTP privacy tests passed");
