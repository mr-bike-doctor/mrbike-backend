const Customer = require("../models/customer_model");
const Dealer = require("../models/dealerModel");
const { sendBookingNotification } = require("./pushNotification");

// Dispatches a campaign to its target audience, reusing the same
// save-then-FCM-send helper as booking notifications so recipients get a
// Notification record (in-app) and/or an FCM push (push), gated by the
// campaign's own toggles. Returns the number of recipients processed.
async function dispatchCampaign(campaign) {
  if (!campaign.pushNotification && !campaign.inAppNotification) return 0;

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
    await sendBookingNotification({
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
  }

  return recipients.length;
}

module.exports = { dispatchCampaign };
