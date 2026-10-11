// End-to-end control-center mutation tests against a uniquely named database
// on a loopback MongoDB replica set. No production URI or external database is
// accepted by this test.
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
const AdminService = require("../models/adminService");
const BikeCompany = require("../models/bikeCompanyModel");
const BikeModel = require("../models/bikeModel");
const BikeVariant = require("../models/bikeVariantModel");
const Tracking = require("../models/Tracking");
const Payment = require("../models/Payment");
const Bill = require("../models/billSchema");
const AdminBookingAudit = require("../models/AdminBookingAudit");
const Notification = require("../models/Notification");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const GarageSlotCapacity = require("../models/GarageSlotCapacity");
const { capacityId, reservationsReady } = require("../services/bookingSlotReservations");
const { authorizeBookingRoom } = require("../middlewares/socketAuth");

if (!process.env.TEST_MONGO_URL) {
  console.log("adminBookingControlCenterE2E.integration.test.js — SKIPPED (set TEST_MONGO_URL to a dedicated loopback replica set)");
  process.exit(0);
}
const mongoUrl = new URL(process.env.TEST_MONGO_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(mongoUrl.hostname)) {
  throw new Error("TEST_MONGO_URL must point to loopback; refusing a remote database");
}
mongoUrl.pathname = `/mrbike_admin_control_e2e_${new mongoose.Types.ObjectId()}`;

const ids = {
  admin: new mongoose.Types.ObjectId(), customer: new mongoose.Types.ObjectId(),
  oldDealer: new mongoose.Types.ObjectId(), newDealer: new mongoose.Types.ObjectId(),
  bike: new mongoose.Types.ObjectId(), company: new mongoose.Types.ObjectId(),
  model: new mongoose.Types.ObjectId(), variant: new mongoose.Types.ObjectId(),
  service: new mongoose.Types.ObjectId(), reassignBooking: new mongoose.Types.ObjectId(),
  cancelBooking: new mongoose.Types.ObjectId(), rollbackBooking: new mongoose.Types.ObjectId(),
  legacyBooking: new mongoose.Types.ObjectId(),
};
const scheduleDate = "2032-06-18";
const timeSlot = "10:00-12:00";
const capturedPushes = [];
const capturedSocketEvents = [];
const oldProviderSocket = { id: "old-provider-socket", data: { actor: { role: "dealer", id: String(ids.oldDealer) } }, left: [], leave(room) { this.left.push(room); } };
const socketIo = {
  to(room) { return { emit(event, payload) { capturedSocketEvents.push({ room, event, payload }); } }; },
  in() { return { async fetchSockets() { return [oldProviderSocket]; }, async socketsLeave() {} }; },
};

function request(port, method, path, token, body, requestId) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestId ? { "x-request-id": requestId } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    }, (res) => {
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

function bookingDoc(_id, overrides = {}) {
  const timestamp = new Date("2032-06-01T12:00:00.000Z");
  return {
    _id, bookingId: `CONTROL-${_id}`, user_id: ids.customer, dealer_id: ids.oldDealer,
    userBike_id: ids.bike, services: [ids.service], additionalServices: [],
    status: "confirmed", dealerResponseStatus: "accepted", pickupStatus: "pending",
    garageTransportStatus: "NOT_STARTED", deliveryTransportStatus: "NOT_STARTED",
    pickupStartedAt: null, pickupOtpVerifiedAt: null, pickupCompletedAt: null,
    deliveryTransportStartedAt: null, deliveryArrivedAt: null,
    transportOption: "SELF_VISIT", towingRequired: false,
    scheduleDate, timeSlot, pickupDate: new Date("2032-06-18T00:00:00.000Z"),
    pickupLocation: { address: "Customer address", latitude: 19.1, longitude: 72.8 },
    deliveryLocation: { address: "Delivery address", latitude: 19.2, longitude: 72.9 },
    billGenerated: false, billStatus: "pending", payment_status: "pending",
    payment_verified: false, walletSettled: false,
    payment_method: null, totalBill: 0, customerTotal: 0, discountAmount: 0,
    createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  };
}

async function main() {
  const savedEnv = {
    jwt: process.env.JWT_SECRET,
    enabled: process.env.ENABLE_BOOKING_SLOT_RESERVATIONS,
    ready: process.env.BOOKING_SLOT_RESERVATIONS_READY,
  };
  const pushHelper = require("../helper/pushNotification");
  const originalSend = pushHelper.sendBookingNotification;
  const uploadFactory = require("../utils/s3Upload");
  const originalUploadFactory = uploadFactory.createS3Upload;
  let server;
  const trackingIds = [ids.cancelBooking, ids.rollbackBooking];
  try {
    // Prove deployment defaults remain disabled before enabling reservations
    // solely for this test process and its isolated database.
    delete process.env.ENABLE_BOOKING_SLOT_RESERVATIONS;
    delete process.env.BOOKING_SLOT_RESERVATIONS_READY;
    await mongoose.connect(mongoUrl.toString(), { serverSelectionTimeoutMS: 3000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("A local replica set is required for control-center transaction tests");
    assert.strictEqual(await reservationsReady(), false, "garage slot reservations are disabled by default");

    await Promise.all([
      Admin.collection.insertOne({ _id: ids.admin, role: "Admin", status: "active", name: "Test Admin", email: `admin-${ids.admin}@example.test`, password: "fixture-only", mobile: "9000000001", ID: `TEST-${ids.admin}` }),
      Customer.collection.insertOne({ _id: ids.customer, status: "active", first_name: "Test", device_token: null }),
      Vendor.collection.insertMany([
        { _id: ids.oldDealer, shopName: "Old Garage", phone: `old-${ids.oldDealer}`, registrationStatus: "Approved", dealerStatus: "Active", online: true, isBlocked: false, status: { adminApproved: true, isActive: true }, latitude: 19.1, longitude: 72.8, serviceRadiusKm: 50, wallet: 0 },
        { _id: ids.newDealer, shopName: "Replacement Garage", phone: `new-${ids.newDealer}`, registrationStatus: "Approved", dealerStatus: "Active", online: true, isBlocked: false, status: { adminApproved: true, isActive: true }, latitude: 19.11, longitude: 72.81, serviceRadiusKm: 50, wallet: 0 },
      ]),
      BikeCompany.collection.insertOne({ _id: ids.company, name: `Test Company ${ids.company}` }),
      BikeModel.collection.insertOne({ _id: ids.model, company_id: ids.company, model_name: `TEST MODEL ${ids.model}` }),
      BikeVariant.collection.insertOne({ _id: ids.variant, model_id: ids.model, variant_name: "Test Variant", engine_cc: 150 }),
      UserBike.collection.insertOne({ _id: ids.bike, user_id: ids.customer, name: "Test Bike", model: "Test Model", bike_cc: "150", plate_number: `TEST-${ids.bike}`, variant_id: ids.variant, status: 1 }),
      AdminService.collection.insertOne({ _id: ids.service, dealer_id: ids.newDealer, base_service_id: new mongoose.Types.ObjectId(), companies: [ids.company], bikes: [{ model_id: ids.model, variant_id: ids.variant, cc: 150, price: 100 }], isActive: true }),
      Booking.collection.insertMany([
        bookingDoc(ids.reassignBooking),
        bookingDoc(ids.cancelBooking),
        bookingDoc(ids.rollbackBooking),
        // Simulate a pre-control-center legacy row with lifecycle fields
        // physically absent; read access remains compatible, mutations must
        // fail closed rather than treating schema defaults as evidence.
        (() => {
          const legacy = bookingDoc(ids.legacyBooking, { scheduleDate: null, timeSlot: null });
          delete legacy.pickupStatus;
          delete legacy.garageTransportStatus;
          delete legacy.deliveryTransportStatus;
          return legacy;
        })(),
      ]),
      Tracking.collection.insertMany([
        { booking_id: ids.cancelBooking, dealer_id: ids.oldDealer, user_id: ids.customer, status: "Order Confirmed" },
        { booking_id: ids.rollbackBooking, dealer_id: ids.oldDealer, user_id: ids.customer, status: "Order Confirmed" },
      ]),
    ]);

    await BookingSlotReservation.collection.createIndex({ bookingId: 1 }, { unique: true });
    const slotRows = [
      { _id: capacityId(ids.oldDealer, scheduleDate, timeSlot), dealerId: ids.oldDealer, scheduleDate, timeSlot, capacity: 1, reservedCount: 1, active: true },
      { _id: capacityId(ids.newDealer, scheduleDate, timeSlot), dealerId: ids.newDealer, scheduleDate, timeSlot, capacity: 1, reservedCount: 0, active: true },
    ];
    await GarageSlotCapacity.collection.insertMany(slotRows);
    await BookingSlotReservation.create({ bookingId: ids.reassignBooking, dealerId: ids.oldDealer, scheduleDate, timeSlot });

    process.env.ENABLE_BOOKING_SLOT_RESERVATIONS = "true";
    process.env.BOOKING_SLOT_RESERVATIONS_READY = "true";
    assert.strictEqual(await reservationsReady(), true, "test-only unique reservation index establishes local readiness");
    process.env.JWT_SECRET = "admin-control-center-e2e-test-secret";
    pushHelper.sendBookingNotification = async (entry) => { capturedPushes.push(entry); return "test-delivered"; };
    uploadFactory.createS3Upload = () => ({ array: () => (_req, _res, next) => next() });
    const routes = require("../routes/bookingRoutes");
    const app = express();
    app.use(express.json());
    app.set("io", socketIo);
    app.use("/bookings", routes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const adminToken = jwt.sign({ user_id: String(ids.admin), user_type: 1 }, process.env.JWT_SECRET, { algorithm: "HS256" });

    const reassigned = await request(port, "POST", `/bookings/${ids.reassignBooking}/reassign-provider`, adminToken, { providerId: String(ids.newDealer), reason: "Customer requested garage change", expectedUpdatedAt: (await Booking.findById(ids.reassignBooking).lean()).updatedAt }, "reassign-e2e-request");
    assert.strictEqual(reassigned.status, 200, JSON.stringify(reassigned.body));
    const [savedBooking, savedAudit, savedReservation, oldCapacity, newCapacity] = await Promise.all([
      Booking.findById(ids.reassignBooking).lean(),
      AdminBookingAudit.findOne({ bookingId: ids.reassignBooking }).lean(),
      BookingSlotReservation.findOne({ bookingId: ids.reassignBooking }).lean(),
      GarageSlotCapacity.findById(capacityId(ids.oldDealer, scheduleDate, timeSlot)).lean(),
      GarageSlotCapacity.findById(capacityId(ids.newDealer, scheduleDate, timeSlot)).lean(),
    ]);
    assert.strictEqual(String(savedBooking.dealer_id), String(ids.newDealer), "booking assignment is committed");
    assert(savedAudit && savedAudit.action === "booking.provider_reassigned", "audit commits with reassignment");
    assert.strictEqual(savedAudit.requestId, "reassign-e2e-request");
    assert.strictEqual(String(savedReservation.dealerId), String(ids.newDealer), "reservation moves with booking");
    assert.strictEqual(oldCapacity.reservedCount, 0, "old garage capacity is released");
    assert.strictEqual(newCapacity.reservedCount, 1, "replacement capacity is claimed");
    assert(capturedPushes.some((item) => item.receiverType === "user" && String(item.receiverId) === String(ids.customer)), "customer notification is sent through the adapter");
    assert(capturedPushes.some((item) => item.receiverType === "dealer" && String(item.receiverId) === String(ids.oldDealer)), "old provider notification is sent through the adapter");
    assert(capturedPushes.some((item) => item.receiverType === "dealer" && String(item.receiverId) === String(ids.newDealer)), "replacement provider notification is sent through the adapter");
    assert(capturedSocketEvents.some((item) => item.event === "booking:updated" && item.room === `booking:${ids.reassignBooking}`), "existing booking:updated mobile contract is emitted");
    assert(oldProviderSocket.left.includes(`booking:${ids.reassignBooking}`), "old provider socket is removed from room");
    assert.strictEqual(await authorizeBookingRoom({ role: "dealer", id: String(ids.oldDealer) }, ids.reassignBooking), false, "old provider cannot reconnect after reassignment");
    assert.strictEqual(await authorizeBookingRoom({ role: "dealer", id: String(ids.newDealer) }, ids.reassignBooking), true, "replacement provider is authorized for reconnect");

    const cancelVersion = (await Booking.findById(ids.cancelBooking).lean()).updatedAt;
    const cancelled = await request(port, "POST", `/bookings/${ids.cancelBooking}/support-cancel`, adminToken, { reason: "Customer requested cancellation", expectedUpdatedAt: cancelVersion }, "cancel-e2e-request");
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
    const [cancelledBooking, cancelledTracking, cancelAudit] = await Promise.all([
      Booking.findById(ids.cancelBooking).lean(), Tracking.findOne({ booking_id: ids.cancelBooking }).lean(), AdminBookingAudit.findOne({ bookingId: ids.cancelBooking }).lean(),
    ]);
    assert.strictEqual(cancelledBooking.status, "cancelled");
    assert.strictEqual(cancelledTracking.status, "cancelled", "tracking state commits with cancellation");
    assert(cancelAudit && cancelAudit.action === "booking.cancelled_by_support", "cancellation audit commits");
    assert.strictEqual(cancelAudit.requestId, "cancel-e2e-request");
    assert(capturedSocketEvents.some((item) => item.event === "booking:cancelled" && item.room === `booking:${ids.cancelBooking}`), "existing cancellation socket event is emitted");

    const rollbackVersion = (await Booking.findById(ids.rollbackBooking).lean()).updatedAt;
    const originalAuditCreate = AdminBookingAudit.create;
    AdminBookingAudit.create = async () => { throw new Error("injected isolated audit insert failure"); };
    try {
      const failedCancellation = await request(port, "POST", `/bookings/${ids.rollbackBooking}/support-cancel`, adminToken, { reason: "Rollback audit failure case", expectedUpdatedAt: rollbackVersion }, "cancel-rollback-request");
      assert.strictEqual(failedCancellation.status, 500, "audit failure fails the mutation closed");
    } finally { AdminBookingAudit.create = originalAuditCreate; }
    const [rollbackBooking, rollbackTracking, rollbackAudit] = await Promise.all([
      Booking.findById(ids.rollbackBooking).lean(), Tracking.findOne({ booking_id: ids.rollbackBooking }).lean(), AdminBookingAudit.findOne({ bookingId: ids.rollbackBooking }).lean(),
    ]);
    assert.strictEqual(rollbackBooking.status, "confirmed", "booking cancellation is rolled back with failed audit");
    assert.strictEqual(rollbackTracking.status, "Order Confirmed", "tracking write is rolled back with failed audit");
    assert.strictEqual(rollbackAudit, null, "failed cancellation leaves no audit event");

    const legacyView = await request(port, "GET", `/bookings/${ids.legacyBooking}/control-center`, adminToken);
    assert.strictEqual(legacyView.status, 200, "legacy booking detail remains readable");
    assert.strictEqual(legacyView.body.data.assignment.reassignAllowed, false, "legacy booking without lifecycle or schedule evidence cannot be reassigned");
    assert.strictEqual(legacyView.body.data.cancellation.allowed, false, "legacy booking without lifecycle evidence cannot be safely cancelled");
    const legacyCancel = await request(port, "POST", `/bookings/${ids.legacyBooking}/support-cancel`, adminToken, { reason: "Legacy booking review" });
    assert.strictEqual(legacyCancel.status, 409, "legacy mutation requires manual review");
    console.log("adminBookingControlCenterE2E.integration.test.js — reassignment/capacity, notifications/sockets, cancellation/audit rollback, legacy guards passed");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      await Promise.all([
        Booking.deleteMany({ _id: { $in: Object.values(ids).filter((id) => id instanceof mongoose.Types.ObjectId) } }),
        Tracking.deleteMany({ booking_id: { $in: trackingIds } }),
        AdminBookingAudit.collection.deleteMany({ bookingId: { $in: Object.values(ids).filter((id) => id instanceof mongoose.Types.ObjectId) } }),
        BookingSlotReservation.deleteMany({ bookingId: ids.reassignBooking }),
        GarageSlotCapacity.deleteMany({ dealerId: { $in: [ids.oldDealer, ids.newDealer] } }),
        Notification.deleteMany({ bookingId: { $in: [ids.reassignBooking, ids.cancelBooking, ids.rollbackBooking] } }),
        Admin.collection.deleteMany({ _id: ids.admin }),
        Customer.collection.deleteMany({ _id: ids.customer }),
        Vendor.collection.deleteMany({ _id: { $in: [ids.oldDealer, ids.newDealer] } }),
        UserBike.collection.deleteMany({ _id: ids.bike }),
        AdminService.collection.deleteMany({ _id: ids.service }),
        BikeCompany.collection.deleteMany({ _id: ids.company }),
        BikeModel.collection.deleteMany({ _id: ids.model }),
        BikeVariant.collection.deleteMany({ _id: ids.variant }),
      ]);
    }
    await mongoose.disconnect();
    pushHelper.sendBookingNotification = originalSend;
    uploadFactory.createS3Upload = originalUploadFactory;
    if (savedEnv.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = savedEnv.jwt;
    if (savedEnv.enabled === undefined) delete process.env.ENABLE_BOOKING_SLOT_RESERVATIONS; else process.env.ENABLE_BOOKING_SLOT_RESERVATIONS = savedEnv.enabled;
    if (savedEnv.ready === undefined) delete process.env.BOOKING_SLOT_RESERVATIONS_READY; else process.env.BOOKING_SLOT_RESERVATIONS_READY = savedEnv.ready;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
