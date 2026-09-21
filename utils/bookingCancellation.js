const CANCELLATION_REASONS = Object.freeze({
  CHANGE_OF_PLANS: "My plans changed",
  BOOKED_BY_MISTAKE: "Booked by mistake",
  NEED_TO_RESCHEDULE: "I need to reschedule",
  FOUND_ANOTHER_GARAGE: "Found another service center",
  PRICE_CONCERN: "Price is higher than expected",
  LOCATION_CONCERN: "Service center is too far",
  OTHER: "Other reason",
});

function resolveCancellationReason(reasonCode) {
  if (typeof reasonCode !== "string") return null;
  const code = reasonCode.trim().toUpperCase();
  const label = CANCELLATION_REASONS[code];
  return label ? { code, label } : null;
}

function canCustomerCancel(status, dealerResponseStatus) {
  return (
    String(status || "").trim().toLowerCase() === "pending" &&
    String(dealerResponseStatus || "").trim().toLowerCase() !== "expired"
  );
}

module.exports = {
  CANCELLATION_REASONS,
  resolveCancellationReason,
  canCustomerCancel,
};
