const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Customer = require("../models/customer_model");
const Vendor = require("../models/dealerModel");
const Admin = require("../models/admin_model");
const Booking = require("../models/Booking");
const { hasAdminBookingPermission } = require("./adminBookingPermissions");

async function authenticateSocketToken(token, models = {}) {
  if (!token || !process.env.JWT_SECRET) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (_error) {
    return null;
  }

  const id = String(decoded.user_id || decoded.id || "");
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const CustomerModel = models.Customer || Customer;
  const VendorModel = models.Vendor || Vendor;
  const AdminModel = models.Admin || Admin;

  if (decoded.user_type === 4) {
    if (!(await CustomerModel.exists({ _id: id }))) return null;
    return { role: "customer", id };
  }

  if (decoded.user_type === 1 || decoded.user_type === 2 || decoded.id) {
    const admin = await AdminModel.findById(id).select("_id status role").lean();
    if (admin?.status === "active") return { role: "admin", adminRole: admin.role, id };
  }

  const dealer = await VendorModel.findById(id).select("_id isBlocked").lean();
  if (!dealer || dealer.isBlocked) return null;
  return { role: "dealer", id };
}

function createSocketAuthMiddleware(models = {}) {
  return (socket, next) => {
    authenticateSocketToken(socket.handshake.auth?.token, models)
      .then(actor => {
        if (!actor) {
          const error = new Error("Socket authentication failed");
          error.data = { code: "SOCKET_AUTH_FAILED" };
          return next(error);
        }
        socket.data.actor = actor;
        return next();
      })
      .catch(() => {
        const error = new Error("Socket authentication failed");
        error.data = { code: "SOCKET_AUTH_FAILED" };
        next(error);
      });
  };
}

function canJoinBookingRoom(actor, booking) {
  if (!actor || !booking) return false;
  if (actor.role === "admin") {
    return hasAdminBookingPermission(actor.adminRole, "booking.live_gps");
  }
  if (actor.role === "customer") return String(booking.user_id) === String(actor.id);
  if (actor.role === "dealer") return String(booking.dealer_id) === String(actor.id);
  return false;
}

async function authorizeBookingRoom(actor, bookingId, BookingModel = Booking) {
  if (!mongoose.Types.ObjectId.isValid(String(bookingId || ""))) return false;
  const booking = await BookingModel.findById(bookingId).select("user_id dealer_id").lean();
  return canJoinBookingRoom(actor, booking);
}

function createBookingRoomJoinHandler(authorize = authorizeBookingRoom) {
  return async function joinBookingRoom(payload = {}) {
    const bookingId = String(payload?.bookingId || "");
    try {
      if (await authorize(this.data?.actor, bookingId)) {
        this.join(`booking:${bookingId}`);
        this.emit("booking:joinUserAccepted", { bookingId });
        return;
      }
    } catch (error) {
      console.error("[SOCKET] booking:joinUser authorization failed:", error.message);
    }
    this.leave(`booking:${bookingId}`);
    this.emit("booking:joinUserDenied", { bookingId, reason: "unauthorized" });
  };
}

module.exports = {
  authenticateSocketToken,
  createSocketAuthMiddleware,
  canJoinBookingRoom,
  authorizeBookingRoom,
  createBookingRoomJoinHandler,
};
