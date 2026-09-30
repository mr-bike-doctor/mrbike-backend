const Campaign = require("../models/Campaign");
const { dispatchCampaign, recordDispatch } = require("./campaignDispatch");

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * One poll cycle. Atomically claims and dispatches every campaign whose
 * scheduled time has arrived. Mirrors the claim-then-process pattern used
 * by bookingExpiryJob so concurrent ticks/instances never double-send.
 */
async function runScheduledCampaigns() {
  try {
    const now = new Date();

    let campaign;
    do {
      campaign = await Campaign.findOneAndUpdate(
        { status: "scheduled", scheduleAt: { $lte: now }, isDeleted: false },
        { $set: { status: "active" } },
        { new: true }
      );

      if (campaign) {
        try {
          const result = await dispatchCampaign(campaign);
          campaign.status = "completed";
          recordDispatch(campaign, result);
          await campaign.save();
          console.log(
            `[CAMPAIGN-SCHEDULER] Sent campaign "${campaign.title}" to ${result.recipients} recipient(s)` +
              ` | push sent=${result.pushSent} failed=${result.pushFailed} noToken=${result.noDeviceToken}`
          );
        } catch (err) {
          console.error(`[CAMPAIGN-SCHEDULER] Dispatch failed for ${campaign._id}:`, err.message);
        }
      }
    } while (campaign);
  } catch (err) {
    console.error("[CAMPAIGN-SCHEDULER] Poll cycle error:", err.message);
  }
}

function start() {
  console.log("[CAMPAIGN-SCHEDULER] Campaign scheduler started — polling every 60 seconds");
  runScheduledCampaigns();
  setInterval(runScheduledCampaigns, POLL_INTERVAL_MS);
}

module.exports = { start };
