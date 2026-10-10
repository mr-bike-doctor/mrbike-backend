const express = require('express');
const router = express.Router();
const { getInvoice, getDealerInvoices } = require("../controller/invoiceController");
const { verifyDealerToken, requireOwnDealer } = require("../middlewares/dealerAuth");
const { requireBookingParticipant } = require("../middlewares/bookingAuth");
const { requireAdminBookingPermission } = require("../middlewares/adminBookingPermissions");

router.get('/booking/:bookingId', requireBookingParticipant(req => req.params.bookingId), requireAdminBookingPermission("booking.view"), getInvoice);
router.get('/dealer/:dealerId', verifyDealerToken, requireOwnDealer('dealerId'), getDealerInvoices);

module.exports = router;
