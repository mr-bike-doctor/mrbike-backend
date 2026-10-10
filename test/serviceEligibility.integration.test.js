// End-to-end checks for the bike-aware discovery/booking endpoints, run
// against a throwaway local database (never the configured DATABASE_URL).
//
// Skips itself with exit code 0 when no local mongod is reachable, so it is
// safe in `npm test` on a machine or CI box without one. Point it elsewhere
// with TEST_MONGO_URL.
const assert = require("assert");
const mongoose = require("mongoose");

const TEST_URL = process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:27017/mrbike_eligibility_test";

const BaseService = require("../models/baseService");
const AdminService = require("../models/adminService");
const UserBike = require("../models/userBikeModel");
const BikeVariant = require("../models/bikeVariantModel");
const BikeModel = require("../models/bikeModel");
const BikeCompany = require("../models/bikeCompanyModel");
const Vendor = require("../models/dealerModel");
// Registered for its side effect: listByCategory populates categoryId.
require("../models/serviceCategoryModel");

const homeController = require("../v1-api/controllers/homeController");
const serviceController = require("../v1-api/controllers/serviceController");

const oid = hex => new mongoose.Types.ObjectId(hex);
const id = n => oid(String(n).padStart(24, "0"));

// ── Fixture ids ─────────────────────────────────────────────────────────────
const HONDA = id(11), HERO = id(12);
const M1 = id(21), M2 = id(22), M3 = id(23);
const V1 = id(31), V2 = id(32), V3 = id(33);
const USER = id(41);
const BIKE_A = id(51), BIKE_B = id(52), BIKE_C = id(53);
const D1 = id(61), D2 = id(62), D3 = id(63), D_OFFLINE = id(64), D_FAR = id(65);
const SVC = [null, id(71), id(72), id(73), id(74), id(75), id(76)];

// User sits at (23.2599, 77.4126). D1/D2/D3/D_OFFLINE are ~1 km away; D_FAR is
// ~50 km away, well outside any configured radius.
const USER_LAT = 23.2599;
const USER_LNG = 77.4126;

function bookableDealer(_id, extra = {}) {
  return {
    _id,
    shopName: `Shop ${_id}`,
    city: "Bhopal",
    locality: "MP Nagar",
    latitude: USER_LAT + 0.005,
    longitude: USER_LNG + 0.005,
    serviceRadiusKm: 5,
    online: true,
    isBlocked: false,
    isActive: true,
    dealerStatus: "Active",
    registrationStatus: "Approved",
    status: { adminApproved: true, isActive: true },
    wallet: 0,
    providesTowing: false,
    shopImages: [],
    ...extra,
  };
}

function res() {
  const captured = {};
  return {
    captured,
    status(code) {
      captured.code = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

function req(query = {}, { params = {}, user_id = null } = {}) {
  return { query, params, user_id, protocol: "http", get: () => "localhost" };
}

async function call(handler, request) {
  const response = res();
  await handler(request, response);
  assert.strictEqual(response.captured.code, 200, JSON.stringify(response.captured.body));
  return response.captured.body;
}

const names = body => body.data.map(d => d.name).sort();

// Counts the mongo operations a handler actually issues, so "no N+1" is an
// assertion rather than a claim.
async function countQueries(fn) {
  const ops = [];
  mongoose.set("debug", (collection, method) => ops.push(`${collection}.${method}`));
  try {
    await fn();
  } finally {
    mongoose.set("debug", false);
  }
  return ops;
}

async function seed() {
  await Promise.all([
    BikeCompany.collection.insertMany([
      { _id: HONDA, name: "HONDA" },
      { _id: HERO, name: "HERO" },
    ]),
    BikeModel.collection.insertMany([
      { _id: M1, company_id: HONDA, model_name: "SHINE" },
      { _id: M2, company_id: HONDA, model_name: "UNICORN" },
      { _id: M3, company_id: HERO, model_name: "SPLENDOR" },
    ]),
    BikeVariant.collection.insertMany([
      { _id: V1, model_id: M1, variant_name: "STD", engine_cc: 110 },
      { _id: V2, model_id: M2, variant_name: "STD", engine_cc: 150 },
      { _id: V3, model_id: M3, variant_name: "STD", engine_cc: 200 },
    ]),
    UserBike.collection.insertMany([
      { _id: BIKE_A, bike_id: 1, user_id: USER, name: "Shine", model: "SHINE", bike_cc: "110", plate_number: "MP09AA0001", variant_id: V1, status: 1 },
      { _id: BIKE_B, bike_id: 2, user_id: USER, name: "Unicorn", model: "UNICORN", bike_cc: "150", plate_number: "MP09AA0002", variant_id: V2, status: 1 },
      { _id: BIKE_C, bike_id: 3, user_id: USER, name: "Splendor", model: "SPLENDOR", bike_cc: "200", plate_number: "MP09AA0003", variant_id: V3, status: 1 },
    ]),
    Vendor.collection.insertMany([
      bookableDealer(D1),
      bookableDealer(D2),
      bookableDealer(D3),
      // Offline: bookable in every other respect, so it isolates the
      // isDealerBookable() rule.
      bookableDealer(D_OFFLINE, { online: false }),
      // Bookable but ~50 km away, outside its own 5 km radius.
      bookableDealer(D_FAR, { latitude: USER_LAT + 0.45, longitude: USER_LNG }),
    ]),
    BaseService.collection.insertMany(
      [1, 2, 3, 4, 5, 6].map(n => ({
        _id: SVC[n],
        id: n,
        name: `Service ${n}`,
        image: "img.png",
        description: `d${n}`,
        basePrice: 100 * n,
        duration: 30,
        pickupAvailable: false,
        warranty: false,
        isActive: true,
      })),
    ),
  ]);

  // Bike A → services 1,2 · Bike B → 2,3 · Bike C → 4,5 · nobody → 6
  await AdminService.collection.insertMany([
    { serviceId: "T-001", base_service_id: SVC[1], dealer_id: D1, companies: [HONDA], bikes: [{ model_id: M1, variant_id: V1, cc: 110, price: 500 }], isActive: true },
    { serviceId: "T-002", base_service_id: SVC[2], dealer_id: D1, companies: [HONDA], bikes: [{ model_id: M1, variant_id: V1, cc: 110, price: 600 }, { model_id: M2, variant_id: V2, cc: 150, price: 700 }], isActive: true },
    { serviceId: "T-003", base_service_id: SVC[3], dealer_id: D2, companies: [HONDA], bikes: [{ model_id: M2, variant_id: V2, cc: 150, price: 800 }], isActive: true },
    { serviceId: "T-004", base_service_id: SVC[4], dealer_id: D2, companies: [HERO], bikes: [{ model_id: M3, variant_id: V3, cc: 200, price: 900 }], isActive: true },
    { serviceId: "T-005", base_service_id: SVC[5], dealer_id: D3, companies: [HERO], bikes: [{ model_id: M3, variant_id: V3, cc: 200, price: 1000 }], isActive: true },
    // Service 6 exists only at an OFFLINE dealer and at a FAR one: it must
    // never appear, even though its BaseService row is perfectly active.
    { serviceId: "T-006", base_service_id: SVC[6], dealer_id: D_OFFLINE, companies: [HONDA], bikes: [{ model_id: M1, variant_id: V1, cc: 110, price: 200 }], isActive: true },
    { serviceId: "T-007", base_service_id: SVC[6], dealer_id: D_FAR, companies: [HONDA], bikes: [{ model_id: M1, variant_id: V1, cc: 110, price: 200 }], isActive: true },
  ]);
}

async function run() {
  await seed();
  // Mongoose can lazily issue createIndex on the first model operation. Keep
  // that one-time setup outside the query-count window below.
  await Vendor.init();

  const here = { lat: USER_LAT, lng: USER_LNG };

  // ── 1. NO SAVED BIKE ──────────────────────────────────────────────────────
  // Anonymous discovery: no compatibility filter, but provider availability
  // still applies — service 6's only providers are offline / out of range.
  const anon = await call(serviceController.listByCategory, req(here));
  assert.deepStrictEqual(names(anon), ["Service 1", "Service 2", "Service 3", "Service 4", "Service 5"]);
  assert.strictEqual(anon.meta.bikeMatched, false);
  assert.strictEqual(anon.meta.bikeCount, 0);

  // ── 2. ONE SAVED BIKE ─────────────────────────────────────────────────────
  const onlyA = await call(serviceController.listByCategory, req({ ...here, bikeId: String(BIKE_A) }, { user_id: String(USER) }));
  assert.deepStrictEqual(names(onlyA), ["Service 1", "Service 2"]);
  assert.strictEqual(onlyA.meta.bikeCount, 1);

  const onlyC = await call(serviceController.listByCategory, req({ ...here, bikeId: String(BIKE_C) }, { user_id: String(USER) }));
  assert.deepStrictEqual(names(onlyC), ["Service 4", "Service 5"]);

  // ── 3. MULTIPLE SAVED BIKES — UNION ───────────────────────────────────────
  // No bikeId at all: the signed-in rider's whole garage is used.
  const union = await call(serviceController.listByCategory, req(here, { user_id: String(USER) }));
  assert.deepStrictEqual(names(union), ["Service 1", "Service 2", "Service 3", "Service 4", "Service 5"]);
  assert.strictEqual(union.meta.bikeCount, 3);
  assert.strictEqual(union.data.length, 5, "union must be de-duplicated");

  const svc2 = union.data.find(s => s.name === "Service 2");
  assert.deepStrictEqual(svc2.eligibleBikeIds.sort(), [String(BIKE_A), String(BIKE_B)].sort());
  assert.deepStrictEqual(union.data.find(s => s.name === "Service 4").eligibleBikeIds, [String(BIKE_C)]);

  // Explicit subset via bikeIds.
  const ab = await call(serviceController.listByCategory, req({ ...here, bikeIds: `${BIKE_A},${BIKE_B}` }, { user_id: String(USER) }));
  assert.deepStrictEqual(names(ab), ["Service 1", "Service 2", "Service 3"]);

  // ── Home feeds agree with the list ────────────────────────────────────────
  const quick = await call(homeController.quickServices, req(here, { user_id: String(USER) }));
  assert.deepStrictEqual(names(quick), ["Service 1", "Service 2", "Service 3", "Service 4", "Service 5"]);
  assert.strictEqual(quick.meta.bikeCount, 3);
  // Card price is the cheapest across the bikes that service can be booked for.
  assert.strictEqual(quick.data.find(s => s.name === "Service 2").basePrice, 600);

  const rec = await call(homeController.recommended, req(here, { user_id: String(USER) }));
  assert.deepStrictEqual(names(rec), ["Service 1", "Service 2", "Service 3", "Service 4", "Service 5"]);

  const garages = await call(homeController.topGarages, req(here, { user_id: String(USER) }));
  // D_OFFLINE and D_FAR are never offered; D1/D2/D3 all serve a saved bike.
  assert.deepStrictEqual(
    garages.data.map(g => String(g.dealerId)).sort(),
    [String(D1), String(D2), String(D3)].sort(),
  );

  // A rider with only bike A sees only the garages that can serve bike A.
  const garagesA = await call(homeController.topGarages, req({ ...here, bikeId: String(BIKE_A) }, { user_id: String(USER) }));
  assert.deepStrictEqual(garagesA.data.map(g => String(g.dealerId)), [String(D1)]);

  // ── 4. PROVIDER SELECTION — ONE SELECTED BIKE ─────────────────────────────
  const forB = await call(serviceController.garagesForService, req({ ...here, bikeId: String(BIKE_B) }, { params: { id: String(SVC[2]) }, user_id: String(USER) }));
  assert.deepStrictEqual(forB.data.map(g => String(g.dealerId)), [String(D1)]);
  assert.strictEqual(forB.data[0].price, 700);
  assert.strictEqual(forB.meta.bikeMatched, true);

  // Service 3 is bike B's; bike A must get an honest empty list, not D2 anyway.
  const forA = await call(serviceController.garagesForService, req({ ...here, bikeId: String(BIKE_A) }, { params: { id: String(SVC[3]) }, user_id: String(USER) }));
  assert.deepStrictEqual(forA.data, []);
  assert.match(forA.message, /No garages found/);

  // Detail screen's providerCount/fromPrice agree with that list.
  const detailB = await call(serviceController.getServiceById, req({ ...here, bikeId: String(BIKE_B) }, { params: { id: String(SVC[2]) }, user_id: String(USER) }));
  assert.strictEqual(detailB.data.providerCount, 1);
  assert.strictEqual(detailB.data.fromPrice, 700);

  const detailA = await call(serviceController.getServiceById, req({ ...here, bikeId: String(BIKE_A) }, { params: { id: String(SVC[3]) }, user_id: String(USER) }));
  assert.strictEqual(detailA.data.providerCount, 0);
  assert.strictEqual(detailA.data.fromPrice, null);

  // Legacy variant_id path still works for clients that don't send bikeId.
  const legacy = await call(serviceController.garagesForService, req({ ...here, variant_id: String(V1) }, { params: { id: String(SVC[2]) } }));
  assert.deepStrictEqual(legacy.data.map(g => String(g.dealerId)), [String(D1)]);
  assert.strictEqual(legacy.data[0].price, 600);

  // ── Towing ────────────────────────────────────────────────────────────────
  // Nobody tows yet, so a towing-required booking has no providers at all.
  const towing = await call(serviceController.garagesForService, req({ ...here, bikeId: String(BIKE_B), towingRequired: "true" }, { params: { id: String(SVC[2]) }, user_id: String(USER) }));
  assert.deepStrictEqual(towing.data, []);

  await Vendor.collection.updateOne({ _id: D1 }, { $set: { providesTowing: true, towingCharges: 250 } });
  const towingNow = await call(serviceController.garagesForService, req({ ...here, bikeId: String(BIKE_B), towingRequired: "true" }, { params: { id: String(SVC[2]) }, user_id: String(USER) }));
  assert.deepStrictEqual(towingNow.data.map(g => String(g.dealerId)), [String(D1)]);
  assert.strictEqual(towingNow.data[0].towingCharges, 250);

  // ── 8. LOCATION / RADIUS ──────────────────────────────────────────────────
  // ~100 km out, inside nobody's radius → nothing, never a fallback.
  const faraway = await call(serviceController.listByCategory, req({ lat: USER_LAT + 0.9, lng: USER_LNG }, { user_id: String(USER) }));
  assert.deepStrictEqual(faraway.data, []);

  // Standing on D_FAR's doorstep, only D_FAR's service shows: D1/D2/D3 are
  // ~50 km away and their own 5 km radius does not reach here.
  const atFar = await call(serviceController.listByCategory, req({ lat: USER_LAT + 0.45, lng: USER_LNG }, { user_id: String(USER) }));
  assert.deepStrictEqual(names(atFar), ["Service 6"]);

  // Reach is per-dealer, not global: ~8 km from D_FAR is outside its 5 km
  // radius, and widening that one dealer's radius is what brings it back.
  const EIGHT_KM = 0.072;
  const nearFarQuery = { lat: USER_LAT + 0.45 + EIGHT_KM, lng: USER_LNG };
  assert.deepStrictEqual((await call(serviceController.listByCategory, req(nearFarQuery, { user_id: String(USER) }))).data, []);
  await Vendor.collection.updateOne({ _id: D_FAR }, { $set: { serviceRadiusKm: 10 } });
  assert.deepStrictEqual(names(await call(serviceController.listByCategory, req(nearFarQuery, { user_id: String(USER) }))), ["Service 6"]);

  // Malformed coordinates are rejected, not silently widened to the network.
  const bad = res();
  await serviceController.listByCategory(req({ lat: "abc", lng: "def" }), bad);
  assert.strictEqual(bad.captured.code, 400);

  // ── 10. NO N+1 ────────────────────────────────────────────────────────────
  // Query cost must be flat in the number of bikes, services and dealers.
  // Measured here, then re-measured after tripling the dealers and the
  // services they offer: the counts have to be identical.
  const measure = handler => countQueries(() => call(handler, req(here, { user_id: String(USER) })));

  const before = {
    list: await measure(serviceController.listByCategory),
    quick: await measure(homeController.quickServices),
    recommended: await measure(homeController.recommended),
    topGarages: await measure(homeController.topGarages),
  };

  // Nothing may issue one query per service or per dealer.
  Object.entries(before).forEach(([name, ops]) => {
    assert.ok(ops.length <= 10, `${name} issued ${ops.length} queries: ${ops.join(", ")}`);
  });
  if (process.env.PRINT_QUERY_PLAN) {
    Object.entries(before).forEach(([name, ops]) => console.log(`  ${name}: ${ops.length} — ${ops.join(", ")}`));
  }

  // Triple the data: 10 more bookable dealers, each offering all five services.
  const extraDealers = [];
  const extraServices = [];
  for (let i = 0; i < 10; i++) {
    const dealerId = id(200 + i);
    extraDealers.push(bookableDealer(dealerId));
    [1, 2, 3, 4, 5].forEach(n => {
      extraServices.push({
        serviceId: `X-${i}-${n}`,
        base_service_id: SVC[n],
        dealer_id: dealerId,
        companies: [HONDA, HERO],
        bikes: [
          { model_id: M1, variant_id: V1, cc: 110, price: 500 + n },
          { model_id: M2, variant_id: V2, cc: 150, price: 600 + n },
          { model_id: M3, variant_id: V3, cc: 200, price: 700 + n },
        ],
        isActive: true,
      });
    });
  }
  await Vendor.collection.insertMany(extraDealers);
  await AdminService.collection.insertMany(extraServices);

  // Same services, many more providers — and the same number of queries.
  const grown = await call(serviceController.listByCategory, req(here, { user_id: String(USER) }));
  assert.deepStrictEqual(names(grown), ["Service 1", "Service 2", "Service 3", "Service 4", "Service 5"]);
  assert.strictEqual(grown.data.find(s => s.name === "Service 1").providerCount, 11);

  const after = {
    list: await measure(serviceController.listByCategory),
    quick: await measure(homeController.quickServices),
    recommended: await measure(homeController.recommended),
    topGarages: await measure(homeController.topGarages),
  };

  Object.keys(before).forEach(name => {
    assert.strictEqual(
      after[name].length,
      before[name].length,
      `${name} query count grew with the data: ${before[name].length} -> ${after[name].length}\n  ${after[name].join("\n  ")}`,
    );
  });

  // ── 7. ZERO RESULT ────────────────────────────────────────────────────────
  // Take every dealer offline: honest empty everywhere, no catalog fallback.
  await Vendor.collection.updateMany({}, { $set: { online: false } });
  assert.deepStrictEqual((await call(serviceController.listByCategory, req(here, { user_id: String(USER) }))).data, []);
  assert.deepStrictEqual((await call(homeController.quickServices, req(here, { user_id: String(USER) }))).data, []);
  assert.deepStrictEqual((await call(homeController.recommended, req(here, { user_id: String(USER) }))).data, []);
  assert.deepStrictEqual((await call(homeController.mostBooked, req(here, { user_id: String(USER) }))).data, []);
  assert.deepStrictEqual((await call(homeController.topGarages, req(here, { user_id: String(USER) }))).data, []);
}

(async () => {
  try {
    await mongoose.connect(TEST_URL, { serverSelectionTimeoutMS: 2000 });
  } catch (err) {
    console.log(`serviceEligibility.integration.test.js — SKIPPED (no mongod at ${TEST_URL})`);
    process.exit(0);
  }

  try {
    await mongoose.connection.dropDatabase();
    await run();
    console.log("serviceEligibility.integration.test.js — all assertions passed");
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
