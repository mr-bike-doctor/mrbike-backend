/**
 * Completion photos are an ADMIN-INTERNAL service record. The customer must
 * never receive them.
 *
 * That guarantee rests on three things, and this file locks all three down so
 * a later change has to break a test rather than quietly leak the field:
 *
 *   1. `completionPhotos` is `select: false` on the Booking schema, so it is
 *      absent from every query unless a handler asks for it by name.
 *   2. The only opt-ins (`+completionPhotos`) live in the three
 *      completion-photo handlers — not in getBookingDetails, getuserbookings,
 *      getbooking, getallbookings or createBooking.
 *   3. Every completion-photo route is gated to dealer (writes) or
 *      dealer/admin (read), so a customer authenticated on their OWN booking
 *      still cannot reach it.
 *
 * No database is required — this is schema and source introspection, matching
 * the style of walletIndexDefinitions.test.js.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Booking = require("../models/Booking");

const read = (relative) =>
  fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

/* ── 1. The schema field itself ─────────────────────────────────────────── */

const photosPath = Booking.schema.path("completionPhotos");
assert.ok(photosPath, "Booking schema must declare completionPhotos");
assert.strictEqual(
  photosPath.options.select,
  false,
  "completionPhotos MUST be select:false — it is what keeps the field out of every customer booking response",
);

const subSchema = photosPath.schema;
assert.ok(subSchema, "completionPhotos must be an array of subdocuments");
for (const field of ["url", "key", "mimeType", "uploadedAt", "uploadedBy"]) {
  assert.ok(subSchema.path(field), `completion photo subdocument must have \`${field}\``);
}
assert.strictEqual(
  subSchema.path("url").isRequired,
  true,
  "a stored completion photo must always carry the real S3 url it was uploaded to",
);

// A booking built without photos must not even carry the key, exactly like an
// ordinary query result.
const fresh = new Booking({});
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(fresh.toObject(), "completionPhotos"),
  false,
  "an unselected completionPhotos path must be absent from toObject(), not present as []",
);

/* ── 2. Who opts in ─────────────────────────────────────────────────────── */

const controller = read("controller/booking.js");

// Every function in the controller that opts into the field, by name.
const optInFunctions = new Set();
// Both definition styles are in use in this controller:
//   `async function name(req, res) {`  and  `const name = async (req, res) => {`
const fnHeader =
  /(?:(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\()|(?:const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\()/g;
const boundaries = [];
let match;
while ((match = fnHeader.exec(controller)) !== null) {
  boundaries.push({ name: match[1] || match[2], index: match.index });
}
const ownerOf = (index) => {
  let owner = null;
  for (const fn of boundaries) {
    if (fn.index <= index) owner = fn.name;
    else break;
  }
  return owner;
};

const optIn = /\+completionPhotos/g;
let occurrence;
let optInCount = 0;
while ((occurrence = optIn.exec(controller)) !== null) {
  optInCount += 1;
  optInFunctions.add(ownerOf(occurrence.index));
}

assert.ok(optInCount > 0, "the completion-photo handlers should select the field");

const ALLOWED_OPT_INS = [
  "uploadCompletionPhotos",
  "getCompletionPhotos",
  "deleteCompletionPhoto",
];
for (const fn of optInFunctions) {
  assert.ok(
    ALLOWED_OPT_INS.includes(fn),
    `\`${fn}\` selects +completionPhotos. Only the dealer/admin completion-photo handlers may — ` +
      "adding it anywhere else risks returning admin-internal photos to a customer.",
  );
}

// Named spot-check on the customer-facing readers: none of them may mention
// the field at all.
const CUSTOMER_FACING = [
  "getBookingDetails",
  "getuserbookings",
  "getbooking",
  "getallbookings",
  "createBooking",
];
for (const name of CUSTOMER_FACING) {
  const declaration = boundaries.find((fn) => fn.name === name);
  assert.ok(declaration, `expected to find ${name} in controller/booking.js`);
  const start = declaration.index;
  const next = boundaries.find((fn) => fn.index > start);
  const body = controller.slice(start, next ? next.index : controller.length);
  assert.ok(
    !body.includes("completionPhotos"),
    `${name} must never reference completionPhotos — it is reachable by customers`,
  );
}

/* ── 3. Route guards ────────────────────────────────────────────────────── */

const routes = read("routes/bookingRoutes.js");
const routeLines = routes
  .split("\n")
  .filter((line) => line.includes("completion-photos") && line.trim().startsWith("router."));

assert.strictEqual(
  routeLines.length,
  3,
  "expected exactly three completion-photo routes (upload, read, delete)",
);

for (const line of routeLines) {
  assert.ok(
    line.includes("requireBookingParticipant"),
    `completion-photo route must scope to the booking's participants: ${line.trim()}`,
  );
  const isRead = line.trim().startsWith("router.get");
  if (isRead) {
    assert.ok(
      line.includes('requireActorRoleAny("dealer", "admin")'),
      `reading completion photos must be dealer-or-admin only: ${line.trim()}`,
    );
  } else {
    assert.ok(
      line.includes('requireActorRole("dealer")'),
      `writing completion photos must be dealer-only: ${line.trim()}`,
    );
  }
  assert.ok(
    !line.includes("requireCustomer"),
    `a completion-photo route must never admit a customer: ${line.trim()}`,
  );
}

console.log("completionPhotoPrivacy.test.js: all tests passed");
