const assert = require("assert");
const {
  DELIVERY_OTP_TTL_MS,
  MAX_DELIVERY_OTP_ATTEMPTS,
  MAX_DELIVERY_OTP_REGENERATIONS,
  deliveryOtpExpiry,
  deliveryOtpState,
  generateDeliveryOtp,
  confirmCashReceipt,
  recordInvalidDeliveryOtp,
  consumeDeliveryOtp,
  regenerateDeliveryOtp,
} = require("../services/deliveryOtpLifecycle");

const now = new Date("2026-10-10T10:00:00.000Z");
const expiry = deliveryOtpExpiry(now);
assert.strictEqual(expiry.getTime() - now.getTime(), DELIVERY_OTP_TTL_MS);
assert.strictEqual(deliveryOtpState({ deliveryOtp: 1234 }, now), "REGENERATION_REQUIRED");
assert.strictEqual(deliveryOtpState({ deliveryOtp: null, deliveryOtpExpiresAt: expiry }, now), "MISSING");
assert.strictEqual(deliveryOtpState({ deliveryOtp: 1234, deliveryOtpExpiresAt: now }, now), "EXPIRED");
assert.strictEqual(deliveryOtpState({ deliveryOtp: 1234, deliveryOtpExpiresAt: expiry }, now), "AVAILABLE");
for (let i = 0; i < 100; i += 1) assert.match(String(generateDeliveryOtp()), /^\d{4}$/);

function matches(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    if ("$ne" in expected) return actual !== expected.$ne;
    if ("$gt" in expected) return actual != null && new Date(actual).getTime() > expected.$gt.getTime();
    if ("$lt" in expected) return actual != null && actual < expected.$lt;
    if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    return false;
  }
  return actual === expected;
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$and") return expected.every((part) => matchesFilter(document, part));
    if (key === "$or") return expected.some((part) => matchesFilter(document, part));
    return matches(document[key], expected);
  });
}

function fakeModel(initial) {
  const state = { ...initial };
  return {
    state,
    async findOneAndUpdate(filter, update) {
      // No await before matching/updating: models MongoDB's atomic conditional write.
      if (!matchesFilter(state, filter)) return null;
      for (const [key, value] of Object.entries(update.$set || {})) state[key] = value;
      for (const [key, value] of Object.entries(update.$inc || {})) state[key] = (state[key] || 0) + value;
      return { ...state, toObject() { return { ...state }; } };
    },
  };
}

(async () => {
  const cash = fakeModel({
    _id: "b1", dealer_id: "d1", status: "payment_selected", payment_method: "CASH",
    payment_status: "pending", payment_verified: false, otp_failed_attempts: 4,
  });
  const issued = await Promise.all([
    confirmCashReceipt(cash, { bookingId: "b1", dealerId: "d1", otp: 1234, now }),
    confirmCashReceipt(cash, { bookingId: "b1", dealerId: "d1", otp: 5678, now }),
  ]);
  assert.strictEqual(issued.filter(Boolean).length, 1, "only one concurrent cash confirmation claims the booking");
  assert.strictEqual(cash.state.deliveryOtp, issued[0]?.deliveryOtp || issued[1]?.deliveryOtp);
  assert.strictEqual(cash.state.deliveryOtpExpiresAt.getTime(), expiry.getTime());
  assert.strictEqual(cash.state.otp_failed_attempts, 0, "new OTP resets failed attempts");
  assert.strictEqual(cash.state.status, "ready_for_delivery");

  const invalids = await Promise.all(Array.from({ length: 8 }, () => recordInvalidDeliveryOtp(cash, {
    bookingId: "b1", dealerId: "d1", paymentMethod: "CASH", storedOtp: cash.state.deliveryOtp, now,
  })));
  assert.strictEqual(invalids.filter(Boolean).length, MAX_DELIVERY_OTP_ATTEMPTS);
  assert.strictEqual(cash.state.otp_failed_attempts, MAX_DELIVERY_OTP_ATTEMPTS, "concurrent invalid attempts cannot exceed five");

  const regen = fakeModel({
    _id: "b2", dealer_id: "d1", status: "ready_for_delivery", otp_regen_count: 0,
    otp_failed_attempts: 3, deliveryOtp: 1111,
  });
  for (let count = 1; count <= MAX_DELIVERY_OTP_REGENERATIONS; count += 1) {
    const result = await regenerateDeliveryOtp(regen, { bookingId: "b2", dealerId: "d1", otp: 2000 + count, expiresAt: expiry, resetAttempts: true, now });
    assert(result, `regeneration ${count} succeeds`);
    assert.strictEqual(regen.state.otp_regen_count, count);
    assert.strictEqual(regen.state.otp_failed_attempts, 0);
    assert.strictEqual(regen.state.deliveryOtpExpiresAt.getTime(), expiry.getTime());
  }
  const overLimit = await regenerateDeliveryOtp(regen, { bookingId: "b2", dealerId: "d1", otp: 9999, expiresAt: expiry, now });
  assert.strictEqual(overLimit, null, "sixth regeneration is rejected atomically");

  const concurrentRegen = fakeModel({ _id: "b2c", dealer_id: "d1", status: "ready_for_delivery", otp_regen_count: 4 });
  const concurrentRegens = await Promise.all([
    regenerateDeliveryOtp(concurrentRegen, { bookingId: "b2c", dealerId: "d1", otp: 3001, expiresAt: expiry, now }),
    regenerateDeliveryOtp(concurrentRegen, { bookingId: "b2c", dealerId: "d1", otp: 3002, expiresAt: expiry, now }),
  ]);
  assert.strictEqual(concurrentRegens.filter(Boolean).length, 1, "concurrent requests cannot exceed the five-regeneration cap");
  assert.strictEqual(concurrentRegen.state.otp_regen_count, MAX_DELIVERY_OTP_REGENERATIONS);

  const delivery = fakeModel({
    _id: "b3", dealer_id: "d1", status: "ready_for_delivery", deliveryOtp: 4321,
    deliveryOtpExpiresAt: expiry, otp_failed_attempts: 0, deliveryTransportStatus: "ARRIVED_AT_CUSTOMER",
  });
  const delivered = await Promise.all([
    consumeDeliveryOtp(delivery, { bookingId: "b3", dealerId: "d1", paymentMethod: "CASH", storedOtp: 4321, now }),
    consumeDeliveryOtp(delivery, { bookingId: "b3", dealerId: "d1", paymentMethod: "CASH", storedOtp: 4321, now }),
  ]);
  assert.strictEqual(delivered.filter(Boolean).length, 1, "concurrent valid verifications deliver only once");
  assert.strictEqual(delivery.state.status, "delivered");
  assert.strictEqual(delivery.state.deliveryOtp, null);

  const normalCash = fakeModel({
    _id: "b3c", dealer_id: "d1", status: "payment_selected", payment_method: "CASH",
    payment_status: "pending", payment_verified: false, otp_failed_attempts: 2,
  });
  assert(await confirmCashReceipt(normalCash, { bookingId: "b3c", dealerId: "d1", otp: 7654, now }));
  assert(await consumeDeliveryOtp(normalCash, { bookingId: "b3c", dealerId: "d1", paymentMethod: "CASH", storedOtp: 7654, now }));
  assert.strictEqual(normalCash.state.status, "delivered", "cash confirmation leads through expiring OTP to delivered");

  const expired = fakeModel({
    _id: "b4", dealer_id: "d1", status: "ready_for_delivery", deliveryOtp: 5555,
    deliveryOtpExpiresAt: now, otp_failed_attempts: 0,
  });
  assert.strictEqual(await consumeDeliveryOtp(expired, { bookingId: "b4", dealerId: "d1", paymentMethod: "CASH", storedOtp: 5555, now }), null);

  const online = fakeModel({
    _id: "b5", dealer_id: "d1", status: "ready_for_delivery", deliveryOtp: 8765,
    otp_failed_attempts: 0, deliveryTransportStatus: "ARRIVED_AT_CUSTOMER",
  });
  assert(await consumeDeliveryOtp(online, { bookingId: "b5", dealerId: "d1", paymentMethod: "ONLINE", storedOtp: 8765, now }), "legacy online OTP verification remains compatible without a CASH expiry");
  console.log("Delivery OTP lifecycle tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
