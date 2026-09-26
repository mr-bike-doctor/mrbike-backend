const mongoose = require("mongoose");

const TARGET_AUDIENCES = ["all", "new_users", "returning_customers", "dealers", "inactive_users"];
const CAMPAIGN_STATUSES = ["draft", "scheduled", "active", "paused", "completed"];

const campaignSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    image: { type: String, required: true },
    // Portrait artwork used by the mobile in-app modal. Optional at schema
    // level so campaigns created before this field was introduced keep working.
    inAppImage: { type: String, default: "" },
    targetAudience: { type: String, enum: TARGET_AUDIENCES, default: "all" },
    pushNotification: { type: Boolean, default: false },
    inAppNotification: { type: Boolean, default: false },
    scheduleAt: { type: Date, required: true },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: "draft" },
    analytics: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
      conversionRate: { type: Number, default: 0 },
    },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

campaignSchema.index({ isDeleted: 1, status: 1 });
campaignSchema.index({ title: "text", description: "text" });

module.exports = mongoose.model("Campaign", campaignSchema);
module.exports.TARGET_AUDIENCES = TARGET_AUDIENCES;
module.exports.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;
