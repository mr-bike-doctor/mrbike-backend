// Rules for editing a booking AFTER the garage has marked the service
// complete and BEFORE the bike is handed back.
//
// Garages asked for this because the customer often remembers something at
// the counter ("also fit a new belt"), or the dealer forgot to type the
// odometer reading or a note before tapping Complete Service. The window is:
//
//   completed / awaiting_payment / payment_selected
//       → services, odometer and notes are all editable. Changing services
//         re-prices the booking through pricingEngine, exactly like the
//         Complete Service screen does.
//   ready_for_delivery
//       → payment has already been collected and the invoice issued for the
//         old service list, so services are LOCKED. Odometer and notes are
//         service-record fields that never reach the bill, so they stay
//         editable until handover.
//   delivered / cancelled / anything else
//       → nothing is editable.
//
// Pure — no DB, no HTTP — so it can be unit tested (test/postServiceEdit.test.js).

const POST_SERVICE_EDITABLE_STATUSES = Object.freeze([
  "completed",
  "awaiting_payment",
  "payment_selected",
  "ready_for_delivery",
]);

// Statuses in which the customer still owes the money. `completed` is the
// legacy pre-payment state some older bookings still sit in.
const PRICING_OPEN_STATUSES = Object.freeze(["completed", "awaiting_payment", "payment_selected"]);

const MAX_ODOMETER_KM = 999999;
const MAX_NOTES = 10;
const MAX_NOTE_LENGTH = 500;

class PostServiceEditError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "PostServiceEditError";
    this.code = code;
    this.status = status;
  }
}

function isPaymentCollected(booking) {
  return (
    booking?.payment_status === "completed" ||
    booking?.payment_verified === true ||
    booking?.billStatus === "paid" ||
    booking?.billGenerated === true
  );
}

/**
 * What the dealer may change on this booking right now.
 * Returned to the app as-is so the edit screen can explain a locked section
 * instead of letting the dealer find out from a 409.
 */
function resolvePostServiceEditWindow(booking) {
  const status = booking?.status;
  if (!POST_SERVICE_EDITABLE_STATUSES.includes(status)) {
    return {
      canEdit: false,
      canEditServices: false,
      code: status === "delivered" ? "BOOKING_DELIVERED" : "BOOKING_NOT_EDITABLE",
      reason:
        status === "delivered"
          ? "This bike has already been delivered. The booking can no longer be edited."
          : "This booking can only be edited after the service is completed and before the bike is delivered.",
    };
  }

  const pricingOpen =
    PRICING_OPEN_STATUSES.includes(status) &&
    !isPaymentCollected(booking) &&
    (booking?.billStatus == null || booking.billStatus === "pending");

  return {
    canEdit: true,
    canEditServices: pricingOpen,
    code: pricingOpen ? null : "PAYMENT_ALREADY_COLLECTED",
    reason: pricingOpen
      ? null
      : "Payment has already been collected for this booking, so services can no longer be changed. You can still update the odometer reading and notes until delivery.",
  };
}

/** '' / null → 0 (no reading recorded). Accepts "12,452" as typed in the app. */
function normalizeOdometer(value) {
  if (value === null || value === "") return 0;
  const cleaned = typeof value === "string" ? value.replace(/[,\s]/g, "") : value;
  const km = Number(cleaned);
  if (!Number.isFinite(km) || !Number.isInteger(km) || km < 0) {
    throw new PostServiceEditError("Last service KM must be a whole number of kilometres.", "INVALID_ODOMETER");
  }
  if (km > MAX_ODOMETER_KM) {
    throw new PostServiceEditError(
      `Last service KM cannot be more than ${MAX_ODOMETER_KM.toLocaleString("en-IN")}.`,
      "INVALID_ODOMETER",
    );
  }
  return km;
}

/** The full dealer note list after this edit. Blank entries are dropped. */
function normalizeNotes(notes) {
  if (!Array.isArray(notes)) {
    throw new PostServiceEditError("`notes` must be an array of strings.", "INVALID_NOTES");
  }
  const cleaned = notes
    .map((note) => (typeof note === "string" ? note.trim() : ""))
    .filter(Boolean);
  if (cleaned.length > MAX_NOTES) {
    throw new PostServiceEditError(`A booking can hold up to ${MAX_NOTES} notes.`, "INVALID_NOTES");
  }
  const tooLong = cleaned.find((note) => note.length > MAX_NOTE_LENGTH);
  if (tooLong) {
    throw new PostServiceEditError(`Each note can be at most ${MAX_NOTE_LENGTH} characters.`, "INVALID_NOTES");
  }
  return cleaned;
}

/** Order-insensitive diff of two id lists. */
function diffIds(previous = [], next = []) {
  const prev = new Set(previous.map(String));
  const nxt = new Set(next.map(String));
  return {
    added: [...nxt].filter((id) => !prev.has(id)),
    removed: [...prev].filter((id) => !nxt.has(id)),
  };
}

function sameNotes(a = [], b = []) {
  return a.length === b.length && a.every((note, index) => note === b[index]);
}

module.exports = {
  POST_SERVICE_EDITABLE_STATUSES,
  PRICING_OPEN_STATUSES,
  MAX_ODOMETER_KM,
  MAX_NOTES,
  MAX_NOTE_LENGTH,
  PostServiceEditError,
  isPaymentCollected,
  resolvePostServiceEditWindow,
  normalizeOdometer,
  normalizeNotes,
  diffIds,
  sameNotes,
};
