const assert = require("assert");
const { __testing } = require("../controller/cashfreeQRController");

const {
  extractDynamicQr,
  amountMatches,
  buildExpiryIso,
  isExpired,
  getQrExpiryMinutes,
} = __testing;

// ── The regression this flow exists to prevent ──────────────────────────────
// A QR built from a hosted-checkout URL opens Cashfree's web page instead of
// paying from PhonePe/GPay. An http(s) value must never be treated as a QR.
{
  assert.strictEqual(
    extractDynamicQr({ data: { url: "https://payments.cashfree.com/order/#session_abc" } }),
    null,
    "hosted checkout URL must not be accepted as a UPI QR",
  );
  assert.strictEqual(
    extractDynamicQr({ data: { payload: { qrcode: "https://payments.cashfree.com/links/xyz" } } }),
    null,
    "a link URL in payload.qrcode must not be accepted as a UPI QR",
  );
  assert.strictEqual(
    extractDynamicQr({ data: { payload: {} } }),
    null,
    "an empty payload yields no QR",
  );
  assert.strictEqual(extractDynamicQr({}), null, "a malformed response yields no QR");
}

// ── What Cashfree actually returns for upi/channel=qrcode ───────────────────
{
  const base64Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  assert.deepStrictEqual(
    extractDynamicQr({ data: { payload: { qrcode: base64Png } } }),
    { kind: "image", value: base64Png },
  );

  // Pure base64 (no data URI prefix) is normalized downstream.
  const rawBase64 = `iVBORw0KGgoAAAANSUhEUg${"A".repeat(120)}==`;
  assert.deepStrictEqual(
    extractDynamicQr({ data: { payload: { default_qr_code: rawBase64 } } }),
    { kind: "image", value: rawBase64 },
  );

  // ...but a short alphanumeric token is not an image.
  assert.strictEqual(
    extractDynamicQr({ data: { payload: { qrcode: "PENDING" } } }),
    null,
    "a short status-ish string must not be mistaken for a base64 QR",
  );

  // A upi:// intent is a genuine dynamic UPI payload with the amount baked in.
  const intent = "upi://pay?pa=bikedoctor@cashfree&pn=BikeDoctor&am=499.00&tr=BIKEDOC_1&cu=INR";
  assert.deepStrictEqual(
    extractDynamicQr({ data: { payload: { bqrdata: intent } } }),
    { kind: "upi_intent", value: intent },
  );

  // A usable payload wins over a hosted URL sitting alongside it.
  assert.deepStrictEqual(
    extractDynamicQr({ data: { url: "https://payments.cashfree.com/x", payload: { qrcode: base64Png } } }),
    { kind: "image", value: base64Png },
  );
}

// ── Amount authority ────────────────────────────────────────────────────────
{
  assert.ok(amountMatches(499, 499));
  assert.ok(amountMatches(499.0, "499.00"), "string amounts from Cashfree compare numerically");
  assert.ok(amountMatches(499, 499.009), "sub-paisa float drift is tolerated");
  assert.ok(!amountMatches(499, 1), "a short payment must not match");
  assert.ok(!amountMatches(499, 500), "an over-payment must not match");
  assert.ok(!amountMatches(499, undefined), "a missing verified amount must not match");
  assert.ok(!amountMatches(499, null));
  assert.ok(!amountMatches(undefined, 499));
}

// ── Expiry is unambiguous in IST ────────────────────────────────────────────
{
  const iso = buildExpiryIso(30);
  assert.match(
    iso,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/,
    "expiry must use Cashfree's documented +05:30 offset form, not a bare Z",
  );
  const minutesAhead = (new Date(iso).getTime() - Date.now()) / 60000;
  assert.ok(
    minutesAhead > 29.5 && minutesAhead < 30.5,
    `expiry must land 30 minutes ahead, got ${minutesAhead.toFixed(2)} — a timezone slip would put it ~5h30m off`,
  );
}

// ── Expiry evaluation on stored payments ────────────────────────────────────
{
  assert.ok(isExpired({ metadata: {} }), "a payment with no expiry is treated as expired");
  assert.ok(isExpired({ metadata: { expiry_time: new Date(Date.now() - 1000).toISOString() } }));
  assert.ok(!isExpired({ metadata: { expiry_time: new Date(Date.now() + 60000).toISOString() } }));
  assert.ok(isExpired({ metadata: { expiry_time: "not-a-date" } }), "an unparseable expiry is expired");
}

// ── Configurable QR lifetime ────────────────────────────────────────────────
{
  const original = process.env.CASHFREE_QR_EXPIRY_MINUTES;
  delete process.env.CASHFREE_QR_EXPIRY_MINUTES;
  assert.strictEqual(getQrExpiryMinutes(), 30, "defaults to 30 minutes");
  process.env.CASHFREE_QR_EXPIRY_MINUTES = "15";
  assert.strictEqual(getQrExpiryMinutes(), 15, "honours the configured value");
  process.env.CASHFREE_QR_EXPIRY_MINUTES = "garbage";
  assert.strictEqual(getQrExpiryMinutes(), 30, "falls back on a non-numeric value");
  process.env.CASHFREE_QR_EXPIRY_MINUTES = "0";
  assert.strictEqual(getQrExpiryMinutes(), 30, "falls back on a non-positive value");
  if (original === undefined) delete process.env.CASHFREE_QR_EXPIRY_MINUTES;
  else process.env.CASHFREE_QR_EXPIRY_MINUTES = original;
}

console.log("bookingDynamicUpiQr.test.js: all assertions passed");
