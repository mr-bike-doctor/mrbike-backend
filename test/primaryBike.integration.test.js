// Primary-bike transaction checks against an explicitly local throwaway replica set.
const assert = require("assert");
const mongoose = require("mongoose");
const Customer = require("../models/customer_model");
const UserBike = require("../models/userBikeModel");
const Booking = require("../models/Booking");
const primary = require("../services/primaryBikeService");
const customersController = require("../controller/customers");
const jwt = require("jsonwebtoken");

const url = process.env.TEST_MONGO_URL || "mongodb://127.0.0.1:27027/mrbike_primary_bike_test?replicaSet=rs0";
const oid = () => new mongoose.Types.ObjectId();
const bikeRow = (_id, user_id, plate_number, status, createdAt) => ({
  _id, user_id, name: "Test bike", model: "Test model", bike_cc: "100",
  plate_number, variant_id: oid(), status, createdAt,
});

(async () => {
  try {
    await mongoose.connect(url, { serverSelectionTimeoutMS: 1500 });
  } catch (error) {
    console.log(`primaryBike.integration.test.js — skipped (local test MongoDB unavailable: ${error.name})`);
    process.exit(0);
  }
  try {
    assert.ok(Customer.schema.path("primaryBikeId"), "primaryBikeId must be registered on the customer schema");
    await mongoose.connection.dropDatabase();
    const customerA = oid(), customerB = oid(), legacyCustomer = oid();
    const bike1 = oid(), bike2 = oid(), foreignBike = oid(), inactiveBike = oid(), legacyBike = oid();
    await Customer.collection.insertMany([{ _id: customerA }, { _id: customerB }, { _id: legacyCustomer }]);
    const legacyBikeRow = bikeRow(legacyBike, legacyCustomer, "PRIMARY-LEGACY", undefined, new Date("2017-01-01"));
    delete legacyBikeRow.status;
    await UserBike.collection.insertMany([
      bikeRow(bike1, customerA, "PRIMARY-1", 1, new Date("2020-01-01")),
      bikeRow(bike2, customerA, "PRIMARY-2", 1, new Date("2021-01-01")),
      bikeRow(foreignBike, customerB, "PRIMARY-3", 1, new Date("2019-01-01")),
      bikeRow(inactiveBike, customerA, "PRIMARY-4", 0, new Date("2018-01-01")),
      legacyBikeRow,
    ]);

    assert.strictEqual(primary.primaryBikeIdForBikes(await UserBike.find({ user_id: customerA }).lean(), null), String(bike1));
    assert.strictEqual(primary.primaryBikeIdForBikes(await UserBike.find({ user_id: legacyCustomer }).lean(), null), String(legacyBike), "legacy bikes without a status remain active under the existing status contract");
    await primary.setPrimaryBike({ userId: legacyCustomer, bikeId: legacyBike });
    const legacyStatusResponse = { status() { return this; }, json(body) { this.body = body; return this; } };
    await customersController.getMyBikes({ headers: { token: jwt.sign({ user_id: String(legacyCustomer) }, "primary-bike-test") } }, legacyStatusResponse);
    assert.strictEqual(legacyStatusResponse.body.data[0].isPrimary, true, "legacy status-less bike remains visible and primary");
    const bikesResponse = { status() { return this; }, json(body) { this.body = body; return this; } };
    await customersController.getMyBikes({ headers: { token: jwt.sign({ user_id: String(customerA) }, "primary-bike-test") } }, bikesResponse);
    assert.strictEqual(bikesResponse.body.data.filter(bike => bike.isPrimary).length, 1);
    assert.strictEqual(String(bikesResponse.body.data.find(bike => bike.isPrimary)._id), String(bike1), "legacy getMyBikes fallback marks the oldest active bike");
    const originalAggregate = Booking.aggregate;
    Booking.aggregate = () => { throw new Error("injected getMyBikes read failure"); };
    const failedBikesResponse = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await customersController.getMyBikes({ headers: { token: jwt.sign({ user_id: String(customerA) }, "primary-bike-test") } }, failedBikesResponse);
    Booking.aggregate = originalAggregate;
    assert.strictEqual(failedBikesResponse.statusCode, 500, "failed bike refresh must not look like a successful empty list");
    assert.strictEqual(failedBikesResponse.body.success, false);
    await assert.rejects(primary.setPrimaryBike({ userId: customerA, bikeId: foreignBike }), e => e.code === "ACTIVE_OWNED_BIKE_NOT_FOUND");
    await assert.rejects(primary.setPrimaryBike({ userId: customerA, bikeId: inactiveBike }), e => e.code === "ACTIVE_OWNED_BIKE_NOT_FOUND");
    await assert.rejects(primary.setPrimaryBike({ userId: customerA, bikeId: oid() }), e => e.code === "ACTIVE_OWNED_BIKE_NOT_FOUND");

    await primary.setPrimaryBike({ userId: customerA, bikeId: bike2 });
    assert.strictEqual(String((await Customer.findById(customerA).lean()).primaryBikeId), String(bike2));
    await primary.updateCustomerBikeStatus({ userId: customerA, bikeId: bike2, status: 0 });
    assert.strictEqual(String((await Customer.findById(customerA).lean()).primaryBikeId), String(bike1), "deactivating primary selects oldest remaining active bike");
    await primary.updateCustomerBikeStatus({ userId: customerA, bikeId: bike2, status: 1 });
    assert.strictEqual(String((await Customer.findById(customerA).lean()).primaryBikeId), String(bike1), "reactivating another bike does not silently change primary");
    await primary.setPrimaryBike({ userId: customerA, bikeId: bike2 });
    await primary.deleteCustomerBike({ userId: customerA, bikeId: bike2 });
    assert.strictEqual(String((await Customer.findById(customerA).lean()).primaryBikeId), String(bike1));
    await assert.rejects(primary.setPrimaryBike({ userId: customerA, bikeId: bike2 }), e => e.code === "ACTIVE_OWNED_BIKE_NOT_FOUND");
    await primary.deleteCustomerBike({ userId: customerA, bikeId: bike1 });
    assert.strictEqual((await Customer.findById(customerA).lean()).primaryBikeId, null);

    // Concurrent selection and deletion share a customer revision write inside
    // transactions; after retries, no reference may point at the deleted bike.
    await UserBike.collection.insertOne(bikeRow(bike2, customerA, "PRIMARY-2", 1, new Date()));
    const raceResults = await Promise.allSettled([
      primary.setPrimaryBike({ userId: customerA, bikeId: bike2 }),
      primary.deleteCustomerBike({ userId: customerA, bikeId: bike2 }),
    ]);
    assert.strictEqual(raceResults[1].status, "fulfilled", "the concurrent delete commits successfully");
    const finalCustomer = await Customer.findById(customerA).lean();
    const referencedBike = finalCustomer.primaryBikeId && await UserBike.findOne({ _id: finalCustomer.primaryBikeId, user_id: customerA, status: { $ne: 0 } }).lean();
    assert.ok(!finalCustomer.primaryBikeId || referencedBike, "primary reference must be owned and active");

    const bike3 = oid();
    await UserBike.collection.insertMany([
      bikeRow(bike1, customerA, "PRIMARY-1", 1, new Date("2020-01-01")),
      bikeRow(bike3, customerA, "PRIMARY-5", 1, new Date("2022-01-01")),
    ]);
    await Promise.allSettled([
      primary.setPrimaryBike({ userId: customerA, bikeId: bike3 }),
      primary.updateCustomerBikeStatus({ userId: customerA, bikeId: bike3, status: 0 }),
    ]);
    const afterDeactivateRace = await Customer.findById(customerA).lean();
    const activePrimary = afterDeactivateRace.primaryBikeId && await UserBike.findOne({ _id: afterDeactivateRace.primaryBikeId, user_id: customerA, status: { $ne: 0 } }).lean();
    assert.ok(!afterDeactivateRace.primaryBikeId || activePrimary, "concurrent selection and deactivation cannot retain an inactive primary");
    console.log("primaryBike.integration.test.js — all assertions passed");
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
})().catch(error => { console.error(error); process.exit(1); });
