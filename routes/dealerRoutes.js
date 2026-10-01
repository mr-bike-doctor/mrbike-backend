var express = require("express")
var path = require("path")
const Vendor = require("../models/dealerModel")
const { createS3Upload, deleteS3Object } = require("../utils/s3Upload")
const { requireAdmin } = require("../middlewares/requireAdmin")
const { requireAdminOrOwnDealer } = require("../middlewares/sharedAuth")
const { verifyDealerToken, requireActiveDealer, requireOwnDealer, requireOwnDealerBody } = require("../middlewares/dealerAuth")
const { getDealerStatus } = require("../helper/dealerStatus")
const {
  buildDealerUpdate,
  DOCUMENT_FILE_PATHS,
  DOCUMENT_KEYS,
  DOCUMENT_VERIFICATION_KEY_MAP,
  getAtPath,
} = require("../helper/dealerFieldMap")
const {
  DEFAULT_SERVICE_RADIUS_KM,
  parseServiceRadiusKm,
} = require("../helper/dealerServiceRadius")
var {
  dealerList,
  deleteDealer,
  singledealer,
  dealerWithInRange,
  editDealerStatus,
  GetwalletInfo,
  WalletAdd,
  addAmount,
  dealerWithInRange2,
  getShopDetails,
  addDealerShopDetails,
  addDealerDocuments,
  getWallet,
  getPendingWallets,
  updateWalletStatus,
  createWithdrawalRequest,
  createDeposit,
  getAllDealersWithDocFalse,
  getAllDealersWithVerifyFalse,
  updateDealerDocStatus,
  updateDealerVerfication,
  setDealerOnline,
  getActiveDealers,
  registerDealerToken,
  getDealerActivityHistory,
} = require("../controller/dealer")
const { getDealerServices, saveDealerServices, getDealersByService } = require("../controller/service")
// Identifies the rider when a customer token is present so nearby-garage
// results can respect their saved bikes; never rejects. See the middleware.
const { attachCustomerIfPresent } = require("../middlewares/optionalCustomer")
const { processDealer } = require("../controller/dealerController")
const { log } = require("console")
const { getPayouts, getDealerWalletsSummary } = require("../controller/adminFinance")

const router = express.Router()

// Dealer Services
router.get("/services", getDealerServices)
router.post("/services", requireAdmin, saveDealerServices)
router.post("/admin/services", requireAdmin, saveDealerServices)

// Get all dealers offering a specific base service (used by mobile home screen categories)
router.get("/by-service/:baseServiceId", getDealersByService)

// Process dealer files
router.post("/process", requireAdmin, processDealer)

const upload = createS3Upload("dealer-documents")

router.post(
  "/addDealer",
  requireAdmin,
  upload.fields([
    { name: "panCardFront", maxCount: 1 },
    { name: "aadharFront", maxCount: 1 },
    { name: "aadharBack", maxCount: 1 },
    { name: "bankPassbook", maxCount: 1 },
    { name: "faceImage", maxCount: 1 },
    { name: "shopImages", maxCount: 5 },
  ]),
  async function addDealer(req, res) {
    try {
      console.log("Incoming payload:", req.body)

      const {
        shopName,
        email,
        phone,
        shopPincode,
        shopNumber,
        locality,
        fullAddress: fullAddressInput,
        city,
        state,
        latitude,
        longitude,
        ownerName,
        alternatePhone,
        accountHolderName,
        ifscCode,
        bankName,
        accountNumber,
        comission: commissionInput,
        tax,
        aadharCardNo,
        panCardNo,
        pickupCharges,
        serviceRadiusKm,
      } = req.body

      // Debug log
      console.log("Commission input:", commissionInput, typeof commissionInput)
      console.log("Tax input:", tax, typeof tax)

      // Validate commission
      const commission = Number.parseFloat(commissionInput)
      if (isNaN(commission) || commission < 0 || commission > 100) {
        return res.status(400).json({
          success: false,
          message: `Commission must be between 0-100%. Received: ${commissionInput}`,
        })
      }

      // Validate tax
      const taxValue = tax ? Number.parseFloat(tax) : 0
      if (tax && (isNaN(taxValue) || taxValue < 0 || taxValue > 18)) {
        return res.status(400).json({
          success: false,
          message: `Tax must be between 0-18%. Received: ${tax}%`,
        })
      }

      // Validate service radius — how far this garage will be shown to users.
      // Optional at creation; a dealer who leaves it blank serves the default
      // radius until the admin or the dealer changes it.
      const radius = parseServiceRadiusKm(serviceRadiusKm)
      if (radius.error) {
        return res.status(400).json({
          success: false,
          message: radius.error,
          field: "serviceRadiusKm",
        })
      }

      // Email format check
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format",
        })
      }

      // PAN format: 5 letters, 4 digits, 1 letter
      const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/
      if (!panCardNo || !panRegex.test(panCardNo.trim().toUpperCase())) {
        return res.status(400).json({
          success: false,
          message: "Invalid PAN card number",
        })
      }

      // Aadhar format: 12-digit number
      const aadharRegex = /^\d{12}$/
      if (!aadharCardNo || !aadharRegex.test(aadharCardNo.trim())) {
        return res.status(400).json({
          success: false,
          message: "Invalid Aadhar card number",
        })
      }

      // Check duplicate email/phone
      const existingDealer = await Vendor.findOne({
        $or: [{ email }, { phone }],
      })

      if (existingDealer) {
        const conflictField = existingDealer.email === email ? "Shop Email" : "Shop Contact"
        return res.status(409).json({
          success: false,
          message: `${conflictField} already exists`,
          field: conflictField.toLowerCase().replace(" ", "-"),
        })
      }

      // Required document validation
      const requiredDocs = {
        panCardFront: "PAN Card Front",
        aadharFront: "Aadhar Front",
        aadharBack: "Aadhar Back",
      }

      const missingDocs = Object.entries(requiredDocs)
        .filter(([key]) => !req.files?.[key]?.[0])
        .map(([_, label]) => label)

      if (missingDocs.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Missing required documents",
          missingDocuments: missingDocs,
        })
      }

      const documents = {}
      // Add required documents
      Object.keys(requiredDocs).forEach((key) => {
        documents[key] = req.files[key][0].location
      })

      // Add face image if provided
      if (req.files?.faceImage?.[0]) {
        documents.faceVerificationImage = req.files.faceImage[0].location
      }

      // Parse DOB
      let parsedDob = null;
      if (ownerName && req.body.dob) {
        // Simple attempt to parse common formats
        const dobStr = req.body.dob;
        const d = new Date(dobStr);
        if (!isNaN(d.getTime())) {
          parsedDob = d;
        }
      }

      const dealerData = {
        shopName,
        email,
        phone,
        shopPincode,
        shopNumber,
        locality,
        fullAddress: [shopNumber, locality, city, state ? `${state} - ${shopPincode}` : shopPincode].filter(Boolean).join(", ") || fullAddressInput,
        city,
        state,
        latitude: Number.parseFloat(latitude),
        longitude: Number.parseFloat(longitude),
        ownerName,
        dob: parsedDob,
        alternatePhone,
        bankDetails: {
          accountHolderName,
          ifscCode,
          bankName,
          accountNumber,
          passbookImage: req.files?.bankPassbook?.[0]?.location || null,
        },
        aadharCardNo: aadharCardNo.trim(),
        panCardNo: panCardNo.trim().toUpperCase(),
        commission,
        tax: taxValue,
        pickupCharges: pickupCharges ? Number.parseFloat(pickupCharges) : 0,
        serviceRadiusKm: radius.provided ? radius.value : DEFAULT_SERVICE_RADIUS_KM,
        documents,
        shopImages: req.files?.shopImages?.map((file) => file.location) || [],
        isVerify: false,
        isProfile: true,
        isDoc: true,
        isActive: true,
        wallet: 0,
      }

      const newDealer = await Vendor.create(dealerData)

      return res.status(201).json({
        success: true,
        message: "Dealer registered successfully",
        data: {
          id: newDealer._id,
          shopName: newDealer.shopName,
          email: newDealer.email,
        },
      })
    } catch (error) {
      console.error("Registration error:", error)

      // Cleanup uploaded files
      if (req.files) {
        Object.values(req.files)
          .flat()
          .forEach((file) => {
            try {
              if (file?.filename) {
                fs.unlinkSync(path.join(uploadDir, file.filename))
              }
            } catch (err) {
              console.error("File cleanup error:", err)
            }
          })
      }

      return res.status(500).json({
        success: false,
        message: "Registration failed due to server error",
        error: process.env.NODE_ENV === "development" ? error.message : undefined,
      })
    }
  },
)

// By Prashant
router.patch("/:id/status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { isActive, isBlocked, blockedReason } = req.body

    if (isActive === undefined && isBlocked === undefined) {
      return res.status(400).json({
        success: false,
        message: "At least one of isActive or isBlocked must be provided",
      })
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      return res.status(400).json({ success: false, message: "isActive must be a boolean value" })
    }
    if (isBlocked !== undefined && typeof isBlocked !== "boolean") {
      return res.status(400).json({ success: false, message: "isBlocked must be a boolean value" })
    }

    const updateData = {}
    if (isActive !== undefined) {
      updateData.isActive = isActive
      updateData["status.isActive"] = isActive
    }
    if (isBlocked !== undefined) {
      updateData.isBlocked = isBlocked
    }
    if (blockedReason !== undefined) {
      updateData.blockedReason = blockedReason
    }

    const dealerBefore = await Vendor.findById(id)
    if (!dealerBefore) {
      return res.status(404).json({ success: false, message: "Dealer not found" })
    }
    console.log("Dealer before update", dealerBefore)
    console.log("Update object", updateData)

    const dealer = await Vendor.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: true })
    console.log("Dealer after update", dealer)

    res.status(200).json({
      success: true,
      message: isActive !== undefined
        ? `Dealer ${dealer.isActive ? "activated" : "deactivated"} successfully`
        : `Dealer ${dealer.isBlocked ? "blocked" : "unblocked"} successfully`,
      data: {
        _id: dealer._id,
        isActive: dealer.isActive,
        status: {
          isActive: dealer.status?.isActive,
          adminApproved: dealer.status?.adminApproved,
        },
        isBlocked: dealer.isBlocked,
        blockedReason: dealer.blockedReason,
        registrationStatus: dealer.registrationStatus,
        dealerStatus: getDealerStatus(dealer),
      },
    })
  } catch (error) {
    console.error("Error updating dealer status:", error)
    res.status(500).json({
      success: false,
      message: "Server error while updating dealer status",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    })
  }
})

router.get("/view/:id", requireAdmin, async (req, res) => {
  try {
    const dealer = await Vendor.findById(req.params.id)
    if (!dealer) {
      return res.status(404).json({ error: "Dealer not found" })
    }
    res.json(dealer)
  } catch (error) {
    res.status(500).json({ error: "Server error" })
  }
})

router.put(
  "/editDealer",
  requireAdmin,
  upload.fields([
    { name: "panCardFront", maxCount: 1 },
    { name: "aadharFront", maxCount: 1 },
    { name: "aadharBack", maxCount: 1 },
    { name: "shopCertificate", maxCount: 1 },
    { name: "faceVerificationImage", maxCount: 1 },
    { name: "passbookImage", maxCount: 1 },
    { name: "shopImages", maxCount: 5 },
  ]),
  async function editDealer(req, res) {
    try {
      const dealerId = req.body.id
      console.log("Request Body:", req.body)
      console.log("Request Files:", req.files)

      // Find existing dealer
      const existingDealer = await Vendor.findById(dealerId)
      if (!existingDealer) {
        return res.status(404).json({
          success: false,
          message: "Dealer not found",
        })
      }

      // Normalize legacy aliases, map + validate every supported field
      // (personal info, shop info, address, bank details, business settings,
      // business hours, notifications) via the centralized field map.
      const { updateData, errors } = buildDealerUpdate(req.body)

      if (Object.keys(errors).length > 0) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors,
        })
      }

      // Auto-sync fullAddress if address components are updated
      const addressComponentsChanged = ["shopNumber", "locality", "city", "state", "shopPincode"].some(
        (field) => req.body[field] !== undefined
      )

      if (addressComponentsChanged) {
        const addr = {
          shopNumber: req.body.shopNumber !== undefined ? req.body.shopNumber : existingDealer.shopNumber,
          locality: req.body.locality !== undefined ? req.body.locality : existingDealer.locality,
          city: req.body.city !== undefined ? req.body.city : existingDealer.city,
          state: req.body.state !== undefined ? req.body.state : existingDealer.state,
          shopPincode: req.body.shopPincode !== undefined ? req.body.shopPincode : existingDealer.shopPincode,
        }

        updateData.fullAddress = [
          addr.shopNumber,
          addr.locality,
          addr.city,
          addr.state ? `${addr.state} - ${addr.shopPincode}` : addr.shopPincode
        ].filter(Boolean).join(", ")
      }

      // Handle document upload / replace (PAN, Aadhaar front/back, shop
      // certificate, passbook image, face verification). Each document is
      // written as its own dotted path so untouched documents/bankDetails
      // siblings are never overwritten. Deletion is not supported yet — no
      // client contract for it exists — so an existing document is only
      // ever touched here when a replacement file is actually uploaded.
      const files = req.files || {}

      for (const docKey of DOCUMENT_KEYS) {
        const uploadedFile = files[docKey]?.[0]
        if (!uploadedFile) continue // untouched — never remove an existing document implicitly

        const docPath = DOCUMENT_FILE_PATHS[docKey]
        const existingLocation = getAtPath(existingDealer, docPath)
        if (existingLocation) {
          await deleteS3Object(existingLocation)
        }
        updateData[docPath] = uploadedFile.location

        // Re-upload after rejection: send the document back into review
        // using the existing documentVerification field/enum — the same
        // one controller/dealerAuth.js's uploadDocuments()/verifyDocument()
        // already use — instead of a second, parallel status field.
        const verificationKey = DOCUMENT_VERIFICATION_KEY_MAP[docKey]
        if (verificationKey) {
          updateData[`documentVerification.${verificationKey}`] = "pending"
        }
      }

      // Handle shop images
      if (req.body.existingShopImages !== undefined || req.files?.shopImages) {
        const imagesToKeep = Array.isArray(req.body.existingShopImages) ? req.body.existingShopImages : req.body.existingShopImages ? [req.body.existingShopImages] : [];
        const newImages = req.files?.shopImages ? req.files.shopImages.map((file) => file.location) : [];

        const keptImages = existingDealer.shopImages.filter(
          (img) => imagesToKeep.some((keptImg) => keptImg.includes(img)),
        )

        if (keptImages.length + newImages.length > 5) {
          return res.status(400).json({
            success: false,
            message: "Maximum 5 shop images allowed",
          })
        }

        updateData.shopImages = [...keptImages, ...newImages]

        // Delete removed images
        existingDealer.shopImages.forEach((img) => {
          if (!imagesToKeep.some((keptImg) => keptImg.includes(img))) {
            try {
              fs.unlinkSync(path.join(uploadDir, img))
            } catch (err) {
              console.error("Error deleting shop image:", err)
            }
          }
        })
      }

      // Update the dealer
      const updatedDealer = await Vendor.findByIdAndUpdate(
        dealerId,
        { $set: updateData },
        { new: true, runValidators: true },
      )

      return res.status(200).json({
        success: true,
        message: "Dealer updated successfully",
        data: updatedDealer,
      })
    } catch (error) {
      console.error("Edit dealer error:", error)

      // Cleanup uploaded files if error occurred
      if (req.files) {
        Object.values(req.files)
          .flat()
          .forEach((file) => {
            try {
              if (file?.filename) {
                fs.unlinkSync(path.join(uploadDir, file.filename))
              }
            } catch (err) {
              console.error("File cleanup error:", err)
            }
          })
      }

      return res.status(500).json({
        success: false,
        message: error.name === "ValidationError" ? "Validation failed" : "Update failed due to server error",
        error: process.env.NODE_ENV === "development" ? error.message : undefined,
      })
    }
  },
)

router.get("/dealerList", requireAdmin, dealerList)
router.get("/dealerWithInRange", attachCustomerIfPresent, dealerWithInRange)
router.get("/dealerWithInRange2", dealerWithInRange2)
router.get("/dealer/:id", verifyDealerToken, requireOwnDealer("id"), singledealer)
// Shared with the admin panel (dealer wallet transaction history / summary
// views) — admins may look up any dealer, a dealer may only look up their own.
router.get("/dealerWallet/:id", requireAdminOrOwnDealer((req) => req.params.id), GetwalletInfo)
router.get("/dealerWallet", requireAdminOrOwnDealer((req) => req.query.dealer_id), getWallet)
router.get("/dealersWithDocFalse", requireAdmin, getAllDealersWithDocFalse)
router.get("/dealersWithVerifyFalse", requireAdmin, getAllDealersWithVerifyFalse)
router.get("/activity-history/:dealerId", requireAdmin, getDealerActivityHistory)

router.delete("/deleteDealer", requireAdmin, deleteDealer)
router.post("/update_status", requireAdmin, editDealerStatus)

router.post("/processTransaction/:id", requireAdmin, WalletAdd)

router.post("/AddAmout/:id", requireAdmin, addAmount)
router.get("/getShopDetails/:id", getShopDetails)

router.post("/add-shop-details", upload.fields([{ name: "shopImages", maxCount: 5 }]), addDealerShopDetails)

router.post(
  "/add-dealer-documents",
  upload.fields([
    { name: "adharCardFront", maxCount: 1 },
    { name: "adharCardBack", maxCount: 1 },
    { name: "panCardFront", maxCount: 1 },
    { name: "panCardBack", maxCount: 1 },
  ]),
  addDealerDocuments,
)

// ── Finance admin routes (must precede param-based routes) ───────────────────
// GET /bikedoctor/dealer/payouts?status=ALL|PENDING|IN_PROGRESS|APPROVED|REJECTED
router.get("/payouts", requireAdmin, getPayouts)
// GET /bikedoctor/dealer/wallets/summary
router.get("/wallets/summary", requireAdmin, getDealerWalletsSummary)

// ── Existing wallet routes (preserved for backward compatibility) ─────────────
router.get("/pending", requireAdmin, getPendingWallets)
router.put("/updatepending/:wallet_id", requireAdmin, updateWalletStatus)
router.post("/withdrawal", verifyDealerToken, requireOwnDealerBody("dealer_id"), createWithdrawalRequest)
router.post("/deposit", verifyDealerToken, requireOwnDealerBody("dealer_id"), createDeposit)
router.put("/updateDocStatus", requireAdmin, updateDealerDocStatus)
router.put("/updateVerification", requireAdmin, updateDealerVerfication)

router.post("/vendor/:dealerId/online", requireActiveDealer, requireOwnDealer("dealerId"), setDealerOnline)

router.get("/vendor/active", getActiveDealers)

router.post("/register-token", verifyDealerToken, requireOwnDealerBody("dealer_id"), registerDealerToken)

module.exports = router
