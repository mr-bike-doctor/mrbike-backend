/**
 * Regression guard for the deadlock that made POST /bikedoctor/cashfree/generate-qr
 * answer 422 "Payment request expired." forever.
 *
 * A booking carrying a historical PENDING PAYMENT_LINK row could never mint a
 * fresh Dynamic UPI QR: /pg/links/{id}/cancel answers 400 for a dead link, the
 * old status allow-list ([409, 422]) re-threw that raw axios error, and the
 * generate-qr catch echoed Cashfree's phrase as its own 422. The local row was
 * never retired, so every Retry reproduced it exactly.
 *
 * The rule locked in here: a cancel refusal aborts the flow ONLY when the
 * remote resource is still payable.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");

// ── Stub axios and the mongoose models before the helper is required ────────
let handlers = {};
let calls = [];

const record = (method, url) => {
  calls.push(`${method.toUpperCase()} ${url}`);
  const handler = handlers[method];
  if (!handler) return Promise.reject(new Error(`unstubbed ${method} ${url}`));
  return handler(url);
};

const inject = (id, exports) => {
  const resolved = require.resolve(id);
  const stub = new Module(resolved, null);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[resolved] = stub;
};

inject("axios", {
  post: (url) => record("post", url),
  patch: (url) => record("patch", url),
  get: (url) => record("get", url),
});
const modelStub = () => ({
  find: async () => [],
  findOneAndUpdate: async () => null,
  updateOne: async () => ({}),
});
inject(path.join(__dirname, "../models/Payment.js"), modelStub());
inject(path.join(__dirname, "../models/Booking.js"), modelStub());

const { terminateCashfreeOrder } = require("../helper/paymentSession");

const upstream = (status, data) => () => {
  const error = new Error(data?.message || `HTTP ${status}`);
  error.response = { status, data };
  return Promise.reject(error);
};
const ok = (data) => () => Promise.resolve({ data });

const PAYMENT_LINK = (orderId) => ({ orderId, metadata: { cashfree_resource: "PAYMENT_LINK" } });
const PG_ORDER = (orderId) => ({ orderId, metadata: { cashfree_resource: "PG_ORDER" } });

const scenario = (stubs) => {
  handlers = stubs;
  calls = [];
};

const resolves = async (promise, message) => {
  try {
    await promise;
  } catch (error) {
    assert.fail(`${message} — unexpected rejection: ${error.code || error.message}`);
  }
};
const rejectsWith = async (promise, predicate, message) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(predicate(error), `${message} — got: ${error.code || error.message}`);
    return;
  }
  assert.fail(`${message} — resolved instead of rejecting`);
};

(async () => {
  // ── THE BUG: a dead PAYMENT_LINK must not block a fresh QR ────────────────
  {
    // Exactly what production returned: /links/{id}/cancel → 400, carrying the
    // body Cashfree uses for a lapsed payment link.
    scenario({
      post: upstream(400, {
        message: "Payment request expired.",
        code: "link_expired",
        type: "invalid_request_error",
      }),
      get: ok({ link_status: "EXPIRED" }),
    });
    await resolves(
      terminateCashfreeOrder(PAYMENT_LINK("LINK_OLD_1")),
      "an expired PAYMENT_LINK whose cancel 400s must be treated as already dead, not re-thrown",
    );
    assert.ok(
      calls.some((call) => call.startsWith("GET")),
      "a 400 must fall through to the state check — the old [409,422] allow-list skipped it entirely",
    );
  }

  // ── 404: Cashfree has no record of it → terminal, safe ────────────────────
  {
    scenario({
      post: upstream(404, { message: "payment link does not exist" }),
      get: upstream(404, { message: "payment link does not exist" }),
    });
    await resolves(
      terminateCashfreeOrder(PAYMENT_LINK("LINK_GONE")),
      "a link Cashfree has no record of is not payable, so the cleanup has already succeeded",
    );
  }

  // ── A PG order that refuses TERMINATE but reads back EXPIRED ──────────────
  {
    scenario({
      patch: upstream(400, { message: "order is not in a terminable state" }),
      get: ok({ order_status: "EXPIRED" }),
    });
    await resolves(
      terminateCashfreeOrder(PG_ORDER("BIKEDOC_OLD")),
      "an expired PG order must not block a fresh order either",
    );
  }

  // ── Safety preserved: a PAID resource still stops everything ──────────────
  {
    scenario({
      post: upstream(409, { message: "cannot cancel a paid link" }),
      get: ok({ link_status: "PAID" }),
    });
    await rejectsWith(
      terminateCashfreeOrder(PAYMENT_LINK("LINK_PAID")),
      (error) => error.code === "CASHFREE_ORDER_ALREADY_PAID",
      "a paid link must never be silently retired — that would collect twice",
    );
  }

  // ── Safety preserved: a still-payable resource still aborts ───────────────
  {
    scenario({
      post: upstream(400, { message: "temporary failure" }),
      get: ok({ link_status: "ACTIVE" }),
    });
    await rejectsWith(
      terminateCashfreeOrder(PAYMENT_LINK("LINK_LIVE")),
      (error) => error.response?.status === 400,
      "a link Cashfree still calls ACTIVE must abort — two live payables per booking is the thing to prevent",
    );
  }

  // ── Safety preserved: an outage is an outage, not a dead resource ─────────
  {
    scenario({ patch: upstream(503, { message: "service unavailable" }) });
    await rejectsWith(
      terminateCashfreeOrder(PG_ORDER("BIKEDOC_5XX")),
      (error) => error.response?.status === 503,
      "a 5xx must propagate — it tells us nothing about whether the order is payable",
    );
  }

  // ── Unverifiable state aborts rather than guessing ────────────────────────
  {
    scenario({
      patch: upstream(400, { message: "cannot terminate" }),
      get: upstream(500, { message: "boom" }),
    });
    await rejectsWith(
      terminateCashfreeOrder(PG_ORDER("BIKEDOC_UNKNOWN")),
      (error) => error.response?.status === 400,
      "if the follow-up read fails we cannot prove the order is dead, so the refusal stands",
    );
  }

  // ── A row with no orderId is a no-op, never a gateway call ────────────────
  {
    scenario({});
    await resolves(terminateCashfreeOrder({ metadata: {} }), "a row with no orderId is skipped");
    assert.strictEqual(calls.length, 0, "no gateway call may be made for a row with no orderId");
  }

  console.log("paymentSessionCleanup.test.js: all assertions passed");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
