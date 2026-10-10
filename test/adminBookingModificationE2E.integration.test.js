// Authenticated HTTP flow against seeded fixtures in a dedicated loopback replica set.
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
require("../models/baseService");
const AdminService = require("../models/adminService");
const BookingChangeConsent = require("../models/BookingChangeConsent");
const AdminBookingAudit = require("../models/AdminBookingAudit");

if (!process.env.TEST_MONGO_URL) {
  console.log("adminBookingModificationE2E.integration.test.js — SKIPPED (set TEST_MONGO_URL to a dedicated loopback replica set)");
  process.exit(0);
}
const url = new URL(process.env.TEST_MONGO_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("TEST_MONGO_URL must be loopback; refusing a remote database");
url.pathname = `/mrbike_booking_modification_http_${new mongoose.Types.ObjectId()}`;

const ids = {
  admin: new mongoose.Types.ObjectId(),
  subadmin: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  executive: new mongoose.Types.ObjectId(),
  telecaller: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  otherCustomer: new mongoose.Types.ObjectId(),
  dealer: new mongoose.Types.ObjectId(),
  bike: new mongoose.Types.ObjectId(),
  serviceBefore: new mongoose.Types.ObjectId(),
  serviceAfter: new mongoose.Types.ObjectId(),
  booking: new mongoose.Types.ObjectId(),
  declineBooking: new mongoose.Types.ObjectId(),
  staleBooking: new mongoose.Types.ObjectId(),
  rollbackBooking: new mongoose.Types.ObjectId(),
  concurrentBooking: new mongoose.Types.ObjectId(),
  lockedBooking: new mongoose.Types.ObjectId(),
};
const events = [];
const pushes = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };

function request(port, method, path, token, body, requestId) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path,
      headers: { Authorization: `Bearer ${token}`, ...(requestId ? { "x-request-id": requestId } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
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

const bookingDoc = (bookingId, status = "confirmed") => ({
  _id: bookingId, user_id: ids.customer, dealer_id: ids.dealer, userBike_id: ids.bike,
  services: [ids.serviceBefore], additionalServices: [], status, pickupStatus: "pending",
  transportOption: "SELF_VISIT", serviceAmount: 100, subtotal: 100, customerTotal: 100,
  amountDue: 100, totalBill: 100, billStatus: "pending", billGenerated: false,
  scheduleDate: "2031-06-18", timeSlot: "09:00-10:00", pickupDate: new Date("2031-06-18T00:00:00.000Z"),
  createdAt: new Date(), updatedAt: new Date(),
});

async function main() {
  const originalSecret = process.env.JWT_SECRET;
  const helper = require("../helper/pushNotification");
  const originalSend = helper.sendBookingNotification;
  const originalAuditCreate = AdminBookingAudit.create;
  let server;
  try {
    await mongoose.connect(url.toString(), { serverSelectionTimeoutMS: 3000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("A local replica set is required for the HTTP transaction flow");
    process.env.JWT_SECRET = "booking-modification-e2e-only-secret";
    helper.sendBookingNotification = async (entry) => { pushes.push(entry); return "mocked"; };

    await Promise.all([
      Admin.collection.insertMany([
        { _id: ids.admin, role: "Admin", status: "active", name: "Test Admin", email: `admin-${ids.admin}@example.test`, password: "fixture-only", mobile: "9000000001", ID: `TEST-${ids.admin}` },
        { _id: ids.subadmin, role: "Subadmin", status: "active", name: "Test Subadmin", email: `sub-${ids.subadmin}@example.test`, password: "fixture-only", mobile: "9000000002", ID: `TEST-${ids.subadmin}` },
        { _id: ids.manager, role: "Manager", status: "active", name: "Test Manager", email: `manager-${ids.manager}@example.test`, password: "fixture-only", mobile: "9000000004", ID: `TEST-${ids.manager}` },
        { _id: ids.executive, role: "Executive", status: "active", name: "Test Executive", email: `executive-${ids.executive}@example.test`, password: "fixture-only", mobile: "9000000005", ID: `TEST-${ids.executive}` },
        { _id: ids.telecaller, role: "Telecaller", status: "active", name: "Test Telecaller", email: `telecaller-${ids.telecaller}@example.test`, password: "fixture-only", mobile: "9000000006", ID: `TEST-${ids.telecaller}` },
      ]),
      Customer.collection.insertMany([
        { _id: ids.customer, status: "active", first_name: "Test" },
        { _id: ids.otherCustomer, status: "active", first_name: "Other" },
      ]),
      Vendor.collection.insertOne({ _id: ids.dealer, phone: "9000000003", tax: 0, commission: 0, providesPickup: false, providesDrop: false, providesTowing: false }),
      UserBike.collection.insertOne({ _id: ids.bike, user_id: ids.customer, name: "Test Bike", model: "Model", bike_cc: "150", plate_number: `TEST-${ids.bike}`, variant_id: new mongoose.Types.ObjectId(), status: 1 }),
      AdminService.collection.insertMany([
        { _id: ids.serviceBefore, dealer_id: ids.dealer, base_service_id: new mongoose.Types.ObjectId(), companies: [], bikes: [{ cc: 150, price: 100 }], isActive: true },
        { _id: ids.serviceAfter, dealer_id: ids.dealer, base_service_id: new mongoose.Types.ObjectId(), companies: [], bikes: [{ cc: 150, price: 175 }], isActive: true },
      ]),
      Booking.collection.insertMany([
        bookingDoc(ids.booking), bookingDoc(ids.declineBooking), bookingDoc(ids.staleBooking), bookingDoc(ids.rollbackBooking), bookingDoc(ids.concurrentBooking), bookingDoc(ids.lockedBooking),
      ]),
    ]);

    // Stub only the unrelated upload provider; all models, auth middleware,
    // consent writes, booking mutations, audit writes and transactions are real.
    const uploadFactory = require("../utils/s3Upload");
    uploadFactory.createS3Upload = () => ({ array: () => (_req, _res, next) => next() });
    const routes = require("../routes/bookingRoutes");
    const app = express();
    app.use(express.json());
    app.set("io", fakeIo);
    app.use("/bookings", routes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const tokenFor = (id, type) => jwt.sign({ user_id: String(id), type: "logged", user_type: type }, process.env.JWT_SECRET, { algorithm: "HS256" });
    const adminToken = tokenFor(ids.admin, 1);
    const subadminToken = tokenFor(ids.subadmin, 1);
    const managerToken = tokenFor(ids.manager, 1);
    const executiveToken = tokenFor(ids.executive, 1);
    const telecallerToken = tokenFor(ids.telecaller, 1);
    const customerToken = tokenFor(ids.customer, 4);
    const otherCustomerToken = tokenFor(ids.otherCustomer, 4);
    const proposal = { services: [String(ids.serviceAfter)] };

    const catalog = await request(port, "GET", `/bookings/${ids.booking}/admin-modification/catalog`, adminToken);
    assert.strictEqual(catalog.status, 200);
    assert(catalog.body.data.services.some((item) => item._id === String(ids.serviceAfter)));
    assert.strictEqual(catalog.body.data.scheduleChangesEnabled, false, "rescheduling stays gated without explicit deployment readiness");
    assert.strictEqual((await request(port, "GET", `/bookings/${ids.booking}/admin-modification/catalog`, managerToken)).status, 200);
    assert.strictEqual((await request(port, "GET", `/bookings/${ids.booking}/admin-modification/catalog`, subadminToken)).status, 403);
    assert.strictEqual((await request(port, "GET", `/bookings/${ids.booking}/admin-modification/catalog`, executiveToken)).status, 403);
    assert.strictEqual((await request(port, "GET", `/bookings/${ids.booking}/admin-modification/catalog`, telecallerToken)).status, 403);

    const preview = await request(port, "POST", `/bookings/${ids.booking}/admin-modification/preview`, adminToken, proposal);
    assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
    assert.strictEqual(preview.body.after.serviceAmount, 175, "backend pricing engine computes the edited catalog total");
    assert.strictEqual(preview.body.priceDifference, 75);
    const expectedUpdatedAt = preview.body.expectedUpdatedAt;
    const consentRequest = await request(port, "POST", `/bookings/${ids.booking}/admin-modification/consent`, adminToken, { ...proposal, expectedUpdatedAt, reason: "Customer-approved support correction" }, "e2e-consent-request");
    assert.strictEqual(consentRequest.status, 201);
    assert(pushes.some((entry) => entry.data?.type === "booking_change_consent" && String(entry.receiverId) === String(ids.customer)), "the customer notification is handed to the notification adapter");
    const wrongCustomer = await request(port, "POST", `/bookings/${ids.booking}/admin-modification/consent/${consentRequest.body.consentId}/respond`, otherCustomerToken, { approved: true });
    assert.strictEqual(wrongCustomer.status, 404, "another customer cannot approve this booking");
    const customerRequest = await request(port, "GET", `/bookings/${ids.booking}/admin-modification/consent`, customerToken);
    assert.strictEqual(customerRequest.status, 200);
    assert.strictEqual(customerRequest.body.data._id, consentRequest.body.consentId);
    const approved = await request(port, "POST", `/bookings/${ids.booking}/admin-modification/consent/${consentRequest.body.consentId}/respond`, customerToken, { approved: true });
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(approved.body.status, "approved");

    const applied = await request(port, "POST", `/bookings/${ids.booking}/admin-modification`, adminToken, { ...proposal, expectedUpdatedAt, reason: "Customer-approved support correction", consentReference: consentRequest.body.consentId }, "e2e-apply-request");
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
    const [savedBooking, savedConsent, audits] = await Promise.all([
      Booking.findById(ids.booking).lean(),
      BookingChangeConsent.findById(consentRequest.body.consentId).lean(),
      AdminBookingAudit.find({ bookingId: ids.booking }).lean(),
    ]);
    assert.deepStrictEqual(savedBooking.services.map(String), [String(ids.serviceAfter)]);
    assert.strictEqual(savedBooking.serviceAmount, 175);
    assert.strictEqual(savedConsent.status, "applied", "customer approval is consumed once");
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].requestId, "e2e-apply-request");
    assert.strictEqual(audits[0].before.serviceAmount, 100);
    assert.strictEqual(audits[0].after.serviceAmount, 175);
    assert(events.some((event) => event.room === `booking:${ids.booking}` && event.event === "booking:updated"), "authorized booking room receives refreshed data event");
    assert(pushes.some((entry) => entry.data?.type === "booking_updated" && entry.receiverType === "user"));
    assert(pushes.some((entry) => entry.data?.type === "booking_updated" && entry.receiverType === "dealer"));
    const duplicateApply = await request(port, "POST", `/bookings/${ids.booking}/admin-modification`, adminToken, { ...proposal, expectedUpdatedAt, reason: "Duplicate", consentReference: consentRequest.body.consentId });
    assert.strictEqual(duplicateApply.status, 409, "a duplicate apply is rejected as stale or consumed");
    assert.strictEqual(await AdminBookingAudit.countDocuments({ bookingId: ids.booking }), 1);

    const declinePreview = await request(port, "POST", `/bookings/${ids.declineBooking}/admin-modification/preview`, adminToken, proposal);
    const declineRequest = await request(port, "POST", `/bookings/${ids.declineBooking}/admin-modification/consent`, adminToken, { ...proposal, expectedUpdatedAt: declinePreview.body.expectedUpdatedAt, reason: "Decline flow" });
    const declined = await request(port, "POST", `/bookings/${ids.declineBooking}/admin-modification/consent/${declineRequest.body.consentId}/respond`, customerToken, { approved: false });
    assert.strictEqual(declined.status, 200);
    assert.strictEqual((await BookingChangeConsent.findById(declineRequest.body.consentId).lean()).status, "rejected");
    assert.deepStrictEqual((await Booking.findById(ids.declineBooking).lean()).services.map(String), [String(ids.serviceBefore)]);

    const stalePreview = await request(port, "POST", `/bookings/${ids.staleBooking}/admin-modification/preview`, adminToken, proposal);
    const staleRequest = await request(port, "POST", `/bookings/${ids.staleBooking}/admin-modification/consent`, adminToken, { ...proposal, expectedUpdatedAt: stalePreview.body.expectedUpdatedAt, reason: "Stale flow" });
    await request(port, "POST", `/bookings/${ids.staleBooking}/admin-modification/consent/${staleRequest.body.consentId}/respond`, customerToken, { approved: true });
    await Booking.updateOne({ _id: ids.staleBooking }, { $set: { additionalNotes: ["concurrent support update"] } });
    const staleApply = await request(port, "POST", `/bookings/${ids.staleBooking}/admin-modification`, adminToken, { ...proposal, expectedUpdatedAt: stalePreview.body.expectedUpdatedAt, reason: "Stale flow", consentReference: staleRequest.body.consentId });
    assert.strictEqual(staleApply.status, 409);
    assert.strictEqual(await AdminBookingAudit.countDocuments({ bookingId: ids.staleBooking }), 0);

    const rollbackPreview = await request(port, "POST", `/bookings/${ids.rollbackBooking}/admin-modification/preview`, adminToken, proposal);
    const rollbackRequest = await request(port, "POST", `/bookings/${ids.rollbackBooking}/admin-modification/consent`, adminToken, { ...proposal, expectedUpdatedAt: rollbackPreview.body.expectedUpdatedAt, reason: "Rollback flow" });
    await request(port, "POST", `/bookings/${ids.rollbackBooking}/admin-modification/consent/${rollbackRequest.body.consentId}/respond`, customerToken, { approved: true });
    AdminBookingAudit.create = async () => { throw new Error("injected audit insert failure"); };
    const rollbackResponse = await request(port, "POST", `/bookings/${ids.rollbackBooking}/admin-modification`, adminToken, { ...proposal, expectedUpdatedAt: rollbackPreview.body.expectedUpdatedAt, reason: "Rollback flow", consentReference: rollbackRequest.body.consentId });
    assert.strictEqual(rollbackResponse.status, 503);
    AdminBookingAudit.create = originalAuditCreate;
    const [rolledBackBooking, rolledBackConsent] = await Promise.all([
      Booking.findById(ids.rollbackBooking).lean(),
      BookingChangeConsent.findById(rollbackRequest.body.consentId).lean(),
    ]);
    assert.deepStrictEqual(rolledBackBooking.services.map(String), [String(ids.serviceBefore)]);
    assert.strictEqual(rolledBackConsent.status, "approved", "failed audit write rolls back both booking and consent");
    assert.strictEqual(await AdminBookingAudit.countDocuments({ bookingId: ids.rollbackBooking }), 0);

    await Booking.updateOne({ _id: ids.lockedBooking }, { $set: { status: "completed" } });
    const completedDenied = await request(port, "POST", `/bookings/${ids.lockedBooking}/admin-modification/preview`, adminToken, proposal);
    assert.strictEqual(completedDenied.status, 409, "service edits are blocked for completed bookings");
    await Booking.updateOne({ _id: ids.lockedBooking }, { $set: { status: "confirmed", billGenerated: true } });
    const billedDenied = await request(port, "POST", `/bookings/${ids.lockedBooking}/admin-modification/preview`, adminToken, proposal);
    assert.strictEqual(billedDenied.status, 409, "service edits are blocked after invoice generation");

    const concurrentPreview = await request(port, "POST", `/bookings/${ids.concurrentBooking}/admin-modification/preview`, adminToken, proposal);
    const concurrentRequest = await request(port, "POST", `/bookings/${ids.concurrentBooking}/admin-modification/consent`, adminToken, { ...proposal, expectedUpdatedAt: concurrentPreview.body.expectedUpdatedAt, reason: "Concurrent approval flow" });
    const approvalReplies = await Promise.all([true, true].map((approvedValue) => request(port, "POST", `/bookings/${ids.concurrentBooking}/admin-modification/consent/${concurrentRequest.body.consentId}/respond`, customerToken, { approved: approvedValue })));
    assert.deepStrictEqual(approvalReplies.map((reply) => reply.status).sort(), [200, 409], "duplicate customer approval requests are conditionally consumed once");
    const applyReplies = await Promise.all([0, 1].map((index) => request(port, "POST", `/bookings/${ids.concurrentBooking}/admin-modification`, adminToken, { ...proposal, expectedUpdatedAt: concurrentPreview.body.expectedUpdatedAt, reason: "Concurrent approval flow", consentReference: concurrentRequest.body.consentId }, `e2e-race-${index}`)));
    assert.strictEqual(applyReplies.filter((reply) => reply.status === 200).length, 1, "only one concurrent apply commits");
    assert.strictEqual(await AdminBookingAudit.countDocuments({ bookingId: ids.concurrentBooking }), 1, "concurrent apply produces one audit event");
    console.log("adminBookingModificationE2E.integration.test.js — authenticated catalog, price preview, customer consent, atomic apply/audit, notifications, stale, wrong-customer, decline and rollback passed");
  } finally {
    AdminBookingAudit.create = originalAuditCreate;
    helper.sendBookingNotification = originalSend;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      await Promise.all([
        Booking.collection.deleteMany({ _id: { $in: Object.values(ids).filter((id) => id instanceof mongoose.Types.ObjectId) } }),
        BookingChangeConsent.collection.deleteMany({ bookingId: { $in: [ids.booking, ids.declineBooking, ids.staleBooking, ids.rollbackBooking, ids.concurrentBooking, ids.lockedBooking] } }),
        AdminBookingAudit.collection.deleteMany({ bookingId: { $in: [ids.booking, ids.declineBooking, ids.staleBooking, ids.rollbackBooking, ids.concurrentBooking, ids.lockedBooking] } }),
        Admin.collection.deleteMany({ _id: { $in: [ids.admin, ids.subadmin, ids.manager, ids.executive, ids.telecaller] } }),
        Customer.collection.deleteMany({ _id: { $in: [ids.customer, ids.otherCustomer] } }),
        Vendor.collection.deleteMany({ _id: ids.dealer }),
        UserBike.collection.deleteMany({ _id: ids.bike }),
        AdminService.collection.deleteMany({ _id: { $in: [ids.serviceBefore, ids.serviceAfter] } }),
      ]);
    }
    await mongoose.disconnect();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
