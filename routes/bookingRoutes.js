var express = require('express');
const router = express.Router();
const { requireAdmin } = require("../middlewares/requireAdmin");
const { requireCustomer, requireOwnedBooking } = require("../middlewares/customerAuth");
const { requireBookingParticipant, requireOwnBookingList, requireActorRole, requireActorRoleAny } = require("../middlewares/bookingAuth");
const { getNotificationsByReceiverId } = require("../controller/notificationController");
const { createS3Upload } = require("../utils/s3Upload");
const { 
    addbooking, 
    getallbookings, 
    getbooking, 
    deletebooking, 
    getuserbookings,
    createBooking,
    getBookingDetails,
    updateBooking,
    updateTowingCharge,
    updateBookingStatus,
    verifyBookingOTP,
    sendBookingOTP,
    updatePickupStatus,
    markCustomerArrived,
    deleteNoteFromBooking,
    updateNoteInBooking,
    getNotesFromBooking,
    addNoteToBooking,
    updateBookings,
    sendOtpToMobile,
    verifyOtpForMobile,
    cancelBooking,
    getBookingTimerStatus,
    serviceComplete,
    selectPaymentMethod,
    confirmCashReceived,
    verifyDeliveryOtp,
    regenerateDeliveryOtp,
    uploadCompletionPhotos,
    getCompletionPhotos,
    deleteCompletionPhoto,
    // updateBookingStatusDealer
} = require("../controller/booking")
const {
    startPickup,
    updatePickupLocation,
    markArrived,
    getPickupOtpForCustomer,
    verifyPickupOtp,
    completeBikePickup,
} = require("../controller/pickupLifecycleController");

const MAX_COMPLETION_PHOTOS_PER_REQUEST = 6;

// Completion photos go to S3 through the project's standard multer-S3 factory
// (utils/s3Upload.js) — the same one behind dealer documents, review images
// and shop images. Images only: unlike the shared default this drops .pdf,
// because a "photo of the finished work" is never a PDF and the apps render
// these straight into an <Image>. 10MB is well above a compressed phone photo
// (the partner app ships them at quality 0.7 / max 1600px) while still being a
// hard stop on an accidental full-resolution upload.
//
// The previous disk-storage multer declared here was never attached to any
// route — writing booking uploads to the server's local ./upload/booking
// folder would not have survived a redeploy anyway.
const completionPhotoUpload = createS3Upload("booking-completion-photos", {
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
    maxFileSizeBytes: 10 * 1024 * 1024,
});

// multer rejects (bad type, oversized file, too many files) surface as errors
// from the middleware, which would otherwise hit the generic 500 handler and
// tell the garage nothing. Turn them into the 400 the partner app renders.
function handleCompletionPhotoUpload(req, res, next) {
    completionPhotoUpload.array("photos", MAX_COMPLETION_PHOTOS_PER_REQUEST)(req, res, (err) => {
        if (!err) return next();
        const message =
            err.code === "LIMIT_FILE_SIZE" ? "Each photo must be 10MB or smaller." :
            err.code === "LIMIT_UNEXPECTED_FILE" ? `Upload at most ${MAX_COMPLETION_PHOTOS_PER_REQUEST} photos at a time.` :
            err.message || "Photo upload failed.";
        return res.status(400).json({ success: false, message });
    });
}

router.post('/addbooking/:id', requireAdmin, addbooking)

// By Prashant 
router.get('/getallbookings', requireAdmin, getallbookings)


router.get('/getuserbookings/:user_id', requireOwnBookingList, getuserbookings)
router.get('/getbooking/:id', requireBookingParticipant(req => req.params.id), getbooking)
router.delete('/deletebooking', requireAdmin, deletebooking)
router.put('/updatebooking/:id', requireBookingParticipant(req => req.params.id), updateBookings)
router.post('/createBooking', requireCustomer, createBooking)
router.get('/getBookingDetails/:id', requireBookingParticipant(req => req.params.id), getBookingDetails)
router.post('/updateBooking', requireBookingParticipant(req => req.body.bookingId), updateBooking)
// Towing charge — dealer handling the booking or an admin, pre-payment only.
// Recomputes the whole pricing breakdown server-side; see controller/booking.js.
router.post('/:bookingId/towing-charge', requireBookingParticipant(req => req.params.bookingId), requireActorRoleAny("dealer", "admin"), updateTowingCharge)
router.post('/updateBookingStatus/:bookingId/status', requireBookingParticipant(req => req.params.bookingId), updateBookingStatus)
router.post('/sendBookingOTP', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), sendBookingOTP)
router.post('/sendBookingMobile', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), sendOtpToMobile)
router.post('/verifyBookingOTP', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), verifyBookingOTP)
router.post('/verifyBookingMobile', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), verifyOtpForMobile)
router.post("/update-pickup-status", requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), updatePickupStatus);
router.post('/:bookingId/customer-arrived', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), markCustomerArrived);
// Authenticated dealer pickup lifecycle. Participant lookup deliberately
// returns 404 to a dealer who does not own the booking.
router.post('/:bookingId/pickup/start', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), startPickup);
router.patch('/:bookingId/pickup/location', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), updatePickupLocation);
router.post('/:bookingId/pickup/arrived', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), markArrived);
router.get('/:bookingId/pickup/otp', requireBookingParticipant(req => req.params.bookingId), requireActorRole("customer"), getPickupOtpForCustomer);
router.post('/:bookingId/pickup/verify-otp', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), verifyPickupOtp);
router.post('/:bookingId/pickup/complete', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), completeBikePickup);
router.post('/addNote', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), addNoteToBooking);
router.get('/getNotes/:bookingId', requireBookingParticipant(req => req.params.bookingId), getNotesFromBooking);
router.put('/updateNote', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), updateNoteInBooking);
router.post('/deleteNote', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), deleteNoteFromBooking);
router.post('/cancelBooking/:bookingId', requireCustomer, requireOwnedBooking("bookingId"), cancelBooking);
router.get('/getBookingTimerStatus/:bookingId', requireBookingParticipant(req => req.params.bookingId), getBookingTimerStatus);
router.post('/:bookingId/service-complete', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), serviceComplete);

// ── Completion photos — ADMIN-INTERNAL, never customer-facing ──────────────
// requireBookingParticipant 404s a dealer who does not own this booking, so a
// garage can never reach another garage's photos. The role gate on top is what
// keeps the CUSTOMER out: a customer authenticated on their own booking passes
// the participant check and is then rejected here. Reads are also open to
// admins, for the booking details screen in the admin panel.
// See controller/booking.js for why `completionPhotos` is `select: false`.
router.post('/:bookingId/completion-photos', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), handleCompletionPhotoUpload, uploadCompletionPhotos);
router.get('/:bookingId/completion-photos', requireBookingParticipant(req => req.params.bookingId), requireActorRoleAny("dealer", "admin"), getCompletionPhotos);
router.delete('/:bookingId/completion-photos/:photoId', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), deleteCompletionPhoto);
router.post('/:bookingId/select-payment-method', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), selectPaymentMethod);
router.post('/:bookingId/confirm-cash-received', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), confirmCashReceived);
router.post('/verify-delivery-otp', requireBookingParticipant(req => req.body.bookingId), requireActorRole("dealer"), verifyDeliveryOtp);
router.post('/:bookingId/regenerate-delivery-otp', requireBookingParticipant(req => req.params.bookingId), requireActorRole("dealer"), regenerateDeliveryOtp);

router.get("notification/:receiverId", getNotificationsByReceiverId);
// router.put('/updateBookingStatus/:booking_id', updateBookingStatusDealer);

module.exports = router;
