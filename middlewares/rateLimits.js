const rateLimit = require("express-rate-limit");

const buildLimiter = (name, defaultMax, defaultWindowMinutes) => rateLimit({
  windowMs: Number(process.env[`RATE_LIMIT_${name}_WINDOW_MINUTES`] || defaultWindowMinutes) * 60 * 1000,
  max: Number(process.env[`RATE_LIMIT_${name}_MAX`] || defaultMax),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    message: "Too many requests. Please try again later.",
  }),
});

const limiters = {
  otpVerify: buildLimiter("OTP_VERIFY", 10, 15),
  otpSend: buildLimiter("OTP_SEND", 5, 15),
  passwordReset: buildLimiter("PASSWORD_RESET", 5, 30),
  login: buildLimiter("LOGIN", 10, 15),
  payment: buildLimiter("PAYMENT", 60, 15),
  referral: buildLimiter("REFERRAL", 30, 15),
  support: buildLimiter("SUPPORT", 60, 15),
};

// Reads are polled by the dashboards (support inbox every 25s, an open ticket
// every 5s), so they can't share the write budget that exists to stop ticket
// and referral spam. Only a body-carrying method is throttled in those two
// categories; auth and payment stay limited on every method.
const isRead = (method) => method === "GET" || method === "HEAD";

function selectLimiter(req) {
  const path = req.path.toLowerCase();
  const method = (req.method || "").toUpperCase();
  if (/otpverify|verify-otp|verifyotp|verify-delivery-otp/.test(path)) return limiters.otpVerify;
  if (/send-otp|sendotp|resendotp|regenerate-delivery-otp/.test(path)) return limiters.otpSend;
  if (/reset.*password|forgot.*password|change[-_]?password|changepassword/.test(path)) return limiters.passwordReset;
  if (/login|signin/.test(path)) return limiters.login;
  if (/payment|cashfree|payu|invoice|checkout|\bbills?\b/.test(path)) return limiters.payment;
  if (/referral/.test(path)) return isRead(method) ? null : limiters.referral;
  if (/ticket|support/.test(path)) return isRead(method) ? null : limiters.support;
  return null;
}

module.exports = function sensitiveRateLimit(req, res, next) {
  const limiter = selectLimiter(req);
  return limiter ? limiter(req, res, next) : next();
};

module.exports.limiters = limiters;
module.exports.selectLimiter = selectLimiter;
