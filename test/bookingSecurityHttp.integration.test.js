// Authenticated HTTP coverage for the real booking authorization middleware.
// Persistence is replaced with fixtures, so this test cannot connect to a DB.
const assert = require("assert");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Admin = require("../models/admin_model");
const Booking = require("../models/Booking");
const Customer = require("../models/customer_model");
const Vendor = require("../models/dealerModel");
const { authenticateActor, requireBookingParticipant, requireActorRole } = require("../middlewares/bookingAuth");
const { requireAdminBookingPermission } = require("../middlewares/adminBookingPermissions");
const { canTransitionBookingStatus } = require("../services/bookingStatusPolicy");
const { removeAdminBookingOtpFields } = require("../services/bookingResponsePrivacy");
const { getBookingAuditHistory } = require("../controller/bookingAuditController");
const Audit = require("../models/AdminBookingAudit");
const { deletebooking, updateBookings } = require("../controller/booking");
const legacyV2BookingRoutes = require("../v2-api/routes/bookingRoutes");

const BOOKING_ID = new mongoose.Types.ObjectId().toString();
const CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const DEALER_ID = new mongoose.Types.ObjectId().toString();
const ADMIN_IDS = Object.fromEntries(["Admin", "Subadmin", "Manager", "Executive", "Telecaller"].map((role) => [
  role, new mongoose.Types.ObjectId().toString(),
]));
const bookingFixture = { _id: BOOKING_ID, user_id: CUSTOMER_ID, dealer_id: DEALER_ID };
const app = express();
app.use(express.json());

app.get("/bookings/:id", requireBookingParticipant((req) => req.params.id), requireAdminBookingPermission("booking.view"), (req, res) => {
  res.json(removeAdminBookingOtpFields({ bookingId: BOOKING_ID, pickupOtp: "1234", pickupOtpExpiresAt: new Date(), deliveryOtp: "9876" }));
});
app.get("/permission/:permission", async (req, res, next) => {
  try {
    req.auth = await authenticateActor(req, res);
    if (!req.auth) return;
    return requireAdminBookingPermission(`booking.${req.params.permission}`)(req, res, next);
  } catch (error) { return next(error); }
}, (_req, res) => res.json({ success: true }));
app.get("/bookings/:bookingId/audit", requireBookingParticipant((req) => req.params.bookingId), requireAdminBookingPermission("booking.audit_read"), getBookingAuditHistory);
app.post("/bookings/:id/services", requireBookingParticipant((req) => req.params.id), requireAdminBookingPermission("booking.service_modify"), (_req, res) => res.json({ success: true }));
app.post("/provider/:id/status", requireBookingParticipant((req) => req.params.id), requireActorRole("dealer"), (req, res) => {
  const allowed = canTransitionBookingStatus(req.auth.role, "pending", req.body.status);
  return res.status(allowed ? 200 : 400).json({ success: allowed });
});
app.put("/legacy/update/:id", updateBookings);
app.delete("/legacy/delete", deletebooking);
app.use("/api/v2/bookings", legacyV2BookingRoutes);

function mockFindById(model, resolver) {
  const original = model.findById;
  model.findById = (...args) => ({ select: () => ({ lean: async () => resolver(...args) }) });
  return () => { model.findById = original; };
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
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "booking-http-test-only-secret";
  const restore = [
    mockFindById(Booking, () => bookingFixture),
    mockFindById(Admin, (id) => {
      const role = Object.keys(ADMIN_IDS).find((candidate) => ADMIN_IDS[candidate] === String(id));
      return role ? { _id: id, role, status: "active" } : null;
    }),
    mockFindById(Vendor, (id) => ({ _id: id, isBlocked: false })),
  ];
  const customerExists = Customer.exists;
  Customer.exists = async () => true;
  const auditFind = Audit.find;
  const auditCount = Audit.countDocuments;
  Audit.find = () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [{ action: "booking.update" }] }) }) }) });
  Audit.countDocuments = async () => 1;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const tokenFor = (id, user_type) => jwt.sign({ user_id: id, user_type }, process.env.JWT_SECRET, { algorithm: "HS256" });

  try {
    const roleMatrix = {
      Admin: ["view", "service_modify", "location_correct", "reassign", "cancel", "charge_review", "complaint_manage", "live_gps", "audit_read"],
      Manager: ["view", "service_modify", "location_correct", "reassign", "cancel", "charge_review", "complaint_manage", "live_gps", "audit_read"],
      Subadmin: ["view", "complaint_manage"],
      Executive: ["view", "complaint_manage", "live_gps"],
      Telecaller: ["view", "complaint_manage"],
    };
    for (const [role, id] of Object.entries(ADMIN_IDS)) {
      for (const permission of ["view", "service_modify", "location_correct", "reassign", "cancel", "charge_review", "complaint_manage", "live_gps", "audit_read"]) {
        const result = await request(port, "GET", `/permission/${permission}`, tokenFor(id, 1));
        assert.strictEqual(result.status, roleMatrix[role].includes(permission) ? 200 : 403, `${role} / ${permission}`);
      }
    }

    for (const [role, id] of Object.entries(ADMIN_IDS)) {
      const token = tokenFor(id, 1);
      assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}`, token)).status, 200, `${role} can view`);
      const modification = await request(port, "POST", `/bookings/${BOOKING_ID}/services`, token, {});
      assert.strictEqual(modification.status, ["Admin", "Manager"].includes(role) ? 200 : 403, `${role} service permission`);
      const audit = await request(port, "GET", `/bookings/${BOOKING_ID}/audit`, token);
      assert.strictEqual(audit.status, ["Admin", "Manager"].includes(role) ? 200 : 403, `${role} audit permission`);
    }

    const adminToken = tokenFor(ADMIN_IDS.Admin, 1);
    const safeView = await request(port, "GET", `/bookings/${BOOKING_ID}`, adminToken);
    assert(!JSON.stringify(safeView.body).match(/pickupOtp|deliveryOtp/i), "booking HTTP response redacts OTP keys");
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}/audit`, tokenFor(ADMIN_IDS.Telecaller, 1))).status, 403);
    assert.strictEqual((await request(port, "GET", `/bookings/${BOOKING_ID}`, tokenFor(new mongoose.Types.ObjectId().toString(), 4))).status, 404, "customer cannot read another booking");
    assert.strictEqual((await request(port, "POST", `/provider/${BOOKING_ID}/status`, tokenFor(DEALER_ID, 2), { status: "confirmed" })).status, 200);
    assert.strictEqual((await request(port, "POST", `/provider/${BOOKING_ID}/status`, tokenFor(DEALER_ID, 2), { status: "delivered" })).status, 400);
    assert.strictEqual((await request(port, "POST", `/provider/${BOOKING_ID}/status`, tokenFor(new mongoose.Types.ObjectId().toString(), 2), { status: "confirmed" })).status, 404, "non-owning provider cannot access booking");
    assert.strictEqual((await request(port, "POST", `/provider/${BOOKING_ID}/status`, adminToken, { status: "confirmed" })).status, 403, "admin cannot use provider status route");
    assert.strictEqual((await request(port, "PUT", `/legacy/update/${BOOKING_ID}`, adminToken, {})).status, 410);
    assert.strictEqual((await request(port, "DELETE", "/legacy/delete", adminToken)).status, 410);
    assert.strictEqual((await request(port, "PATCH", "/api/v2/bookings/BK-legacy/status", null, { status: "delivered" })).status, 410, "legacy v2 status mutation is retired");
    assert.strictEqual((await request(port, "POST", "/api/v2/bookings/verify-otp", null, { bookingId: "BK-legacy", otp: "1234" })).status, 410, "legacy v2 OTP mutation is retired");
    console.log("Authenticated booking HTTP integration tests passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore.forEach((undo) => undo());
    Customer.exists = customerExists;
    Audit.find = auditFind;
    Audit.countDocuments = auditCount;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
