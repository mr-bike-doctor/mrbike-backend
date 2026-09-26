/**
 * Public App Content Controller
 *
 * Unauthenticated reads of published Preferences content for the customer
 * app. Legacy `/bannerList` writes are mirrored into AppBanner by their write
 * handlers, keeping this public read path fast and side-effect free.
 */

const LegalDocument = require("../../models/LegalDocument");
const AppSettings = require("../../models/AppSettings");
const AppBanner = require("../../models/AppBanner");
const Faq = require("../../models/Faq");
const { LEGAL_DOC_TYPES } = LegalDocument;
const { BANNER_TYPES } = AppBanner;

function isValidDocType(docType) {
  return LEGAL_DOC_TYPES.includes(docType);
}

function isValidBannerType(bannerType) {
  return BANNER_TYPES.includes(bannerType);
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (value) => (value * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const getPublicLegalDocuments = async (req, res) => {
  try {
    const documents = await LegalDocument.find({ isPublished: true }).lean();
    return res.status(200).json({ success: true, data: documents });
  } catch (error) {
    console.error("getPublicLegalDocuments error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getPublicLegalDocumentByType = async (req, res) => {
  try {
    const { docType } = req.params;
    if (!isValidDocType(docType)) {
      return res.status(400).json({ success: false, message: `Invalid docType. Allowed: ${LEGAL_DOC_TYPES.join(", ")}` });
    }
    const document = await LegalDocument.findOne({ docType, isPublished: true }).lean();
    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }
    return res.status(200).json({ success: true, data: document });
  } catch (error) {
    console.error("getPublicLegalDocumentByType error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getPublicAppSettings = async (req, res) => {
  try {
    const settings = await AppSettings.findOne({}).lean();
    return res.status(200).json({ success: true, data: settings || {} });
  } catch (error) {
    console.error("getPublicAppSettings error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getPublicAppBanners = async (req, res) => {
  try {
    const { bannerType } = req.params;
    if (!isValidBannerType(bannerType)) {
      return res.status(400).json({ success: false, message: `Invalid bannerType. Allowed: ${BANNER_TYPES.join(", ")}` });
    }
    // Legacy create/update/delete handlers mirror their individual record into
    // AppBanner. Do not bulk-sync the entire collection on this read path: it
    // made every Home visit wait for a database write before banners could be
    // returned. Older deployments can use migrateLegacyHomeBanners.js once.
    const now = new Date();
    // scheduleEnd is compared against the start of today rather than the
    // exact instant `now`: banners written before the end-of-day fix have
    // scheduleEnd stored at 00:00:00 UTC of their end date, and would
    // otherwise look expired from the very start of that date. Comparing
    // against start-of-day treats "expires on day D" as valid through all of
    // day D regardless of which time-of-day D's timestamp was stored with,
    // so both legacy (00:00:00) and current (23:59:59.999) documents behave
    // the same — no migration required.
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let data = await AppBanner.find({
      bannerType,
      isDeleted: false,
      isActive: true,
      $and: [
        { $or: [{ scheduleStart: null }, { scheduleStart: { $lte: now } }] },
        { $or: [{ scheduleEnd: null }, { scheduleEnd: { $gte: startOfToday } }] },
      ],
    })
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();
    // Coordinates are optional for older app versions. When supplied, only
    // global banners or specific banners whose radius contains the selected
    // location are returned.
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      data = data.filter((banner) => {
        if (!banner.locationType || banner.locationType === "all") return true;
        if (!Number.isFinite(banner.latitude) || !Number.isFinite(banner.longitude)) return false;
        return distanceKm(lat, lng, banner.latitude, banner.longitude) <= (banner.radiusKm || 10);
      });
    }
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getPublicAppBanners error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const FAQ_APP_TYPES = ["user", "dealer"];

const getPublicFaqs = async (req, res) => {
  try {
    // appType is optional so app builds that predate this filter keep
    // getting every active FAQ, unfiltered, exactly as before.
    const { appType } = req.query;
    const filter = { isDeleted: false, isActive: true };
    if (appType && FAQ_APP_TYPES.includes(appType)) filter.appType = appType;

    const data = await Faq.find(filter)
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getPublicFaqs error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  getPublicLegalDocuments,
  getPublicLegalDocumentByType,
  getPublicAppSettings,
  getPublicAppBanners,
  getPublicFaqs,
};
