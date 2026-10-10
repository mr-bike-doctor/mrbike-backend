const AdminBookingAudit = require("../models/AdminBookingAudit");
const BookingChangeConsent = require("../models/BookingChangeConsent");
const { PRICING_WRITE_BYPASS_FLAG } = require("./pricingEngine");

class ConsentAlreadyResolvedError extends Error {
  constructor() {
    super("The customer approval was already consumed or is no longer valid.");
    this.code = "CONSENT_ALREADY_RESOLVED";
  }
}

async function persistApprovedBookingModification({ booking, consent, auditEvent, session }) {
  const consumed = await BookingChangeConsent.updateOne(
    { _id: consent._id, status: "approved", expectedUpdatedAt: consent.expectedUpdatedAt },
    { $set: { status: "applied" } },
    { session },
  );
  if (consumed.modifiedCount !== 1) throw new ConsentAlreadyResolvedError();
  await booking.save({ session, [PRICING_WRITE_BYPASS_FLAG]: true });
  await AdminBookingAudit.create([auditEvent], { session });
}

module.exports = { persistApprovedBookingModification, ConsentAlreadyResolvedError };
