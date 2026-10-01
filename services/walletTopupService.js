const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const Vendor = require("../models/dealerModel");
const Wallet = require("../models/Wallet_modal");

const TOPUP_TYPE = "WALLET_TOPUP";

function round2(value) {
  return Number(Number(value).toFixed(2));
}

function transactionsUnsupported(error) {
  return /Transaction numbers are only allowed|replica set|mongos/i.test(error?.message || "");
}

// This is deliberately an order-level operation. A Payment may receive many
// webhooks/status checks, but a successful PayU top-up may create only one
// approved deposit row and one wallet credit.
async function finalizeInTransaction(paymentId, session) {
  const payment = await Payment.findOneAndUpdate(
    {
      _id: paymentId,
      payment_type: TOPUP_TYPE,
      order_status: "SUCCESS",
      wallet_credit_state: { $ne: "CREDITED" },
    },
    { $set: { wallet_credit_state: "PROCESSING" } },
    { new: true, session },
  );

  if (!payment) return { credited: false, reason: "already_credited_or_not_successful" };

  const existing = await Wallet.findOne({
    orderId: payment.orderId,
    transaction_type: "deposit",
  }).session(session);
  if (existing) {
    await Payment.updateOne({ _id: payment._id }, {
      $set: { wallet_credit_state: "CREDITED", wallet_credited_at: existing.createdAt || new Date() },
    }, { session });
    return { credited: false, reason: "ledger_already_exists", wallet: existing };
  }

  const dealer = await Vendor.findById(payment.dealer_id).session(session);
  if (!dealer) throw new Error("Wallet top-up dealer not found");

  const amount = round2(payment.orderAmount);
  if (!(amount > 0)) throw new Error("Wallet top-up amount is invalid");
  const preBalance = round2(dealer.wallet || 0);
  const postBalance = round2(preBalance + amount);

  dealer.wallet = postBalance;
  await dealer.save({ session });
  const [wallet] = await Wallet.create([{
    orderId: payment.orderId,
    dealer_id: dealer._id,
    Amount: amount,
    Type: "Credit",
    Note: `Wallet top-up via PayU (Order: ${payment.orderId}, Payment: ${payment.transaction_id || "pending"})`,
    Total: postBalance,
    pre_balance: preBalance,
    order_status: "APPROVED",
    transaction_type: "deposit",
  }], { session });

  await Payment.updateOne({ _id: payment._id }, {
    $set: { wallet_credit_state: "CREDITED", wallet_credited_at: new Date() },
  }, { session });
  return { credited: true, wallet };
}

// Safe fallback for standalone MongoDB. The Payment claim and unique deposit
// index prevent a second worker from crediting the same top-up order.
async function finalizeWithoutTransaction(paymentId) {
  // Recover the only safe interrupted-fallback case: ledger creation finished
  // but recording Payment.wallet_credit_state did not. Never re-apply money.
  const prior = await Payment.findById(paymentId);
  if (prior?.wallet_credit_state === "PROCESSING") {
    const existing = await Wallet.findOne({ orderId: prior.orderId, transaction_type: "deposit" });
    if (existing) {
      await Payment.updateOne({ _id: prior._id, wallet_credit_state: "PROCESSING" }, {
        $set: { wallet_credit_state: "CREDITED", wallet_credited_at: existing.createdAt || new Date() },
      });
      return { credited: false, reason: "recovered_existing_ledger", wallet: existing };
    }
    return { credited: false, reason: "already_processing" };
  }

  const payment = await Payment.findOneAndUpdate(
    {
      _id: paymentId,
      payment_type: TOPUP_TYPE,
      order_status: "SUCCESS",
      wallet_credit_state: { $nin: ["PROCESSING", "CREDITED"] },
    },
    { $set: { wallet_credit_state: "PROCESSING" } },
    { new: true },
  );
  if (!payment) return { credited: false, reason: "already_processing_or_credited" };

  let creditedDealer = null;
  let creditedAmount = null;
  try {
    const existing = await Wallet.findOne({ orderId: payment.orderId, transaction_type: "deposit" });
    if (existing) {
      await Payment.updateOne({ _id: payment._id }, { $set: { wallet_credit_state: "CREDITED", wallet_credited_at: existing.createdAt || new Date() } });
      return { credited: false, reason: "ledger_already_exists", wallet: existing };
    }

    const amount = round2(payment.orderAmount);
    if (!(amount > 0)) throw new Error("Wallet top-up amount is invalid");
    const dealer = await Vendor.findOneAndUpdate(
      { _id: payment.dealer_id },
      { $inc: { wallet: amount } },
      { new: true },
    );
    if (!dealer) throw new Error("Wallet top-up dealer not found");
    creditedDealer = dealer;
    creditedAmount = amount;
    const postBalance = round2(dealer.wallet || 0);
    const wallet = await Wallet.create({
      orderId: payment.orderId,
      dealer_id: dealer._id,
      Amount: amount,
      Type: "Credit",
      Note: `Wallet top-up via PayU (Order: ${payment.orderId}, Payment: ${payment.transaction_id || "pending"})`,
      Total: postBalance,
      pre_balance: round2(postBalance - amount),
      order_status: "APPROVED",
      transaction_type: "deposit",
    });
    await Payment.updateOne({ _id: payment._id }, { $set: { wallet_credit_state: "CREDITED", wallet_credited_at: new Date() } });
    return { credited: true, wallet };
  } catch (error) {
    // A duplicate ledger means a previous worker completed the money movement.
    if (error?.code === 11000) {
      const wallet = await Wallet.findOne({ orderId: payment.orderId, transaction_type: "deposit" });
      await Payment.updateOne({ _id: payment._id }, { $set: { wallet_credit_state: "CREDITED", wallet_credited_at: wallet?.createdAt || new Date() } });
      return { credited: false, reason: "ledger_already_exists", wallet };
    }
    // If the ledger insert failed after the conditional balance increment,
    // compensate only when no other writer has changed that exact balance.
    // If it cannot be proven safe to reverse, retain PROCESSING: a retry must
    // not increment a second time and the order remains explicitly auditable.
    if (creditedDealer) {
      const rollback = await Vendor.updateOne(
        { _id: creditedDealer._id, wallet: creditedDealer.wallet },
        { $inc: { wallet: -creditedAmount } },
      );
      if (rollback.modifiedCount !== 1) throw error;
    }
    await Payment.updateOne({ _id: payment._id, wallet_credit_state: "PROCESSING" }, { $set: { wallet_credit_state: "PENDING" } });
    throw error;
  }
}

async function finalizeWalletTopup(paymentId) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await finalizeInTransaction(paymentId, session);
    });
    return result;
  } catch (error) {
    if (!transactionsUnsupported(error)) throw error;
    return finalizeWithoutTransaction(paymentId);
  } finally {
    await session.endSession();
  }
}

module.exports = { TOPUP_TYPE, finalizeWalletTopup, finalizeInTransaction, finalizeWithoutTransaction, round2 };
