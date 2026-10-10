const crypto = require("crypto");
const Payment = require("../models/Payment");
const Booking = require("../models/Booking");
const Bill = require("../models/billSchema");
const Wallet = require("../models/Wallet_modal");
const Customer = require("../models/customer_model");
const PaymentReconciliationTask = require("../models/PaymentReconciliationTask");
const { getOrCreateInvoice } = require("../services/invoiceService");
const { settleBookingWallet } = require("./walletSettlement");
const { sendBookingNotification } = require("./pushNotification");
const { enqueuePaymentReconciliation } = require("../services/paymentReconciliationService");

const RUN_INTERVAL_MS = 5 * 60 * 1000;
const TASK_LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 20;
let timer = null;
let running = false;

async function auditPaymentIntegrity() {
  const successfulPayments = await Payment.find({
    order_status: "SUCCESS",
    booking_id: { $ne: null },
  }).sort({ updatedAt: -1 }).limit(500).lean();

  for (const payment of successfulPayments) {
    const [booking, bill, walletSettlement] = await Promise.all([
      Booking.findById(payment.booking_id)
        .select("payment_status payment_verified status walletSettled payment_method dealerEarnings commissionAmount commissionTaxAmount platformFee")
        .lean(),
      Bill.findOne({ booking_id: payment.booking_id }).select("_id").lean(),
      Wallet.findOne({
        booking_id: payment.booking_id,
        transaction_type: { $in: ["settlement_online", "settlement_cash"] },
      }).select("_id").lean(),
    ]);
    const tasks = [];
    if (!booking || booking.payment_status !== "completed" || !booking.payment_verified) tasks.push("BOOKING_SYNC");
    if (!bill) tasks.push("INVOICE");
    // Mirrors the debit/credit helper/walletSettlement.js actually writes —
    // a CASH settlement recovers the commission AND the platform fee the
    // dealer collected on MR Bike's behalf.
    const expectedSettlementAmount = booking?.payment_method === "CASH"
      ? Number(booking?.commissionAmount || 0) +
        Number(booking?.commissionTaxAmount || 0) +
        Number(booking?.platformFee || 0)
      : Number(booking?.dealerEarnings || 0);
    if (!booking?.walletSettled || (expectedSettlementAmount > 0 && !walletSettlement)) tasks.push("WALLET");
    if (
      payment.verified_timestamp &&
      Date.now() - new Date(payment.verified_timestamp).getTime() <= 24 * 60 * 60 * 1000
    ) {
      tasks.push("NOTIFICATION");
    }
    if (tasks.length) await enqueuePaymentReconciliation(payment, tasks);
  }

  const suspiciousBills = await Bill.aggregate([
    { $lookup: { from: "payments", localField: "booking_id", foreignField: "booking_id", as: "payments" } },
    { $match: { payments: { $elemMatch: { order_status: { $ne: "SUCCESS" } } }, "payments.order_status": { $ne: "SUCCESS" } } },
    { $limit: 200 },
  ]);
  for (const bill of suspiciousBills) {
    const payment = bill.payments?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    await enqueuePaymentReconciliation(
      { _id: payment?._id || bill.payment_id, booking_id: bill.booking_id },
      ["INVOICE_PAYMENT_MISMATCH"],
    );
  }
}

async function claimTask() {
  const now = new Date();
  return PaymentReconciliationTask.findOneAndUpdate(
    {
      attempts: { $lt: MAX_ATTEMPTS },
      nextAttemptAt: { $lte: now },
      $or: [
        { status: { $in: ["PENDING", "FAILED"] } },
        { status: "PROCESSING", lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: "PROCESSING", lockedUntil: new Date(now.getTime() + TASK_LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { createdAt: 1 } },
  );
}

async function processTask(task) {
  const payment = task.payment_id ? await Payment.findById(task.payment_id) : null;
  const booking = await Booking.findById(task.booking_id).select("+deliveryOtp +deliveryOtpExpiresAt");
  if (!booking) throw new Error("Booking missing during reconciliation");

  if (task.taskType !== "INVOICE_PAYMENT_MISMATCH" && (!payment || payment.order_status !== "SUCCESS")) {
    throw new Error("Successful payment missing during reconciliation");
  }

  switch (task.taskType) {
    case "BOOKING_SYNC":
      if (booking.payment_status !== "completed" || !booking.payment_verified) {
        booking.payment_method = booking.payment_method || "ONLINE";
        booking.payment_status = "completed";
        booking.payment_verified = true;
        booking.deliveryOtp = booking.deliveryOtp || crypto.randomInt(1000, 10000);
        booking.status = ["delivered", "completed", "cash received"].includes(booking.status)
          ? booking.status
          : "ready_for_delivery";
        booking.billStatus = "paid";
        booking.paymentDate = booking.paymentDate || payment.verified_timestamp || new Date();
        await booking.save();
      }
      break;
    case "INVOICE":
      await getOrCreateInvoice(booking._id, {
        payment_id: payment._id,
        payment_method: payment.payment_method || "ONLINE",
        transaction_id: payment.transaction_id || payment.cf_payment_id || payment.cf_order_id,
      });
      break;
    case "WALLET":
      if (booking.walletSettled) {
        const existingSettlement = await Wallet.exists({
          booking_id: booking._id,
          transaction_type: { $in: ["settlement_online", "settlement_cash"] },
        });
        const expectedAmount = booking.payment_method === "CASH"
          ? Number(booking.commissionAmount || 0) +
            Number(booking.commissionTaxAmount || 0) +
            Number(booking.platformFee || 0)
          : Number(booking.dealerEarnings || 0);
        if (expectedAmount > 0 && !existingSettlement) {
          await Booking.updateOne({ _id: booking._id, walletSettled: true }, { $set: { walletSettled: false } });
        }
      }
      await settleBookingWallet(booking._id, booking.payment_method || "ONLINE");
      break;
    case "NOTIFICATION": {
      const user = await Customer.findById(booking.user_id).select("device_token ftoken").lean();
      const token = user?.device_token || user?.ftoken;
      if (token) {
        await sendBookingNotification({
          token,
          title: "Payment Received",
          body: "Your payment has been confirmed.",
          data: { type: "payment_confirmed", bookingId: booking._id.toString() },
          receiverId: booking.user_id,
          receiverType: "user",
          bookingId: booking._id,
        });
      }
      break;
    }
    case "INVOICE_PAYMENT_MISMATCH":
      throw new Error("Manual review required: invoice exists without a successful payment");
    default:
      throw new Error(`Unknown reconciliation task: ${task.taskType}`);
  }
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    await auditPaymentIntegrity();
    for (let count = 0; count < 100; count += 1) {
      const task = await claimTask();
      if (!task) break;
      try {
        await processTask(task);
        task.status = "COMPLETED";
        task.completedAt = new Date();
        task.lockedUntil = null;
        task.lastError = null;
      } catch (error) {
        task.status = "FAILED";
        task.lockedUntil = null;
        task.lastError = error.message.slice(0, 500);
        task.nextAttemptAt = new Date(Date.now() + Math.min(60, 2 ** task.attempts) * 60 * 1000);
      }
      await task.save();
    }
  } catch (error) {
    console.error("[PAYMENT_RECONCILIATION] Job failed", { message: error.message });
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  runOnce();
  timer = setInterval(runOnce, RUN_INTERVAL_MS);
  timer.unref?.();
}

module.exports = { start, runOnce, auditPaymentIntegrity };
