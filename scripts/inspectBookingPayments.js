/**
 * Read-only diagnostic: print the Payment lifecycle for one booking.
 *
 *   node scripts/inspectBookingPayments.js <bookingId>
 *
 * Writes nothing. Prints no card data, no session token, no gateway
 * credentials — only the fields needed to tell which attempt a booking is
 * stuck on and whether a stale row is blocking a fresh Dynamic UPI QR.
 *
 * Must run from a host whose IP is on the Atlas allowlist.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const bookingId = process.argv[2];
if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
  console.error("Usage: node scripts/inspectBookingPayments.js <bookingId>");
  process.exit(1);
}

const minutesFromNow = (value) => {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) && ms > 0 ? Number(((ms - Date.now()) / 60000).toFixed(2)) : null;
};

(async () => {
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const _id = new mongoose.Types.ObjectId(bookingId);

  const booking = await db.collection("bookings").findOne({ _id });
  console.log("server_now =", new Date().toISOString());
  console.log(
    "\nBOOKING:",
    booking
      ? JSON.stringify(
          {
            _id: String(booking._id),
            bookingId: booking.bookingId,
            status: booking.status,
            payment_method: booking.payment_method,
            payment_status: booking.payment_status,
            billStatus: booking.billStatus,
            customerTotal: booking.customerTotal,
            discountAmount: booking.discountAmount,
            paymentOrderLockUntil: booking.paymentOrderLockUntil,
          },
          null,
          2,
        )
      : "NOT FOUND",
  );

  const rows = await db.collection("payments").find({ booking_id: _id }).sort({ createdAt: 1 }).toArray();
  console.log(`\nPAYMENT ROWS: ${rows.length}`);
  for (const row of rows) {
    console.log(
      JSON.stringify(
        {
          _id: String(row._id),
          orderId: row.orderId,
          order_status: row.order_status,
          gateway_status: row.gateway_status,
          payment_type: row.payment_type,
          orderAmount: row.orderAmount,
          cashfree_resource: row.metadata?.cashfree_resource || null,
          expiry_time: row.metadata?.expiry_time || null,
          minutes_remaining: minutesFromNow(row.metadata?.expiry_time),
          qr_code_present: Boolean(row.metadata?.qr_code),
          qr_source: row.metadata?.qr_source || null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        null,
        2,
      ),
    );
  }

  // The one_pending_payment_per_booking index allows a single PENDING row, so
  // whatever sits here is what generate-qr must reuse or retire.
  const pending = rows.filter((row) => row.order_status === "PENDING");
  console.log("\nVERDICT:");
  if (rows.some((row) => row.order_status === "SUCCESS")) {
    console.log("  Booking is already paid — generate-qr must refuse.");
  } else if (!pending.length) {
    console.log("  No PENDING row — generate-qr will mint a fresh PG_ORDER.");
  } else {
    for (const row of pending) {
      const resource = row.metadata?.cashfree_resource || "UNTAGGED";
      const remaining = minutesFromNow(row.metadata?.expiry_time);
      if (resource !== "PG_ORDER") {
        console.log(`  PENDING ${resource} ${row.orderId} — never reusable as a Dynamic QR; must be retired.`);
      } else if (remaining === null || remaining <= 0) {
        console.log(`  PENDING PG_ORDER ${row.orderId} is expired — must be retired, then a fresh order minted.`);
      } else if (!row.metadata?.qr_code) {
        console.log(`  PENDING PG_ORDER ${row.orderId} has no stored QR — must be retired.`);
      } else {
        console.log(`  PENDING PG_ORDER ${row.orderId} is live (${remaining} min left) — reuse it.`);
      }
    }
  }

  await mongoose.disconnect();
})().catch((error) => {
  console.error("Inspection failed:", error.message);
  process.exit(1);
});
