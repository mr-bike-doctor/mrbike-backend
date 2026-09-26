const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../../middlewares/requireAdmin");
const { createS3Upload, BANNER_UPLOAD_OPTIONS } = require("../../utils/s3Upload");
const {
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
} = require("../../controller/preferences/campaignController");

const upload = createS3Upload("campaigns", BANNER_UPLOAD_OPTIONS);

router.get("/", requireAdmin, getCampaigns);
router.post("/bulk-delete", requireAdmin, bulkDeleteCampaigns);
router.post("/bulk-status", requireAdmin, bulkUpdateCampaignStatus);
const campaignImages = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "inAppImage", maxCount: 1 },
]);

router.post("/", requireAdmin, campaignImages, createCampaign);
router.get("/:id/analytics", requireAdmin, getCampaignAnalytics);
router.patch("/:id/status", requireAdmin, toggleCampaignStatus);
router.post("/:id/send-now", requireAdmin, sendCampaignNow);
router.get("/:id", requireAdmin, getCampaignById);
router.put("/:id", requireAdmin, campaignImages, updateCampaign);
router.delete("/:id", requireAdmin, deleteCampaign);

module.exports = router;
