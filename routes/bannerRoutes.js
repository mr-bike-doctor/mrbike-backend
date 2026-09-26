var express = require("express")
var path = require("path")
const { verifyToken } = require("../helper/verifyAuth")
const { requireAdmin } = require("../middlewares/requireAdmin")
var { addbanner, bannerlist, deletebanner, editbanner } = require("../controller/banner")
const { createS3Upload, BANNER_UPLOAD_OPTIONS } = require("../utils/s3Upload")
const router = express.Router()

const upload = createS3Upload("banners", BANNER_UPLOAD_OPTIONS)

/* POST users listing. */
router.post("/addbanner", requireAdmin, upload.single("images"), addbanner)
router.get("/bannerlist", bannerlist)
router.delete("/deletebanner", requireAdmin, deletebanner)
// Same multipart field name as addbanner ("images"), so an edit can swap the
// artwork. multer passes a plain JSON body straight through, so an edit that
// only changes text fields still works unchanged.
router.put("/editbanner", requireAdmin, upload.single("images"), editbanner)

module.exports = router
