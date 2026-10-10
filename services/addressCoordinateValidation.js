const axios = require("axios");

const MAX_ADDRESS_PIN_DISTANCE_METERS = 500;

function distanceMeters(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function verifyAddressCoordinates(location, { apiKey = process.env.MAPKEY, geocode = axios.get } = {}) {
  if (!location?.address || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
    return { valid: false, code: "INVALID_LOCATION" };
  }
  if (!apiKey) return { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" };

  try {
    const response = await geocode("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: location.address, key: apiKey },
      timeout: 5000,
    });
    if (response?.data?.status === "ZERO_RESULTS") return { valid: false, code: "ADDRESS_PIN_MISMATCH" };
    if (response?.data?.status !== "OK") return { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" };
    const result = response?.data?.results?.[0]?.geometry?.location;
    if (!Number.isFinite(Number(result?.lat)) || !Number.isFinite(Number(result?.lng))) return { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" };
    const distance = distanceMeters(location, { latitude: Number(result.lat), longitude: Number(result.lng) });
    return distance <= MAX_ADDRESS_PIN_DISTANCE_METERS
      ? { valid: true }
      : { valid: false, code: "ADDRESS_PIN_MISMATCH" };
  } catch (_error) {
    // Do not expose request URLs or provider responses, which may contain the API key.
    return { valid: false, code: "ADDRESS_VERIFICATION_UNAVAILABLE" };
  }
}

module.exports = { verifyAddressCoordinates, distanceMeters, MAX_ADDRESS_PIN_DISTANCE_METERS };
