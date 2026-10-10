const crypto = require("crypto");

const SENSITIVE_KEY = /(otp|password|token|secret|authorization|cookie|device.?token)/i;

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object" || value instanceof Date || value._bsontype) return value;
  return Object.entries(value).reduce((safe, [key, entry]) => {
    if (!SENSITIVE_KEY.test(key)) safe[key] = redactSensitive(entry);
    return safe;
  }, {});
}

function correlationId(req) {
  const supplied = req?.get?.("x-request-id") || req?.headers?.["x-request-id"];
  return typeof supplied === "string" && supplied.length <= 128
    ? supplied
    : crypto.randomBytes(16).toString("hex");
}

function createAdminBookingAuditEvent({
  bookingId, adminId, adminRole, action, reason, before, after,
  approvalReference = null, consentReference = null, requestId,
}) {
  return {
    bookingId,
    adminId,
    adminRole,
    action,
    reason: String(reason || "Admin update (reason not supplied)").trim().slice(0, 500),
    occurredAt: new Date(),
    before: redactSensitive(before || {}),
    after: redactSensitive(after || {}),
    approvalReference: approvalReference || null,
    consentReference: consentReference || null,
    requestId: requestId || crypto.randomBytes(16).toString("hex"),
  };
}

async function saveBookingWithAdminAudit(document, auditEvent) {
  const mongoose = require("mongoose");
  const AdminBookingAudit = require("../models/AdminBookingAudit");
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await document.save({ session });
      await AdminBookingAudit.create([auditEvent], { session });
    });
  } finally {
    await session.endSession();
  }
}

function snapshotFields(document, fields) {
  const source = typeof document?.toObject === "function" ? document.toObject() : document || {};
  return fields.reduce((snapshot, field) => {
    const value = field.split(".").reduce((current, key) => current?.[key], source);
    if (value !== undefined) snapshot[field] = value;
    return snapshot;
  }, {});
}

module.exports = { redactSensitive, correlationId, createAdminBookingAuditEvent, saveBookingWithAdminAudit, snapshotFields };
