const assert = require("assert");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Vendor = require("../models/dealerModel");
const Admin = require("../models/admin_model");
const CustomerModel = require("../models/customer_model");
const { requireBookingParticipant, requireActorRole } = require("../middlewares/bookingAuth");
const {
  PICKUP_STATUSES,
  ARRIVAL_RADIUS_METERS,
  PICKUP_OTP_TTL_MS,
  isPickupBooking,
  distanceToPickupMeters,
  canMarkArrived,
  canStartPickup,
  canMarkCustomerArrived,
  shouldRecordNearby,
  pickupOtpMatches,
  pickupOtpIsExpired,
  canVerifyPickupOtp,
  canRegeneratePickupOtp,
  canCompleteBikePickup,
  pickupLocationSocketPayload,
  garageLocation,
  deliveryLocation,
  canStartDelivery,
  canPublishDeliveryLocation,
  validGpsCapture,
  canTransitionDuringGarageTransport,
} = require("../services/pickupLifecycle");

const CUSTOMER = new mongoose.Types.ObjectId();
const DEALER = new mongoose.Types.ObjectId();
const WRONG_DEALER = new mongoose.Types.ObjectId();
const BOOKING = new mongoose.Types.ObjectId();

async function authorizationResult(actorId, userType = 3, requiredRole = "dealer") {
  const oldSecret = process.env.JWT_SECRET;
  const oldVendorFind = Vendor.findById;
  const oldAdminFind = Admin.findById;
  const oldBookingFind = Booking.findById;
  const oldCustomerExists = CustomerModel.exists;
  process.env.JWT_SECRET = "pickup-lifecycle-test-secret";

  Vendor.findById = () => ({
    select: () => ({ lean: async () => ({ _id: actorId, isBlocked: false }) }),
  });
  Admin.findById = () => ({ select: () => ({ lean: async () => null }) });
  Booking.findById = () => ({
    select: () => ({ lean: async () => ({ user_id: CUSTOMER, dealer_id: DEALER }) }),
  });
  CustomerModel.exists = async () => true;

  const req = {
    headers: { authorization: `Bearer ${jwt.sign({ user_id: String(actorId), user_type: userType }, process.env.JWT_SECRET)}` },
    params: { bookingId: String(BOOKING) },
  };
  let result = null;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { result = { statusCode: this.statusCode, payload }; return this; },
  };

  await requireBookingParticipant(r => r.params.bookingId)(req, res, () => {
    requireActorRole(requiredRole)(req, res, () => { result = { next: true }; });
  });

  Vendor.findById = oldVendorFind;
  Admin.findById = oldAdminFind;
  Booking.findById = oldBookingFind;
  CustomerModel.exists = oldCustomerExists;
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
  return result;
}

async function run() {
  const confirmedPickup = {
    transportOption: "PICKUP_ONLY",
    status: "confirmed",
    pickupStatus: PICKUP_STATUSES.BOOKING_CONFIRMED,
  };
  assert.strictEqual(isPickupBooking(confirmedPickup), true);
  assert.strictEqual(canStartPickup(confirmedPickup), true, "confirmed pickup can start");
  const garage = { dealer_id: { latitude: 17.4, longitude: 78.5 } };
  assert.deepStrictEqual(garageLocation(garage), { latitude: 17.4, longitude: 78.5 });
  assert.strictEqual(garageLocation({ dealer_id: { latitude: null, longitude: null } }), null, "missing garage coordinates are never invented");
  const deliveryBooking = {
    status: "ready_for_delivery", deliveryOtp: 4321, payment_status: "completed", billStatus: "paid", deliveryTransportStatus: "NOT_STARTED",
    transportOption: "PICKUP_ONLY", pickupStatus: PICKUP_STATUSES.BIKE_PICKED_UP,
    pickupAndDropId: { user_lat: 12.9716, user_lng: 77.5946, user_id: CUSTOMER, dealer_id: DEALER, status: 1 },
    user_id: CUSTOMER, dealer_id: { _id: DEALER, latitude: 17.4, longitude: 78.5 }, garageTransportStatus: "ARRIVED_AT_GARAGE",
  };
  assert.deepStrictEqual(deliveryLocation(deliveryBooking), { latitude: 12.9716, longitude: 77.5946 });
  assert.strictEqual(canStartDelivery(deliveryBooking), true, "eligible paid pickup booking can start delivery after garage arrival");
  assert.strictEqual(canStartDelivery({ ...deliveryBooking, garageTransportStatus: "TO_GARAGE" }), false, "delivery cannot start during garage transport");
  assert.strictEqual(canStartDelivery({ ...deliveryBooking, garageTransportStatus: "NOT_STARTED", garageTransportStartedAt: new Date() }), false, "a started garage leg must complete before delivery");
  assert.strictEqual(canStartDelivery({ ...deliveryBooking, garageTransportStatus: "NOT_STARTED", garageTransportStartedAt: null }), true, "legacy bookings with no garage leg state retain delivery compatibility");
  assert.strictEqual(canStartDelivery({ ...deliveryBooking, deliveryOtp: null }), false, "delivery cannot start before existing payment flow issues the OTP");
  assert.strictEqual(canStartDelivery({ ...deliveryBooking, pickupAndDropId: { user_lat: null, user_lng: null } }), false, "missing destination coordinates are not inferred");
  assert.strictEqual(canStartDelivery({ ...deliveryBooking, pickupAndDropId: { ...deliveryBooking.pickupAndDropId, user_id: WRONG_DEALER } }), false, "destination record must belong to booking customer");
  assert.strictEqual(canPublishDeliveryLocation({ ...deliveryBooking, deliveryTransportStatus: "OUT_FOR_DELIVERY" }), true);
  assert.strictEqual(canPublishDeliveryLocation({ ...deliveryBooking, status: "cancelled", deliveryTransportStatus: "OUT_FOR_DELIVERY" }), false, "cancelled booking cannot publish GPS");
  assert.strictEqual(canPublishDeliveryLocation({ ...deliveryBooking, deliveryTransportStatus: "ARRIVED_AT_CUSTOMER" }), false, "arrival ends live GPS publishing");
  const captureTime = new Date();
  assert.strictEqual(validGpsCapture({ accuracy: 25, capturedAt: captureTime.toISOString() }, captureTime), true);
  assert.strictEqual(validGpsCapture({ accuracy: 101, capturedAt: captureTime.toISOString() }, captureTime), false, "inaccurate GPS is rejected");
  assert.strictEqual(validGpsCapture({ accuracy: 25, capturedAt: new Date(captureTime.getTime() - 121000).toISOString() }, captureTime), false, "stale GPS is rejected");
  assert.strictEqual(validGpsCapture({ accuracy: 25, capturedAt: new Date(captureTime.getTime() + 11000).toISOString() }, captureTime), false, "future GPS is rejected");
  assert.strictEqual(validGpsCapture({ accuracy: null, capturedAt: captureTime.toISOString() }, captureTime), false, "missing GPS accuracy is rejected");
  assert.strictEqual(canTransitionDuringGarageTransport({ garageTransportStatus: "TO_GARAGE" }, "awaiting_payment"), false);
  assert.strictEqual(canTransitionDuringGarageTransport({ garageTransportStatus: "TO_GARAGE" }, "confirmed"), true);
  assert.strictEqual(canTransitionDuringGarageTransport({ garageTransportStatus: "ARRIVED_AT_GARAGE" }, "awaiting_payment"), true);

  const normalBooking = {
    transportOption: "SELF_VISIT",
    status: "confirmed",
    pickupStatus: "pending",
  };
  assert.strictEqual(isPickupBooking(normalBooking), false, "non-pickup booking is rejected");
  assert.strictEqual(canStartPickup(normalBooking), false);
  assert.strictEqual(canMarkCustomerArrived(normalBooking), true, "confirmed self-visit can arrive");
  assert.strictEqual(
    canMarkCustomerArrived({ ...normalBooking, pickupStatus: "arrived" }),
    false,
    "self-visit arrival cannot be repeated as a new transition",
  );

  const livePayload = pickupLocationSocketPayload({
    bookingId: BOOKING,
    pickupStatus: PICKUP_STATUSES.PICKUP_STARTED,
    location: { latitude: 12.9716, longitude: 77.5946, accuracy: 8, heading: 241, capturedAt: new Date("2026-09-18T09:59:58.000Z") },
    updatedAt: new Date("2026-09-18T10:00:00.000Z"),
    distanceMeters: 125.6,
  });
  assert.strictEqual(livePayload.bookingId, String(BOOKING));
  assert.strictEqual(livePayload.distanceMeters, 126);
  assert.strictEqual(livePayload.nearby, false);
  assert.strictEqual(livePayload.location.accuracy, 8);
  assert.strictEqual(livePayload.location.heading, 241);
  assert.strictEqual(livePayload.location.capturedAt.toISOString(), "2026-09-18T09:59:58.000Z");
  assert.strictEqual(livePayload.dealer, undefined, "location event exposes no dealer PII");
  assert.strictEqual(canMarkCustomerArrived(confirmedPickup), false, "pickup booking must use GPS arrival");
  assert.strictEqual(isPickupBooking({ transportOption: "DROP_ONLY", pickupAndDropId: BOOKING }), false);

  assert.deepStrictEqual(await authorizationResult(DEALER), { next: true });
  assert.strictEqual((await authorizationResult(WRONG_DEALER)).statusCode, 404, "wrong dealer cannot modify booking");
  assert.strictEqual((await authorizationResult(CUSTOMER, 4)).statusCode, 403, "customer cannot trigger pickup actions");
  assert.deepStrictEqual(
    await authorizationResult(CUSTOMER, 4, "customer"),
    { next: true },
    "assigned customer can retrieve the arrived pickup OTP"
  );
  assert.strictEqual(
    (await authorizationResult(DEALER, 3, "customer")).statusCode,
    403,
    "dealer cannot retrieve the customer pickup OTP"
  );

  const customerLocation = { latitude: 12.9716, longitude: 77.5946 };
  const over100m = distanceToPickupMeters({ latitude: 12.9730, longitude: 77.5946 }, customerLocation);
  const within100m = distanceToPickupMeters({ latitude: 12.9720, longitude: 77.5946 }, customerLocation);
  assert(over100m > ARRIVAL_RADIUS_METERS, "arrival is blocked above 100m");
  assert(within100m <= ARRIVAL_RADIUS_METERS, "arrival is allowed within 100m");
  assert.strictEqual(canMarkArrived(PICKUP_STATUSES.PICKUP_STARTED), true);
  assert.strictEqual(canMarkArrived(PICKUP_STATUSES.RIDER_NEARBY), true);
  assert.strictEqual(canMarkArrived(PICKUP_STATUSES.ARRIVED), false, "duplicate arrival is rejected");

  const started = { pickupStatus: PICKUP_STATUSES.PICKUP_STARTED, pickupNearbyNotifiedAt: null };
  assert.strictEqual(shouldRecordNearby(started, within100m), true);
  assert.strictEqual(
    shouldRecordNearby({ ...started, pickupNearbyNotifiedAt: new Date() }, within100m),
    false,
    "nearby notification is emitted only once"
  );

  assert.strictEqual(pickupOtpMatches(4321, "9999"), false, "invalid OTP is rejected");
  assert.strictEqual(pickupOtpMatches(4321, "4321"), true, "valid OTP is accepted");
  assert.strictEqual(pickupOtpMatches(null, "4321"), false, "consumed OTP cannot be reused");
  assert.strictEqual(
    pickupOtpIsExpired(
      { pickupOtpExpiresAt: new Date("2026-09-18T09:59:59.000Z") },
      new Date("2026-09-18T10:00:00.000Z")
    ),
    true,
    "expired pickup OTP is rejected"
  );
  assert.strictEqual(
    pickupOtpIsExpired(
      { pickupOtpExpiresAt: new Date("2026-09-18T10:15:00.000Z") },
      new Date("2026-09-18T10:00:00.000Z")
    ),
    false
  );
  assert.strictEqual(PICKUP_OTP_TTL_MS, 15 * 60 * 1000);
  assert.strictEqual(
    canVerifyPickupOtp({ pickupStatus: PICKUP_STATUSES.ARRIVED, pickupOtp: 4321, pickupOtpVerifiedAt: null }, "4321"),
    true
  );
  assert.strictEqual(
    canRegeneratePickupOtp({ pickupStatus: PICKUP_STATUSES.ARRIVED, pickupOtpVerifiedAt: null }),
    true,
    "an unverified arrived pickup can regenerate its OTP"
  );
  assert.strictEqual(
    canRegeneratePickupOtp({ pickupStatus: PICKUP_STATUSES.PICKUP_OTP_VERIFIED, pickupOtpVerifiedAt: new Date() }),
    false,
    "a verified pickup cannot regenerate its OTP"
  );
  assert.strictEqual(
    canVerifyPickupOtp({
      pickupStatus: PICKUP_STATUSES.ARRIVED,
      pickupOtp: 4321,
      pickupOtpVerifiedAt: null,
      pickupOtpExpiresAt: new Date(Date.now() - 1000),
    }, "4321"),
    false,
    "a matching but expired OTP is rejected"
  );
  assert.strictEqual(
    canCompleteBikePickup({ pickupStatus: PICKUP_STATUSES.PICKUP_OTP_VERIFIED, pickupOtpVerifiedAt: new Date() }),
    true,
    "valid OTP enables bike pickup completion"
  );
  assert.strictEqual(
    canCompleteBikePickup({ pickupStatus: PICKUP_STATUSES.ARRIVED, pickupOtpVerifiedAt: null }),
    false
  );
  assert.strictEqual(
    canCompleteBikePickup({ pickupStatus: PICKUP_STATUSES.BIKE_PICKED_UP, pickupOtpVerifiedAt: new Date() }),
    false,
    "duplicate pickup completion is rejected"
  );

  assert.strictEqual(
    canStartPickup({ ...confirmedPickup, pickupStatus: PICKUP_STATUSES.PICKUP_STARTED }),
    false,
    "duplicate start is rejected"
  );

  const normalDoc = new Booking({
    user_id: CUSTOMER,
    dealer_id: DEALER,
    userBike_id: new mongoose.Types.ObjectId(),
    transportOption: "SELF_VISIT",
    pickupStatus: "pending",
  });
  assert.strictEqual(normalDoc.validateSync(), undefined, "normal non-pickup booking schema remains valid");
  assert.strictEqual(normalDoc.pickupTrackingActive, false);
  assert.strictEqual(normalDoc.pickupOtp, null);
  assert.strictEqual(
    Booking.schema.path("pickupOtp").options.select,
    false,
    "pickup OTP is excluded from ordinary booking responses"
  );
  assert.strictEqual(
    Booking.schema.path("pickupOtpExpiresAt").options.select,
    false,
    "pickup OTP expiry metadata is excluded from ordinary booking responses"
  );

  console.log("Pickup lifecycle tests passed");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
