// Authenticated HTTP coverage for the booking control-center routes. All
// persistence is replaced by in-memory fixtures; this test never connects to
// MongoDB or a remote service.
const assert = require("assert");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Admin = require("../models/admin_model");
const Customer = require("../models/customer_model");
const Vendor = require("../models/dealerModel");
const Payment = require("../models/Payment");
const Bill = require("../models/billSchema");
const Tracking = require("../models/Tracking");
const Ticket = require("../models/ticket_model");
const Audit = require("../models/AdminBookingAudit");
const uploadFactory = require("../utils/s3Upload");

uploadFactory.createS3Upload = () => ({ array: () => (_req, _res, next) => next() });
const bookingRoutes = require("../routes/bookingRoutes");
const ticketRoutes = require("../routes/ticketRoutes");

const BOOKING_ID = new mongoose.Types.ObjectId().toString();
const CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const DEALER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_DEALER_ID = new mongoose.Types.ObjectId().toString();
const TICKET_ID = new mongoose.Types.ObjectId().toString();
const ADMIN_IDS = Object.fromEntries(["Admin", "Subadmin", "Manager", "Executive", "Telecaller", "UnknownRole"].map((role) => [role, new mongoose.Types.ObjectId().toString()]));
const now = new Date("2026-10-10T12:00:00.000Z");
const bookingFixture = {
  _id: new mongoose.Types.ObjectId(BOOKING_ID), bookingId: "MRB-TEST-1",
  user_id: new mongoose.Types.ObjectId(CUSTOMER_ID), dealer_id: new mongoose.Types.ObjectId(DEALER_ID),
  status: "confirmed", pickupStatus: "pending", garageTransportStatus: "NOT_STARTED",
  deliveryTransportStatus: "NOT_STARTED", scheduleDate: "2026-10-12", timeSlot: "10:00-12:00",
  updatedAt: now, payment_status: "pending", payment_verified: false,
  billGenerated: false, billStatus: "pending", walletSettled: false,
  pickupLocation: { address: "Customer pickup", latitude: 19.1, longitude: 72.8 },
  deliveryLocation: { address: "Customer drop", latitude: 19.2, longitude: 72.9 },
  pickupCurrentLocation: { latitude: 19.15, longitude: 72.85, updatedAt: new Date(now.getTime() - 10 * 60_000) },
  services: [], additionalServices: [],
};
const app = express();
app.use(express.json());
app.use("/bookings", bookingRoutes);
app.use("/tickets", ticketRoutes);

function query(value) {
  const q = {
    select() { return q; }, populate() { return q; }, sort() { return q; }, skip() { return q; }, limit() { return q; },
    lean() { return Promise.resolve(typeof value === "function" ? value() : value); },
    then(resolve, reject) { return Promise.resolve(typeof value === "function" ? value() : value).then(resolve, reject); },
  };
  return q;
}

function request(port, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
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

async function main() {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "booking-control-center-http-test-secret";
  const originals = {
    bookingFindById: Booking.findById, paymentExists: Payment.exists, paymentFind: Payment.find,
    billFindOne: Bill.findOne, trackingFindOne: Tracking.findOne, ticketFind: Ticket.find,
    ticketFindById: Ticket.findById, ticketFindOne: Ticket.findOne, auditFind: Audit.find,
    auditCount: Audit.countDocuments, auditCreate: Audit.create, adminFindById: Admin.findById, customerExists: Customer.exists,
    vendorFindById: Vendor.findById, vendorFind: Vendor.find, customerFindById: Customer.findById,
    trackingUpdateOne: Tracking.updateOne, startSession: mongoose.startSession,
  };
  const adminForId = (id) => {
    const role = Object.keys(ADMIN_IDS).find((candidate) => ADMIN_IDS[candidate] === String(id));
    return role ? { _id: id, role, status: "active" } : null;
  };
  Booking.findById = () => query(bookingFixture);
  Admin.findById = (id) => query(adminForId(id));
  Customer.exists = async () => true;
  Vendor.findById = (id) => query({ _id: id, isBlocked: false });
  Vendor.find = () => query([]);
  let gatewayActivity = false;
  Payment.exists = async () => gatewayActivity;
  Payment.find = () => query([]);
  Bill.findOne = () => query(null);
  Tracking.findOne = () => query({ status: "pending", updatedAt: now });
  Tracking.updateOne = async () => ({ modifiedCount: 1 });
  Customer.findById = () => query(null);
  const ticketState = {
    _id: new mongoose.Types.ObjectId(TICKET_ID), user_id: new mongoose.Types.ObjectId(CUSTOMER_ID), user_type: "user",
    source: "booking_support", booking_id: new mongoose.Types.ObjectId(BOOKING_ID), status: "Open", subject: "Support case",
    messages: [{ sender_id: new mongoose.Types.ObjectId(ADMIN_IDS.Admin), sender_type: "admin", message: "public update", internal: false, timestamp: now }],
    lastMessageText: "private support note", lastMessageAt: now, created_at: now,
    addMessage(message) { this.messages.push(message); }, resetUnreadForAdmin() {},
    async save() {},
  };
  const ticketSnapshot = () => ({ ...ticketState, messages: ticketState.messages.map((message) => ({ ...message })) });
  Ticket.find = () => query([ticketSnapshot()]);
  Ticket.findById = () => {
    const q = query(() => ticketState);
    let selected = "";
    q.select = (value) => { selected = value; return q; };
    q.lean = async () => selected === "user_id" ? { user_id: CUSTOMER_ID } : ticketSnapshot();
    return q;
  };
  Ticket.findOne = () => query(ticketSnapshot());
  Audit.create = async () => [{}];
  mongoose.startSession = async () => ({ withTransaction: async (callback) => callback(), endSession: async () => {} });
  Audit.find = () => query([{ action: "booking.provider_reassigned" }]);
  Audit.countDocuments = async () => 1;

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const token = (id, user_type) => jwt.sign({ user_id: id, user_type }, process.env.JWT_SECRET, { algorithm: "HS256" });
  const adminToken = (role) => token(ADMIN_IDS[role], 1);
  const customerToken = token(CUSTOMER_ID, 4);
  const strangerCustomerToken = token(OTHER_CUSTOMER_ID, 4);
  const dealerToken = token(DEALER_ID, 2);
  const strangerDealerToken = token(OTHER_DEALER_ID, 2);
  const allowed = {
    "control-center": ["Admin", "Subadmin", "Manager", "Executive", "Telecaller"],
    "control-center/financial": ["Admin", "Manager"],
    "control-center/tracking": ["Admin", "Manager", "Executive"],
    audit: ["Admin", "Manager"],
  };
  try {
    for (const [suffix, roles] of Object.entries(allowed)) {
      for (const role of Object.keys(ADMIN_IDS)) {
        const response = await request(port, "GET", `/bookings/${BOOKING_ID}/${suffix}`, adminToken(role));
        assert.strictEqual(response.status, roles.includes(role) ? 200 : 403, `${role} GET ${suffix}`);
      }
    }
    for (const [path, participant] of [
      [`/bookings/${BOOKING_ID}/control-center`, customerToken],
      [`/bookings/${BOOKING_ID}/control-center/financial`, customerToken],
      [`/bookings/${BOOKING_ID}/control-center/tracking`, customerToken],
      [`/bookings/${BOOKING_ID}/audit`, customerToken],
      [`/bookings/${BOOKING_ID}/control-center/financial`, dealerToken],
      [`/bookings/${BOOKING_ID}/control-center/tracking`, dealerToken],
      [`/bookings/${BOOKING_ID}/audit`, dealerToken],
    ]) assert.strictEqual((await request(port, "GET", path, participant)).status, 403, `participant denied admin-only endpoint ${path}`);
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/control-center`, strangerCustomerToken)).status, 404, "non-owning customer cannot access booking");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/control-center`, strangerDealerToken)).status, 404, "non-assigned provider cannot access booking");

    const tracking = await request(port, "GET", `/bookings/${BOOKING_ID}/control-center/tracking`, adminToken("Executive"));
    assert.strictEqual(tracking.body.data.gpsState.stale, true, "stale GPS is reported without fabricating a location");
    assert.strictEqual(tracking.body.data.lastGpsUpdateAt.toString(), bookingFixture.pickupCurrentLocation.updatedAt.toISOString());
    assert.strictEqual(tracking.body.data.providerLocation.latitude, bookingFixture.pickupCurrentLocation.latitude);
    assert.strictEqual(tracking.body.data.providerLocation.longitude, bookingFixture.pickupCurrentLocation.longitude);
    bookingFixture.pickupCurrentLocation = null;
    const missingGps = await request(port, "GET", `/bookings/${BOOKING_ID}/control-center/tracking`, adminToken("Executive"));
    assert.strictEqual(missingGps.body.data.gpsState.stale, true, "missing GPS is explicitly reported as stale");
    assert.strictEqual(missingGps.body.data.providerLocation, null, "missing GPS is never replaced with a fabricated point");
    bookingFixture.pickupCurrentLocation = { latitude: 19.15, longitude: 72.85, updatedAt: new Date(now.getTime() - 10 * 60_000) };

    gatewayActivity = true;
    const cancellation = await request(port, "POST", `/bookings/${BOOKING_ID}/support-cancel`, adminToken("Admin"), { reason: "Customer requested cancellation" });
    assert.strictEqual(cancellation.status, 409, "cancellation escalates when gateway activity exists");
    assert.strictEqual(bookingFixture.status, "confirmed", "guarded cancellation leaves booking unchanged");
    assert.strictEqual((await request(port, "POST", `/bookings/${BOOKING_ID}/reassign-provider`, adminToken("Admin"), { providerId: OTHER_DEALER_ID, reason: "Customer requested garage change" })).status, 409, "reassignment refuses existing gateway activity");
    assert.strictEqual(String(bookingFixture.dealer_id), DEALER_ID, "guarded reassignment preserves the provider assignment");
    assert.strictEqual(bookingFixture.payment_verified, false, "cancellation does not set payment state");
    assert.strictEqual(bookingFixture.walletSettled, false, "cancellation does not settle or reverse wallet state");
    assert.strictEqual((await request(port, "POST", `/bookings/${BOOKING_ID}/support-cancel`, adminToken("Executive"), { reason: "Customer requested cancellation" })).status, 403);
    gatewayActivity = false;
    bookingFixture.garageTransportStatus = "IN_PROGRESS";
    assert.strictEqual((await request(port, "POST", `/bookings/${BOOKING_ID}/reassign-provider`, adminToken("Admin"), { providerId: OTHER_DEALER_ID, reason: "Customer requested garage change" })).status, 409, "reassignment refuses an active garage transport stage");
    bookingFixture.garageTransportStatus = "NOT_STARTED";
    const candidateResponse = await request(port, "GET", `/bookings/${BOOKING_ID}/provider-candidates`, adminToken("Admin"));
    assert.strictEqual(candidateResponse.status, 503, "candidate search fails closed without verified slot reservation readiness");

    bookingFixture.isNew = false;
    bookingFixture.modifiedPaths = () => ["status"];
    bookingFixture.markModified = () => {};
    bookingFixture.save = async () => {};
    bookingFixture.dealer_id = null;
    const financialSnapshot = { payment_status: bookingFixture.payment_status, payment_verified: bookingFixture.payment_verified, billStatus: bookingFixture.billStatus, billGenerated: bookingFixture.billGenerated, walletSettled: bookingFixture.walletSettled };
    const successfulCancel = await request(port, "POST", `/bookings/${BOOKING_ID}/support-cancel`, adminToken("Admin"), { reason: "Customer requested cancellation" });
    assert.strictEqual(successfulCancel.status, 200, "authorized pre-handoff cancellation succeeds when there is no payment activity");
    assert.strictEqual(bookingFixture.status, "cancelled");
    assert.deepStrictEqual({ payment_status: bookingFixture.payment_status, payment_verified: bookingFixture.payment_verified, billStatus: bookingFixture.billStatus, billGenerated: bookingFixture.billGenerated, walletSettled: bookingFixture.walletSettled }, financialSnapshot, "cancellation leaves payment, invoice, and wallet fields unchanged");

    const customerTickets = await request(port, "GET", `/tickets/my-tickets/${CUSTOMER_ID}`, customerToken);
    assert.strictEqual(customerTickets.status, 200, "customer ticket list remains available");
    assert(!JSON.stringify(customerTickets.body).includes("private support note"), "internal note and list preview are hidden from customer");
    const ownTicket = await request(port, "GET", `/tickets/tickets/${TICKET_ID}`, customerToken);
    assert.strictEqual(ownTicket.status, 200, "ticket owner can read own support case");
    assert(!JSON.stringify(ownTicket.body).includes("private support note"), "internal note and detail preview are hidden from customer");
    const adminInternalNote = await request(port, "POST", `/tickets/reply/${TICKET_ID}`, adminToken("Admin"), { message: "new private note", internal: true });
    assert.strictEqual(adminInternalNote.status, 200, "authorized admin can add an internal support note");
    assert(JSON.stringify(adminInternalNote.body).includes("new private note"), "admin receives the private note in its staff response");
    const customerAfterNote = await request(port, "GET", `/tickets/tickets/${TICKET_ID}`, customerToken);
    assert(!JSON.stringify(customerAfterNote.body).includes("new private note"), "new internal note is hidden from customer ticket detail");
    assert.strictEqual(customerAfterNote.body.data.lastMessageText, "public update", "participant preview resolves to last public message");
    assert.strictEqual((await request(port, "GET", `/tickets/tickets/${TICKET_ID}`, strangerCustomerToken)).status, 404, "another customer cannot read the case");
    assert.strictEqual((await request(port, "POST", `/tickets/reply/${TICKET_ID}`, customerToken, { message: "private", internal: true })).status, 403, "customer cannot create internal notes");
    assert.strictEqual((await request(port, "POST", `/tickets/booking/${BOOKING_ID}`, customerToken, { subject: "case", message: "internal" })).status, 403, "customer cannot create admin booking cases");

    const unauthenticated = await request(port, "GET", `/bookings/${BOOKING_ID}/control-center`, null);
    assert.strictEqual(unauthenticated.status, 401, "control center requires authentication");
    console.log("Admin booking control-center authenticated HTTP checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Booking.findById = originals.bookingFindById;
    Payment.exists = originals.paymentExists;
    Payment.find = originals.paymentFind;
    Bill.findOne = originals.billFindOne;
    Tracking.findOne = originals.trackingFindOne;
    Ticket.find = originals.ticketFind;
    Ticket.findById = originals.ticketFindById;
    Ticket.findOne = originals.ticketFindOne;
    Audit.find = originals.auditFind;
    Audit.countDocuments = originals.auditCount;
    Audit.create = originals.auditCreate;
    Admin.findById = originals.adminFindById;
    Customer.exists = originals.customerExists;
    Vendor.findById = originals.vendorFindById;
    Vendor.find = originals.vendorFind;
    Customer.findById = originals.customerFindById;
    Tracking.updateOne = originals.trackingUpdateOne;
    mongoose.startSession = originals.startSession;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
