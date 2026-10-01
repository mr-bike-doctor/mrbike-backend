const express = require("express")
const router = express.Router()
const { requireAdmin } = require("../middlewares/requireAdmin")
const { requireBookingParticipant, requirePaymentParticipant, requireActorRole } = require("../middlewares/bookingAuth")
const {
  generateUPIQRCode,
  checkPaymentStatus,
  payuWebhook,
  getPaymentByBooking,
  regenerateQRCode,
  cancelPayment,
  getAllQRPayments,
} = require("../controller/payuQRController")

/**
 * PayU Dynamic UPI QR Payment Routes
 * Base path: /bikedoctor/payu
 */

// Generate UPI QR Code for payment (Dealer App)
// POST /bikedoctor/payu/generate-qr
router.post("/generate-qr", requireBookingParticipant(req => req.body.booking_id), requireActorRole("dealer"), generateUPIQRCode)

// Check payment status (Polling from Dealer App)
// GET /bikedoctor/payu/status/:order_id
router.get("/status/:order_id", requirePaymentParticipant(req => ({ orderId: req.params.order_id })), checkPaymentStatus)

// PayU transaction callback (webhook + surl/furl). Reverse hash is verified in the handler.
// POST /bikedoctor/payu/webhook
router.post("/webhook", payuWebhook)

// Get payment details by booking ID
// GET /bikedoctor/payu/booking/:booking_id
router.get("/booking/:booking_id", requireBookingParticipant(req => req.params.booking_id), getPaymentByBooking)

// Re-serve the QR of a still-live attempt
// POST /bikedoctor/payu/regenerate/:payment_id
router.post("/regenerate/:payment_id", requirePaymentParticipant(req => ({ _id: req.params.payment_id })), requireActorRole("dealer"), regenerateQRCode)

// Cancel pending payment
// DELETE /bikedoctor/payu/cancel/:order_id
router.delete("/cancel/:order_id", requirePaymentParticipant(req => ({ orderId: req.params.order_id })), requireActorRole("dealer"), cancelPayment)

// Get all QR payments with filters
// GET /bikedoctor/payu/payments
router.get("/payments", requireAdmin, getAllQRPayments)

module.exports = router
