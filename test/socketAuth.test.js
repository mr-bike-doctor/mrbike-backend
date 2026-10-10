const assert = require("assert");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const {
  authenticateSocketToken,
  createSocketAuthMiddleware,
  canJoinBookingRoom,
  authorizeBookingRoom,
  createBookingRoomJoinHandler,
} = require("../middlewares/socketAuth");

const CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const DEALER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_ID = new mongoose.Types.ObjectId().toString();
const ADMIN_ID = new mongoose.Types.ObjectId().toString();
const BOOKING_ID = new mongoose.Types.ObjectId().toString();
const SECRET = "socket-auth-test-secret";

function modelFind(result) {
  return { findById: () => ({ select: () => ({ lean: async () => result }) }) };
}

async function run() {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  const models = {
    Customer: { exists: async ({ _id }) => (_id === CUSTOMER_ID ? { _id } : null) },
    Vendor: modelFind({ _id: DEALER_ID, isBlocked: false }),
    Admin: modelFind({ _id: ADMIN_ID, status: "active", role: "Telecaller" }),
  };

  assert.strictEqual(await authenticateSocketToken(null, models), null, "missing token is rejected");
  assert.strictEqual(await authenticateSocketToken("invalid", models), null, "invalid token is rejected");

  const customerToken = jwt.sign({ user_id: CUSTOMER_ID, user_type: 4 }, SECRET);
  const dealerToken = jwt.sign({ user_id: DEALER_ID, user_type: 3 }, SECRET);
  const adminToken = jwt.sign({ user_id: ADMIN_ID, user_type: 1 }, SECRET);
  assert.deepStrictEqual(await authenticateSocketToken(customerToken, models), {
    role: "customer", id: CUSTOMER_ID,
  });
  assert.deepStrictEqual(await authenticateSocketToken(dealerToken, models), {
    role: "dealer", id: DEALER_ID,
  });
  assert.deepStrictEqual(await authenticateSocketToken(adminToken, models), {
    role: "admin", adminRole: "Telecaller", id: ADMIN_ID,
  });

  const socket = { handshake: { auth: { token: customerToken } }, data: {} };
  await new Promise((resolve, reject) => createSocketAuthMiddleware(models)(socket, error => {
    if (error) return reject(error);
    resolve();
  }));
  assert.deepStrictEqual(socket.data.actor, { role: "customer", id: CUSTOMER_ID });
  await new Promise(resolve => createSocketAuthMiddleware(models)(
    { handshake: { auth: {} }, data: {} },
    error => { assert.strictEqual(error?.data?.code, "SOCKET_AUTH_FAILED"); resolve(); },
  ));

  assert.strictEqual(canJoinBookingRoom({ role: "customer", id: CUSTOMER_ID }, {
    user_id: CUSTOMER_ID, dealer_id: DEALER_ID,
  }), true);
  assert.strictEqual(canJoinBookingRoom({ role: "dealer", id: DEALER_ID }, {
    user_id: CUSTOMER_ID, dealer_id: DEALER_ID,
  }), true);
  assert.strictEqual(canJoinBookingRoom({ role: "dealer", id: OTHER_ID }, {
    user_id: CUSTOMER_ID, dealer_id: DEALER_ID,
  }), false, "unassigned dealer cannot subscribe");
  assert.strictEqual(canJoinBookingRoom({ role: "customer", id: OTHER_ID }, {
    user_id: CUSTOMER_ID, dealer_id: DEALER_ID,
  }), false, "unrelated customer cannot subscribe");
  assert.strictEqual(canJoinBookingRoom({ role: "admin", adminRole: "Telecaller", id: ADMIN_ID }, {
    user_id: CUSTOMER_ID, dealer_id: DEALER_ID,
  }), false, "telecaller lacks live GPS room access");
  assert.strictEqual(canJoinBookingRoom({ role: "admin", adminRole: "Manager", id: ADMIN_ID }, {
    user_id: CUSTOMER_ID, dealer_id: DEALER_ID,
  }), true, "manager can join authorized live booking rooms");

  const bookingModel = modelFind({ user_id: CUSTOMER_ID, dealer_id: DEALER_ID });
  assert.strictEqual(await authorizeBookingRoom(
    { role: "customer", id: CUSTOMER_ID }, BOOKING_ID, bookingModel,
  ), true);
  assert.strictEqual(await authorizeBookingRoom(
    { role: "dealer", id: OTHER_ID }, BOOKING_ID, bookingModel,
  ), false);
  assert.strictEqual(await authorizeBookingRoom(
    { role: "customer", id: CUSTOMER_ID }, "not-an-object-id", bookingModel,
  ), false);

  const joined = [];
  const emitted = [];
  const left = [];
  const joinHandler = createBookingRoomJoinHandler(async (actor, bookingId) =>
    authorizeBookingRoom(actor, bookingId, bookingModel));
  const socketContext = {
    data: { actor: { role: "customer", id: CUSTOMER_ID } },
    join: room => joined.push(room),
    leave: room => left.push(room),
    emit: (event, payload) => emitted.push({ event, payload }),
  };
  await joinHandler.call(socketContext, { bookingId: BOOKING_ID });
  assert.deepStrictEqual(joined, [`booking:${BOOKING_ID}`], "authorized customer joins booking room");
  assert.strictEqual(emitted.at(-1).event, "booking:joinUserAccepted");
  socketContext.data.actor = { role: "dealer", id: OTHER_ID };
  await joinHandler.call(socketContext, { bookingId: BOOKING_ID });
  assert.deepStrictEqual(left, [`booking:${BOOKING_ID}`], "unauthorized client is removed from booking room");
  assert.strictEqual(emitted.at(-1).event, "booking:joinUserDenied");

  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
  console.log("Socket authentication and booking room authorization tests passed");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
