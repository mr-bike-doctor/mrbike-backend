const assert = require("assert");
const {
  findPriceRowForCC,
  resolveBikeCC,
  resolveServiceLines,
  resolveServiceAmount,
} = require("../services/pricingEngine");
const { buildServiceLineItems } = require("../services/invoiceService");

const MODEL = "6a6f03898dd53a371f0c3b2e";
const VARIANT = "6aaac7af82bb2014ad592793";
const OTHER_VARIANT = "6aaac7af82bb2014ad592794";

// ── findPriceRowForCC: null (not 0) when no row applies ─────────────────────
const otherVariantOnly = { bikes: [{ variant_id: OTHER_VARIANT, cc: 110, price: 150 }] };
assert.strictEqual(findPriceRowForCC(otherVariantOnly, 110, { variantId: VARIANT, modelId: MODEL }), null);
assert.strictEqual(findPriceRowForCC({ bikes: [{ cc: 110, price: 0 }] }, 110, { variantId: VARIANT }).price, 0);

// ── Decimal engine_cc: exact first, whole-number fallback ───────────────────
assert.strictEqual(resolveBikeCC({ variant_id: { engine_cc: 109.7 }, bike_cc: "110" }), 109.7);
assert.strictEqual(resolveBikeCC({ bike_cc: "125cc" }), 125);
assert.strictEqual(resolveBikeCC(null), 0);
assert.strictEqual(findPriceRowForCC({ bikes: [{ cc: 109.7, price: 300 }] }, 109.7).price, 300);
assert.strictEqual(findPriceRowForCC({ bikes: [{ cc: 109, price: 300 }] }, 109.7).price, 300);
assert.strictEqual(
  findPriceRowForCC({ bikes: [{ cc: 109.7, price: 300 }, { cc: 109, price: 200 }] }, 109.7).price,
  300,
);

// ── resolveServiceLines sums to resolveServiceAmount ───────────────────────
const general = { _id: "a1", bikes: [{ variant_id: VARIANT, cc: 110, price: 700 }] };
const battery = { _id: "b1", bikes: [{ cc: 110, price: 150 }] };
const ctx = { variantId: VARIANT, modelId: MODEL };
const lines = resolveServiceLines({ services: [general], additionalServices: [battery], bikeCC: 110, bikeContext: ctx });
assert.deepStrictEqual(lines, [
  { kind: "service", ref: "a1", price: 700 },
  { kind: "additional", ref: "b1", price: 150 },
]);
assert.strictEqual(
  resolveServiceAmount({ services: [general], additionalServices: [battery], bikeCC: 110, bikeContext: ctx }),
  850,
);

// ── Invoice rows: priced with the variant context, not CC-only ──────────────
const variantScopedBattery = {
  _id: "b2",
  base_additional_service_id: { name: "Battery Charge" },
  bikes: [
    { variant_id: OTHER_VARIANT, cc: 110, price: 999 },
    { variant_id: VARIANT, cc: 110, price: 150 },
  ],
};
const booking = {
  userBike_id: { bike_cc: "", variant_id: { _id: VARIANT, engine_cc: 110, model_id: { _id: MODEL } } },
  services: [{ _id: "a1", base_service_id: { name: "General Service" }, bikes: general.bikes }],
  additionalServices: [variantScopedBattery],
  serviceLines: [],
};
assert.deepStrictEqual(buildServiceLineItems(booking), [
  { name: "General Service", price: 700, quantity: 1, total: 700 },
  { name: "Additional: Battery Charge", price: 150, quantity: 1, total: 150 },
]);

// ── Stored serviceLines win over the (possibly changed) catalog ─────────────
const withSnapshot = {
  ...booking,
  serviceLines: [
    { kind: "service", ref: "a1", price: 650 },
    { kind: "additional", ref: "b2", price: 120 },
  ],
};
assert.deepStrictEqual(
  buildServiceLineItems(withSnapshot).map((l) => l.total),
  [650, 120],
);

console.log("invoiceServiceLines tests passed");
