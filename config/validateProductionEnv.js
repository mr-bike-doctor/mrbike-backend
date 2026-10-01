const REQUIRED_PRODUCTION_ENV = [
  "NODE_ENV",
  "BACKEND_URL",
  "FRONTEND_URL",
];

function validateHttpsUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid production URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  if (/localhost|127\.0\.0\.1|sandbox|test/i.test(parsed.hostname)) {
    throw new Error(`${name} must point to a production host`);
  }
}

function validateProductionEnv() {
  const missing = REQUIRED_PRODUCTION_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }

  if (process.env.NODE_ENV !== "production") {
    throw new Error('NODE_ENV must be set to "production"');
  }

  // Booking UPI QR answers 503 until PayU is configured; never block startup.
  if (!process.env.PAYU_KEY?.trim() || !process.env.PAYU_SALT?.trim()) {
    console.warn("[PAYU_QR] PAYU_KEY / PAYU_SALT missing — booking UPI QR is disabled");
  } else if (process.env.PAYU_ENV !== "production") {
    console.warn('[PAYU_QR] PAYU_ENV is not "production" — QR requests go to test.payu.in');
  }

  validateHttpsUrl("BACKEND_URL", process.env.BACKEND_URL);
  validateHttpsUrl("FRONTEND_URL", process.env.FRONTEND_URL);
}

module.exports = validateProductionEnv;
