const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Vendor = require("../models/dealerModel");
const AdminService = require("../models/adminService");
const AdditionalService = require("../models/additionalServiceSchema");
const Payment = require("../models/Payment");
const Bill = require("../models/billSchema");
const Tracking = require("../models/Tracking");
const Ticket = require("../models/ticket_model");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const GarageSlotCapacity = require("../models/GarageSlotCapacity");
const { isDealerBookable } = require("../helper/dealerStatus");
const { createAdminBookingAuditEvent, saveBookingWithAdminAudit, correlationId } = require("../services/bookingAudit");
const { sendBookingNotification } = require("../helper/pushNotification");
const { calculateDistanceKm, isAdminServiceCompatibleWithBike, matchesBikePriceRow } = require("../v1-api/helpers/geoAndRatings");
const { isWithinServiceRadius } = require("../helper/dealerServiceRadius");
const { MAX_GPS_AGE_MS } = require("../services/pickupLifecycle");
const { resolveBikeContextById } = require("../v1-api/helpers/serviceEligibility");
const { hasAdminBookingPermission } = require("../middlewares/adminBookingPermissions");

const HANDOFF_STATUSES = new Set(["pending", "confirmed"]);
const ACTIVE_PICKUP = new Set(["arriving", "arrived", "pickedup", "completed", "PICKUP_STARTED", "RIDER_NEARBY", "ARRIVED", "PICKUP_OTP_VERIFIED", "BIKE_PICKED_UP"]);
const REASSIGN_REASON_MIN = 5;
const { reservationsReady, capacityId } = require("../services/bookingSlotReservations");

function lifecycleEvidenceMissing(booking) {
  const lifecycleFields = ["pickupStatus", "garageTransportStatus", "deliveryTransportStatus"];
  // Mongoose hydrates schema defaults for fields absent from old raw records.
  // `$isDefault` distinguishes those defaults from lifecycle values actually
  // persisted by the booking/pickup flows; unknown history must fail closed.
  const defaulted = typeof booking?.$isDefault === "function" && lifecycleFields.some((field) => booking.$isDefault(field));
  return defaulted || lifecycleFields.some((field) => booking?.[field] == null || booking[field] === "");
}

function reasonFrom(req) {
  return typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reassignmentBlock(booking) {
  if (!HANDOFF_STATUSES.has(booking.status)) return "Reassignment is locked after the booking leaves the pre-handoff stage.";
  if (lifecycleEvidenceMissing(booking)) return "Pickup and transport history is incomplete on this legacy booking. Reassignment requires manual review.";
  if (ACTIVE_PICKUP.has(booking.pickupStatus) || booking.pickupStartedAt || booking.pickupOtpVerifiedAt || booking.pickupCompletedAt) return "Pickup has started. Reassignment is disabled to protect the active trip.";
  if (booking.garageTransportStatus && booking.garageTransportStatus !== "NOT_STARTED") return "Garage transport has started. Reassignment is disabled to protect the active trip.";
  if (booking.deliveryTransportStatus && booking.deliveryTransportStatus !== "NOT_STARTED") return "Delivery has started. Reassignment is disabled to protect the active trip.";
  if (booking.billGenerated || booking.billStatus === "paid" || booking.payment_status === "completed" || booking.payment_verified || booking.walletSettled) return "A bill, payment, or settlement exists. Reassignment requires manual review.";
  if (!booking.scheduleDate || !booking.timeSlot) return "A complete booking date and time slot is unavailable, so replacement garage availability cannot be verified.";
  return null;
}

function cancellationBlock(booking) {
  if (booking.status === "cancelled" || booking.status === "user_cancelled") return "Booking is already cancelled.";
  if (!HANDOFF_STATUSES.has(booking.status)) return "This booking is in progress or past the operational handoff. Escalate for manual review.";
  if (lifecycleEvidenceMissing(booking)) return "Pickup and transport history is incomplete on this legacy booking. Escalate for manual review.";
  if (ACTIVE_PICKUP.has(booking.pickupStatus) || booking.pickupStartedAt || booking.pickupOtpVerifiedAt || booking.pickupCompletedAt) return "Pickup has started. Escalate for manual review.";
  if (booking.garageTransportStatus && booking.garageTransportStatus !== "NOT_STARTED") return "Garage transport has started. Escalate for manual review.";
  if (booking.deliveryTransportStatus && booking.deliveryTransportStatus !== "NOT_STARTED") return "Delivery has started. Escalate for manual review.";
  if (booking.billGenerated || booking.billStatus === "paid" || booking.payment_status === "completed" || booking.payment_verified || booking.walletSettled) return "Financial activity exists. Use manual review; no payment or settlement will be reversed here.";
  return null;
}

function serializeProvider(provider) {
  if (!provider) return null;
  return { _id: provider._id, name: provider.shopName || provider.ownerName || "Garage", city: provider.city || "", address: provider.fullAddress || "", online: Boolean(provider.online), dealerStatus: provider.dealerStatus || null };
}

function supportsBookingTransport(provider, booking) {
  const option = booking.transportOption || "SELF_VISIT";
  if (["PICKUP_ONLY", "PICKUP_AND_DROP"].includes(option) && !provider.providesPickup) return false;
  if (["DROP_ONLY", "PICKUP_AND_DROP"].includes(option) && !provider.providesDrop) return false;
  if (booking.towingRequired && !provider.providesTowing) return false;
  return true;
}

async function providersWithCompatibleServices(booking, dealerIds) {
  const selectedServices = booking.services || [];
  const baseServiceIds = [...new Set(selectedServices.map((service) => String(service.base_service_id?._id || service.base_service_id || "")).filter(Boolean))];
  const selectedAdditional = booking.additionalServices || [];
  const additionalBaseIds = [...new Set(selectedAdditional.map((service) => String(service.base_additional_service_id?._id || service.base_additional_service_id || "")).filter(Boolean))];
  if ((!baseServiceIds.length && !additionalBaseIds.length) || !dealerIds.length) return new Set();
  const bikeContext = await resolveBikeContextById(booking.userBike_id, booking.user_id);
  if (!bikeContext) return new Set();
  const [rows, additionalRows] = await Promise.all([
    baseServiceIds.length ? AdminService.find({ dealer_id: { $in: dealerIds }, isActive: true, base_service_id: { $in: baseServiceIds }, companies: bikeContext.companyId }).select("dealer_id base_service_id companies bikes").lean() : [],
    additionalBaseIds.length ? AdditionalService.find({ dealer_id: { $in: dealerIds }, isActive: true, base_additional_service_id: { $in: additionalBaseIds } }).select("dealer_id base_additional_service_id bikes").lean() : [],
  ]);
  const byDealer = new Map();
  rows.forEach((row) => {
    if (!isAdminServiceCompatibleWithBike(row, bikeContext)) return;
    const dealerId = String(row.dealer_id);
    const bases = byDealer.get(dealerId) || new Set();
    bases.add(String(row.base_service_id));
    byDealer.set(dealerId, bases);
  });
  additionalRows.forEach((row) => {
    if (!(row.bikes || []).some((priceRow) => matchesBikePriceRow(priceRow, bikeContext))) return;
    const dealerId = String(row.dealer_id);
    const bases = byDealer.get(dealerId) || new Set();
    bases.add(`additional:${row.base_additional_service_id}`);
    byDealer.set(dealerId, bases);
  });
  const required = [...baseServiceIds, ...additionalBaseIds.map((id) => `additional:${id}`)];
  return new Set([...byDealer.entries()].filter(([, bases]) => required.every((id) => bases.has(id))).map(([dealerId]) => dealerId));
}

async function getBookingControlCenter(req, res) {
  try {
    const booking = await Booking.findById(req.params.bookingId)
      .select("bookingId status dealerResponseStatus dealer_id pickupStatus pickupStartedAt pickupOtpVerifiedAt pickupCompletedAt garageTransportStatus deliveryTransportStatus scheduleDate timeSlot payment_status payment_verified billGenerated billStatus walletSettled updatedAt")
      .populate("dealer_id", "shopName ownerName city fullAddress online dealerStatus")
      .lean();
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const [complaints, paymentActivity] = await Promise.all([
      Ticket.find({ booking_id: booking._id, source: "booking_support" }).select("subject status issue_type issue_label priority assignee_id lastMessageAt created_at").sort({ updatedAt: -1 }).lean(),
      Payment.exists({ booking_id: booking._id, order_status: { $in: ["PENDING", "SUCCESS"] } }),
    ]);
    const provider = booking.dealer_id;
    return res.json({ success: true, data: {
      booking: { _id: booking._id, bookingId: booking.bookingId, status: booking.status, updatedAt: booking.updatedAt },
      permissions: {
        reassign: hasAdminBookingPermission(req.auth?.adminRole, "booking.reassign"),
        cancel: hasAdminBookingPermission(req.auth?.adminRole, "booking.cancel"),
        finance: hasAdminBookingPermission(req.auth?.adminRole, "booking.charge_review"),
        tracking: hasAdminBookingPermission(req.auth?.adminRole, "booking.live_gps"),
        audit: hasAdminBookingPermission(req.auth?.adminRole, "booking.audit_read"),
        complaints: hasAdminBookingPermission(req.auth?.adminRole, "booking.complaint_manage"),
      },
      assignment: { current: serializeProvider(provider), reassignAllowed: !reassignmentBlock(booking) && !paymentActivity, blockedReason: reassignmentBlock(booking) || (paymentActivity ? "A pending or successful payment gateway record exists. Reassignment requires manual review." : null), stage: booking.status },
      cancellation: { allowed: !cancellationBlock(booking) && !paymentActivity, blockedReason: cancellationBlock(booking) || (paymentActivity ? "A pending or successful payment gateway record exists. Escalate for manual review." : null) },
      complaints,
    } });
  } catch (error) {
    console.error("Admin booking control center read failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load booking control center" });
  }
}

async function getBookingFinancialOverview(req, res) {
  try {
    const booking = await Booking.findById(req.params.bookingId).select("customerTotal discountAmount totalBill payment_method payment_status payment_verified billGenerated billStatus").lean();
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const [payments, invoice] = await Promise.all([
      Payment.find({ booking_id: req.params.bookingId }).select("orderAmount order_status payment_type payment_method transaction_id verified_amount verified_timestamp refund_amount refund_status create_date").sort({ create_date: -1 }).lean(),
      Bill.findOne({ booking_id: req.params.bookingId }).select("bill_number bill_date subtotal pickup_charges drop_charges towing_charge tax_amount platform_fee discount_amount total_amount status payment_details.payment_method payment_details.payment_date").lean(),
    ]);
    const total = Number(invoice?.total_amount ?? booking.totalBill ?? Math.max(0, Number(booking.customerTotal || 0) - Number(booking.discountAmount || 0)));
    const gatewayPaid = payments.filter((p) => p.order_status === "SUCCESS").reduce((sum, p) => sum + Number(p.verified_amount ?? p.orderAmount ?? 0), 0);
    const paid = booking.payment_method === "CASH" && booking.payment_status === "completed" && booking.payment_verified ? total : gatewayPaid;
    return res.json({ success: true, data: { total, paid, outstanding: Math.max(0, total - paid), paymentMethod: booking.payment_method || invoice?.payment_details?.payment_method || null, paymentStatus: booking.payment_status, paymentVerified: Boolean(booking.payment_verified), billGenerated: Boolean(booking.billGenerated || invoice), billStatus: booking.billStatus || invoice?.status || "pending", invoice: invoice ? { bill_number: invoice.bill_number, bill_date: invoice.bill_date, subtotal: invoice.subtotal, pickup_charges: invoice.pickup_charges, drop_charges: invoice.drop_charges, towing_charge: invoice.towing_charge, tax_amount: invoice.tax_amount, platform_fee: invoice.platform_fee, discount_amount: invoice.discount_amount, total_amount: invoice.total_amount, status: invoice.status, payment_details: invoice.payment_details } : null, payments: payments.map(({ transaction_id, ...p }) => ({ ...p, transactionReference: transaction_id ? String(transaction_id).slice(-6) : null })) } });
  } catch (error) {
    console.error("Booking financial overview read failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load financial overview" });
  }
}

async function getBookingTracking(req, res) {
  try {
    const booking = await Booking.findById(req.params.bookingId).select("status dealer_id pickupAndDropId pickupStatus pickupStartedAt pickupOtpVerifiedAt pickupCompletedAt garageTransportStatus deliveryTransportStatus deliveryTransportStartedAt deliveryArrivedAt deliveryTransportCompletedAt pickupCurrentLocation pickupLocation deliveryLocation").populate("dealer_id", "shopName fullAddress latitude longitude").populate("pickupAndDropId", "user_lat user_lng status").lean();
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const tracking = await Tracking.findOne({ booking_id: booking._id }).select("status createdAt updatedAt").lean();
    const gpsAt = booking.pickupCurrentLocation?.capturedAt || booking.pickupCurrentLocation?.updatedAt || null;
    const gpsTimestamp = gpsAt ? new Date(gpsAt).getTime() : NaN;
    const gpsAgeMs = Number.isFinite(gpsTimestamp) ? Math.max(0, Date.now() - gpsTimestamp) : null;
    const gpsStale = gpsAgeMs == null || gpsAgeMs > MAX_GPS_AGE_MS;
    const savedCustomerLocation = booking.pickupAndDropId?.user_lat != null && booking.pickupAndDropId?.user_lng != null
      ? { latitude: Number(booking.pickupAndDropId.user_lat), longitude: Number(booking.pickupAndDropId.user_lng), address: null }
      : null;
    return res.json({ success: true, data: { pickup: booking.pickupLocation?.latitude != null ? booking.pickupLocation : savedCustomerLocation, drop: booking.deliveryLocation?.latitude != null ? booking.deliveryLocation : savedCustomerLocation, garage: booking.dealer_id ? { name: booking.dealer_id.shopName || null, latitude: booking.dealer_id.latitude ?? null, longitude: booking.dealer_id.longitude ?? null, address: booking.dealer_id.fullAddress || null } : null, providerLocation: booking.pickupCurrentLocation?.latitude != null ? booking.pickupCurrentLocation : null, stage: { bookingStatus: booking.status, pickupStatus: booking.pickupStatus, garageTransportStatus: booking.garageTransportStatus, deliveryTransportStatus: booking.deliveryTransportStatus }, lastGpsUpdateAt: booking.pickupCurrentLocation?.updatedAt || null, gpsState: { stale: gpsStale, ageMs: gpsAgeMs, maxAgeMs: MAX_GPS_AGE_MS }, trackingRecord: tracking ? { status: tracking.status, updatedAt: tracking.updatedAt } : null } });
  } catch (error) {
    console.error("Booking tracking read failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not load booking tracking" });
  }
}

async function findEligibleProviders(req, res) {
  try {
    const booking = await Booking.findById(req.params.bookingId).populate("services", "_id base_service_id").populate("additionalServices", "_id base_additional_service_id").populate("dealer_id", "shopName").populate("pickupAndDropId", "user_lat user_lng").lean();
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const blockedReason = reassignmentBlock(booking);
    if (blockedReason) return res.status(409).json({ success: false, message: blockedReason, data: [] });
    if (await Payment.exists({ booking_id: booking._id, order_status: { $in: ["PENDING", "SUCCESS"] } })) return res.status(409).json({ success: false, message: "A pending or successful payment gateway record exists. Reassignment requires manual review.", data: [] });
    const q = escapeRegex(String(req.query.q || "").trim().slice(0, 80));
    const dealers = await Vendor.find({ isBlocked: { $ne: true }, registrationStatus: "Approved", online: true, wallet: { $gt: -500 }, ...(q ? { $or: [{ shopName: { $regex: q, $options: "i" } }, { ownerName: { $regex: q, $options: "i" } }, { city: { $regex: q, $options: "i" } }] } : {}) }).select("shopName ownerName city fullAddress online dealerStatus providesPickup providesDrop providesTowing latitude longitude serviceRadiusKm").limit(50).lean();
    const rawCustomerLat = booking.pickupLocation?.latitude ?? booking.pickupAndDropId?.user_lat;
    const rawCustomerLng = booking.pickupLocation?.longitude ?? booking.pickupAndDropId?.user_lng;
    const customerLat = Number(rawCustomerLat);
    const customerLng = Number(rawCustomerLng);
    if (rawCustomerLat == null || rawCustomerLng == null || rawCustomerLat === "" || rawCustomerLng === "" || !Number.isFinite(customerLat) || !Number.isFinite(customerLng) || customerLat < -90 || customerLat > 90 || customerLng < -180 || customerLng > 180) return res.status(503).json({ success: false, code: "SERVICEABILITY_UNVERIFIED", message: "Customer coordinates are unavailable, so provider serviceability cannot be verified.", data: [] });
    const distanceByDealer = new Map();
    const eligible = dealers.filter((d) => {
      if (!isDealerBookable(d) || String(d._id) === String(booking.dealer_id?._id || booking.dealer_id)) return false;
      if (!supportsBookingTransport(d, booking)) return false;
      if (d.latitude == null || d.longitude == null) return false;
      const distanceKm = calculateDistanceKm(customerLat, customerLng, Number(d.latitude), Number(d.longitude));
      if (!Number.isFinite(distanceKm) || !isWithinServiceRadius(distanceKm, d)) return false;
      distanceByDealer.set(String(d._id), distanceKm);
      return true;
    });
    const serviceEligibleIds = await providersWithCompatibleServices(booking, eligible.map((dealer) => dealer._id));
    const serviceEligible = eligible.filter((dealer) => serviceEligibleIds.has(String(dealer._id)));
    // Scheduled assignments require verified slot capacity; otherwise report
    // availability as unverified instead of suggesting a false guarantee.
    let slotReservation = null;
    if (!(await reservationsReady())) return res.status(503).json({ success: false, code: "SCHEDULE_AVAILABILITY_UNVERIFIED", message: "Garage slot capacity is not configured, so scheduled reassignment is disabled.", data: [] });
    slotReservation = await BookingSlotReservation.findOne({ bookingId: booking._id, dealerId: booking.dealer_id?._id || booking.dealer_id, scheduleDate: booking.scheduleDate, timeSlot: booking.timeSlot }).lean();
    if (!slotReservation) return res.status(503).json({ success: false, code: "SCHEDULE_RESERVATION_BASELINE_MISSING", message: "This booking has no verified slot reservation, so replacement garage availability cannot be guaranteed.", data: [] });
    const capacities = await GarageSlotCapacity.find({ _id: { $in: serviceEligible.map((d) => capacityId(d._id, booking.scheduleDate, booking.timeSlot)) }, active: true }).select("_id dealerId capacity reservedCount").lean();
    const byCapacityId = new Map(capacities.map((c) => [String(c._id), c]));
    const withAvailability = serviceEligible.filter((d) => {
      const capacity = byCapacityId.get(capacityId(d._id, booking.scheduleDate, booking.timeSlot));
      return capacity && Number.isInteger(capacity.capacity) && Number.isInteger(capacity.reservedCount) && capacity.capacity > capacity.reservedCount;
    }).map((d) => ({ ...serializeProvider(d), serviceCompatibility: "All selected services are active and bike-compatible", transportCompatible: true, distanceKm: Number(distanceByDealer.get(String(d._id)).toFixed(1)), serviceRadiusKm: d.serviceRadiusKm, slotsRemaining: byCapacityId.get(capacityId(d._id, booking.scheduleDate, booking.timeSlot)).capacity - byCapacityId.get(capacityId(d._id, booking.scheduleDate, booking.timeSlot)).reservedCount }));
    return res.json({ success: true, data: withAvailability });
  } catch (error) {
    console.error("Eligible booking providers lookup failed:", error.message);
    return res.status(500).json({ success: false, message: "Could not search eligible providers" });
  }
}

async function reassignProvider(req, res) {
  const reason = reasonFrom(req);
  const { providerId, expectedUpdatedAt } = req.body || {};
  if (reason.length < REASSIGN_REASON_MIN) return res.status(400).json({ success: false, message: "A reason of at least 5 characters is required." });
  if (!mongoose.Types.ObjectId.isValid(providerId)) return res.status(400).json({ success: false, message: "A valid replacement provider is required." });
  try {
    const booking = await Booking.findById(req.params.bookingId).populate("services", "_id base_service_id").populate("additionalServices", "_id base_additional_service_id").populate("dealer_id", "shopName ownerName").populate("pickupAndDropId", "user_lat user_lng");
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const blocked = reassignmentBlock(booking);
    if (blocked) return res.status(409).json({ success: false, message: blocked });
    if (await Payment.exists({ booking_id: booking._id, order_status: { $in: ["PENDING", "SUCCESS"] } })) return res.status(409).json({ success: false, message: "A pending or successful payment gateway record exists. Reassignment requires manual review." });
    if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== new Date(booking.updatedAt).getTime()) return res.status(409).json({ success: false, message: "Booking changed since preview. Refresh and review the assignment again." });
    booking.$where = { updatedAt: booking.updatedAt };
    const provider = await Vendor.findById(providerId).select("shopName ownerName city fullAddress online isBlocked dealerStatus registrationStatus providesPickup providesDrop providesTowing device_token ftoken latitude longitude serviceRadiusKm");
    if (!isDealerBookable(provider) || provider.registrationStatus !== "Approved") return res.status(409).json({ success: false, message: "Replacement provider is no longer active and available." });
    if (!supportsBookingTransport(provider, booking)) return res.status(409).json({ success: false, message: "Replacement provider does not support the booking's pickup, drop, or towing requirements." });
    const compatibleProviderIds = await providersWithCompatibleServices(booking, [provider._id]);
    if (!compatibleProviderIds.has(String(provider._id))) return res.status(409).json({ success: false, message: "Replacement provider does not have active, bike-compatible pricing for every selected service." });
    const rawCustomerLat = booking.pickupLocation?.latitude ?? booking.pickupAndDropId?.user_lat;
    const rawCustomerLng = booking.pickupLocation?.longitude ?? booking.pickupAndDropId?.user_lng;
    if (rawCustomerLat == null || rawCustomerLng == null || provider.latitude == null || provider.longitude == null) return res.status(409).json({ success: false, message: "Customer or replacement garage location is missing, so serviceability cannot be verified." });
    const distanceKm = calculateDistanceKm(Number(rawCustomerLat), Number(rawCustomerLng), Number(provider.latitude), Number(provider.longitude));
    if (!isWithinServiceRadius(distanceKm, provider)) return res.status(409).json({ success: false, message: "Replacement provider is outside its configured service radius." });
    const oldDealerId = booking.dealer_id?._id || booking.dealer_id;
    const oldDealer = await Vendor.findById(oldDealerId).select("shopName ownerName device_token ftoken");
    const before = { dealerId: oldDealerId, dealerName: oldDealer?.shopName || oldDealer?.ownerName || null };
    const io = req.app.get("io");
    let bookingRoomSubscribers = [];
    if (io) {
      try {
        bookingRoomSubscribers = await io.in(`booking:${booking._id}`).fetchSockets();
      } catch (socketError) {
        return res.status(503).json({ success: false, message: "Provider tracking subscriptions could not be safely refreshed. No reassignment was made." });
      }
    }
    booking.dealer_id = provider._id;
    const audit = createAdminBookingAuditEvent({ bookingId: booking._id, adminId: req.admin_id || req.auth?.id, adminRole: req.admin_role || req.auth?.adminRole, action: "booking.provider_reassigned", reason, before, after: { dealerId: provider._id, dealerName: provider.shopName || provider.ownerName || null }, requestId: correlationId(req) });
    const transferSlot = async (session) => {
      if (!(await reservationsReady())) throw new Error("SCHEDULE_AVAILABILITY_UNVERIFIED");
      const reservation = await BookingSlotReservation.findOne({ bookingId: booking._id, dealerId: oldDealerId, scheduleDate: booking.scheduleDate, timeSlot: booking.timeSlot }).session(session);
      if (!reservation) throw new Error("SCHEDULE_RESERVATION_BASELINE_MISSING");
      const targetId = capacityId(provider._id, booking.scheduleDate, booking.timeSlot);
      const oldId = capacityId(oldDealerId, booking.scheduleDate, booking.timeSlot);
      const claimed = await GarageSlotCapacity.findOneAndUpdate({ _id: targetId, dealerId: provider._id, scheduleDate: booking.scheduleDate, timeSlot: booking.timeSlot, active: true, $expr: { $lt: ["$reservedCount", "$capacity"] } }, { $inc: { reservedCount: 1 } }, { new: true, session });
      if (!claimed) throw new Error("SCHEDULE_SLOT_UNAVAILABLE");
      const released = await GarageSlotCapacity.updateOne({ _id: oldId, dealerId: oldDealerId, scheduleDate: booking.scheduleDate, timeSlot: booking.timeSlot, reservedCount: { $gt: 0 } }, { $inc: { reservedCount: -1 } }, { session });
      if (released.modifiedCount !== 1) throw new Error("SCHEDULE_RESERVATION_INCONSISTENT");
      reservation.dealerId = provider._id;
      await reservation.save({ session });
    };
    await saveBookingWithAdminAudit(booking, audit, { beforeAudit: transferSlot });
    if (io) {
      const room = `booking:${booking._id}`;
      io.to(room).emit("booking:assignment-updated", { bookingId: String(booking._id), provider: serializeProvider(provider) });
      // Both shipped apps already subscribe to booking:updated and refetch the
      // authoritative booking. Keep that contract so older app releases learn
      // about the new provider without requiring the new custom event.
      io.to(room).emit("booking:updated", { bookingId: String(booking._id), status: booking.status, dealer_id: String(provider._id) });
      try {
        // Include sockets that joined while the booking transaction was
        // committing. The room join handler also rechecks after joining, so a
        // stale authorization read cannot recreate old-provider access.
        const currentSubscribers = await io.in(room).fetchSockets();
        const subscribers = new Map([...bookingRoomSubscribers, ...currentSubscribers].map((socket, index) => [socket.id || `socket-${index}`, socket]));
        const oldProviderSockets = [...subscribers.values()].filter((socket) => socket.data?.actor?.role === "dealer" && String(socket.data.actor.id) === String(oldDealerId));
        await Promise.all(oldProviderSockets.map((socket) => Promise.resolve().then(() => socket.leave(room))));
      } catch (socketError) {
        // If per-socket enumeration failed after commit, remove the room grant
        // from all current members. Authorized participants can rejoin against
        // the updated booking assignment.
        try { await io.in(room).socketsLeave(room); }
        catch (revocationError) { console.error("Booking room revocation failed:", revocationError.message); }
        console.error("Previous provider room revocation required fallback:", socketError.message);
      }
      io.to(`dealer:${provider._id}`).emit("booking:new", { bookingId: String(booking._id), timerExpiresAt: null, source: "admin_reassignment" });
    }
    const customer = await require("../models/customer_model").findById(booking.user_id).select("device_token ftoken");
    for (const receiver of [{ doc: oldDealer, type: "dealer", title: "Booking reassigned", body: "This booking was reassigned by support." }, { doc: provider, type: "dealer", title: "Booking assigned", body: "A booking has been assigned to your garage." }]) {
      if (receiver.doc) await sendBookingNotification({ token: receiver.doc.device_token || receiver.doc.ftoken, title: receiver.title, body: receiver.body, data: { bookingId: String(booking._id), status: booking.status }, receiverId: receiver.doc._id, receiverType: receiver.type, bookingId: booking._id }).catch((e) => console.error("Assignment notification failed:", e.message));
    }
    if (customer) await sendBookingNotification({ token: customer.device_token || customer.ftoken, title: "Service provider updated", body: "Your booking has been assigned to another garage. Booking details have been updated.", data: { bookingId: String(booking._id), status: booking.status }, receiverId: customer._id, receiverType: "user", bookingId: booking._id }).catch((e) => console.error("Customer assignment notification failed:", e.message));
    return res.json({ success: true, message: "Provider reassigned", data: { provider: serializeProvider(provider), updatedAt: booking.updatedAt } });
  } catch (error) {
    console.error("Booking reassignment failed:", error.message);
    if (["SCHEDULE_AVAILABILITY_UNVERIFIED", "SCHEDULE_RESERVATION_BASELINE_MISSING", "SCHEDULE_SLOT_UNAVAILABLE", "SCHEDULE_RESERVATION_INCONSISTENT"].includes(error.message)) {
      return res.status(error.message === "SCHEDULE_SLOT_UNAVAILABLE" ? 409 : 503).json({ success: false, code: error.message, message: error.message === "SCHEDULE_SLOT_UNAVAILABLE" ? "The replacement garage slot is no longer available. Refresh candidates and retry." : "The garage slot reservation could not be verified. No changes were saved." });
    }
    return res.status(500).json({ success: false, message: "Reassignment failed; no unsafe fallback was applied." });
  }
}

async function cancelBookingForSupport(req, res) {
  const reason = reasonFrom(req);
  const { expectedUpdatedAt } = req.body || {};
  if (reason.length < REASSIGN_REASON_MIN) return res.status(400).json({ success: false, message: "A reason of at least 5 characters is required." });
  try {
    const booking = await Booking.findById(req.params.bookingId).populate("dealer_id", "shopName ownerName device_token ftoken");
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const blocked = cancellationBlock(booking);
    if (blocked) return res.status(409).json({ success: false, message: blocked, escalationRequired: true });
    if (await Payment.exists({ booking_id: booking._id, order_status: { $in: ["PENDING", "SUCCESS"] } })) return res.status(409).json({ success: false, message: "A pending or successful payment gateway record exists. Escalate for manual review.", escalationRequired: true });
    if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== new Date(booking.updatedAt).getTime()) return res.status(409).json({ success: false, message: "Booking changed since eligibility was checked. Refresh before cancelling." });
    booking.$where = { updatedAt: booking.updatedAt };
    const before = { status: booking.status, payment_status: booking.payment_status, billStatus: booking.billStatus, walletSettled: booking.walletSettled };
    booking.status = "cancelled";
    booking.cancellationReason = reason.slice(0, 120);
    booking.cancelledAt = new Date();
    booking.cancelledBy = null; // Admin identity is retained in the append-only audit event.
    const audit = createAdminBookingAuditEvent({ bookingId: booking._id, adminId: req.admin_id || req.auth?.id, adminRole: req.admin_role || req.auth?.adminRole, action: "booking.cancelled_by_support", reason, before, after: { status: booking.status, payment_status: booking.payment_status, billStatus: booking.billStatus, walletSettled: booking.walletSettled }, requestId: correlationId(req) });
    await saveBookingWithAdminAudit(booking, audit, { beforeAudit: async (session) => {
      await Tracking.updateOne({ booking_id: booking._id }, { $set: { status: "cancelled" } }, { session });
    } });
    const io = req.app.get("io");
    const cancellationEvent = { bookingId: String(booking._id), status: "cancelled", source: "admin_support" };
    io?.to(`booking:${booking._id}`).emit("booking:cancelled", cancellationEvent);
    io?.to(`dealer:${booking.dealer_id?._id || booking.dealer_id}`).emit("booking:cancelled", cancellationEvent);
    const customer = await require("../models/customer_model").findById(booking.user_id).select("device_token ftoken");
    await Promise.all([
      customer && sendBookingNotification({ token: customer.device_token || customer.ftoken, title: "Booking cancelled", body: "Your booking was cancelled by support. Contact us if you need help.", data: { bookingId: String(booking._id), status: "cancelled" }, receiverId: customer._id, receiverType: "user", bookingId: booking._id }),
      booking.dealer_id && sendBookingNotification({ token: booking.dealer_id.device_token || booking.dealer_id.ftoken, title: "Booking cancelled", body: "This booking was cancelled by support.", data: { bookingId: String(booking._id), status: "cancelled" }, receiverId: booking.dealer_id._id, receiverType: "dealer", bookingId: booking._id }),
    ].filter(Boolean).map((p) => p.catch((e) => console.error("Cancellation notification failed:", e.message))));
    return res.json({ success: true, message: "Booking cancelled without changing payment, invoice, refund, or wallet records." });
  } catch (error) {
    console.error("Support cancellation failed:", error.message);
    if (error.name === "VersionError") return res.status(409).json({ success: false, message: "Booking changed while cancellation was being saved. Refresh and review its latest state." });
    return res.status(500).json({ success: false, message: "Cancellation failed; no financial state was changed." });
  }
}

module.exports = { getBookingControlCenter, getBookingFinancialOverview, getBookingTracking, findEligibleProviders, reassignProvider, cancelBookingForSupport };
