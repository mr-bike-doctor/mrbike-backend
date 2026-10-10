const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  dealer: Object.freeze({
    pending: Object.freeze(["confirmed", "rejected"]),
  }),
  customer: Object.freeze({}),
  admin: Object.freeze({}),
});

function canTransitionBookingStatus(role, currentStatus, nextStatus) {
  const transitions = ALLOWED_STATUS_TRANSITIONS[role];
  return Boolean(transitions && transitions[currentStatus]?.includes(nextStatus));
}

module.exports = { ALLOWED_STATUS_TRANSITIONS, canTransitionBookingStatus };
