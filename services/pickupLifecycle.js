const { calculateDistanceKm } = require("../v1-api/helpers/geoAndRatings");

const PICKUP_STATUSES = Object.freeze({
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  PICKUP_STARTED: "PICKUP_STARTED",
  RIDER_NEARBY: "RIDER_NEARBY",
  ARRIVED: "ARRIVED",
  PICKUP_OTP_VERIFIED: "PICKUP_OTP_VERIFIED",
  BIKE_PICKED_UP: "BIKE_PICKED_UP",
});

const PICKUP_TRANSPORT_OPTIONS = new Set(["PICKUP_ONLY", "PICKUP_AND_DROP"]);
const ARRIVAL_RADIUS_METERS = 100;
const MAX_GARAGE_GPS_ACCURACY_METERS = 100;
const MAX_GPS_AGE_MS = 120000;
const PICKUP_OTP_TTL_MS = 15 * 60 * 1000;

function isPickupBooking(booking) {
  if (!booking) return false;
  if (PICKUP_TRANSPORT_OPTIONS.has(booking.transportOption)) return true;
  if (booking.transportOption === "DROP_ONLY") return false;
  // Old rows predate transportOption; Mongoose may materialize its SELF_VISIT
  // default when reading them, so pickupAndDropId is the compatibility signal
  // only when there is no modern pricing snapshot.
  if (booking.transportOption === "SELF_VISIT") {
    return Boolean(booking.pickupAndDropId && booking.priceSnapshotAt == null);
  }
  return Boolean(booking.pickupAndDropId);
}

function normalizeLocation(input = {}) {
  const source = input.location && typeof input.location === "object" ? input.location : input;
  const latitude = Number(source.latitude ?? source.lat);
  const longitude = Number(source.longitude ?? source.lng);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function pickupLocation(booking) {
  const pickup = booking?.pickupAndDropId;
  const latitude = Number(pickup?.user_lat);
  const longitude = Number(pickup?.user_lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function distanceToPickupMeters(riderLocation, customerLocation) {
  if (!riderLocation || !customerLocation) return null;
  return (
    calculateDistanceKm(
      riderLocation.latitude,
      riderLocation.longitude,
      customerLocation.latitude,
      customerLocation.longitude
    ) * 1000
  );
}

function garageLocation(booking) {
  if (booking?.dealer_id?.latitude == null || booking?.dealer_id?.longitude == null) return null;
  const latitude = Number(booking?.dealer_id?.latitude);
  const longitude = Number(booking?.dealer_id?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function deliveryLocation(booking) {
  const point = booking?.pickupAndDropId;
  if (point?.user_lat == null || point?.user_lng == null || point?.user_lat === "" || point?.user_lng === "") return null;
  const latitude = Number(point?.user_lat);
  const longitude = Number(point?.user_lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function canStartDelivery(booking) {
  const point = booking?.pickupAndDropId;
  const sameRecordOwner = point && typeof point === "object" && point.user_id != null
    ? String(point.user_id?._id || point.user_id) === String(booking.user_id?._id || booking.user_id) &&
      String(point.dealer_id?._id || point.dealer_id) === String(booking.dealer_id?._id || booking.dealer_id) && Number(point.status) === 1
    : true;
  return Boolean(booking && booking.status === "ready_for_delivery" && booking.deliveryOtp != null &&
    booking.payment_status === "completed" && booking.billStatus === "paid" &&
    [undefined, null, "NOT_STARTED"].includes(booking.deliveryTransportStatus) &&
    (booking.garageTransportStatus !== "TO_GARAGE") &&
    (booking.garageTransportStartedAt == null || booking.garageTransportStatus === "ARRIVED_AT_GARAGE") &&
    sameRecordOwner && deliveryLocation(booking));
}

function canPublishDeliveryLocation(booking) {
  return Boolean(booking?.status === "ready_for_delivery" && booking.payment_status === "completed" && booking.billStatus === "paid" && booking.deliveryOtp != null && booking.deliveryTransportStatus === "OUT_FOR_DELIVERY");
}

function validGpsCapture(body = {}, now = new Date()) {
  if (body.accuracy == null || body.capturedAt == null) return false;
  const accuracy = Number(body.accuracy);
  const capturedAt = new Date(body.capturedAt);
  const age = now.getTime() - capturedAt.getTime();
  return Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= MAX_GARAGE_GPS_ACCURACY_METERS &&
    Number.isFinite(capturedAt.getTime()) && age >= -10000 && age <= MAX_GPS_AGE_MS;
}

function canTransitionDuringGarageTransport(booking, nextStatus) {
  if (booking?.garageTransportStatus !== "TO_GARAGE") return true;
  return nextStatus === "confirmed" || ["cancelled", "user_cancelled"].includes(nextStatus);
}

function canMarkArrived(status) {
  return [PICKUP_STATUSES.PICKUP_STARTED, PICKUP_STATUSES.RIDER_NEARBY].includes(status);
}

function canStartPickup(booking) {
  return Boolean(
    isPickupBooking(booking) &&
      booking.status === "confirmed" &&
      [PICKUP_STATUSES.BOOKING_CONFIRMED, "pending"].includes(booking.pickupStatus)
  );
}

function canMarkCustomerArrived(booking) {
  return Boolean(
    booking &&
      !isPickupBooking(booking) &&
      booking.status === "confirmed" &&
      booking.pickupStatus === "pending"
  );
}

function shouldRecordNearby(booking, distanceMeters) {
  return Boolean(
    booking?.pickupStatus === PICKUP_STATUSES.PICKUP_STARTED &&
      booking.pickupNearbyNotifiedAt == null &&
      Number.isFinite(distanceMeters) &&
      distanceMeters <= ARRIVAL_RADIUS_METERS
  );
}

function pickupOtpMatches(storedOtp, incomingOtp) {
  const incoming = String(incomingOtp ?? "").trim();
  return storedOtp != null && /^\d{4}$/.test(incoming) && String(storedOtp) === incoming;
}

function pickupOtpIsExpired(booking, now = new Date()) {
  if (!booking?.pickupOtpExpiresAt) return false;
  return new Date(booking.pickupOtpExpiresAt).getTime() <= new Date(now).getTime();
}

function canVerifyPickupOtp(booking, incomingOtp) {
  return Boolean(
      booking?.pickupStatus === PICKUP_STATUSES.ARRIVED &&
      booking.pickupOtpVerifiedAt == null &&
      !pickupOtpIsExpired(booking) &&
      pickupOtpMatches(booking.pickupOtp, incomingOtp)
  );
}

function canRegeneratePickupOtp(booking) {
  return Boolean(
    booking?.pickupStatus === PICKUP_STATUSES.ARRIVED &&
      booking.pickupOtpVerifiedAt == null
  );
}

function canCompleteBikePickup(booking) {
  return Boolean(
    booking?.pickupStatus === PICKUP_STATUSES.PICKUP_OTP_VERIFIED &&
      booking.pickupOtpVerifiedAt
  );
}

function pickupLocationSocketPayload({ bookingId, pickupStatus, location, updatedAt, distanceMeters }) {
  return {
    bookingId: String(bookingId),
    pickupStatus,
    pickupTrackingActive: true,
    location: {
      latitude: location.latitude,
      longitude: location.longitude,
      ...(Number.isFinite(Number(location.heading)) ? { heading: Number(location.heading) } : {}),
      ...(Number.isFinite(Number(location.accuracy)) ? { accuracy: Number(location.accuracy) } : {}),
      ...(location.capturedAt ? { capturedAt: location.capturedAt } : {}),
      updatedAt,
    },
    distanceMeters: Math.round(distanceMeters),
    nearby: distanceMeters <= ARRIVAL_RADIUS_METERS,
  };
}

module.exports = {
  PICKUP_STATUSES,
  ARRIVAL_RADIUS_METERS,
  MAX_GARAGE_GPS_ACCURACY_METERS,
  MAX_GPS_AGE_MS,
  PICKUP_OTP_TTL_MS,
  isPickupBooking,
  normalizeLocation,
  pickupLocation,
  distanceToPickupMeters,
  garageLocation,
  deliveryLocation,
  canStartDelivery,
  canPublishDeliveryLocation,
  validGpsCapture,
  canTransitionDuringGarageTransport,
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
};
