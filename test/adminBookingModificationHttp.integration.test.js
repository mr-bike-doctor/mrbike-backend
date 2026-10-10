// Exercise the mounted booking router over authenticated loopback HTTP.
// Model methods are replaced with isolated fixtures; no database is used.
const assert = require("assert");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Admin = require("../models/admin_model");
const Customer = require("../models/customer_model");
const BookingChangeConsent = require("../models/BookingChangeConsent");
// The route module creates the existing S3 upload middleware at import time;
// this HTTP test exercises booking APIs only and replaces that unrelated edge.
const uploadFactory = require("../utils/s3Upload");
uploadFactory.createS3Upload = () => ({ array: () => (_req, _res, next) => next() });
const bookingRoutes = require("../routes/bookingRoutes");

const BOOKING_ID = new mongoose.Types.ObjectId().toString();
const CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const ADMIN_IDS = Object.fromEntries(["Admin", "Subadmin", "Manager", "Executive", "Telecaller"].map((role) => [role, new mongoose.Types.ObjectId().toString()]));
const fixture = { _id: new mongoose.Types.ObjectId(BOOKING_ID), user_id: new mongoose.Types.ObjectId(CUSTOMER_ID), dealer_id: new mongoose.Types.ObjectId(), status: "confirmed", pickupStatus: "pending", updatedAt: new Date("2026-10-10T00:00:00.000Z"), services: [], additionalServices: [] };
const makeBooking = () => ({ ...fixture });
const app = express();
app.use(express.json());
app.use("/bookings", bookingRoutes);

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

async function main() {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "admin-modification-http-test-secret";
  const originals = { bookingFindById: Booking.findById, bookingFindOne: Booking.findOne, adminFindById: Admin.findById, customerExists: Customer.exists, bikeFindById: require("../models/userBikeModel").findById, bikeFind: require("../models/userBikeModel").find, serviceFind: require("../models/adminService").find, addonFind: require("../models/additionalServiceSchema").find, consentUpdate: BookingChangeConsent.findOneAndUpdate, consentFind: BookingChangeConsent.findOne, startSession: mongoose.startSession };
  const UserBike = require("../models/userBikeModel");
  const AdminService = require("../models/adminService");
  const AdditionalService = require("../models/additionalServiceSchema");
  const authById = (id) => {
    const role = Object.keys(ADMIN_IDS).find((candidate) => ADMIN_IDS[candidate] === String(id));
    return { select: () => ({ lean: async () => role ? { _id: id, role, status: "active" } : null }) };
  };
  const participantBookingQuery = () => ({
    select: () => ({ lean: async () => ({ _id: BOOKING_ID, user_id: CUSTOMER_ID, dealer_id: String(fixture.dealer_id) }), then: (resolve, reject) => Promise.resolve(makeBooking()).then(resolve, reject) }),
    then: (resolve, reject) => Promise.resolve(makeBooking()).then(resolve, reject),
  });
  Booking.findById = participantBookingQuery;
  Booking.findOne = () => ({ session: () => Promise.resolve(null) });
  Admin.findById = authById;
  Customer.exists = async () => true;
  UserBike.findById = () => ({ select: () => ({ populate: () => ({ lean: async () => ({ _id: new mongoose.Types.ObjectId(), bike_cc: 150, variant_id: null }) }) }) });
  UserBike.find = () => ({ select: () => ({ lean: async () => [] }) });
  AdminService.find = () => ({ populate: () => ({ lean: async () => [] }) });
  AdditionalService.find = () => ({ populate: () => ({ lean: async () => [] }) });
  BookingChangeConsent.findOneAndUpdate = async (filter, update) => ({ _id: filter._id, bookingId: filter.bookingId, status: update.$set.status });
  mongoose.startSession = async () => ({ withTransaction: async (callback) => callback(), endSession: async () => {} });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const token = (id, user_type) => jwt.sign({ user_id: id, user_type }, process.env.JWT_SECRET, { algorithm: "HS256" });
  try {
    const adminToken = token(ADMIN_IDS.Admin, 1);
    const managerToken = token(ADMIN_IDS.Manager, 1);
    const subadminToken = token(ADMIN_IDS.Subadmin, 1);
    const executiveToken = token(ADMIN_IDS.Executive, 1);
    const telecallerToken = token(ADMIN_IDS.Telecaller, 1);
    const customerToken = token(CUSTOMER_ID, 4);

    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/admin-modification/catalog`, adminToken)).status, 200, "Admin can load eligible catalog");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/admin-modification/catalog`, managerToken)).status, 200, "Manager can load eligible catalog");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/admin-modification/catalog`, subadminToken)).status, 403, "Subadmin cannot modify catalog");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/admin-modification/catalog`, executiveToken)).status, 403, "Executive cannot modify catalog");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/admin-modification/catalog`, telecallerToken)).status, 403, "Telecaller cannot modify catalog");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/admin-modification/catalog`, token(OTHER_CUSTOMER_ID, 4))).status, 404, "unrelated customer cannot access booking");

    const schedulePreview = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification/preview`, managerToken, { scheduleDate: "2026-10-20", timeSlot: "10:00-12:00" });
    assert.strictEqual(schedulePreview.status, 503, `schedule preview fails closed without atomic garage availability: ${JSON.stringify(schedulePreview.body)}`);
    const paidBooking = { ...makeBooking(), status: "confirmed", billStatus: "paid" };
    Booking.findById = () => ({ select: () => ({ lean: async () => ({ _id: BOOKING_ID, user_id: CUSTOMER_ID, dealer_id: String(fixture.dealer_id) }), then: (resolve, reject) => Promise.resolve(paidBooking).then(resolve, reject) }), then: (resolve, reject) => Promise.resolve(paidBooking).then(resolve, reject) });
    const paidPreview = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification/preview`, managerToken, { services: [new mongoose.Types.ObjectId().toString()] });
    assert.strictEqual(paidPreview.status, 409, "paid booking service edits are rejected");
    const completedBooking = { ...makeBooking(), status: "completed", billStatus: "pending" };
    Booking.findById = () => ({ select: () => ({ lean: async () => ({ _id: BOOKING_ID, user_id: CUSTOMER_ID, dealer_id: String(fixture.dealer_id) }), then: (resolve, reject) => Promise.resolve(completedBooking).then(resolve, reject) }), then: (resolve, reject) => Promise.resolve(completedBooking).then(resolve, reject) });
    const completedPreview = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification/preview`, managerToken, { services: [new mongoose.Types.ObjectId().toString()] });
    assert.strictEqual(completedPreview.status, 409, "completed booking service edits are rejected");
    Booking.findById = participantBookingQuery;

    const consentId = new mongoose.Types.ObjectId().toString();
    const approved = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification/consent/${consentId}/respond`, customerToken, { approved: true });
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(approved.body.status, "approved");
    const declined = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification/consent/${consentId}/respond`, customerToken, { approved: false });
    assert.strictEqual(declined.status, 200);
    assert.strictEqual(declined.body.status, "rejected");

    const staleApply = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification`, managerToken, { scheduleDate: "2026-10-20", timeSlot: "10:00-12:00", expectedUpdatedAt: "2026-10-09T00:00:00.000Z", reason: "support", consentReference: consentId });
    assert.strictEqual(staleApply.status, 409, "stale booking version is rejected before mutation");
    Booking.findOne = () => ({ session: () => Promise.resolve(makeBooking()) });
    BookingChangeConsent.findOne = () => ({ session: () => Promise.resolve({ _id: consentId, expectedUpdatedAt: fixture.updatedAt }) });
    const approvedApply = await request(port, "POST", `/bookings/${BOOKING_ID}/admin-modification`, managerToken, { scheduleDate: "2026-10-20", timeSlot: "10:00-12:00", expectedUpdatedAt: fixture.updatedAt.toISOString(), reason: "support", consentReference: consentId });
    assert.strictEqual(approvedApply.status, 503, "approved apply still fails closed while atomic garage slot availability is unavailable");
    assert.strictEqual(approvedApply.body.code, "SCHEDULE_AVAILABILITY_UNVERIFIED");
    console.log("Authenticated admin booking modification HTTP integration checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Booking.findById = originals.bookingFindById;
    Booking.findOne = originals.bookingFindOne;
    Admin.findById = originals.adminFindById;
    Customer.exists = originals.customerExists;
    UserBike.findById = originals.bikeFindById;
    UserBike.find = originals.bikeFind;
    AdminService.find = originals.serviceFind;
    AdditionalService.find = originals.addonFind;
    BookingChangeConsent.findOneAndUpdate = originals.consentUpdate;
    BookingChangeConsent.findOne = originals.consentFind;
    mongoose.startSession = originals.startSession;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
