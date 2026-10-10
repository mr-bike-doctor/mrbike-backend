const assert = require("assert");
const { verifyAddressCoordinates, distanceMeters, MAX_ADDRESS_PIN_DISTANCE_METERS } = require("../services/addressCoordinateValidation");

(async () => {
  const location = { address: "12 MG Road, Bengaluru", latitude: 12.9716, longitude: 77.5946 };
  const close = await verifyAddressCoordinates(location, {
    apiKey: "unit-test-only",
    geocode: async (_url, config) => {
      assert.strictEqual(config.params.address, location.address);
      assert.strictEqual(config.timeout, 5000);
      return { data: { status: "OK", results: [{ geometry: { location: { lat: 12.9717, lng: 77.5947 } } }] } };
    },
  });
  assert.deepStrictEqual(close, { valid: true });

  const mismatch = await verifyAddressCoordinates(location, {
    apiKey: "unit-test-only",
    geocode: async () => ({ data: { status: "OK", results: [{ geometry: { location: { lat: 13.2, lng: 77.8 } } }] } }),
  });
  assert.deepStrictEqual(mismatch, { valid: false, code: "ADDRESS_PIN_MISMATCH" });

  const noResult = await verifyAddressCoordinates(location, {
    apiKey: "unit-test-only",
    geocode: async () => ({ data: { status: "ZERO_RESULTS", results: [] } }),
  });
  assert.deepStrictEqual(noResult, { valid: false, code: "ADDRESS_PIN_MISMATCH" });

  const denied = await verifyAddressCoordinates(location, {
    apiKey: "unit-test-only",
    geocode: async () => ({ data: { status: "REQUEST_DENIED", results: [] } }),
  });
  assert.deepStrictEqual(denied, { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" }, "Google key restrictions/configuration errors fail closed as a service failure");

  const unavailable = await verifyAddressCoordinates(location, { apiKey: "unit-test-only", geocode: async () => { throw new Error("must not leak"); } });
  assert.deepStrictEqual(unavailable, { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" });
  assert.deepStrictEqual(await verifyAddressCoordinates(location, { apiKey: "" }), { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" });
  assert.deepStrictEqual(await verifyAddressCoordinates({ ...location, address: "" }, { apiKey: "unit-test-only" }), { valid: false, code: "INVALID_LOCATION" });
  assert.deepStrictEqual(await verifyAddressCoordinates({ ...location, latitude: Number.NaN }, { apiKey: "unit-test-only" }), { valid: false, code: "INVALID_LOCATION" });
  assert(distanceMeters(location, { latitude: 12.9716, longitude: 77.5946 }) < MAX_ADDRESS_PIN_DISTANCE_METERS);
  console.log("Address and coordinate validation checks passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
