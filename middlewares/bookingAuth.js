const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Customer = require("../models/customer_model");
const Vendor = require("../models/dealerModel");
const Admin = require("../models/admin_model");
const Payment = require("../models/Payment");

function tokenFrom(req) {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : req.headers.token;
}

async function authenticateActor(req, res) {
  const token = tokenFrom(req);
  if (!token) {
    res.status(401).json({ success: false, message: "Token not provided" });
    return null;
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (_error) {
    res.status(401).json({ success: false, message: "Authentication failed" });
    return null;
  }
  const id = decoded.user_id || decoded.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(401).json({ success: false, message: "Authentication failed" });
    return null;
  }
  if (decoded.user_type === 4) {
    if (!(await Customer.exists({ _id: id }))) {
      res.status(401).json({ success: false, message: "Customer account not found" });
      return null;
    }
    return { role: "customer", id: String(id) };
  }
  if (decoded.user_type === 1 || decoded.user_type === 2 || decoded.id) {
    const admin = await Admin.findById(id).select("_id status role").lean();
    if (admin?.status === "active") return { role: "admin", adminRole: admin.role, id: String(id) };
  }
  const dealer = await Vendor.findById(id).select("_id isBlocked").lean();
  if (!dealer || dealer.isBlocked) {
    res.status(403).json({ success: false, message: "Dealer access denied" });
    return null;
  }
  return { role: "dealer", id: String(id) };
}

function requireBookingParticipant(getBookingId) {
  return async function (req, res, next) {
    try {
      const actor = await authenticateActor(req, res);
      if (!actor) return;
      const bookingId = getBookingId(req);
      if (!mongoose.Types.ObjectId.isValid(bookingId)) {
        return res.status(400).json({ success: false, message: "Invalid booking ID" });
      }
      const booking = await Booking.findById(bookingId).select("user_id dealer_id").lean();
      if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
      const allowed = actor.role === "admin" ||
        (actor.role === "customer" && String(booking.user_id) === actor.id) ||
        (actor.role === "dealer" && String(booking.dealer_id) === actor.id);
      if (!allowed) return res.status(404).json({ success: false, message: "Booking not found" });
      req.auth = actor;
      req.user_id = actor.id;
      return next();
    } catch (error) {
      console.error("requireBookingParticipant error:", error.message);
      return res.status(500).json({ success: false, message: "Authorization check failed" });
    }
  };
}

async function requireOwnBookingList(req, res, next) {
  try {
    const actor = await authenticateActor(req, res);
    if (!actor) return;
    const requestedType = Number(req.query.user_type);
    const expectedType = actor.role === "customer" ? 4 : actor.role === "dealer" ? 2 : requestedType;
    if (actor.role !== "admin" && (String(req.params.user_id) !== actor.id || requestedType !== expectedType)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    req.auth = actor;
    req.user_id = actor.id;
    return next();
  } catch (error) {
    console.error("requireOwnBookingList error:", error.message);
    return res.status(500).json({ success: false, message: "Authorization check failed" });
  }
}

function requireActorRole(role) {
  return function (req, res, next) {
    if (!req.auth || req.auth.role !== role) {
      return res.status(403).json({ success: false, message: `${role} access required` });
    }
    return next();
  };
}

// Same contract as requireActorRole, for endpoints more than one role may
// call (e.g. a towing charge the dealer OR an admin can set).
function requireActorRoleAny(...roles) {
  return function (req, res, next) {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({
        success: false,
        message: `${roles.join(" or ")} access required`,
      });
    }
    return next();
  };
}

function requirePaymentParticipant(getPaymentFilter) {
  return async function (req, res, next) {
    try {
      const actor = await authenticateActor(req, res);
      if (!actor) return;
      const payment = await Payment.findOne(getPaymentFilter(req)).select("booking_id").lean();
      if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });
      const booking = await Booking.findById(payment.booking_id).select("user_id dealer_id").lean();
      const allowed = booking && (actor.role === "admin" ||
        (actor.role === "customer" && String(booking.user_id) === actor.id) ||
        (actor.role === "dealer" && String(booking.dealer_id) === actor.id));
      if (!allowed) return res.status(404).json({ success: false, message: "Payment not found" });
      req.auth = actor;
      req.user_id = actor.id;
      return next();
    } catch (error) {
      console.error("requirePaymentParticipant error:", error.message);
      return res.status(500).json({ success: false, message: "Authorization check failed" });
    }
  };
}

module.exports = { authenticateActor, requireBookingParticipant, requireOwnBookingList, requireActorRole, requireActorRoleAny, requirePaymentParticipant };
