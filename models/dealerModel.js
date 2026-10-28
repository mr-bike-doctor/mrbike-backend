const mongoose = require("mongoose")
const AutoIncrement = require("mongoose-sequence")(mongoose)
const { DEALER_STATUSES, deriveDealerStatus, mergeForStatus } = require("../helper/dealerStatus")
const {
  DEFAULT_SERVICE_RADIUS_KM,
  MIN_SERVICE_RADIUS_KM,
  MAX_SERVICE_RADIUS_KM,
} = require("../helper/dealerServiceRadius")

const dealerModel = new mongoose.Schema(
  {
    id: { type: Number },
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    shopName: { type: String, required: false },
    email: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      index: true,
      validate: {
        validator: (v) => {
          if (!v) return true // allow empty when sparse
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
        },
        message: (props) => `${props.value} is not a valid email!`,
      },
    },
    shopEmail: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      index: true,
      validate: {
        validator: (v) => {
          if (!v) return true // allow empty when sparse
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
        },
        message: (props) => `${props.value} is not a valid email!`,
      },
    },
    phone: { type: String, required: true, index: true },
    password: { type: String, required: false }, // if you support password login
    aadharCardNo: {
      type: String,
      required: false,
      validate: {
        validator: (v) => {
          if (!v) return true
          return /^\d{12}$/.test(v)
        },
        message: (props) => `${props.value} is not a valid Aadhar number!`,
      },
    },
    shopContact: { type: String, required: false },
    gstNumber: { type: String, required: false },
    panCardNo: {
      type: String,
      required: false,
      uppercase: true,
      validate: {
        validator: (v) => {
          if (!v) return true
          return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v)
        },
        message: (props) => `${props.value} is not a valid PAN number!`,
      },
    },
    shopNumber: { type: String, required: false },
    locality: { type: String, required: false },
    shopPincode: { type: String, required: false },
    fullAddress: { type: String, required: false },
    city: { type: String, required: false },
    state: { type: String, required: false },
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
    ownerName: { type: String, required: false },
    shopImages: [{ type: String }],
    personalEmail: { type: String, required: false },
    personalPhone: { type: String, required: false },
    holiday: { type: String, required: false },
    storeDescription: { type: String, required: false },
    alternatePhone: { type: String, required: false },
    permanentAddress: {
      address: { type: String, required: false },
      state: { type: String, required: false },
      city: { type: String, required: false },
    },
    presentAddress: {
      address: { type: String, required: false },
      state: { type: String, required: false },
      city: { type: String, required: false },
    },
    documents: {
      panCardFront: { type: String, required: false },
      aadharFront: { type: String, required: false },
      aadharBack: { type: String, required: false },
      shopCertificate: { type: String, required: false },
      faceVerificationImage: { type: String, required: false },
    },
    bankDetails: {
      accountHolderName: { type: String, required: false },
      ifscCode: { type: String, required: false },
      bankName: { type: String, required: false },
      accountNumber: { type: String, required: false },
      passbookImage: { type: String, required: false },
      upiId: { type: String, required: false },
    },
    liveVerification: {
      shopLivePhoto: { type: String, required: false },
      latitude: { type: Number, required: false },
      longitude: { type: Number, required: false },
      timestamp: { type: Date, required: false },
      capturedAt: { type: Date, required: false },
    },
    commission: {
      type: Number,
      required: false,
      min: 0,
      max: 100,
      set: (v) => (v === undefined || v === null ? v : Number.parseFloat(v)),
    },
    tax: {
      type: Number,
      default: 0,
      min: 0,
      max: 18,
    },
    pickupCharges: {
      type: Number,
      default: 0,
    },
    minWalletAmount: {
      type: Number,
      default: 0,
    },
    wallet: {
      type: Number,
      default: 0,
    },
    formProgress: {
      currentStep: { type: Number, default: 1 },
      completedSteps: {
        type: Map,
        of: Boolean,
        default: {
          basicInfo: false,
          locationInfo: false,
          shopDetails: false,
          documents: false,
          liveVerification: false,
          bankDetails: false,
        },
      },
      lastActiveStep: { type: Number, default: 1 },
    },
    completionTimestamps: {
      basicInfo: Date,
      locationInfo: Date,
      shopDetails: Date,
      documents: Date,
      liveVerification: Date,
      bankDetails: Date,
    },
    registrationStatus: {
      type: String,
      enum: ["Draft", "Pending", "Approved", "Rejected"],
      default: "Pending",
      required: true,
    },
    // Canonical dealer status — single source of truth, kept in sync with
    // registrationStatus/status.*/isActive/isBlocked/isDoc by the pre-save
    // and pre-findOneAndUpdate hooks below. See helper/dealerStatus.js.
    dealerStatus: {
      type: String,
      enum: DEALER_STATUSES,
      default: "Pending",
    },
    adminNotes: String,
    submittedAt: Date,
    approvedAt: Date,
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },

    // OTP fields
    otp: String,
    otpExpiry: Date,

    // security
    loginAttempts: { type: Number, default: 0 },
    accountLockedUntil: Date,

    // booleans used elsewhere
    isVerify: { type: Boolean, default: false },
    isProfile: { type: Boolean, default: false },
    isDoc: { type: Boolean, default: false },
    isActive: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    blockedReason: { type: String, required: false },

    // service capabilities
    providesPickup: { type: Boolean, default: false },
    providesDrop: { type: Boolean, default: false },
    dropCharges: { type: Number, default: 0 },
    // Towing — charged when the customer declares their bike as not rideable
    // or completely dead at booking time. Configured by the admin (and by the
    // dealer in their own settings) exactly like pickup/drop above, so the
    // amount is never hardcoded in any frontend. A dealer who does not offer
    // towing keeps providesTowing false; such bookings start at ₹0 and the
    // dealer/admin can still add the agreed amount to the booking later.
    providesTowing: { type: Boolean, default: false },
    towingCharges: { type: Number, default: 0 },

    // How far from this shop the dealer is willing to serve, in km. A user
    // only sees this garage (and its services) when their location falls
    // inside this radius. Settable by the admin (add/edit dealer) and by the
    // dealer themselves (Dealer App). Defaults to the 3 km that used to be
    // hard-coded in the nearby-dealer lookups — see helper/dealerServiceRadius.js.
    serviceRadiusKm: {
      type: Number,
      default: DEFAULT_SERVICE_RADIUS_KM,
      min: MIN_SERVICE_RADIUS_KM,
      max: MAX_SERVICE_RADIUS_KM,
    },

    // Explicit status object you want to query against
    status: {
      adminApproved: { type: Boolean, default: false },
      isActive: { type: Boolean, default: false },
      isVerified: { type: Boolean, default: false },
    },

    documentVerification: {
      aadhar: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      aadharFront: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      aadharBack: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      pan: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      bank: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      face: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      shop: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
      passbook: { type: String, enum: ["none", "pending", "verified", "rejected", "requested"], default: "none" },
    },

    // Post-approval document re-verification cycle. Turned on when an admin
    // rejects/requests a document from an already-approved dealer (and when
    // that dealer re-uploads it), turned off once nothing needs dealer action
    // any more. Without this flag a plain "pending" document — which is the
    // normal resting state for an approved dealer whose documents were never
    // individually verified — would read as "waiting_for_review" forever and
    // keep bouncing the dealer to the waiting screen.
    reVerification: {
      active: { type: Boolean, default: false },
      startedAt: { type: Date },
    },

    // Current admin document request per documentVerification key (Phase 3).
    // Keyed the same way as documentVerification (aadharFront, pan, shop, ...).
    // Holds only the latest request, not a history.
    documentRequests: {
      type: Map,
      of: new mongoose.Schema(
        {
          reason: { type: String, required: false },
          requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
          requestedAt: { type: Date },
        },
        { _id: false },
      ),
      default: {},
    },

    shopOpeningDate: { type: Date, required: false },
    businessHours: {
      open: String,
      close: String,
      days: [String],
    },
    notifications: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      app: { type: Boolean, default: true },
    },
    services: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AdminService",
      },
    ],
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      default: "Male",
    },
    dob: {
      type: Date,
      default: null,
    },
    online: { type: Boolean, default: false },
    // Availability timestamps written by setDealerOnline/logout.
    activeSince: { type: Date, default: null },
    lastSeen: { type: Date, default: null },
    // Provider-app session state, shown to admins. Set on OTP login and
    // device-token registration, cleared on logout. Undefined on dealers who
    // have not logged in since this field was added.
    appLoggedIn: { type: Boolean },
    lastLoginAt: { type: Date, default: null },
    lastLogoutAt: { type: Date, default: null },
    // RSA is a separately granted capability and remains disabled unless an
    // admin explicitly enables it for this dealer.
    rsaEnabled: { type: Boolean, default: false, index: true },
    rsaOnline: { type: Boolean, default: false, index: true },
    rsaCapabilities: { type: [String], enum: ["towing"], default: [] },
    rsaAvailableCapacity: { type: Number, min: 0, default: 0 },
    rsaCapacityLimit: { type: Number, min: 0, default: 0 },
    rsaCapacityReserved: { type: Number, min: 0, default: 0 },
    device_token: { type: String, default: null },
    ftoken: { type: String, default: null },

    // --- Creator metadata for admin/self created
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "creatorModel", // dynamic ref to 'Admin' or 'Vendor'
      required: false,
    },
    creatorModel: {
      type: String,
      enum: ["Admin", "Vendor", "System"],
      default: "Vendor",
    },
    creatorType: {
      // 'admin' | 'self' | 'system'
      type: String,
      enum: ["admin", "self", "system"],
      default: "self",
    },
    createdVia: { type: String, required: false }, // e.g. 'admin-panel', 'mobile', 'web'

    // Google Play Review Test Account
    // Do not remove without replacing the Play Store testing process.
    isPlayStoreTestAccount: { type: Boolean, default: false },
  },
  { timestamps: true },
)

// indexes
dealerModel.index({ phone: 1, email: 1, registrationStatus: 1, creatorType: 1 })

// pre-save adjustments
dealerModel.pre("save", function (next) {
  // existing registrationStatus behavior:
  if (this.isModified("registrationStatus")) {
    if (this.registrationStatus === "Pending" && !this.submittedAt) {
      this.submittedAt = new Date()
    } else if (this.registrationStatus === "Approved" && !this.approvedAt) {
      this.approvedAt = new Date()
      this.isActive = true
    }
  }

  if (this.creatorType === "admin") {
    this.status = this.status || {}
    if (typeof this.status.adminApproved === "undefined") {
      this.status.adminApproved = true
    }
    if (typeof this.status.isActive === "undefined") {
      this.status.isActive = true
    }
    if (typeof this.status.isVerified === "undefined") {
      this.status.isVerified = this.isVerify || false
    }
    this.isActive = this.isActive || true
    this.isVerify = this.isVerify || Boolean(this.status.isVerified)
  }

  // Canonical dealer status: auto-derive from the legacy fields above unless
  // a caller explicitly set dealerStatus in this same save.
  if (!this.isModified("dealerStatus")) {
    this.dealerStatus = deriveDealerStatus(this)
  }

  next()
})

// Safety net so every existing findByIdAndUpdate/findOneAndUpdate status
// write (approve/reject/block/activate, wherever it happens) keeps the
// canonical dealerStatus field in sync too, without having to touch each
// call site individually.
dealerModel.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate() || {}
  const set = update.$set || update

  if (Object.prototype.hasOwnProperty.call(set, "dealerStatus")) {
    return next() // caller explicitly set the canonical status — respect it
  }

  const statusFields = [
    "isBlocked",
    "isActive",
    "isDoc",
    "registrationStatus",
    "status",
    "status.isActive",
    "status.adminApproved",
    "status.isVerified",
  ]
  const touchesStatusFields = statusFields.some((key) =>
    Object.prototype.hasOwnProperty.call(set, key),
  )
  if (!touchesStatusFields) return next()

  this.model
    .findOne(this.getQuery())
    .then((current) => {
      if (!current) return next()
      const merged = mergeForStatus(current, set)
      this.set("dealerStatus", deriveDealerStatus(merged))
      next()
    })
    .catch(next)
})

dealerModel.plugin(AutoIncrement, { id: "dealer_seq", inc_field: "id" })

dealerModel.virtual("dealerId").get(function () {
  if (!this.id) return null
  return `MRBD${this.id.toString().padStart(4, "0")}`
})

dealerModel.set("toJSON", { virtuals: true })
dealerModel.set("toObject", { virtuals: true })

module.exports = mongoose.model("Vendor", dealerModel)
