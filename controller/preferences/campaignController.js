/**
 * Campaigns Controller (Preferences module)
 *
 * Endpoints (mounted at /bikedoctor/preferences/campaigns):
 *   GET    /                     → getCampaigns
 *   GET    /:id                  → getCampaignById
 *   GET    /:id/analytics        → getCampaignAnalytics
 *   POST   /                     → createCampaign        (multipart, field "image")
 *   PUT    /:id                  → updateCampaign        (multipart, field "image")
 *   DELETE /:id                  → deleteCampaign        (soft delete)
 *   PATCH  /:id/status           → toggleCampaignStatus  body: { status }
 *   POST   /bulk-delete          → bulkDeleteCampaigns   body: { ids }
 *   POST   /bulk-status          → bulkUpdateCampaignStatus body: { ids, status }
 */

const mongoose = require("mongoose");
const Campaign = require("../../models/Campaign");
const { TARGET_AUDIENCES, CAMPAIGN_STATUSES } = Campaign;
const { deleteS3Object } = require("../../utils/s3Upload");
const { dispatchCampaign } = require("../../helper/campaignDispatch");

const toBool = (v) => v === true || v === "true";
const uploadedFile = (req, field) => req.files?.[field]?.[0] || (field === "image" ? req.file : null);

const getCampaigns = async (req, res) => {
  try {
    const { page, limit, search, status, targetAudience } = req.query;

    const filter = { isDeleted: false };
    if (status) filter.status = status;
    if (targetAudience) filter.targetAudience = targetAudience;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    // Frontend does not currently send page/limit — default to full list
    // so the response shape stays a bare array under `data`.
    if (!page && !limit) {
      const data = await Campaign.find(filter).sort({ createdAt: -1 }).lean();
      return res.status(200).json({ success: true, data });
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [data, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Campaign.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error("getCampaigns error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getCampaignById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id" });
    }
    const campaign = await Campaign.findOne({ _id: id, isDeleted: false }).lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.status(200).json({ success: true, data: campaign });
  } catch (error) {
    console.error("getCampaignById error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getCampaignAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id" });
    }
    const campaign = await Campaign.findOne({ _id: id, isDeleted: false }).lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.status(200).json({
      success: true,
      data: campaign.analytics || { sent: 0, delivered: 0, opened: 0, clicked: 0, conversionRate: 0 },
    });
  } catch (error) {
    console.error("getCampaignAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const createCampaign = async (req, res) => {
  try {
    const { title, description, targetAudience, pushNotification, inAppNotification, scheduleAt, status } = req.body;

    if (!title || !title.trim()) return res.status(400).json({ success: false, message: "Title is required" });
    if (!description || !description.trim()) return res.status(400).json({ success: false, message: "Description is required" });
    if (!scheduleAt) return res.status(400).json({ success: false, message: "Schedule date & time is required" });
    const bannerFile = uploadedFile(req, "image");
    const inAppFile = uploadedFile(req, "inAppImage");
    const wantsInApp = toBool(inAppNotification);
    if (!bannerFile) return res.status(400).json({ success: false, message: "Campaign banner image is required" });
    if (wantsInApp && !inAppFile) {
      return res.status(400).json({ success: false, message: "In-app mobile image is required when in-app notification is enabled" });
    }
    if (targetAudience && !TARGET_AUDIENCES.includes(targetAudience)) {
      return res.status(400).json({ success: false, message: `Invalid targetAudience. Allowed: ${TARGET_AUDIENCES.join(", ")}` });
    }
    if (status && !CAMPAIGN_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${CAMPAIGN_STATUSES.join(", ")}` });
    }

    const scheduleDate = new Date(scheduleAt);
    if (isNaN(scheduleDate.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid scheduleAt date" });
    }

    const campaign = await Campaign.create({
      title: title.trim(),
      description,
      image: bannerFile.location,
      inAppImage: inAppFile?.location || "",
      targetAudience: targetAudience || "all",
      pushNotification: toBool(pushNotification),
      inAppNotification: wantsInApp,
      scheduleAt: scheduleDate,
      status: status || "draft",
    });

    return res.status(201).json({ success: true, message: "Campaign created successfully", data: campaign });
  } catch (error) {
    console.error("createCampaign error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const updateCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id" });
    }
    const campaign = await Campaign.findOne({ _id: id, isDeleted: false });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    const { title, description, targetAudience, pushNotification, inAppNotification, scheduleAt, status } = req.body;

    if (targetAudience && !TARGET_AUDIENCES.includes(targetAudience)) {
      return res.status(400).json({ success: false, message: `Invalid targetAudience. Allowed: ${TARGET_AUDIENCES.join(", ")}` });
    }
    if (status && !CAMPAIGN_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${CAMPAIGN_STATUSES.join(", ")}` });
    }

    if (title !== undefined) campaign.title = title.trim();
    if (description !== undefined) campaign.description = description;
    if (targetAudience !== undefined) campaign.targetAudience = targetAudience;
    if (pushNotification !== undefined) campaign.pushNotification = toBool(pushNotification);
    if (inAppNotification !== undefined) campaign.inAppNotification = toBool(inAppNotification);
    if (status !== undefined) campaign.status = status;
    if (scheduleAt !== undefined) {
      const scheduleDate = new Date(scheduleAt);
      if (isNaN(scheduleDate.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid scheduleAt date" });
      }
      campaign.scheduleAt = scheduleDate;
    }

    const bannerFile = uploadedFile(req, "image");
    const inAppFile = uploadedFile(req, "inAppImage");
    if (campaign.inAppNotification && !inAppFile && !campaign.inAppImage) {
      return res.status(400).json({ success: false, message: "In-app mobile image is required when in-app notification is enabled" });
    }

    if (bannerFile) {
      const oldImage = campaign.image;
      campaign.image = bannerFile.location;
      deleteS3Object(oldImage);
    }

    if (inAppFile) {
      const oldInAppImage = campaign.inAppImage;
      campaign.inAppImage = inAppFile.location;
      deleteS3Object(oldInAppImage);
    }

    await campaign.save();
    return res.status(200).json({ success: true, message: "Campaign updated successfully", data: campaign });
  } catch (error) {
    console.error("updateCampaign error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const deleteCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id" });
    }
    const campaign = await Campaign.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.status(200).json({ success: true, message: "Campaign deleted successfully" });
  } catch (error) {
    console.error("deleteCampaign error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const toggleCampaignStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id" });
    }
    if (!status || !CAMPAIGN_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${CAMPAIGN_STATUSES.join(", ")}` });
    }
    const campaign = await Campaign.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { status },
      { new: true }
    );
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    return res.status(200).json({ success: true, message: "Campaign status updated", data: campaign });
  } catch (error) {
    console.error("toggleCampaignStatus error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const sendCampaignNow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id" });
    }
    const campaign = await Campaign.findOne({ _id: id, isDeleted: false });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    const sentCount = await dispatchCampaign(campaign);
    campaign.status = "completed";
    campaign.analytics.sent += sentCount;
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: `Campaign sent to ${sentCount} recipient(s)`,
      data: campaign,
    });
  } catch (error) {
    console.error("sendCampaignNow error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const bulkDeleteCampaigns = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "ids array is required" });
    }
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    await Campaign.updateMany({ _id: { $in: validIds } }, { isDeleted: true });
    return res.status(200).json({ success: true, message: "Campaigns deleted successfully" });
  } catch (error) {
    console.error("bulkDeleteCampaigns error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const bulkUpdateCampaignStatus = async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "ids array is required" });
    }
    if (!status || !CAMPAIGN_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${CAMPAIGN_STATUSES.join(", ")}` });
    }
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    await Campaign.updateMany({ _id: { $in: validIds } }, { status });
    return res.status(200).json({ success: true, message: "Campaign statuses updated successfully" });
  } catch (error) {
    console.error("bulkUpdateCampaignStatus error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  getCampaigns,
  getCampaignById,
  getCampaignAnalytics,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  toggleCampaignStatus,
  sendCampaignNow,
  bulkDeleteCampaigns,
  bulkUpdateCampaignStatus,
};
