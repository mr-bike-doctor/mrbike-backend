const Joi = require("joi");

const objectId = Joi.string().pattern(/^[a-f\d]{24}$/i).messages({
  "string.pattern.base": "{{#label}} must be a valid ObjectId",
});
const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5"] });
const phone = Joi.string().trim().pattern(/^\+?[1-9]\d{9,14}$/).messages({
  "string.pattern.base": "{{#label}} must be a valid phone number",
});
const otp = Joi.alternatives().try(
  Joi.string().pattern(/^\d{4,8}$/),
  Joi.number().integer().min(0).max(99999999)
).messages({ "alternatives.match": "{{#label}} must be a 4 to 8 digit OTP" });
const amount = Joi.alternatives().try(
  Joi.number().min(0).max(100000000),
  Joi.string().pattern(/^\d+(\.\d{1,2})?$/)
);
const positiveInteger = Joi.alternatives().try(
  Joi.number().integer().min(1),
  Joi.string().pattern(/^[1-9]\d*$/)
);
const pagination = (maximum) => Joi.alternatives().try(
  Joi.number().integer().min(1).max(maximum),
  Joi.string().pattern(new RegExp(`^(?:[1-9]\\d{0,${String(maximum).length - 1}})$`)).custom((value, helpers) => (
    Number(value) <= maximum ? value : helpers.error("number.max", { limit: maximum })
  ))
);
const isoDate = Joi.alternatives().try(
  Joi.string().isoDate(),
  Joi.date().timestamp("javascript"),
  Joi.number().integer().min(0)
);

const STATUS_VALUES = [
  "active", "inactive", "pending", "sent", "failed", "draft", "scheduled",
  "processing", "completed", "cancelled", "expired", "approved", "rejected",
  "credited", "reversed", "live", "coming_soon", "paused", "generated", "paid",
  "picked-up", "in-progress", "ready-for-delivery", "delivered", "success",
  "confirmed", "awaiting", "accepted", "awaiting_payment", "payment_selected",
  "user_cancelled", "cash received", "Payment", "upcoming", "verified", "requested",
  "arriving", "arrived",
  "Open", "In Progress", "Closed", "ALL", "PROCESSED", "NONE",
  "PENDING", "SUCCESS", "FAILED", "CANCELLED", "EXPIRED", "ACTIVE", "PAID",
  "IN_PROGRESS", "COMPLETED", "APPROVED", "REJECTED", "Draft", "Pending",
  "Approved", "Rejected", "open", "closed", "resolved",
];
const ROLE_VALUES = [
  "user", "dealer", "admin", "customer", "system", "Telecaller", "Manager",
  "Admin", "Subadmin", "Executive", "Vendor", "System",
];
const USER_TYPE_VALUES = [...ROLE_VALUES, "1", "2", "3", "4", 1, 2, 3, 4];

const fieldSchema = (key) => {
  if (key === "_id" || /(?:^|_)(user|dealer|booking|service|payment|ticket|bike|admin)_?id$/i.test(key) || /(?:user|dealer|booking|service|payment|ticket|bike|admin)Id$/.test(key)) return objectId;
  if (/uuid/i.test(key)) return uuid;
  if (/^(email|.*_email|personalEmail|customerEmail)$/i.test(key)) return Joi.string().trim().email({ tlds: { allow: false } });
  if (/^(phone|mobile|mobileno|.*_phone|phoneNumber)$/i.test(key)) return phone;
  if (/otp/i.test(key)) return otp;
  if (/(^|_)(amount|price|fee|total|subtotal|discount|tax|commission)(_|$)/i.test(key) || /Amount$|Price$/.test(key)) return amount;
  if (/^(page|limit|pageSize)$/i.test(key)) return pagination(key.toLowerCase() === "page" ? 1000000 : 100);
  if (/(^|_)(date|startDate|endDate|fromDate|toDate|scheduledAt|expiresAt|createdAt|updatedAt)$/i.test(key)) return isoDate;
  if (key === "status") return Joi.string().valid(...STATUS_VALUES);
  if (/^(role|receiverType)$/i.test(key)) return Joi.string().valid(...ROLE_VALUES);
  // Legacy booking APIs use numeric user types (2 = dealer, 4 = customer),
  // while newer APIs use role names. Query parameters arrive as strings;
  // body fields may still be numbers, so accept both representations.
  if (/^user_type$/i.test(key)) return Joi.any().valid(...USER_TYPE_VALUES);
  if (/^gender$/i.test(key)) return Joi.string().valid("male", "female", "other", "Male", "Female", "Other");
  return null;
};

function validateFields(value, path, errors) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return;
  Object.entries(value).forEach(([key, child]) => {
    const currentPath = path ? `${path}.${key}` : key;
    if (child === undefined || child === null || child === "") return;
    const schema = key === "id" && path === "params" ? objectId : fieldSchema(key);
    if (schema) {
      const result = schema.validate(child, { convert: false });
      if (result.error) errors.push({ field: currentPath, message: result.error.details[0].message.replace(/"/g, "") });
    }
    if (typeof child === "object") validateFields(child, currentPath, errors);
  });
}

const requiredRules = [
  { method: "POST", path: /\/userAuth\/(userLogin|resendOtp)$/i, fields: ["phone"] },
  { method: "POST", path: /\/userAuth\/otpVerify$/i, fields: ["phone", "otp"] },
  { method: "POST", path: /\/dealerAuth\/sendotp$/i, fields: ["phone"] },
  { method: "POST", path: /\/dealerAuth\/verifyotp$/i, fields: ["phone", "otp"] },
  { method: "POST", path: /\/dealerAuth\/signin$/i, fields: ["phone"] },
  { method: "POST", path: /\/adminauth\/suadminLogin$/i, fields: ["email", "password"] },
  { method: "POST", path: /\/adminauth\/send-otp$/i, fields: ["phone"] },
  { method: "POST", path: /\/adminauth\/verify-otp$/i, fields: ["phone", "otp"] },
  { method: "POST", path: /\/bikedoctor\/verify-otp$/i, fields: ["mobile", "otp"] },
  { method: "POST", path: /\/api\/v2\/bookings\/verify-otp$/i, fields: ["bookingId", "dealerId", "otp"] },
  { method: "POST", path: /\/(payu|cashfree)\/generate-qr$/i, fields: ["booking_id"] },
  { method: "POST", path: /\/customers\/validateReferralCode$/i, fields: ["referralCode"] },
  { method: "POST", path: /\/ticket\/create\/[^/]+$/i, fields: ["subject", "message"] },
  { method: "POST", path: /\/ticket\/reply\/[^/]+$/i, fields: ["message"] },
];

module.exports = function validateRequest(req, res, next) {
  // PayU webhook/callback bodies are authenticated by their reverse hash in
  // the handler; gateway field values (e.g. status=failure) are not ours.
  if (/\/webhook\/?$/i.test(req.originalUrl.split("?")[0])) return next();

  const errors = [];
  validateFields(req.params, "params", errors);
  validateFields(req.query, "query", errors);
  validateFields(req.body, "body", errors);

  const rule = requiredRules.find((item) => item.method === req.method && item.path.test(req.originalUrl.split("?")[0]));
  if (rule) {
    rule.fields.forEach((field) => {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === "") {
        errors.push({ field: `body.${field}`, message: `${field} is required` });
      }
    });
  }

  if (errors.length) {
    return res.status(400).json({ success: false, message: errors[0].message });
  }
  next();
};

module.exports.schemas = { objectId, uuid, phone, amount, otp, positiveInteger, isoDate };
