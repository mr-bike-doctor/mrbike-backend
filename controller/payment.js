var crypto = require('crypto');
const jwt_decode = require("jwt-decode");
const { sendBookingNotification } = require("../helper/pushNotification");
const { settleBookingWallet } = require("../helper/walletSettlement");
const { type } = require("os");
const Booking = require("../models/Booking");
// const Booking = require("../models/Booking");
var Tracking = require("../models/Tracking");
const { default: axios } = require("axios");
var Payment = require("../models/Payment");
const customers = require("../models/customer_model");
const Dealer = require("../models/dealerModel");
const Card = require("../models/cardModel");
const Wallet = require("../models/Wallet_modal")
const Razorpay = require('razorpay');
const { method } = require('lodash');
const contacts = require("../models/Contact_model")
const FundAccount = require("../models/FundAccount_model")
const CryptoJS = require('crypto-js');
const QRCode = require('qrcode');
const API_KEY_ID = process.env.API_KEY_ID_RAZO;
const API_KEY_SECRET = process.env.API_KEY_SECRET_RAZO;
const Customer = require("../models/customer_model");
const Bill = require("../models/billSchema");
const {
    acquirePaymentOrderLock,
    releasePaymentOrderLock,
    cancelPendingPaymentSessions,
} = require("../helper/paymentSession");
const {
    enqueuePaymentReconciliation,
    completeReconciliationTask,
} = require("../services/paymentReconciliationService");
const { finalizeWalletTopup } = require("../services/walletTopupService");
const payu = require("../services/payuService");

const PAYMENT_DEALER_FIELDS =
    "name shopName ownerName email shopEmail personalEmail phone personalPhone wallet";


// Bill generation is centralized in services/invoiceService.js (single
// source of truth shared by the PayU QR flow, cash-received/
// cash-confirm paths, and the booking-completed fallback). This wrapper
// keeps the historical name/signature so none of those call sites need to
// change — they already gate on the correct booking/payment state before
// calling this.
const { getOrCreateInvoice } = require("../services/invoiceService");
const generateBill = async (payment) => {
    return getOrCreateInvoice(payment.booking_id, {
        payment_id: payment._id,
        payment_method: payment.payment_method,
        transaction_id: payment.transaction_id,
    });
};

// Get Bill by Booking ID
const getBillByBookingId = async (req, res) => {
    try {
        const { booking_id } = req.params;

        const bill = await Bill.findOne({ booking_id: booking_id })
            .populate("booking_id")
            .populate("payment_id");

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: "Bill not found for this booking"
            });
        }

        res.status(200).json({
            success: true,
            message: "Bill fetched successfully",
            data: bill
        });

    } catch (error) {
        console.error("Get Bill Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch bill",
        });
    }
};

// Get All Bills with Filtering
const getAllBills = async (req, res) => {
    try {
        const { page = 1, limit = 10, startDate, endDate } = req.query;

        const filters = {};

        // Date range filter
        if (startDate || endDate) {
            filters.bill_date = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                filters.bill_date.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                filters.bill_date.$lte = end;
            }
        }

        const bills = await Bill.find(filters)
            .populate("booking_id")
            .populate("payment_id")
            .sort({ bill_date: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const totalBills = await Bill.countDocuments(filters);

        res.status(200).json({
            success: true,
            message: "Bills fetched successfully",
            data: {
                bills,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(totalBills / limit),
                    totalBills
                }
            }
        });

    } catch (error) {
        console.error("Get All Bills Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch bills"
        });
    }
};

//  Get single payment details
const getPaymentById = async (req, res) => {
    try {
        const { id } = req.params;

        // Find by MongoDB _id OR orderId
        let payment = await Payment.findById(id)
            .populate({
                path: "booking_id",
                select: "bookingId totalBill status serviceDate",
                options: { strictPopulate: false },
            })
            .populate("dealer_id", PAYMENT_DEALER_FIELDS)
            .populate("user_id", "first_name last_name email phone");

        // If not found by _id, try finding by orderId
        if (!payment) {
            payment = await Payment.findOne({ orderId: id })
                .populate({
                    path: "booking_id",
                    select: "bookingId totalBill status serviceDate",
                    options: { strictPopulate: false },
                })
                .populate("dealer_id", PAYMENT_DEALER_FIELDS)
                .populate("user_id", "first_name last_name email phone");
        }

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Payment fetched successfully",
            data: payment,
        });
    } catch (error) {
        console.error("Error fetching payment:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch payment",
        });
    }
};

// Get All Payments 
const getAllPayments = async (req, res) => {
    try {
        // 🔍 Build filters dynamically
        const filters = {};

        // Status filter
        if (req.query.status) {
            filters.order_status = req.query.status.trim().toUpperCase();
        }

        // Dealer filter
        if (req.query.dealer_id) {
            filters.dealer_id = req.query.dealer_id;
        }

        // User filter
        if (req.query.user_id) {
            filters.user_id = req.query.user_id;
        }

        // Date range filter (optional)
        if (req.query.startDate && req.query.endDate) {
            const start = new Date(req.query.startDate);
            const end = new Date(req.query.endDate);
            if (!isNaN(start) && !isNaN(end)) {
                end.setHours(23, 59, 59, 999);
                filters.createdAt = { $gte: start, $lte: end };
            }
        }

        // 🕒 Sort (latest first)
        const sort = { createdAt: -1 };

        // 📦 Fetch all records (no skip/limit)
        const payments = await Payment.find(filters)
            .populate({
                path: "booking_id",
                select: "bookingId totalBill status serviceDate",
                options: { strictPopulate: false },
            })
            .populate("dealer_id", PAYMENT_DEALER_FIELDS)
            .populate("user_id", "first_name last_name email phone")
            .sort(sort)
            .lean();

        // 🧾 Send response
        res.status(200).json({
            success: true,
            message: "All payments fetched successfully",
            totalRecords: payments.length,
            data: payments,
        });

    } catch (error) {
        console.error("❌ Error fetching all payments:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch payments",
        });
    }
};

// Get All Bills for User (Simplified)
const getUserBillsSimple = async (req, res) => {
    try {
        const user_id = req.user_id;

        // Get all bookings for this user
        const userBookings = await Booking.find({ user_id: user_id })
            .select('_id bookingId serviceDate status')
            .populate('userBike_id', 'model registration_number');

        if (userBookings.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No bookings found for this user",
                data: []
            });
        }

        const bookingIds = userBookings.map(booking => booking._id);

        // Get all bills for these bookings
        const bills = await Bill.find({ booking_id: { $in: bookingIds } })
            .populate('payment_id', 'orderId payment_method')
            .sort({ bill_date: -1 })
            .lean();

        // Map bills with booking details
        const billsWithDetails = bills.map(bill => {
            const booking = userBookings.find(b => b._id.toString() === bill.booking_id.toString());
            return {
                bill_id: bill._id,
                bill_number: bill.bill_number,
                bill_date: bill.bill_date,
                booking_id: booking?._id,
                booking_number: booking?.bookingId,
                service_date: booking?.serviceDate,
                bike_model: booking?.userBike_id?.model,
                bike_registration: booking?.userBike_id?.registration_number,
                booking_status: booking?.status,
                customer_name: bill.customer_details?.name,
                total_amount: bill.total_amount,
                payment_method: bill.payment_details?.payment_method,
                bill_status: bill.status
            };
        });

        res.status(200).json({
            success: true,
            message: "User bills fetched successfully",
            data: billsWithDetails
        });

    } catch (error) {
        console.error("Get User Bills Simple Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch user bills"
        });
    }
};

// Get Bill Details for User (with download format)
const getUserBillDetails = async (req, res) => {
    try {
        const { bill_id } = req.params;
        const user_id = req.user_id;

        // Verify the bill belongs to the user
        const bill = await Bill.findById(bill_id)
            .populate({
                path: "booking_id",
                select: "user_id bookingId serviceDate userBike_id",
                populate: {
                    path: "userBike_id",
                    select: "model registration_number vin year"
                }
            })
            .populate("payment_id", "orderId payment_method transaction_id");

        if (!bill) {
            return res.status(404).json({
                success: false,
                message: "Bill not found"
            });
        }

        // Check if bill belongs to the requested user
        if (bill.booking_id.user_id.toString() !== user_id) {
            return res.status(403).json({
                success: false,
                message: "Access denied. This bill does not belong to you"
            });
        }

        // Format bill for download/view
        const billDetails = {
            bill_id: bill._id,
            bill_number: bill.bill_number,
            bill_date: bill.bill_date,
            booking_number: bill.booking_id.bookingId,
            service_date: bill.booking_id.serviceDate,
            bike_details: {
                model: bill.booking_id.userBike_id?.model,
                registration: bill.booking_id.userBike_id?.registration_number,
                vin: bill.booking_id.userBike_id?.vin,
                year: bill.booking_id.userBike_id?.year
            },
            customer_details: bill.customer_details,
            services: bill.services,
            subtotal: bill.subtotal,
            pickup_charges: bill.pickup_charges,
            drop_charges: bill.drop_charges,
            towing_charge: bill.towing_charge || 0,
            tax_amount: bill.tax_amount,
            tax_rate: bill.tax_rate,
            total_amount: bill.total_amount,
            payment_details: bill.payment_details,
            bill_status: bill.status,
            created_at: bill.createdAt
        };

        res.status(200).json({
            success: true,
            message: "Bill details fetched successfully",
            data: billDetails
        });

    } catch (error) {
        console.error("Get User Bill Details Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch bill details",
        });
    }
};

// ─── Dealer Wallet Top-Up (PayU hosted checkout) ────────────────────────────

const TOPUP_CALLBACK_PATH = "/bikedoctor/payu/webhook";

// PayU `mode` → Payment.payment_method enum.
function mapPayuMode(mode) {
    switch (String(mode || "").toUpperCase()) {
        case "CC":
        case "DC":
        case "CARD":
            return "card";
        case "NB":
            return "netbanking";
        case "UPI":
            return "upi";
        case "CASH":
        case "WALLET":
            return "wallet";
        case "EMI":
            return "emi";
        case "DBQR":
            return "qrcode";
        default:
            return null;
    }
}

// PayU's verify_payment is the only authority before a wallet is credited.
async function verifyAndRecordWalletTopup(payment) {
    const details = await payu.verifyPayment(payment.orderId);
    const verdict = payu.mapPayuStatus(details.status);
    // NOT_FOUND = dealer has not submitted the checkout yet.
    let status = verdict === "NOT_FOUND" ? "PENDING" : verdict;
    const verifiedAmount = Number(details.transaction_amount ?? details.amt);
    if (status === "SUCCESS" && (!Number.isFinite(verifiedAmount) || Number(verifiedAmount.toFixed(2)) !== Number(Number(payment.orderAmount).toFixed(2)))) {
        throw new Error("PayU wallet top-up amount mismatch");
    }
    // A confirmed top-up is never downgraded by a later read.
    if (payment.order_status === "SUCCESS") status = "SUCCESS";

    payment.order_status = status;
    payment.gateway_status = details.status || null;
    payment.payment_method = mapPayuMode(details.mode) || payment.payment_method || null;
    payment.transaction_id = details.mihpayid != null && details.mihpayid !== "Not Found" ? String(details.mihpayid) : payment.transaction_id;
    payment.utr_number = details.bank_ref_num || payment.utr_number;
    payment.verified_amount = Number.isFinite(verifiedAmount) ? verifiedAmount : payment.verified_amount;
    payment.verified_timestamp = new Date();
    payment.metadata = {
        ...(payment.metadata || {}),
        wallet_topup_verified_at: new Date(),
        payu_status: details.status || null,
        payu_mode: details.mode || null,
    };
    await payment.save();
    return { status, details };
}

const verifyWalletTopupStatus = async (req, res) => {
    try {
        const payment = await Payment.findOne({ orderId: req.params.orderId, dealer_id: req.dealer_id, payment_type: "WALLET_TOPUP" });
        if (!payment) return res.status(404).json({ success: false, message: "Wallet top-up order not found" });
        const verified = await verifyAndRecordWalletTopup(payment);
        if (verified.status === "SUCCESS") await finalizeWalletTopup(payment._id);
        const finalization = await Payment.findById(payment._id)
            .select("wallet_credit_state wallet_credited_at")
            .lean();
        return res.status(200).json({
            success: true,
            data: {
                order_id: payment.orderId,
                payment_status: verified.status,
                wallet_credited: finalization?.wallet_credit_state === "CREDITED",
                wallet_credit_state: finalization?.wallet_credit_state || "PENDING",
                wallet_credited_at: finalization?.wallet_credited_at || null,
            },
        });
    } catch (error) {
        console.error("verifyWalletTopupStatus error:", error.message);
        return res.status(502).json({ success: false, message: "Unable to verify wallet top-up with PayU" });
    }
};

const createOrderForAdd = async (req, res) => {
    try {
        let tokenData = {};
        try {
            tokenData = jwt_decode(req.headers.token);
        } catch (_) {
            return res.status(401).json({ success: false, message: "Invalid or missing token" });
        }

        const { user_id: tokenUserId, user_type } = tokenData;
        const { dealer_id, amount } = req.body;

        if (!dealer_id || !amount) {
            return res.status(400).json({ success: false, message: "dealer_id and amount are required" });
        }

        const topupAmount = parseFloat(amount);
        if (isNaN(topupAmount) || topupAmount < 1) {
            return res.status(400).json({ success: false, message: "amount must be at least ₹1" });
        }

        // Dealer can only top up their own wallet
        if (user_type === 2 && tokenUserId !== dealer_id) {
            return res.status(403).json({ success: false, message: "Dealers can only top up their own wallet" });
        }

        if (!payu.getPayuConfig()) {
            return res.status(503).json({ success: false, message: "Online wallet top-up is not configured yet" });
        }

        const dealer = await Dealer.findById(dealer_id);
        if (!dealer) {
            return res.status(404).json({ success: false, message: "Dealer not found" });
        }

        // PayU caps txnid at 25 characters.
        const orderId = `WTOP${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const callbackUrl = `${payu.getCallbackBaseUrl()}${TOPUP_CALLBACK_PATH}`;
        const checkout = payu.buildCheckoutRequest({
            txnid: orderId,
            amount: topupAmount,
            productinfo: "Wallet Topup",
            customer: {
                name: dealer.ownerName || dealer.shopName || "Dealer",
                email: dealer.email || "dealer@mrbikedoctor.com",
                phone: dealer.phone || "9999999999",
            },
            udf1: dealer._id.toString(),
            surl: callbackUrl,
            furl: callbackUrl,
        });

        await Payment.create({
            orderId,
            dealer_id: dealer._id,
            orderAmount: topupAmount,
            payment_type: "WALLET_TOPUP",
            order_currency: "INR",
            order_status: "PENDING",
            order_token: "payu_checkout",
            payment_by: "dealer",
            metadata: {
                gateway: payu.PAYU_GATEWAY,
                initiated_by: tokenUserId,
                created_at: new Date(),
            },
        });

        return res.status(200).json({
            success: true,
            order_id: orderId,
            gateway: payu.PAYU_GATEWAY,
            // The app POSTs these fields to `action` inside a WebView and
            // closes it once PayU redirects to `callback_url`.
            checkout: { ...checkout, callback_url: callbackUrl },
        });

    } catch (error) {
        console.error("createOrderForAdd error:", error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to create wallet top-up order",
        });
    }
};

module.exports = { getBillByBookingId, getAllBills, getUserBillsSimple, getUserBillDetails, getAllPayments, getPaymentById, generateBill, createOrderForAdd, verifyWalletTopupStatus, verifyAndRecordWalletTopup, mapPayuMode };
