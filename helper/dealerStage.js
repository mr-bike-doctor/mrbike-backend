// Admin dealer-list stages. One place defines both the per-dealer label
// (getDealerStage) and the Mongo filter for each tab (stageFilter), so the
// list, the tab counts and the row badge can never disagree.
//
// Stages are mutually exclusive and resolved in this order:
//   blocked → rejected → reverification → active → inactive
//   → waiting_review → new
//
// "new" is a dealer who signed up in the app but has not submitted the
// onboarding form yet. Every signup is created with registrationStatus
// "Pending" (the schema default), so registrationStatus alone cannot tell a
// fresh signup from a submitted application — `submittedAt` (set only by
// POST /dealerAuth/submit-registration) does. Dealers that finished every
// onboarding step before `submittedAt` existed count as submitted too.

const ONBOARDING_STEPS = [
  "basicInfo",
  "locationInfo",
  "shopDetails",
  "documents",
  "liveVerification",
  "bankDetails",
];

const DEALER_STAGES = [
  "new",
  "waiting_review",
  "reverification",
  "active",
  "inactive",
  "rejected",
  "blocked",
];

// Tab ids the admin list accepts. "approved" groups every approved dealer
// (active, inactive, and those with documents under re-verification).
const DEALER_LIST_TABS = ["all", "approved", ...DEALER_STAGES];

const STAGE_LABELS = {
  new: "New Signup",
  waiting_review: "Waiting Review",
  reverification: "Re-verification",
  active: "Active",
  inactive: "Inactive",
  rejected: "Rejected",
  blocked: "Blocked",
};

const readStep = (completedSteps, key) => {
  if (!completedSteps) return false;
  if (typeof completedSteps.get === "function") return completedSteps.get(key) === true;
  return completedSteps[key] === true;
};

function isApproved(dealer) {
  return dealer.registrationStatus === "Approved" || dealer.status?.adminApproved === true;
}

function isSubmitted(dealer) {
  if (dealer.submittedAt) return true;
  const steps = dealer.formProgress?.completedSteps;
  return ONBOARDING_STEPS.every((key) => readStep(steps, key));
}

function getDealerStage(dealer) {
  if (!dealer) return "new";
  if (dealer.isBlocked === true) return "blocked";
  if (dealer.registrationStatus === "Rejected") return "rejected";
  if (isApproved(dealer)) {
    if (dealer.reVerification?.active === true) return "reverification";
    return dealer.status?.isActive === true ? "active" : "inactive";
  }
  return isSubmitted(dealer) ? "waiting_review" : "new";
}

const NOT_BLOCKED = { isBlocked: { $ne: true } };
const NOT_REJECTED = { registrationStatus: { $ne: "Rejected" } };
const APPROVED = {
  $or: [{ registrationStatus: "Approved" }, { "status.adminApproved": true }],
};
const NOT_APPROVED = {
  registrationStatus: { $ne: "Approved" },
  "status.adminApproved": { $ne: true },
};
const SUBMITTED = {
  $or: [
    { submittedAt: { $ne: null } },
    {
      $and: ONBOARDING_STEPS.map((key) => ({
        [`formProgress.completedSteps.${key}`]: true,
      })),
    },
  ],
};
const IN_REVERIFICATION = { "reVerification.active": true };
const NOT_IN_REVERIFICATION = { "reVerification.active": { $ne: true } };

// Mongo filter for a tab id. Unknown ids return null so the caller can 400.
function stageFilter(tab) {
  switch (tab) {
    case "all":
      return {};
    case "blocked":
      return { isBlocked: true };
    case "rejected":
      return { $and: [NOT_BLOCKED, { registrationStatus: "Rejected" }] };
    case "approved":
      return { $and: [NOT_BLOCKED, NOT_REJECTED, APPROVED] };
    case "reverification":
      return { $and: [NOT_BLOCKED, NOT_REJECTED, APPROVED, IN_REVERIFICATION] };
    case "active":
      return {
        $and: [NOT_BLOCKED, NOT_REJECTED, APPROVED, NOT_IN_REVERIFICATION, { "status.isActive": true }],
      };
    case "inactive":
      return {
        $and: [NOT_BLOCKED, NOT_REJECTED, APPROVED, NOT_IN_REVERIFICATION, { "status.isActive": { $ne: true } }],
      };
    case "waiting_review":
      return { $and: [NOT_BLOCKED, NOT_REJECTED, NOT_APPROVED, SUBMITTED] };
    case "new":
      return { $and: [NOT_BLOCKED, NOT_REJECTED, NOT_APPROVED, { $nor: [SUBMITTED] }] };
    default:
      return null;
  }
}

module.exports = {
  ONBOARDING_STEPS,
  DEALER_STAGES,
  DEALER_LIST_TABS,
  STAGE_LABELS,
  getDealerStage,
  stageFilter,
};
