const crypto = require("crypto");
const Booking = require("../models/Booking");
const Customer = require("../models/customer_model");
const { sendBookingNotification } = require("../helper/pushNotification");
const {
  PICKUP_STATUSES,
  ARRIVAL_RADIUS_METERS,
  PICKUP_OTP_TTL_MS,
  isPickupBooking,
  normalizeLocation,
  pickupLocation,
  distanceToPickupMeters,
  canMarkArrived,
  canStartPickup,
  shouldRecordNearby,
  pickupOtpMatches,
  pickupOtpIsExpired,
  canRegeneratePickupOtp,
  canCompleteBikePickup,
  pickupLocationSocketPayload,
  garageLocation,
  deliveryLocation,
  canStartDelivery,
  canPublishDeliveryLocation,
  validGpsCapture,
} = require("../services/pickupLifecycle");

function pickupOtp() {
  return crypto.randomInt(1000, 10000);
}

function locationWasProvided(body = {}) {
  return Boolean(
    body.location ||
      body.latitude !== undefined ||
      body.longitude !== undefined ||
      body.lat !== undefined ||
      body.lng !== undefined
  );
}

async function loadPickupBooking(bookingId) {
  return Booking.findById(bookingId)
    .select("+pickupOtp +pickupOtpExpiresAt")
    .populate("pickupAndDropId", "user_lat user_lng user_id dealer_id status")
    .populate("dealer_id", "latitude longitude shopName");
}

function pickupGuard(res, bookingDoc) {
  if (!bookingDoc) {
    res.status(404).json({ success: false, message: "Booking not found" });
    return false;
  }
  if (!isPickupBooking(bookingDoc)) {
    res.status(400).json({ success: false, message: "This action is only available for PICKUP bookings" });
    return false;
  }
  return true;
}

function locationSet(location, now, body = {}) {
  const set = {
    "pickupCurrentLocation.latitude": location.latitude,
    "pickupCurrentLocation.longitude": location.longitude,
    "pickupCurrentLocation.updatedAt": now,
  };
  const accuracy = Number(body.accuracy);
  const capturedAt = new Date(body.capturedAt);
  const heading = Number(body.heading);
  if (Number.isFinite(accuracy) && accuracy >= 0) set["pickupCurrentLocation.accuracy"] = accuracy;
  if (body.capturedAt != null && Number.isFinite(capturedAt.getTime())) set["pickupCurrentLocation.capturedAt"] = capturedAt;
  if (Number.isFinite(heading) && heading >= 0 && heading <= 360) set["pickupCurrentLocation.heading"] = heading;
  return set;
}

function transportLocationSet(location, body, now) {
  return {
    ...locationSet(location, now),
    "pickupCurrentLocation.accuracy": Number(body.accuracy),
    "pickupCurrentLocation.capturedAt": new Date(body.capturedAt),
    ...(Number.isFinite(Number(body.heading)) && Number(body.heading) >= 0 && Number(body.heading) <= 360
      ? { "pickupCurrentLocation.heading": Number(body.heading) }
      : {}),
  };
}

function newerLocationFilter(body = {}) {
  const capturedAt = new Date(body.capturedAt);
  if (body.capturedAt == null || !Number.isFinite(capturedAt.getTime())) return {};
  return {
    $or: [
      { "pickupCurrentLocation.capturedAt": { $exists: false } },
      { "pickupCurrentLocation.capturedAt": null },
      { "pickupCurrentLocation.capturedAt": { $lte: capturedAt } },
    ],
  };
}

async function notifyCustomer(req, bookingDoc, event, title, body, extraData = {}) {
  // Socket delivery is independent from FCM. A stale/missing device token must
  // never prevent an already-connected customer from receiving the lifecycle
  // update (especially a regenerated OTP notification).
  const io = req.app.get("io");
  if (io) {
    io.to(`booking:${bookingDoc._id}`).emit(`pickup:${event}`, {
      bookingId: String(bookingDoc._id),
      pickupStatus: bookingDoc.pickupStatus,
      garageTransportStatus: bookingDoc.garageTransportStatus || "NOT_STARTED",
      pickupTrackingActive: bookingDoc.pickupTrackingActive,
    });
  }

  try {
    const customer = await Customer.findById(bookingDoc.user_id)
      .select("device_token ftoken")
      .lean();
    await sendBookingNotification({
      token: customer?.device_token || customer?.ftoken,
      title,
      body,
      data: { type: event, bookingId: String(bookingDoc._id), ...extraData },
      receiverId: bookingDoc.user_id,
      receiverType: "user",
      bookingId: bookingDoc._id,
    });
  } catch (error) {
    // Notification delivery must not roll back an already-valid lifecycle transition.
    console.error(`[PICKUP-NOTIFICATION] ${event} failed:`, error.message);
  }
}

async function startPickup(req, res) {
  try {
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (bookingDoc.status !== "confirmed") {
      return res.status(409).json({ success: false, message: "Pickup can start only after booking confirmation" });
    }
    if (!canStartPickup(bookingDoc)) {
      return res.status(409).json({ success: false, message: `Pickup already started or completed (${bookingDoc.pickupStatus})` });
    }

    const provided = locationWasProvided(req.body);
    const location = provided ? normalizeLocation(req.body) : null;
    if (provided && !location) {
      return res.status(400).json({ success: false, message: "Valid rider latitude and longitude are required" });
    }

    const now = new Date();
    const set = {
      pickupStatus: PICKUP_STATUSES.PICKUP_STARTED,
      pickupStartedAt: now,
      pickupTrackingActive: true,
      ...(bookingDoc.pickupOtp == null ? { pickupOtp: pickupOtp() } : {}),
      ...(location ? locationSet(location, now) : {}),
    };
    const updated = await Booking.findOneAndUpdate(
      {
        _id: bookingDoc._id,
        dealer_id: req.auth.id,
        status: "confirmed",
        pickupStatus: { $in: [PICKUP_STATUSES.BOOKING_CONFIRMED, "pending"] },
      },
      { $set: set },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: "Pickup was already started or booking state changed" });
    }

    await notifyCustomer(req, updated, "started", "Pickup Started", "The rider has started towards your pickup location.");
    return res.status(200).json({
      success: true,
      message: "Pickup started",
      data: { bookingId: updated._id, pickupStatus: updated.pickupStatus, pickupStartedAt: updated.pickupStartedAt },
    });
  } catch (error) {
    console.error("startPickup error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function updatePickupLocation(req, res) {
  try {
    const location = normalizeLocation(req.body);
    if (!location) {
      return res.status(400).json({ success: false, message: "Valid rider latitude and longitude are required" });
    }
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (canPublishDeliveryLocation(bookingDoc)) {
      const now = new Date();
      if (!validGpsCapture(req.body, now)) {
        return res.status(422).json({ success: false, message: "A recent GPS location with accuracy within 100 metres is required" });
      }
      const destination = deliveryLocation(bookingDoc);
      if (!destination) return res.status(409).json({ success: false, message: "Customer delivery coordinates are unavailable" });
      const distanceMeters = distanceToPickupMeters(location, destination);
      const saved = await Booking.findOneAndUpdate(
        { _id: bookingDoc._id, dealer_id: req.auth.id, status: "ready_for_delivery", payment_status: "completed", billStatus: "paid", deliveryOtp: { $ne: null }, deliveryTransportStatus: "OUT_FOR_DELIVERY", ...newerLocationFilter(req.body) },
        { $set: transportLocationSet(location, req.body, now) },
        { new: true }
      );
      if (!saved) return res.status(409).json({ success: false, message: "Delivery tracking is no longer active" });
      const payload = {
        bookingId: String(saved._id), deliveryTransportStatus: saved.deliveryTransportStatus,
        trackingActive: true,
        location: { latitude: location.latitude, longitude: location.longitude, accuracy: Number(req.body.accuracy), ...(Number.isFinite(Number(req.body.heading)) ? { heading: Number(req.body.heading) } : {}), updatedAt: now, capturedAt: new Date(req.body.capturedAt) },
        distanceMeters: Math.round(distanceMeters),
      };
      req.app.get("io")?.to(`booking:${saved._id}`).emit("delivery:location", payload);
      return res.status(200).json({ success: true, message: "Delivery location updated", data: payload });
    }
    if (!pickupGuard(res, bookingDoc)) return;
    if (bookingDoc.status !== "confirmed") {
      return res.status(409).json({ success: false, message: "Location updates require a confirmed booking" });
    }
    if (bookingDoc.garageTransportStatus === "TO_GARAGE") {
      const now = new Date();
      if (bookingDoc.pickupStatus !== PICKUP_STATUSES.BIKE_PICKED_UP || !validGpsCapture(req.body, now)) {
        return res.status(422).json({ success: false, message: "A recent GPS location with accuracy within 100 metres is required" });
      }
      const destination = garageLocation(bookingDoc);
      if (!destination) {
        return res.status(409).json({ success: false, message: "Assigned garage coordinates are unavailable" });
      }
      const distanceMeters = distanceToPickupMeters(location, destination);
      const saved = await Booking.findOneAndUpdate(
        { _id: bookingDoc._id, dealer_id: req.auth.id, status: "confirmed", pickupStatus: PICKUP_STATUSES.BIKE_PICKED_UP, garageTransportStatus: "TO_GARAGE", ...newerLocationFilter(req.body) },
        { $set: transportLocationSet(location, req.body, now) },
        { new: true }
      );
      if (!saved) return res.status(409).json({ success: false, message: "Garage transport is no longer active" });
      const payload = {
        bookingId: String(saved._id),
        garageTransportStatus: saved.garageTransportStatus,
        trackingActive: true,
        location: { latitude: location.latitude, longitude: location.longitude, accuracy: Number(req.body.accuracy), ...(Number.isFinite(Number(req.body.heading)) ? { heading: Number(req.body.heading) } : {}), updatedAt: now, capturedAt: new Date(req.body.capturedAt) },
        distanceMeters: Math.round(distanceMeters),
      };
      req.app.get("io")?.to(`booking:${saved._id}`).emit("transport:location", payload);
      return res.status(200).json({ success: true, message: "Garage transport location updated", data: payload });
    }
    if (!bookingDoc.pickupTrackingActive) {
      return res.status(409).json({ success: false, message: "Pickup tracking is not active" });
    }
    if (!validGpsCapture(req.body, new Date())) {
      return res.status(422).json({ success: false, message: "A recent GPS location with accuracy within 100 metres is required" });
    }
    const trackable = [
      PICKUP_STATUSES.PICKUP_STARTED,
      PICKUP_STATUSES.RIDER_NEARBY,
      PICKUP_STATUSES.ARRIVED,
      PICKUP_STATUSES.PICKUP_OTP_VERIFIED,
    ];
    if (!trackable.includes(bookingDoc.pickupStatus)) {
      return res.status(409).json({ success: false, message: `Location cannot be updated in ${bookingDoc.pickupStatus}` });
    }

    const customerLocation = pickupLocation(bookingDoc);
    if (!customerLocation) {
      return res.status(422).json({ success: false, message: "Customer pickup coordinates are unavailable" });
    }
    const distanceMeters = distanceToPickupMeters(location, customerLocation);
    const now = new Date();
    let nearbyFirstRecorded = false;

    if (shouldRecordNearby(bookingDoc, distanceMeters)) {
      const nearbyUpdate = await Booking.findOneAndUpdate(
        {
          _id: bookingDoc._id,
          dealer_id: req.auth.id,
          pickupTrackingActive: true,
          pickupStatus: PICKUP_STATUSES.PICKUP_STARTED,
          pickupNearbyNotifiedAt: null,
          ...newerLocationFilter(req.body),
        },
        {
          $set: {
            ...locationSet(location, now, req.body),
            pickupStatus: PICKUP_STATUSES.RIDER_NEARBY,
            riderNearbyAt: now,
            pickupNearbyNotifiedAt: now,
          },
        },
        { new: true }
      );
      if (nearbyUpdate) {
        nearbyFirstRecorded = true;
        bookingDoc.pickupStatus = nearbyUpdate.pickupStatus;
        await notifyCustomer(req, nearbyUpdate, "nearby", "Rider Nearby", "Your rider is within 100 metres of the pickup location.");
      }
    }

    if (!nearbyFirstRecorded) {
      const savedLocation = await Booking.updateOne(
        { _id: bookingDoc._id, dealer_id: req.auth.id, pickupTrackingActive: true, ...newerLocationFilter(req.body) },
        { $set: locationSet(location, now, req.body) }
      );
      if (!savedLocation.matchedCount) {
        return res.status(409).json({ success: false, message: "A newer provider location has already been accepted" });
      }
    }

    // Phase 3 customer tracking consumes the existing booking room. Keep this
    // payload deliberately minimal: live coordinates and lifecycle metadata,
    // with no dealer identity, contact details, or other customer data.
    const effectivePickupStatus = nearbyFirstRecorded
      ? PICKUP_STATUSES.RIDER_NEARBY
      : bookingDoc.pickupStatus;
    const io = req.app.get("io");
    if (io) {
      io.to(`booking:${bookingDoc._id}`).emit(
        "pickup:location",
        pickupLocationSocketPayload({
          bookingId: bookingDoc._id,
          pickupStatus: effectivePickupStatus,
          location: {
            ...location,
            accuracy: Number(req.body.accuracy),
            capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : undefined,
            heading: Number.isFinite(Number(req.body.heading)) ? Number(req.body.heading) : undefined,
          },
          updatedAt: now,
          distanceMeters,
        })
      );
    }

    return res.status(200).json({
      success: true,
      message: nearbyFirstRecorded ? "Rider location updated; rider is nearby" : "Rider location updated",
      data: {
        bookingId: bookingDoc._id,
        pickupStatus: effectivePickupStatus,
        distanceMeters: Math.round(distanceMeters),
        nearby: distanceMeters <= ARRIVAL_RADIUS_METERS,
      },
    });
  } catch (error) {
    console.error("updatePickupLocation error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function startDelivery(req, res) {
  try {
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!bookingDoc) return res.status(404).json({ success: false, message: "Booking not found" });
    if (!canStartDelivery(bookingDoc)) {
      return res.status(409).json({ success: false, message: "Delivery cannot start in the current booking stage or destination is unavailable" });
    }
    const now = new Date();
    const updated = await Booking.findOneAndUpdate(
      { _id: bookingDoc._id, dealer_id: req.auth.id, status: "ready_for_delivery", payment_status: "completed", billStatus: "paid", deliveryOtp: { $ne: null }, deliveryTransportStatus: { $in: [null, "NOT_STARTED"] }, garageTransportStatus: { $ne: "TO_GARAGE" }, $or: [{ garageTransportStartedAt: null }, { garageTransportStatus: "ARRIVED_AT_GARAGE" }] },
      { $set: { deliveryTransportStatus: "OUT_FOR_DELIVERY", deliveryTransportStartedAt: now, deliveryArrivedAt: null } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "Delivery was already started or booking state changed" });
    const payload = { bookingId: String(updated._id), deliveryTransportStatus: updated.deliveryTransportStatus, trackingActive: true, startedAt: now };
    req.app.get("io")?.to(`booking:${updated._id}`).emit("delivery:started", payload);
    return res.status(200).json({ success: true, message: "Delivery tracking started", data: payload });
  } catch (error) {
    console.error("startDelivery error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function markDeliveryArrived(req, res) {
  try {
    const location = normalizeLocation(req.body);
    const now = new Date();
    if (!location || !validGpsCapture(req.body, now)) return res.status(422).json({ success: false, message: "Recent GPS coordinates with accuracy within 100 metres are required" });
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!bookingDoc) return res.status(404).json({ success: false, message: "Booking not found" });
    if (!canPublishDeliveryLocation(bookingDoc)) return res.status(409).json({ success: false, message: "Delivery journey is not active" });
    const destination = deliveryLocation(bookingDoc);
    if (!destination) return res.status(422).json({ success: false, message: "Customer delivery coordinates are unavailable" });
    const distanceMeters = distanceToPickupMeters(location, destination);
    if (distanceMeters > ARRIVAL_RADIUS_METERS) return res.status(422).json({ success: false, message: "Provider must be within 100 metres of the customer delivery location", distanceMeters: Math.round(distanceMeters) });
    const updated = await Booking.findOneAndUpdate(
      { _id: bookingDoc._id, dealer_id: req.auth.id, status: "ready_for_delivery", payment_status: "completed", billStatus: "paid", deliveryOtp: { $ne: null }, deliveryTransportStatus: "OUT_FOR_DELIVERY" },
      { $set: { deliveryTransportStatus: "ARRIVED_AT_CUSTOMER", deliveryArrivedAt: now, ...transportLocationSet(location, req.body, now) } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "Delivery journey is no longer active" });
    const payload = { bookingId: String(updated._id), deliveryTransportStatus: updated.deliveryTransportStatus, trackingActive: false, arrivedAt: now, location: { latitude: location.latitude, longitude: location.longitude, accuracy: Number(req.body.accuracy), ...(Number.isFinite(Number(req.body.heading)) ? { heading: Number(req.body.heading) } : {}), updatedAt: now, capturedAt: new Date(req.body.capturedAt) } };
    req.app.get("io")?.to(`booking:${updated._id}`).emit("delivery:arrived", payload);
    return res.status(200).json({ success: true, message: "Customer arrival confirmed. Verify the delivery OTP to complete handover.", data: payload });
  } catch (error) {
    console.error("markDeliveryArrived error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function markArrived(req, res) {
  try {
    const location = normalizeLocation(req.body);
    if (!location) {
      return res.status(400).json({ success: false, message: "Current rider latitude and longitude are required" });
    }
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (!canMarkArrived(bookingDoc.pickupStatus)) {
      return res.status(409).json({ success: false, message: `Cannot mark arrived from ${bookingDoc.pickupStatus}` });
    }
    const customerLocation = pickupLocation(bookingDoc);
    if (!customerLocation) {
      return res.status(422).json({ success: false, message: "Customer pickup coordinates are unavailable" });
    }
    const distanceMeters = distanceToPickupMeters(location, customerLocation);
    if (distanceMeters > ARRIVAL_RADIUS_METERS) {
      return res.status(422).json({
        success: false,
        message: "Rider must be within 100 metres of the pickup location",
        distanceMeters: Math.round(distanceMeters),
      });
    }

    const now = new Date();
    const otpExpiresAt = new Date(now.getTime() + PICKUP_OTP_TTL_MS);
    const firstNearby = bookingDoc.pickupNearbyNotifiedAt == null;
    const updated = await Booking.findOneAndUpdate(
      {
        _id: bookingDoc._id,
        dealer_id: req.auth.id,
        pickupStatus: { $in: [PICKUP_STATUSES.PICKUP_STARTED, PICKUP_STATUSES.RIDER_NEARBY] },
      },
      {
        $set: {
          ...locationSet(location, now),
          pickupStatus: PICKUP_STATUSES.ARRIVED,
          arrivedAt: now,
          pickupOtp: bookingDoc.pickupOtp == null ? pickupOtp() : bookingDoc.pickupOtp,
          pickupOtpExpiresAt: otpExpiresAt,
          ...(firstNearby
            ? { riderNearbyAt: now, pickupNearbyNotifiedAt: now }
            : {}),
        },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: "Arrival was already recorded or booking state changed" });
    }

    if (firstNearby) {
      await notifyCustomer(req, updated, "nearby", "Rider Nearby", "Your rider is within 100 metres of the pickup location.");
    }
    await notifyCustomer(
      req,
      updated,
      "arrived",
      "Rider Arrived",
      "Your rider has arrived. Open the booking to view the pickup OTP."
    );
    return res.status(200).json({
      success: true,
      message: "Rider arrival recorded",
      data: { bookingId: updated._id, pickupStatus: updated.pickupStatus, arrivedAt: updated.arrivedAt, distanceMeters: Math.round(distanceMeters) },
    });
  } catch (error) {
    console.error("markArrived error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function verifyPickupOtp(req, res) {
  try {
    const incoming = String(req.body.otp ?? "").trim();
    if (!/^\d{4}$/.test(incoming)) {
      return res.status(400).json({ success: false, message: "OTP must be exactly 4 digits" });
    }
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (bookingDoc.pickupStatus !== PICKUP_STATUSES.ARRIVED) {
      return res.status(409).json({ success: false, message: `Pickup OTP cannot be verified from ${bookingDoc.pickupStatus}` });
    }
    if (bookingDoc.pickupOtp == null || bookingDoc.pickupOtpVerifiedAt) {
      return res.status(409).json({ success: false, message: "Pickup OTP is missing or already verified" });
    }
    if (pickupOtpIsExpired(bookingDoc)) {
      return res.status(410).json({ success: false, message: "Pickup OTP has expired" });
    }
    if (!pickupOtpMatches(bookingDoc.pickupOtp, incoming)) {
      return res.status(401).json({ success: false, message: "Invalid pickup OTP" });
    }

    const now = new Date();
    const updated = await Booking.findOneAndUpdate(
      {
        _id: bookingDoc._id,
        dealer_id: req.auth.id,
        pickupStatus: PICKUP_STATUSES.ARRIVED,
        pickupOtp: Number(incoming),
        pickupOtpVerifiedAt: null,
        $or: [
          { pickupOtpExpiresAt: null },
          { pickupOtpExpiresAt: { $gt: now } },
        ],
      },
      {
        $set: { pickupStatus: PICKUP_STATUSES.PICKUP_OTP_VERIFIED, pickupOtpVerifiedAt: now },
        $unset: { pickupOtp: 1, pickupOtpExpiresAt: 1 },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: "Pickup OTP was already verified or booking state changed" });
    }
    return res.status(200).json({
      success: true,
      message: "Pickup OTP verified",
      data: { bookingId: updated._id, pickupStatus: updated.pickupStatus, pickupOtpVerifiedAt: updated.pickupOtpVerifiedAt },
    });
  } catch (error) {
    console.error("verifyPickupOtp error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function getPickupOtpForCustomer(req, res) {
  try {
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (bookingDoc.pickupStatus !== PICKUP_STATUSES.ARRIVED) {
      return res.status(409).json({
        success: false,
        message: "Pickup OTP is available only after the rider has arrived",
      });
    }
    if (bookingDoc.pickupOtp == null || bookingDoc.pickupOtpVerifiedAt) {
      return res.status(409).json({ success: false, message: "Pickup OTP is unavailable or already used" });
    }
    if (pickupOtpIsExpired(bookingDoc)) {
      return res.status(410).json({ success: false, message: "Pickup OTP has expired" });
    }
    return res.status(200).json({
      success: true,
      data: {
        otp: String(bookingDoc.pickupOtp),
        expiresAt: bookingDoc.pickupOtpExpiresAt,
      },
    });
  } catch (error) {
    console.error("getPickupOtpForCustomer error:", error.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function regeneratePickupOtp(req, res) {
  try {
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (!canRegeneratePickupOtp(bookingDoc)) {
      return res.status(409).json({
        success: false,
        message: "Pickup OTP can be resent only after arrival and before verification",
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PICKUP_OTP_TTL_MS);
    const nextOtp = pickupOtp();
    const updated = await Booking.findOneAndUpdate(
      {
        _id: bookingDoc._id,
        dealer_id: req.auth.id,
        pickupStatus: PICKUP_STATUSES.ARRIVED,
        pickupOtpVerifiedAt: null,
      },
      {
        $set: {
          pickupOtp: nextOtp,
          pickupOtpExpiresAt: expiresAt,
        },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({
        success: false,
        message: "Pickup OTP was already verified or booking state changed",
      });
    }

    await notifyCustomer(
      req,
      updated,
      "otp-regenerated",
      "New Pickup OTP",
      "A new pickup OTP is ready. Open the booking to view it."
    );
    return res.status(200).json({
      success: true,
      message: "A new pickup OTP is now visible in the customer app",
      data: { bookingId: updated._id, pickupStatus: updated.pickupStatus, expiresAt },
    });
  } catch (error) {
    console.error("regeneratePickupOtp error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function completeBikePickup(req, res) {
  try {
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (!canCompleteBikePickup(bookingDoc)) {
      return res.status(409).json({ success: false, message: `Bike pickup cannot complete from ${bookingDoc.pickupStatus}` });
    }
    const now = new Date();
    const assignedGarage = garageLocation(bookingDoc);
    const transportStarts = Boolean(assignedGarage);
    const updated = await Booking.findOneAndUpdate(
      {
        _id: bookingDoc._id,
        dealer_id: req.auth.id,
        status: "confirmed",
        pickupStatus: PICKUP_STATUSES.PICKUP_OTP_VERIFIED,
        pickupOtpVerifiedAt: { $ne: null },
      },
      {
        $set: {
          pickupStatus: PICKUP_STATUSES.BIKE_PICKED_UP,
          pickupCompletedAt: now,
          pickupDate: now,
          pickupTrackingActive: false,
          garageTransportStatus: transportStarts ? "TO_GARAGE" : "NOT_STARTED",
          garageTransportStartedAt: transportStarts ? now : null,
          garageArrivedAt: null,
        },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: "Bike pickup was already completed or booking state changed" });
    }

    await notifyCustomer(req, updated, "completed", "Bike Picked Up Successfully", "Bike Picked Up Successfully. Service is now in progress.");
    if (transportStarts) {
      req.app.get("io")?.to(`booking:${updated._id}`).emit("transport:started", {
        bookingId: String(updated._id),
        garageTransportStatus: "TO_GARAGE",
        trackingActive: true,
        startedAt: now,
      });
    }
    return res.status(200).json({
      success: true,
      message: "Bike pickup completed; service is in progress",
      data: {
        bookingId: updated._id,
        status: updated.status,
        pickupStatus: updated.pickupStatus,
        pickupCompletedAt: updated.pickupCompletedAt,
        pickupTrackingActive: updated.pickupTrackingActive,
        garageTransportStatus: updated.garageTransportStatus,
        garageTransportStartedAt: updated.garageTransportStartedAt,
      },
    });
  } catch (error) {
    console.error("completeBikePickup error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function markGarageArrived(req, res) {
  try {
    const location = normalizeLocation(req.body);
    const now = new Date();
    if (!location || !validGpsCapture(req.body, now)) {
      return res.status(422).json({ success: false, message: "Recent GPS coordinates with accuracy within 100 metres are required" });
    }
    const bookingDoc = await loadPickupBooking(req.params.bookingId);
    if (!pickupGuard(res, bookingDoc)) return;
    if (bookingDoc.status !== "confirmed" || bookingDoc.pickupStatus !== PICKUP_STATUSES.BIKE_PICKED_UP || bookingDoc.garageTransportStatus !== "TO_GARAGE") {
      return res.status(409).json({ success: false, message: "Garage arrival cannot be confirmed in the current booking stage" });
    }
    const destination = garageLocation(bookingDoc);
    if (!destination) return res.status(422).json({ success: false, message: "Assigned garage coordinates are unavailable" });
    const distanceMeters = distanceToPickupMeters(location, destination);
    if (distanceMeters > ARRIVAL_RADIUS_METERS) {
      return res.status(422).json({ success: false, message: "Provider must be within 100 metres of the assigned garage", distanceMeters: Math.round(distanceMeters) });
    }
    const updated = await Booking.findOneAndUpdate(
      { _id: bookingDoc._id, dealer_id: req.auth.id, status: "confirmed", pickupStatus: PICKUP_STATUSES.BIKE_PICKED_UP, garageTransportStatus: "TO_GARAGE" },
      { $set: { garageTransportStatus: "ARRIVED_AT_GARAGE", garageArrivedAt: now, ...transportLocationSet(location, req.body, now) } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "Garage journey is no longer active" });
    const payload = { bookingId: String(updated._id), garageTransportStatus: updated.garageTransportStatus, trackingActive: false, arrivedAt: now, location: { latitude: location.latitude, longitude: location.longitude, accuracy: Number(req.body.accuracy), ...(Number.isFinite(Number(req.body.heading)) ? { heading: Number(req.body.heading) } : {}), updatedAt: now, capturedAt: new Date(req.body.capturedAt) } };
    req.app.get("io")?.to(`booking:${updated._id}`).emit("transport:arrived", payload);
    return res.status(200).json({ success: true, message: "Garage arrival confirmed", data: payload });
  } catch (error) {
    console.error("markGarageArrived error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

module.exports = {
  startPickup,
  updatePickupLocation,
  markArrived,
  getPickupOtpForCustomer,
  regeneratePickupOtp,
  verifyPickupOtp,
  completeBikePickup,
  markGarageArrived,
  startDelivery,
  markDeliveryArrived,
};
