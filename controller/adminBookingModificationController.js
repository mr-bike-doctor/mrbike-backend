const mongoose = require("mongoose");
const crypto = require("crypto");
const Booking = require("../models/Booking");
const BookingChangeConsent = require("../models/BookingChangeConsent");
const AdminService = require("../models/adminService");
const AdditionalService = require("../models/additionalServiceSchema");
const UserBike = require("../models/userBikeModel");
const Vendor = require("../models/dealerModel");
const {
  computePriceBreakdown,
  resolveServiceAmount,
  resolveServiceLines,
  applyBreakdownToBooking,
  resolveBikeCC,
  findPriceRowForCC,
} = require("../services/pricingEngine");
const {
  createAdminBookingAuditEvent,
  correlationId,
  snapshotFields,
  redactSensitive,
} = require("../services/bookingAudit");
const { sendBookingNotification } = require("../helper/pushNotification");
const { hasAdminBookingPermission } = require("../middlewares/adminBookingPermissions");
const { verifyAddressCoordinates } = require("../services/addressCoordinateValidation");
const { persistApprovedBookingModification, ConsentAlreadyResolvedError } = require("../services/adminBookingModificationTransaction");
const { checkSlotAvailability, reserveBookingSlot, SlotUnavailableError, reservationsReady } = require("../services/bookingSlotReservations");

const TERMINAL = new Set(["rejected", "user_cancelled", "cancelled", "expired", "delivered"]);
const SERVICE_LOCKED = new Set(["completed", "awaiting_payment", "ready_for_delivery", "delivered"]);
const SERVICE_CAP = 30;
const LOCATION_FIELDS = ["pickupLocation", "deliveryLocation"];
const PRICE_FIELDS = [
  "serviceAmount", "serviceLines", "pickupCharges", "dropCharges", "towingCharge",
  "subtotal", "taxRate", "taxAmount", "platformFee", "platformFeeLabel",
  "discountAmount", "customerTotal", "amountDue", "commissionRate",
  "commissionAmount", "commissionTaxRate", "commissionTaxAmount", "dealerEarnings",
  "totalBill", "tax",
];

class ModificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeLocation(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModificationError(400, "INVALID_LOCATION", `${field} must include an address and map coordinates.`);
  }
  const address = String(value.address || "").trim();
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!address || address.length > 500 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ModificationError(400, "INVALID_LOCATION", `${field} needs an address and valid latitude/longitude.`);
  }
  return { address, latitude, longitude };
}

function editableState(doc, plan) {
  if (TERMINAL.has(doc.status)) throw new ModificationError(409, "BOOKING_CLOSED", "Closed or delivered bookings cannot be modified.");
  const pickupDone = ["PICKUP_OTP_VERIFIED", "BIKE_PICKED_UP", "pickedup", "arrived"].includes(doc.pickupStatus);
  if (plan.services && (SERVICE_LOCKED.has(doc.status) || doc.billGenerated || doc.billStatus === "paid" || doc.payment_status === "completed")) {
    throw new ModificationError(409, "SERVICES_LOCKED", "Services cannot change after billing or payment.");
  }
  if (plan.services && doc.status === "payment_selected") {
    throw new ModificationError(409, "PAYMENT_SELECTION_LOCKED", "Services cannot change after a payment method is selected. Resolve the pending payment through its supported flow first.");
  }
  if (plan.vehicle && (pickupDone || !["pending", "confirmed"].includes(doc.status))) {
    throw new ModificationError(409, "VEHICLE_LOCKED", "Vehicle details can only be corrected before pickup.");
  }
  if (plan.pickupLocation && (!['pending', 'confirmed'].includes(doc.status) || pickupDone)) throw new ModificationError(409, "PICKUP_LOCATION_LOCKED", "Pickup location can only be corrected before pickup begins.");
  if (plan.deliveryLocation && ["OUT_FOR_DELIVERY", "ARRIVED_AT_CUSTOMER", "DELIVERED"].includes(String(doc.deliveryTransportStatus || "").toUpperCase())) {
    throw new ModificationError(409, "DELIVERY_LOCATION_LOCKED", "Delivery location is locked after the delivery trip begins.");
  }
  if (plan.schedule && (!(["pending", "confirmed"].includes(doc.status)) || pickupDone)) {
    throw new ModificationError(409, "SCHEDULE_LOCKED", "Schedule can only change before pickup and service completion.");
  }
}

function planFromBody(body) {
  const allowed = ["services", "additionalServices", "pickupLocation", "deliveryLocation", "scheduleDate", "timeSlot", "userBikeId"];
  const unknown = Object.keys(body || {}).filter((key) => ![...allowed, "reason", "consentReference", "expectedUpdatedAt"].includes(key));
  if (unknown.length) throw new ModificationError(400, "UNSUPPORTED_FIELDS", `Unsupported modification field(s): ${unknown.join(", ")}`);
  const plan = {};
  if (Object.hasOwn(body, "services") || Object.hasOwn(body, "additionalServices")) plan.services = true;
  if (Object.hasOwn(body, "pickupLocation")) plan.pickupLocation = true;
  if (Object.hasOwn(body, "deliveryLocation")) plan.deliveryLocation = true;
  if (Object.hasOwn(body, "scheduleDate") || Object.hasOwn(body, "timeSlot")) plan.schedule = true;
  if (Object.hasOwn(body, "userBikeId")) plan.vehicle = true;
  if (!Object.keys(plan).length) throw new ModificationError(400, "NOTHING_TO_UPDATE", "Choose at least one supported booking change.");
  return plan;
}

const CHANGE_KEYS = ["services", "additionalServices", "pickupLocation", "deliveryLocation", "scheduleDate", "timeSlot", "userBikeId"];
function requestedChanges(body) {
  return CHANGE_KEYS.reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) result[key] = body[key];
    return result;
  }, {});
}
async function validateLocationChanges(changes) {
  for (const field of LOCATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(changes || {}, field)) continue;
    const normalized = normalizeLocation(changes[field], field);
    const result = await verifyAddressCoordinates(normalized);
    if (!result.valid) {
      const unavailable = result.code === "ADDRESS_VERIFICATION_UNAVAILABLE";
      throw new ModificationError(unavailable ? 503 : 422, result.code,
        unavailable
          ? "Address verification is temporarily unavailable. No booking changes were saved."
          : "The submitted address and map pin do not match. Correct the address or pin before continuing.");
    }
  }
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function changesHash(changes) {
  return crypto.createHash("sha256").update(canonical(changes)).digest("hex");
}
async function assertScheduleAvailability(doc, scheduleDate, timeSlot) {
  try {
    await checkSlotAvailability({ booking: doc, scheduleDate, timeSlot });
  } catch (error) {
    if (error instanceof SlotUnavailableError) throw new ModificationError(error.status, error.code, error.message);
    throw error;
  }
}

async function requestAdminBookingConsent(req, res) {
  try {
    const body = req.body || {};
    if (typeof body.reason !== "string" || !body.reason.trim()) throw new ModificationError(400, "ADMIN_REASON_REQUIRED", "A support reason is required.");
    if (!body.expectedUpdatedAt || Number.isNaN(Date.parse(body.expectedUpdatedAt))) throw new ModificationError(400, "EXPECTED_VERSION_REQUIRED", "Refresh the booking preview before requesting approval.");
    const changes = requestedChanges(body);
    const plan = planFromBody(changes);
    assertPlanPermissions(req, plan);
    await validateLocationChanges(changes);
    const doc = await Booking.findOne({ _id: req.params.bookingId, updatedAt: new Date(body.expectedUpdatedAt) });
    if (!doc) throw new ModificationError(409, "BOOKING_CHANGED", "Booking changed after preview. Refresh and preview again.");
    const { before, after } = await applyPlan(doc, changes);
    const consent = await BookingChangeConsent.create({
      bookingId: doc._id, customerId: doc.user_id, requestedBy: req.auth.id,
      adminRole: req.auth.adminRole, reason: body.reason.trim().slice(0, 500),
      changes, changesHash: changesHash(changes), expectedUpdatedAt: doc.updatedAt,
      pricePreview: { before: { serviceAmount: before.serviceAmount, customerTotal: before.customerTotal, amountDue: before.amountDue }, after: { serviceAmount: after.serviceAmount, customerTotal: after.customerTotal, amountDue: after.amountDue } },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    try {
      const Customer = require("../models/customer_model");
      const customer = await Customer.findById(doc.user_id).select("device_token ftoken").lean();
      await sendBookingNotification({ token: customer?.device_token || customer?.ftoken, title: "Booking change approval needed", body: "MR Bike support has proposed a change to your booking. Review it in the app.", data: { type: "booking_change_consent", bookingId: String(doc._id) }, receiverId: doc.user_id, receiverType: "user", bookingId: doc._id });
    } catch (notificationError) { console.error("[admin-booking-modification] consent notification failed:", notificationError.message); }
    return res.status(201).json({ success: true, consentId: String(consent._id), status: consent.status, expiresAt: consent.expiresAt });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, code: error.code || "CONSENT_REQUEST_FAILED", message: error.status ? error.message : "Unable to request customer approval." });
  }
}

async function getCustomerBookingConsent(req, res) {
  try {
    const consent = await BookingChangeConsent.findOne({ bookingId: req.params.bookingId, customerId: req.auth.id, status: { $in: ["pending", "approved"] }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    if (!consent) return res.json({ success: true, data: null });
    const summary = [];
    if (consent.changes.services) {
      const entries = await AdminService.find({ _id: { $in: consent.changes.services } }).populate("base_service_id", "name").select("base_service_id").lean();
      summary.push({ label: "Services", value: entries.map((item) => item.base_service_id?.name).filter(Boolean).join(", ") || "No services selected" });
    }
    if (consent.changes.additionalServices) {
      const entries = await AdditionalService.find({ _id: { $in: consent.changes.additionalServices } }).populate("base_additional_service_id", "name").select("base_additional_service_id").lean();
      summary.push({ label: "Additional work", value: entries.map((item) => item.base_additional_service_id?.name).filter(Boolean).join(", ") || "No additional work selected" });
    }
    if (consent.changes.pickupLocation) summary.push({ label: "Pickup location", value: consent.changes.pickupLocation.address });
    if (consent.changes.deliveryLocation) summary.push({ label: "Delivery location", value: consent.changes.deliveryLocation.address });
    if (consent.changes.scheduleDate || consent.changes.timeSlot) summary.push({ label: "Schedule", value: [consent.changes.scheduleDate, consent.changes.timeSlot].filter(Boolean).join(" · ") });
    if (consent.changes.userBikeId) {
      const vehicle = await UserBike.findOne({ _id: consent.changes.userBikeId, user_id: req.auth.id }).select("name model plate_number bike_cc").lean();
      summary.push({ label: "Vehicle", value: vehicle ? [vehicle.plate_number, vehicle.name, vehicle.model, `${vehicle.bike_cc} cc`].filter(Boolean).join(" · ") : "Vehicle details updated" });
    }
    return res.json({ success: true, data: { ...consent, changeSummary: summary } });
  } catch (error) {
    console.error("[admin-booking-modification] customer consent read failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load the booking approval request." });
  }
}

async function respondToBookingConsent(req, res) {
  try {
  const { approved } = req.body || {};
  if (typeof approved !== "boolean") return res.status(400).json({ success: false, message: "approved must be true or false." });
  const consent = await BookingChangeConsent.findOneAndUpdate({ _id: req.params.consentId, bookingId: req.params.bookingId, customerId: req.auth.id, status: "pending", expiresAt: { $gt: new Date() } }, { $set: { status: approved ? "approved" : "rejected", respondedAt: new Date() } }, { new: true });
  if (!consent) return res.status(409).json({ success: false, code: "CONSENT_EXPIRED_OR_RESOLVED", message: "This approval request has expired or was already answered." });
  return res.json({ success: true, status: consent.status, message: approved ? "Booking change approved." : "Booking change declined." });
  } catch (error) {
    console.error("[admin-booking-modification] customer consent response failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to record your approval response." });
  }
}

async function getAdminBookingConsentStatus(req, res) {
  try {
  const consent = await BookingChangeConsent.findOne({ _id: req.params.consentId, bookingId: req.params.bookingId, requestedBy: req.auth.id }).select("status expiresAt respondedAt").lean();
  if (!consent) return res.status(404).json({ success: false, message: "Approval request not found." });
  if (consent.status === "pending" && consent.expiresAt <= new Date()) consent.status = "expired";
  return res.json({ success: true, data: consent });
  } catch (error) {
    console.error("[admin-booking-modification] consent status read failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to check customer approval." });
  }
}

function assertPlanPermissions(req, plan) {
  const needed = [];
  if (plan.services || plan.vehicle || plan.schedule) needed.push("booking.service_modify");
  if (plan.pickupLocation || plan.deliveryLocation) needed.push("booking.location_correct");
  if (!needed.every((permission) => hasAdminBookingPermission(req.auth?.adminRole, permission))) {
    throw new ModificationError(403, "BOOKING_PERMISSION_DENIED", "Your admin role cannot perform one or more selected changes.");
  }
}

async function getAdminBookingModificationCatalog(req, res) {
  try {
    const doc = await Booking.findById(req.params.bookingId).select("user_id dealer_id userBike_id services additionalServices status");
    if (!doc) return res.status(404).json({ success: false, message: "Booking not found" });
    const bikeData = await UserBike.findById(doc.userBike_id).select("bike_cc variant_id").populate({ path: "variant_id", select: "model_id engine_cc" }).lean();
    if (!bikeData) return res.status(409).json({ success: false, message: "Booking vehicle is unavailable." });
    const bikeCC = resolveBikeCC(bikeData);
    const context = { variantId: bikeData.variant_id?._id || bikeData.variant_id, modelId: bikeData.variant_id?.model_id };
    const [services, addOns, vehicles] = await Promise.all([
      AdminService.find({ dealer_id: doc.dealer_id, $or: [{ isActive: { $ne: false } }, { _id: { $in: doc.services || [] } }] }).populate("base_service_id", "name image description").lean(),
      AdditionalService.find({ dealer_id: doc.dealer_id, $or: [{ isActive: { $ne: false } }, { _id: { $in: doc.additionalServices || [] } }] }).populate("base_additional_service_id", "name image description").lean(),
      UserBike.find({ user_id: doc.user_id, status: { $ne: 0 } }).select("_id name model bike_cc plate_number variant_id").lean(),
    ]);
    const eligible = (items) => items.map((item) => {
      const row = findPriceRowForCC(item, bikeCC, context);
      return row ? { _id: String(item._id), name: item.base_service_id?.name || item.name || "Service", description: item.description || item.base_service_id?.description || "", price: Number(row.price) || 0 } : null;
    }).filter(Boolean);
    return res.json({ success: true, data: { services: eligible(services), additionalServices: eligible(addOns), vehicles, selectedServices: (doc.services || []).map(String), selectedAdditionalServices: (doc.additionalServices || []).map(String), scheduleChangesEnabled: await reservationsReady() } });
  } catch (error) {
    console.error("[admin-booking-modification] catalog failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load eligible booking options." });
  }
}

async function applyPlan(doc, body) {
  const plan = planFromBody(body);
  editableState(doc, plan);
  const before = snapshotFields(doc, ["services", "additionalServices", ...LOCATION_FIELDS, "scheduleDate", "timeSlot", "userBike_id", ...PRICE_FIELDS]);

  if (plan.vehicle) {
    if (!mongoose.Types.ObjectId.isValid(body.userBikeId)) throw new ModificationError(400, "INVALID_VEHICLE", "Choose a valid customer vehicle.");
    const vehicle = await UserBike.findOne({ _id: body.userBikeId, user_id: doc.user_id, status: { $ne: 0 } }).select("_id");
    if (!vehicle) throw new ModificationError(400, "INVALID_VEHICLE", "Vehicle must belong to this customer and be active.");
    doc.userBike_id = vehicle._id;
  }

  const shouldReprice = plan.services || plan.vehicle;
  if (shouldReprice) {
    const services = body.services === undefined ? (doc.services || []).map(String) : body.services;
    const additionalServices = body.additionalServices === undefined ? (doc.additionalServices || []).map(String) : body.additionalServices;
    if (!Array.isArray(services) || !Array.isArray(additionalServices) || services.length + additionalServices.length > SERVICE_CAP) {
      throw new ModificationError(400, "INVALID_SERVICES", `Send valid service id arrays (up to ${SERVICE_CAP} services total).`);
    }
    if (!services.length) throw new ModificationError(400, "INVALID_SERVICES", "A booking must retain at least one core service.");
    if (new Set(services.map(String)).size !== services.length || new Set(additionalServices.map(String)).size !== additionalServices.length) {
      throw new ModificationError(400, "DUPLICATE_SERVICES", "A service can only be selected once; quantities are not supported.");
    }
    for (const id of [...services, ...additionalServices]) if (!mongoose.Types.ObjectId.isValid(id)) throw new ModificationError(400, "INVALID_SERVICES", "A service id is invalid.");
    const oldServices = new Set((doc.services || []).map(String));
    const oldAddOns = new Set((doc.additionalServices || []).map(String));
    const [mainDocs, addOnDocs] = await Promise.all([
      AdminService.find({ _id: { $in: services }, dealer_id: doc.dealer_id, $or: [{ isActive: { $ne: false } }, { _id: { $in: [...oldServices] } }] }).select("_id bikes").lean(),
      AdditionalService.find({ _id: { $in: additionalServices }, dealer_id: doc.dealer_id, $or: [{ isActive: { $ne: false } }, { _id: { $in: [...oldAddOns] } }] }).select("_id bikes").lean(),
    ]);
    if (mainDocs.length !== new Set(services.map(String)).size || addOnDocs.length !== new Set(additionalServices.map(String)).size) {
      throw new ModificationError(400, "SERVICE_UNAVAILABLE", "One or more services are inactive, unavailable to this garage, or invalid.");
    }
    const bikeData = await UserBike.findById(doc.userBike_id).select("bike_cc variant_id").populate({ path: "variant_id", select: "model_id engine_cc" }).lean();
    const context = { variantId: bikeData?.variant_id?._id || bikeData?.variant_id, modelId: bikeData?.variant_id?.model_id };
    if (!bikeData || [...mainDocs, ...addOnDocs].some((item) => !findPriceRowForCC(item, resolveBikeCC(bikeData), context))) {
      throw new ModificationError(400, "SERVICE_NOT_PRICED_FOR_VEHICLE", "Every selected service must have a catalog price for this vehicle.");
    }
    doc.services = services.map((id) => new mongoose.Types.ObjectId(id));
    doc.additionalServices = additionalServices.map((id) => new mongoose.Types.ObjectId(id));
    const dealer = await Vendor.findById(doc.dealer_id).select("tax commission pickupCharges dropCharges providesPickup providesDrop providesTowing towingCharges").lean();
    if (!bikeData || !dealer) throw new ModificationError(409, "PRICING_CONTEXT_MISSING", "Could not validate the booking bike or garage pricing.");
    const pricingInput = { services: mainDocs, additionalServices: addOnDocs, bikeCC: resolveBikeCC(bikeData), bikeContext: context };
    const breakdown = computePriceBreakdown({
      serviceAmount: resolveServiceAmount(pricingInput),
      transportOption: doc.transportOption,
      dealer,
      discountAmount: doc.discountAmount,
      bikeCondition: doc.bikeCondition,
      towingRequiredOverride: doc.towingRequired,
      towingChargeOverride: doc.towingCharge,
      platformFeeOverride: doc.platformFee,
      platformFeeLabelOverride: doc.platformFeeLabel,
      commissionTaxRateOverride: doc.commissionTaxRate,
    });
    applyBreakdownToBooking(doc, breakdown, { serviceLines: resolveServiceLines(pricingInput) });
  }

  if (plan.pickupLocation) {
    doc.pickupLocation = normalizeLocation(body.pickupLocation, "pickupLocation");
    doc.pickupAddress = doc.pickupLocation.address;
  }
  if (plan.deliveryLocation) doc.deliveryLocation = normalizeLocation(body.deliveryLocation, "deliveryLocation");
  if (plan.schedule) {
    const date = body.scheduleDate == null ? "" : String(body.scheduleDate).trim();
    const slot = body.timeSlot == null ? "" : String(body.timeSlot).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slot || slot.length > 80 || !Number.isFinite(Date.parse(`${date}T00:00:00`))) {
      throw new ModificationError(400, "INVALID_SCHEDULE", "Choose a valid date and time slot.");
    }
    doc.scheduleDate = date;
    doc.timeSlot = slot;
    doc.pickupDate = new Date(`${date}T00:00:00.000Z`);
  }
  if (plan.schedule && (before.scheduleDate !== doc.scheduleDate || before.timeSlot !== doc.timeSlot)) {
    await assertScheduleAvailability(doc, doc.scheduleDate, doc.timeSlot);
  }

  const after = snapshotFields(doc, ["services", "additionalServices", ...LOCATION_FIELDS, "pickupAddress", "scheduleDate", "timeSlot", "pickupDate", "userBike_id", ...PRICE_FIELDS]);
  return { plan, before, after };
}

function requiresConsent(before, after) {
  return JSON.stringify(before.services) !== JSON.stringify(after.services) ||
    JSON.stringify(before.additionalServices) !== JSON.stringify(after.additionalServices) ||
    JSON.stringify(before.pickupLocation) !== JSON.stringify(after.pickupLocation) ||
    JSON.stringify(before.deliveryLocation) !== JSON.stringify(after.deliveryLocation) ||
    String(before.userBike_id) !== String(after.userBike_id) ||
    before.scheduleDate !== after.scheduleDate || before.timeSlot !== after.timeSlot ||
    Number(before.amountDue || 0) !== Number(after.amountDue || 0);
}

async function previewAdminBookingModification(req, res) {
  try {
    const body = req.body || {};
    const doc = await Booking.findById(req.params.bookingId);
    if (!doc) return res.status(404).json({ success: false, message: "Booking not found" });
    const plan = planFromBody(body);
    assertPlanPermissions(req, plan);
    await validateLocationChanges(body);
    const { before, after } = await applyPlan(doc, body);
    return res.json({ success: true, preview: true, expectedUpdatedAt: doc.updatedAt, requiresCustomerConsent: requiresConsent(before, after), before: redactSensitive(before), after: redactSensitive(after), priceDifference: Number(after.amountDue || 0) - Number(before.amountDue || 0) });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, code: error.code || "MODIFICATION_PREVIEW_FAILED", message: error.status ? error.message : "Unable to preview booking changes" });
  }
}

async function applyAdminBookingModification(req, res) {
  const { bookingId } = req.params;
  const body = req.body || {};
  if (typeof body.reason !== "string" || !body.reason.trim()) return res.status(400).json({ success: false, code: "ADMIN_REASON_REQUIRED", message: "A reason is required." });
  if (!mongoose.Types.ObjectId.isValid(body.consentReference)) return res.status(409).json({ success: false, code: "CUSTOMER_CONSENT_REQUIRED", message: "An approved customer consent request is required before saving." });
  if (!body.expectedUpdatedAt || Number.isNaN(Date.parse(body.expectedUpdatedAt))) return res.status(400).json({ success: false, code: "EXPECTED_VERSION_REQUIRED", message: "Refresh the booking preview before saving." });

  try {
    await validateLocationChanges(body);
  } catch (error) {
    return res.status(error.status || 503).json({ success: false, code: error.code || "ADDRESS_VERIFICATION_UNAVAILABLE", message: error.message || "Address verification is unavailable." });
  }

  const session = await mongoose.startSession();
  let committed;
  try {
    await session.withTransaction(async () => {
      const doc = await Booking.findOne({ _id: bookingId, updatedAt: new Date(body.expectedUpdatedAt) }).session(session);
      if (!doc) throw new ModificationError(409, "BOOKING_CHANGED", "Booking changed after preview. Refresh and review the new values.");
      const plan = planFromBody(body);
      assertPlanPermissions(req, plan);
      const consent = await BookingChangeConsent.findOne({
        _id: body.consentReference,
        bookingId: doc._id,
        customerId: doc.user_id,
        status: "approved",
        expiresAt: { $gt: new Date() },
        expectedUpdatedAt: doc.updatedAt,
        changesHash: changesHash(requestedChanges(body)),
      }).session(session);
      if (!consent) throw new ModificationError(409, "CUSTOMER_CONSENT_REQUIRED", "The customer has not approved these exact changes, or the booking changed after approval.");
      const { before, after } = await applyPlan(doc, body);
      if (before.scheduleDate !== after.scheduleDate || before.timeSlot !== after.timeSlot) {
        await reserveBookingSlot({ booking: doc, scheduleDate: doc.scheduleDate, timeSlot: doc.timeSlot, hadPreviousSchedule: Boolean(before.scheduleDate || before.timeSlot), session });
      }
      const adminFields = ["services", "additionalServices", ...LOCATION_FIELDS, "pickupAddress", "scheduleDate", "timeSlot", "pickupDate", "userBike_id", ...PRICE_FIELDS];
      const auditEvent = createAdminBookingAuditEvent({
        bookingId: doc._id,
        adminId: req.auth.id,
        adminRole: req.auth.adminRole,
        action: "booking.admin_modification",
        reason: body.reason,
        before,
        after: snapshotFields(doc, adminFields),
        consentReference: body.consentReference,
        requestId: correlationId(req),
      });
      await persistApprovedBookingModification({ booking: doc, consent, auditEvent, session });
      committed = { id: String(doc._id), customerId: String(doc.user_id), dealerId: String(doc.dealer_id), data: doc.toObject(), locationsChanged: Boolean(doc.isModified("pickupLocation") || doc.isModified("deliveryLocation")) };
    });
  } catch (error) {
    if (error instanceof ModificationError || error instanceof SlotUnavailableError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    if (error instanceof ConsentAlreadyResolvedError) return res.status(409).json({ success: false, code: error.code, message: error.message });
    console.error("[admin-booking-modification] transaction failed:", error.message);
    return res.status(503).json({ success: false, code: "AUDITED_MUTATION_UNAVAILABLE", message: "Booking change was not saved because the audited transaction could not complete." });
  } finally {
    await session.endSession();
  }

  // Notifications are best effort and occur only after the booking + audit
  // transaction committed. Historical tracking points are never edited.
  try {
    const customer = await require("../models/customer_model").findById(committed.customerId).select("device_token ftoken").lean();
    await sendBookingNotification({ token: customer?.device_token || customer?.ftoken, title: "Your booking was updated", body: "An MR Bike support agent updated your booking. Open the app to review the latest details.", data: { type: "booking_updated", bookingId }, receiverId: committed.customerId, receiverType: "user", bookingId });
  } catch (error) { console.error("[admin-booking-modification] customer notification failed:", error.message); }
  try {
    const dealer = await Vendor.findById(committed.dealerId).select("device_token ftoken").lean();
    await sendBookingNotification({ token: dealer?.device_token || dealer?.ftoken, title: "Booking details updated", body: "MR Bike support updated a booking assigned to your garage. Refresh the booking before acting.", data: { type: "booking_updated", bookingId }, receiverId: committed.dealerId, receiverType: "dealer", bookingId });
  } catch (error) { console.error("[admin-booking-modification] provider notification failed:", error.message); }
  const io = req.app.get("io");
  const locationUpdate = { pickupLocation: committed.data.pickupLocation, deliveryLocation: committed.data.deliveryLocation };
  if (io) io.to(`booking:${bookingId}`).emit("booking:updated", { bookingId, status: committed.data.status, ...locationUpdate });
  const updated = await Booking.findById(bookingId)
    .populate({ path: "services", select: "_id name description image" })
    .populate({ path: "additionalServices", select: "_id description base_additional_service_id", populate: { path: "base_additional_service_id", select: "name image description" } })
    .populate({ path: "userBike_id", select: "_id name model bike_cc plate_number variant_id", populate: { path: "variant_id", select: "model_id engine_cc" } });
  return res.json({ success: true, message: "Booking updated and audit recorded.", data: redactSensitive(updated?.toObject() || committed.data) });
}

module.exports = {
  requestAdminBookingConsent,
  getCustomerBookingConsent,
  respondToBookingConsent,
  getAdminBookingConsentStatus,
  getAdminBookingModificationCatalog,
  previewAdminBookingModification,
  applyAdminBookingModification,
  _test: { normalizeLocation, editableState, planFromBody, requiresConsent, assertPlanPermissions, assertScheduleAvailability, changesHash, requestedChanges, validateLocationChanges, ModificationError },
};
