const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../../middlewares/requireAdmin");
const { createS3Upload, BANNER_UPLOAD_OPTIONS } = require("../../utils/s3Upload");
const {
  getAppBanners,
  createAppBanner,
  updateAppBanner,
  deleteAppBanner,
  toggleAppBannerStatus,
  bulkDeleteAppBanners,
} = require("../../controller/preferences/appBannerController");

const upload = createS3Upload("app-banners", BANNER_UPLOAD_OPTIONS);

router.post("/:bannerType/bulk-delete", requireAdmin, bulkDeleteAppBanners);
router.patch("/:bannerType/:id/status", requireAdmin, toggleAppBannerStatus);
router.put("/:bannerType/:id", requireAdmin, upload.single("image"), updateAppBanner);
router.delete("/:bannerType/:id", requireAdmin, deleteAppBanner);
router.get("/:bannerType", requireAdmin, getAppBanners);
router.post("/:bannerType", requireAdmin, upload.single("image"), createAppBanner);

module.exports = router;
