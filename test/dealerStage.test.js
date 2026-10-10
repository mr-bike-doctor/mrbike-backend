const assert = require("assert");
const siftModule = require("sift");
const sift = siftModule.default || siftModule;
const {
  DEALER_STAGES,
  DEALER_LIST_TABS,
  getDealerStage,
  stageFilter,
} = require("../helper/dealerStage");

const allSteps = {
  basicInfo: true,
  locationInfo: true,
  shopDetails: true,
  documents: true,
  liveVerification: true,
  bankDetails: true,
};

// Representative dealers, keyed by the stage each must land in.
const fixtures = {
  new: [
    // Fresh app signup: schema defaults only.
    { registrationStatus: "Pending", status: { adminApproved: false, isActive: false }, isActive: true },
    // Half-way through onboarding.
    {
      registrationStatus: "Pending",
      status: { adminApproved: false },
      formProgress: { completedSteps: { ...allSteps, bankDetails: false } },
    },
    { registrationStatus: "Draft" },
  ],
  waiting_review: [
    { registrationStatus: "Pending", submittedAt: new Date(), status: { adminApproved: false } },
    // Legacy: finished every step before submittedAt existed.
    { registrationStatus: "Pending", formProgress: { completedSteps: allSteps } },
  ],
  reverification: [
    { registrationStatus: "Approved", status: { adminApproved: true, isActive: true }, reVerification: { active: true } },
  ],
  active: [
    { registrationStatus: "Approved", status: { adminApproved: true, isActive: true }, reVerification: { active: false } },
    // Approved via the legacy flag only.
    { registrationStatus: "Pending", submittedAt: new Date(), status: { adminApproved: true, isActive: true } },
  ],
  inactive: [
    { registrationStatus: "Approved", status: { adminApproved: true, isActive: false } },
  ],
  rejected: [
    { registrationStatus: "Rejected", submittedAt: new Date(), status: { adminApproved: false } },
  ],
  blocked: [
    { registrationStatus: "Approved", status: { adminApproved: true, isActive: true }, isBlocked: true },
    { registrationStatus: "Pending", isBlocked: true },
  ],
};

const everyDealer = Object.values(fixtures).flat();

// 1. The JS label puts each fixture in its expected stage.
for (const [stage, dealers] of Object.entries(fixtures)) {
  dealers.forEach((dealer, i) => {
    assert.strictEqual(getDealerStage(dealer), stage, `${stage}[${i}] labelled ${getDealerStage(dealer)}`);
  });
}

// 2. Each stage's Mongo filter matches exactly the dealers labelled with it,
//    so tab counts, tab contents and row badges agree.
for (const stage of DEALER_STAGES) {
  const matched = everyDealer.filter(sift(stageFilter(stage)));
  const expected = everyDealer.filter((d) => getDealerStage(d) === stage);
  assert.deepStrictEqual(matched, expected, `filter for "${stage}" disagrees with getDealerStage`);
}

// 3. Stages partition the full list; "approved" groups the approved stages.
const stageTotal = DEALER_STAGES.reduce((n, s) => n + everyDealer.filter(sift(stageFilter(s))).length, 0);
assert.strictEqual(stageTotal, everyDealer.length);
assert.strictEqual(everyDealer.filter(sift(stageFilter("all"))).length, everyDealer.length);
assert.strictEqual(
  everyDealer.filter(sift(stageFilter("approved"))).length,
  fixtures.active.length + fixtures.inactive.length + fixtures.reverification.length,
);

// 4. Every advertised tab resolves; unknown ones are rejected.
DEALER_LIST_TABS.forEach((tab) => assert.ok(stageFilter(tab), `tab ${tab} has no filter`));
assert.strictEqual(stageFilter("pending"), null);
assert.strictEqual(stageFilter("$where"), null);

console.log("dealerStage.test.js — all assertions passed");
