const mongoose = require("mongoose")
const Customer = require("../models/customer_model")
const UserBike = require("../models/userBikeModel")

class PrimaryBikeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = "PrimaryBikeError"
    this.status = status
    this.code = code
  }
}

function isTransactionUnsupported(error) {
  return error?.code === 20 || /Transaction numbers are only allowed|does not support retryable writes/i.test(error?.message || "")
}

function transactionError(error) {
  if (error instanceof PrimaryBikeError) return error
  if (isTransactionUnsupported(error)) {
    return new PrimaryBikeError(503, "PRIMARY_BIKE_TRANSACTIONS_UNAVAILABLE", "Primary bike changes require MongoDB transaction support, which is unavailable.")
  }
  return error
}

function primaryBikeIdForBikes(bikes, storedPrimaryId) {
  const active = (bikes || []).filter(bike => bike.status == null || Number(bike.status) !== 0)
  if (storedPrimaryId && active.some(bike => String(bike._id) === String(storedPrimaryId))) return String(storedPrimaryId)
  return active[0] ? String(active[0]._id) : null
}

async function oldestActiveBikeId(userId, excludedBikeId, session) {
  return UserBike.findOne({
    user_id: userId,
    status: { $ne: 0 },
    ...(excludedBikeId ? { _id: { $ne: excludedBikeId } } : {}),
  })
    .sort({ createdAt: 1, _id: 1 })
    .select("_id")
    .session(session)
    .lean()
}

async function inCustomerBikeTransaction(work) {
  const session = await mongoose.startSession()
  try {
    let result
    await session.withTransaction(async () => {
      result = await work(session)
    })
    return result
  } catch (error) {
    throw transactionError(error)
  } finally {
    await session.endSession()
  }
}

async function setPrimaryBike({ userId, bikeId }) {
  if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(bikeId)) {
    throw new PrimaryBikeError(400, "INVALID_BIKE_ID", "Valid bikeId is required.")
  }

  return inCustomerBikeTransaction(async session => {
    const bike = await UserBike.findOne({ _id: bikeId, user_id: userId, status: { $ne: 0 } })
      .select("_id")
      .session(session)
      .lean()
    if (!bike) throw new PrimaryBikeError(404, "ACTIVE_OWNED_BIKE_NOT_FOUND", "Active bike not found.")

    const customer = await Customer.findById(userId).select("+primaryBikeRevision").session(session)
    if (!customer) throw new PrimaryBikeError(404, "CUSTOMER_NOT_FOUND", "Customer not found.")
    customer.primaryBikeId = bike._id
    customer.primaryBikeRevision = (customer.primaryBikeRevision || 0) + 1
    await customer.save({ session })
    return { primaryBikeId: String(bike._id) }
  })
}

async function deleteCustomerBike({ userId, bikeId }) {
  if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(bikeId)) {
    throw new PrimaryBikeError(400, "INVALID_BIKE_ID", "Valid bikeId is required.")
  }

  return inCustomerBikeTransaction(async session => {
    const bike = await UserBike.findOne({ _id: bikeId, user_id: userId }).select("_id").session(session).lean()
    if (!bike) throw new PrimaryBikeError(404, "OWNED_BIKE_NOT_FOUND", "Bike not found.")
    const customer = await Customer.findById(userId).select("+primaryBikeRevision").session(session)
    if (!customer) throw new PrimaryBikeError(404, "CUSTOMER_NOT_FOUND", "Customer not found.")

    const result = await UserBike.deleteOne({ _id: bike._id, user_id: userId }, { session })
    if (!result.deletedCount) throw new PrimaryBikeError(404, "OWNED_BIKE_NOT_FOUND", "Bike not found.")

    const currentPrimary = customer.primaryBikeId ? String(customer.primaryBikeId) : null
    const currentPrimaryIsValid = currentPrimary && await UserBike.exists({
      _id: customer.primaryBikeId,
      user_id: userId,
      status: { $ne: 0 },
    }).session(session)
    if (!currentPrimaryIsValid || currentPrimary === String(bike._id)) {
      const replacement = await oldestActiveBikeId(userId, bike._id, session)
      customer.primaryBikeId = replacement?._id || null
    }
    customer.primaryBikeRevision = (customer.primaryBikeRevision || 0) + 1
    await customer.save({ session })
    return { deleted: true, primaryBikeId: customer.primaryBikeId ? String(customer.primaryBikeId) : null }
  })
}

async function updateCustomerBikeStatus({ userId, bikeId, status }) {
  if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(bikeId)) {
    throw new PrimaryBikeError(400, "INVALID_BIKE_ID", "Valid bikeId is required.")
  }
  return inCustomerBikeTransaction(async session => {
    const bike = await UserBike.findOne({ _id: bikeId, user_id: userId }).session(session)
    if (!bike) throw new PrimaryBikeError(404, "OWNED_BIKE_NOT_FOUND", "Bike not found.")
    bike.status = status
    await bike.save({ session })

    const customer = await Customer.findById(userId).select("+primaryBikeRevision").session(session)
    if (!customer) throw new PrimaryBikeError(404, "CUSTOMER_NOT_FOUND", "Customer not found.")
    const currentPrimary = customer.primaryBikeId ? String(customer.primaryBikeId) : null
    const currentPrimaryIsValid = currentPrimary && await UserBike.exists({
      _id: customer.primaryBikeId,
      user_id: userId,
      status: { $ne: 0 },
    }).session(session)
    if (!currentPrimaryIsValid || (Number(status) <= 0 && currentPrimary === String(bike._id))) {
      const replacement = await oldestActiveBikeId(userId, Number(status) > 0 ? null : bike._id, session)
      customer.primaryBikeId = replacement?._id || null
    }
    customer.primaryBikeRevision = (customer.primaryBikeRevision || 0) + 1
    await customer.save({ session })
    return bike
  })
}

module.exports = { PrimaryBikeError, isTransactionUnsupported, primaryBikeIdForBikes, setPrimaryBike, deleteCustomerBike, updateCustomerBikeStatus }
