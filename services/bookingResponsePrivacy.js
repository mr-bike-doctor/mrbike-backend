function removeBookingOtpFields(value) {
  if (Array.isArray(value)) return value.map(removeBookingOtpFields);
  if (!value || typeof value !== "object" || value instanceof Date || value._bsontype) return value;
  return Object.entries(value).reduce((safe, [key, entry]) => {
    if (!/(^|_)pickupOtp$|^deliveryOtp$|OtpExpiresAt$/i.test(key)) {
      safe[key] = removeBookingOtpFields(entry);
    }
    return safe;
  }, {});
}

module.exports = {
  removeBookingOtpFields,
  // Retain the existing export for current admin response call sites.
  removeAdminBookingOtpFields: removeBookingOtpFields,
};
