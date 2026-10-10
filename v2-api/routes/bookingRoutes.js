const express = require("express");
const router = express.Router();
const bookingController = require("../controllers/bookingController");

function retiredLegacyBookingMutation(req, res) {
  return res.status(410).json({
    status: false,
    code: "LEGACY_BOOKING_API_RETIRED",
    message: "This booking API is retired. Use the authenticated booking lifecycle endpoints.",
  });
}

// DEPRECATED — confirmed unused by User App, Dealer App and Admin UI.
// POST / returns 410 Gone (see controllers/bookingController.js#createBooking).
// Live booking creation is POST /bikedoctor/bookings/createBooking.
router.post("/", bookingController.createBooking);
router.get("/user/:userId", bookingController.getUserBookings);
router.post("/verify-otp", retiredLegacyBookingMutation);
router.patch("/:bookingId/status", retiredLegacyBookingMutation);
router.get("/:bookingId", bookingController.getBookingDetails);

module.exports = router;
