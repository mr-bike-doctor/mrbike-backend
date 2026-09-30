const Customer = require("../models/customer_model");
const Dealer = require("../models/dealerModel");
const { sendBookingNotification } = require("./pushNotification");

// Dispatches a campaign to its target audience, reusing the same
// save-then-FCM-send helper as booking notifications so recipients get a
// Notification record (in-app) and/or an FCM push (push), gated by the
// campaign's own toggles. Returns per-outcome counts so the admin panel can
// show how many pushes FCM actually accepted versus failed or had no token.
async function dispatchCampaign(campaign) {
  const result = { recipients: 0, pushSent: 0, pushFailed: 0, noDeviceToken: 0 };
  if (!campaign.pushNotification && !campaign.inAppNotification) return result;

  const isDealerAudience = campaign.targetAudience === "dealers";
  const Model = isDealerAudience ? Dealer : Customer;
  const receiverType = isDealerAudience ? "dealer" : "user";

  // Google Play Review Test Account
  // Do not remove without replacing the Play Store testing process.
  // Play Store reviewer accounts must never receive promotional campaigns.
  const recipients = await Model.find({ isPlayStoreTestAccount: { $ne: true } })
    .select("device_token ftoken")
    .lean();

  for (const recipient of recipients) {
    const token = campaign.pushNotification ? recipient.device_token || recipient.ftoken : null;
    const outcome = await sendBookingNotification({
      token,
      title: campaign.title,
      body: campaign.description,
      data: {
        type: "campaign",
        campaignId: campaign._id.toString(),
        // The notification row and app popup use portrait artwork. Old
        // campaigns fall back to their original image until they are edited.
        image: campaign.inAppImage || campaign.image,
        inAppImage: campaign.inAppImage || campaign.image,
        // FCM's expanded push notification keeps the landscape banner.
        pushImage: campaign.image,
      },
      receiverId: recipient._id,
      receiverType,
    });

    result.recipients += 1;
    if (!campaign.pushNotification) continue;
    if (outcome === "sent") result.pushSent += 1;
    else if (outcome === "no_token") result.noDeviceToken += 1;
    else result.pushFailed += 1;
  }

  return result;
}

// Folds one dispatch result into the campaign's stored analytics.
function recordDispatch(campaign, result) {
  campaign.analytics.sent += result.recipients;
  campaign.analytics.pushSent = (campaign.analytics.pushSent || 0) + result.pushSent;
  campaign.analytics.pushFailed = (campaign.analytics.pushFailed || 0) + result.pushFailed;
  campaign.analytics.noDeviceToken = (campaign.analytics.noDeviceToken || 0) + result.noDeviceToken;
}

module.exports = { dispatchCampaign, recordDispatch };
