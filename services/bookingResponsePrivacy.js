function removeAdminBookingOtpFields(value) {
  if (Array.isArray(value)) return value.map(removeAdminBookingOtpFields);
  if (!value || typeof value !== "object" || value instanceof Date || value._bsontype) return value;
  return Object.entries(value).reduce((safe, [key, entry]) => {
    if (!/(^|_)pickupOtp$|^deliveryOtp$|OtpExpiresAt$/i.test(key)) {
      safe[key] = removeAdminBookingOtpFields(entry);
    }
    return safe;
  }, {});
}

module.exports = { removeAdminBookingOtpFields };
