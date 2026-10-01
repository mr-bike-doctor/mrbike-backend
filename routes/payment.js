const express = require('express');
const router = express.Router();
const { requireAdmin } = require("../middlewares/requireAdmin");
const { requireCustomer, requireOwnCustomerParam } = require("../middlewares/customerAuth");
const { requireBookingParticipant } = require("../middlewares/bookingAuth");
const { verifyDealerToken, requireOwnDealerBody } = require("../middlewares/dealerAuth");
const { getAllPayments,getBillByBookingId,getUserBillsSimple,getUserBillDetails,getAllBills, getPaymentById, createOrderForAdd, verifyWalletTopupStatus } = require("../controller/payment");

// Wallet top-up gateway callbacks arrive at POST /bikedoctor/payu/webhook.
router.post("/createOrderForAdd", verifyDealerToken, requireOwnDealerBody("dealer_id"), createOrderForAdd);
router.get("/wallet-topups/:orderId/status", verifyDealerToken, verifyWalletTopupStatus);
router.get("/all-payments", requireAdmin, getAllPayments);
router.get("/single-payment-detail/:id", requireAdmin, getPaymentById);
router.get('/bills/booking/:booking_id', requireBookingParticipant(req => req.params.booking_id), getBillByBookingId);
router.get('/bills/all', requireAdmin, getAllBills);
router.get('/user/:user_id/bills/simple', requireCustomer, requireOwnCustomerParam("user_id"), getUserBillsSimple);
router.get('/user/:user_id/bills/:bill_id', requireCustomer, requireOwnCustomerParam("user_id"), getUserBillDetails);

module.exports = router;
