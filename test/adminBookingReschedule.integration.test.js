// Admin rescheduling runs only against a dedicated local replica set.
const assert = require("assert");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Admin = require("../models/admin_model");
const Customer = require("../models/customer_model");
const Vendor = require("../models/dealerModel");
const UserBike = require("../models/userBikeModel");
require("../models/bikeVariantModel");
const BookingChangeConsent = require("../models/BookingChangeConsent");
const AdminBookingAudit = require("../models/AdminBookingAudit");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const GarageSlotCapacity = require("../models/GarageSlotCapacity");
const { capacityId, reservationsReady } = require("../services/bookingSlotReservations");

if (!process.env.TEST_MONGO_URL) {
  console.log("adminBookingReschedule.integration.test.js — SKIPPED (set TEST_MONGO_URL to a dedicated loopback replica set)");
  process.exit(0);
}
const url = new URL(process.env.TEST_MONGO_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("TEST_MONGO_URL must be loopback; refusing a remote database");
url.pathname = `/mrbike_admin_reschedule_${new mongoose.Types.ObjectId()}`;

const id = () => new mongoose.Types.ObjectId();
const ids = {
  admin: id(), customer: id(), otherCustomer: id(), dealer: id(), bike: id(),
  pending: id(), confirmed: id(), decline: id(), sourcePeer: id(),
  raceA: id(), raceB: id(), rollback: id(), moving: id(), otpVerified: id(), garageStarted: id(),
  atGarage: id(), serviceStarted: id(), deliveryStarted: id(), paid: id(), closed: id(),
};
const sourceDate = "2031-06-18";
const sourceSlot = "09:00-10:00";
const targetDateA = "2031-06-19";
const targetDateB = "2031-06-20";
const targetDateRace = "2031-06-21";
const events = [];
const notifications = [];
const io = { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };

function bookingDoc(bookingId, status = "confirmed", extra = {}) {
  return {
    _id: bookingId, bookingId: `TEST-${bookingId}`, user_id: ids.customer, dealer_id: ids.dealer, userBike_id: ids.bike,
    services: [], additionalServices: [], status, pickupStatus: "pending",
    pickupTrackingActive: false, pickupStartedAt: null, pickupOtpVerifiedAt: null,
    pickupCompletedAt: null, garageTransportStatus: "NOT_STARTED", garageTransportStartedAt: null,
    garageArrivedAt: null, deliveryTransportStatus: "NOT_STARTED", deliveryTransportStartedAt: null,
    deliveryArrivedAt: null, deliveryTransportCompletedAt: null,
    billGenerated: false, billStatus: "pending", payment_status: "pending",
    scheduleDate: sourceDate, timeSlot: sourceSlot, pickupDate: new Date(`${sourceDate}T00:00:00.000Z`),
    createdAt: new Date(), updatedAt: new Date(), ...extra,
  };
}

function request(port, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function approveAndApply(port, bookingId, adminToken, customerToken, scheduleDate, timeSlot, label) {
  const proposal = { scheduleDate, timeSlot };
  const preview = await request(port, "POST", `/bookings/${bookingId}/admin-modification/preview`, adminToken, proposal);
  assert.strictEqual(preview.status, 200, `${label} preview: ${JSON.stringify(preview.body)}`);
  assert.strictEqual(preview.body.requiresCustomerConsent, true, "a schedule change requires customer approval");
  const consent = await request(port, "POST", `/bookings/${bookingId}/admin-modification/consent`, adminToken, { ...proposal, expectedUpdatedAt: preview.body.expectedUpdatedAt, reason: `Customer requested ${label}` });
  assert.strictEqual(consent.status, 201, `${label} approval request`);
  const customerReply = await request(port, "POST", `/bookings/${bookingId}/admin-modification/consent/${consent.body.consentId}/respond`, customerToken, { approved: true });
  assert.strictEqual(customerReply.status, 200, `${label} customer approval`);
  const applied = await request(port, "POST", `/bookings/${bookingId}/admin-modification`, adminToken, { ...proposal, expectedUpdatedAt: preview.body.expectedUpdatedAt, reason: `Customer requested ${label}`, consentReference: consent.body.consentId });
  return { applied, preview, consentId: consent.body.consentId };
}

async function main() {
  const originalEnable = process.env.ENABLE_BOOKING_SLOT_RESERVATIONS;
  const originalReady = process.env.BOOKING_SLOT_RESERVATIONS_READY;
  const originalSecret = process.env.JWT_SECRET;
  const helper = require("../helper/pushNotification");
  const originalNotify = helper.sendBookingNotification;
  const originalAuditCreate = AdminBookingAudit.create;
  let server;
  try {
    await mongoose.connect(url.toString(), { serverSelectionTimeoutMS: 3000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("A local replica set is required for rescheduling transaction tests");
    delete process.env.ENABLE_BOOKING_SLOT_RESERVATIONS;
    delete process.env.BOOKING_SLOT_RESERVATIONS_READY;
    assert.strictEqual(await reservationsReady(), false, "rescheduling is disabled by default");
    process.env.JWT_SECRET = "admin-reschedule-e2e-only-secret";
    helper.sendBookingNotification = async (entry) => { notifications.push(entry); return "test-adapter"; };

    await BookingSlotReservation.collection.createIndex({ bookingId: 1 }, { unique: true });
    await Promise.all([
      Admin.collection.insertOne({ _id: ids.admin, role: "Admin", status: "active", name: "Test Admin", email: `reschedule-${ids.admin}@example.test`, password: "fixture-only", mobile: "9000000011", ID: `TEST-${ids.admin}` }),
      Customer.collection.insertMany([{ _id: ids.customer, status: "active", first_name: "Test" }, { _id: ids.otherCustomer, status: "active", first_name: "Other" }]),
      Vendor.collection.insertOne({ _id: ids.dealer, phone: "9000000012" }),
      UserBike.collection.insertOne({ _id: ids.bike, user_id: ids.customer, name: "Test Bike", model: "Model", bike_cc: "150", plate_number: `TEST-${ids.bike}`, variant_id: id(), status: 1 }),
      Booking.collection.insertMany([
        bookingDoc(ids.pending, "pending"), bookingDoc(ids.confirmed), bookingDoc(ids.decline), bookingDoc(ids.sourcePeer),
        bookingDoc(ids.raceA, "pending"), bookingDoc(ids.raceB, "pending"), bookingDoc(ids.rollback, "pending"),
        bookingDoc(ids.moving, "confirmed", { scheduleDate: "2031-06-22", pickupStatus: "arriving", pickupTrackingActive: true, pickupStartedAt: new Date() }),
        bookingDoc(ids.otpVerified, "confirmed", { scheduleDate: "2031-06-23", pickupStatus: "PICKUP_OTP_VERIFIED", pickupOtpVerifiedAt: new Date() }),
        bookingDoc(ids.garageStarted, "confirmed", { scheduleDate: "2031-06-24", pickupStatus: "BIKE_PICKED_UP", garageTransportStatus: "TO_GARAGE", garageTransportStartedAt: new Date() }),
        bookingDoc(ids.atGarage, "confirmed", { scheduleDate: "2031-06-25", pickupStatus: "BIKE_PICKED_UP", garageTransportStatus: "ARRIVED_AT_GARAGE", garageArrivedAt: new Date() }),
        bookingDoc(ids.serviceStarted, "confirmed", { scheduleDate: "2031-06-26", serviceDate: new Date() }),
        bookingDoc(ids.deliveryStarted, "confirmed", { scheduleDate: "2031-06-29", deliveryTransportStatus: "OUT_FOR_DELIVERY", deliveryTransportStartedAt: new Date() }),
        bookingDoc(ids.paid, "payment_selected", { scheduleDate: "2031-06-27", payment_status: "completed" }),
        bookingDoc(ids.closed, "cancelled", { scheduleDate: "2031-06-28" }),
      ]),
    ]);

    // All source slots and capacities are fixture-only. The pending booking's
    // source reservation is intentionally missing; authoritative counts prove
    // the counter and allow the transaction to reconcile it safely.
    const oldSourceIds = [ids.pending, ids.confirmed, ids.decline, ids.sourcePeer, ids.raceA, ids.raceB, ids.rollback];
    await GarageSlotCapacity.create([
      { _id: capacityId(ids.dealer, sourceDate, sourceSlot), dealerId: ids.dealer, scheduleDate: sourceDate, timeSlot: sourceSlot, capacity: 8, reservedCount: 7 },
      ...[targetDateA, targetDateB].map((date) => ({ _id: capacityId(ids.dealer, date, "10:00-11:00"), dealerId: ids.dealer, scheduleDate: date, timeSlot: "10:00-11:00", capacity: 1, reservedCount: 0 })),
      { _id: capacityId(ids.dealer, "2031-06-22", "10:00-11:00"), dealerId: ids.dealer, scheduleDate: "2031-06-22", timeSlot: "10:00-11:00", capacity: 1, reservedCount: 0 },
      { _id: capacityId(ids.dealer, targetDateRace, "11:00-12:00"), dealerId: ids.dealer, scheduleDate: targetDateRace, timeSlot: "11:00-12:00", capacity: 1, reservedCount: 0 },
    ]);
    await BookingSlotReservation.create(oldSourceIds.slice(1).map((bookingId) => ({ bookingId, dealerId: ids.dealer, scheduleDate: sourceDate, timeSlot: sourceSlot })));
    process.env.ENABLE_BOOKING_SLOT_RESERVATIONS = "true";
    process.env.BOOKING_SLOT_RESERVATIONS_READY = "true";
    assert.strictEqual(await reservationsReady(), true, "test-only unique index and capacity config enables isolated readiness");

    const uploadFactory = require("../utils/s3Upload");
    uploadFactory.createS3Upload = () => ({ array: () => (_req, _res, next) => next() });
    const app = express(); app.use(express.json()); app.set("io", io);
    app.use("/bookings", require("../routes/bookingRoutes"));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const tokenFor = (userId, userType) => jwt.sign({ user_id: String(userId), type: "logged", user_type: userType }, process.env.JWT_SECRET, { algorithm: "HS256" });
    const adminToken = tokenFor(ids.admin, 1);
    const customerToken = tokenFor(ids.customer, 4);
    const otherCustomerToken = tokenFor(ids.otherCustomer, 4);

    const scheduleCatalog = await request(port, "GET", `/bookings/${ids.pending}/admin-modification/catalog`, adminToken);
    assert.strictEqual(scheduleCatalog.status, 200);
    assert.strictEqual(scheduleCatalog.body.data.scheduleChangesEnabled, true, "verified capacity can safely reconcile one missing source reservation");
    assert.strictEqual(await BookingSlotReservation.exists({ bookingId: ids.pending }), null, "catalog/readiness check does not mutate reservation data");
    const configuredSlots = await request(port, "GET", `/bookings/${ids.pending}/admin-modification/slots?date=${targetDateA}`, adminToken);
    assert.strictEqual(configuredSlots.status, 200);
    assert.deepStrictEqual(configuredSlots.body.data.slots.map((slot) => slot.timeSlot), ["10:00-11:00"], "time choices come only from configured capacity records");
    const movingCatalog = await request(port, "GET", `/bookings/${ids.moving}/admin-modification/catalog`, adminToken);
    assert.strictEqual(movingCatalog.body.data.scheduleChangesEnabled, false);
    assert.match(movingCatalog.body.data.scheduleChangeBlockedReason, /Pickup activity has started/);

    const { applied: pendingApply } = await approveAndApply(port, ids.pending, adminToken, customerToken, targetDateA, "10:00-11:00", "pending booking reschedule");
    assert.strictEqual(pendingApply.status, 200, JSON.stringify(pendingApply.body));
    const pendingSaved = await Booking.findById(ids.pending).lean();
    assert.strictEqual(pendingSaved.scheduleDate, targetDateA);
    assert.strictEqual(pendingSaved.timeSlot, "10:00-11:00");
    const pendingReservation = await BookingSlotReservation.findOne({ bookingId: ids.pending }).lean();
    assert.strictEqual(pendingReservation.scheduleDate, targetDateA);
    assert(await BookingSlotReservation.exists({ bookingId: ids.sourcePeer }), "the missing source reservation was reconciled from authoritative booking data");
    assert.strictEqual((await GarageSlotCapacity.findById(capacityId(ids.dealer, sourceDate, sourceSlot)).lean()).reservedCount, 6, "old slot is released only after new reservation commits");
    assert.strictEqual((await GarageSlotCapacity.findById(capacityId(ids.dealer, targetDateA, "10:00-11:00")).lean()).reservedCount, 1);
    assert(await AdminBookingAudit.exists({ bookingId: ids.pending, action: "booking.admin_modification" }));
    assert(notifications.some((entry) => entry.receiverType === "user" && entry.data?.scheduleDate === targetDateA));
    assert(notifications.some((entry) => entry.receiverType === "dealer" && entry.data?.timeSlot === "10:00-11:00"));
    assert(events.some((entry) => entry.event === "booking:updated" && entry.payload?.scheduleDate === targetDateA && entry.payload?.timeSlot === "10:00-11:00"));

    const confirmedApply = await approveAndApply(port, ids.confirmed, adminToken, customerToken, targetDateB, "10:00-11:00", "confirmed booking reschedule");
    assert.strictEqual(confirmedApply.applied.status, 200, JSON.stringify(confirmedApply.applied.body));
    const duplicateApply = await request(port, "POST", `/bookings/${ids.confirmed}/admin-modification`, adminToken, { scheduleDate: targetDateB, timeSlot: "10:00-11:00", expectedUpdatedAt: confirmedApply.preview.body.expectedUpdatedAt, reason: "duplicate reschedule", consentReference: confirmedApply.consentId });
    assert.strictEqual(duplicateApply.status, 409, "duplicate apply is rejected by stale booking or consumed consent");

    const declinePreview = await request(port, "POST", `/bookings/${ids.decline}/admin-modification/preview`, adminToken, { scheduleDate: "2031-06-22", timeSlot: "10:00-11:00" });
    assert.strictEqual(declinePreview.status, 200);
    const declineConsent = await request(port, "POST", `/bookings/${ids.decline}/admin-modification/consent`, adminToken, { scheduleDate: "2031-06-22", timeSlot: "10:00-11:00", expectedUpdatedAt: declinePreview.body.expectedUpdatedAt, reason: "decline requested schedule" });
    assert.strictEqual((await request(port, "POST", `/bookings/${ids.decline}/admin-modification/consent/${declineConsent.body.consentId}/respond`, otherCustomerToken, { approved: true })).status, 404);
    assert.strictEqual((await request(port, "POST", `/bookings/${ids.decline}/admin-modification/consent/${declineConsent.body.consentId}/respond`, customerToken, { approved: false })).status, 200);
    assert.strictEqual((await Booking.findById(ids.decline).lean()).scheduleDate, sourceDate, "declined schedule remains unchanged");

    const lockedCases = [
      [ids.moving, { pickupStatus: "arriving", pickupTrackingActive: true, pickupStartedAt: new Date() }, "provider started pickup travel"],
      [ids.otpVerified, { pickupStatus: "PICKUP_OTP_VERIFIED", pickupOtpVerifiedAt: new Date() }, "pickup OTP verified"],
      [ids.garageStarted, { pickupStatus: "BIKE_PICKED_UP", garageTransportStatus: "TO_GARAGE", garageTransportStartedAt: new Date() }, "garage transport started"],
      [ids.atGarage, { pickupStatus: "BIKE_PICKED_UP", garageTransportStatus: "ARRIVED_AT_GARAGE", garageArrivedAt: new Date() }, "arrived at garage/service stage"],
      [ids.serviceStarted, { serviceDate: new Date() }, "service started/completed"],
      [ids.deliveryStarted, { deliveryTransportStatus: "OUT_FOR_DELIVERY", deliveryTransportStartedAt: new Date() }, "delivery started"],
      [ids.paid, { payment_status: "completed" }, "payment started"],
      [ids.closed, {}, "closed booking"],
    ];
    for (const [bookingId, values, label] of lockedCases) {
      await Booking.collection.updateOne({ _id: bookingId }, { $set: values });
      const response = await request(port, "POST", `/bookings/${bookingId}/admin-modification/preview`, adminToken, { scheduleDate: targetDateA, timeSlot: "10:00-11:00" });
      assert.strictEqual(response.status, 409, `${label} must be blocked: ${JSON.stringify(response.body)}`);
      assert(["SCHEDULE_LOCKED", "BOOKING_CLOSED"].includes(response.body.code), `${label} returns a lifecycle-specific block code`);
    }

    const staleDate = await request(port, "POST", `/bookings/${ids.sourcePeer}/admin-modification/preview`, adminToken, { scheduleDate: "2020-01-01", timeSlot: "10:00-11:00" });
    assert.strictEqual(staleDate.status, 400, "past booking dates are rejected by backend validation");
    assert.strictEqual(staleDate.body.code, "INVALID_SCHEDULE");

    const racePreviewA = await request(port, "POST", `/bookings/${ids.raceA}/admin-modification/preview`, adminToken, { scheduleDate: targetDateRace, timeSlot: "11:00-12:00" });
    const racePreviewB = await request(port, "POST", `/bookings/${ids.raceB}/admin-modification/preview`, adminToken, { scheduleDate: targetDateRace, timeSlot: "11:00-12:00" });
    assert.strictEqual(racePreviewA.status, 200); assert.strictEqual(racePreviewB.status, 200);
    const raceConsents = await Promise.all([[ids.raceA, racePreviewA], [ids.raceB, racePreviewB]].map(async ([bookingId, preview]) => {
      const response = await request(port, "POST", `/bookings/${bookingId}/admin-modification/consent`, adminToken, { scheduleDate: targetDateRace, timeSlot: "11:00-12:00", expectedUpdatedAt: preview.body.expectedUpdatedAt, reason: "race for a capacity-one slot" });
      await request(port, "POST", `/bookings/${bookingId}/admin-modification/consent/${response.body.consentId}/respond`, customerToken, { approved: true });
      return { bookingId, preview, consentId: response.body.consentId };
    }));
    const raceResults = await Promise.all(raceConsents.map(({ bookingId, preview, consentId }) => request(port, "POST", `/bookings/${bookingId}/admin-modification`, adminToken, { scheduleDate: targetDateRace, timeSlot: "11:00-12:00", expectedUpdatedAt: preview.body.expectedUpdatedAt, reason: "race for a capacity-one slot", consentReference: consentId })));
    assert.deepStrictEqual(raceResults.map((result) => result.status).sort(), [200, 409], "capacity-one slot cannot be overbooked by concurrent reschedules");
    assert.strictEqual((await GarageSlotCapacity.findById(capacityId(ids.dealer, targetDateRace, "11:00-12:00")).lean()).reservedCount, 1);
    assert.strictEqual(await BookingSlotReservation.countDocuments({ dealerId: ids.dealer, scheduleDate: targetDateRace, timeSlot: "11:00-12:00" }), 1);

    // An audit failure must roll back booking, reservation and capacity writes.
    const rollbackId = ids.rollback;
    const rollbackPreview = await request(port, "POST", `/bookings/${rollbackId}/admin-modification/preview`, adminToken, { scheduleDate: "2031-06-22", timeSlot: "10:00-11:00" });
    const rollbackConsent = await request(port, "POST", `/bookings/${rollbackId}/admin-modification/consent`, adminToken, { scheduleDate: "2031-06-22", timeSlot: "10:00-11:00", expectedUpdatedAt: rollbackPreview.body.expectedUpdatedAt, reason: "verify atomic rollback" });
    await request(port, "POST", `/bookings/${rollbackId}/admin-modification/consent/${rollbackConsent.body.consentId}/respond`, customerToken, { approved: true });
    AdminBookingAudit.create = async () => { throw new Error("injected isolated audit failure"); };
    const rollback = await request(port, "POST", `/bookings/${rollbackId}/admin-modification`, adminToken, { scheduleDate: "2031-06-22", timeSlot: "10:00-11:00", expectedUpdatedAt: rollbackPreview.body.expectedUpdatedAt, reason: "verify atomic rollback", consentReference: rollbackConsent.body.consentId });
    AdminBookingAudit.create = originalAuditCreate;
    assert.strictEqual(rollback.status, 503);
    assert.strictEqual((await Booking.findById(rollbackId).lean()).scheduleDate, sourceDate);
    const rollbackReservation = await BookingSlotReservation.findOne({ bookingId: rollbackId }).lean();
    assert.strictEqual(rollbackReservation.scheduleDate, sourceDate, "failed audited change preserves the old reservation");
    assert.strictEqual((await GarageSlotCapacity.findById(capacityId(ids.dealer, sourceDate, sourceSlot)).lean()).reservedCount, 4, "failed audited change preserves old slot occupancy");
    assert.strictEqual((await GarageSlotCapacity.findById(capacityId(ids.dealer, "2031-06-22", "10:00-11:00")).lean()).reservedCount, 0);
    assert.strictEqual((await BookingChangeConsent.findById(rollbackConsent.body.consentId).lean()).status, "approved");

    console.log("adminBookingReschedule.integration.test.js — pre-pickup reschedule, stage locks, consent, capacity reconciliation/race, notifications and rollback passed");
  } finally {
    AdminBookingAudit.create = originalAuditCreate;
    helper.sendBookingNotification = originalNotify;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      await Promise.all([
        Booking.collection.deleteMany({ _id: { $in: Object.values(ids) } }),
        BookingChangeConsent.deleteMany({ bookingId: { $in: Object.values(ids) } }),
        AdminBookingAudit.collection.deleteMany({ bookingId: { $in: Object.values(ids) } }),
        BookingSlotReservation.deleteMany({ bookingId: { $in: Object.values(ids) } }),
        GarageSlotCapacity.deleteMany({ dealerId: ids.dealer }),
        Admin.deleteOne({ _id: ids.admin }), Customer.deleteMany({ _id: { $in: [ids.customer, ids.otherCustomer] } }),
        Vendor.deleteOne({ _id: ids.dealer }), UserBike.deleteOne({ _id: ids.bike }),
      ]);
    }
    await mongoose.disconnect();
    if (originalEnable === undefined) delete process.env.ENABLE_BOOKING_SLOT_RESERVATIONS; else process.env.ENABLE_BOOKING_SLOT_RESERVATIONS = originalEnable;
    if (originalReady === undefined) delete process.env.BOOKING_SLOT_RESERVATIONS_READY; else process.env.BOOKING_SLOT_RESERVATIONS_READY = originalReady;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
