const mongoose = require("mongoose")
const AutoIncrement = require("mongoose-sequence")(mongoose)

const CustomerSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      default: 0,
    },
    first_name: {
      type: String,
      default: "",
    },
    last_name: {
      type: String,
      default: "",
    },
    pincode: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      default: "",
    },
    password: {
      type: String,
      select: false,
    },
    phone: {
      type: String,
      default: null,
    },
    state: {
      type: String,
      default: "",
    },
    city: {
      type: String,
      default: "",
    },
    address: {
      type: String,
      default: "",
    },
    image: {
      type: String,
      default: "",
    },
    ftoken: {
      type: String,
      default: "",
    },
    device_token: {
      type: String,
      default: "",
    },
    userBike: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "UserBike",
        default: [],
      },
    ],
    primaryBikeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserBike",
      default: null,
    },
    // Mutations increment this field in the same transaction so competing
    // bike selection, deletion, and deactivation operations conflict.
    primaryBikeRevision: { type: Number, default: 0, select: false },
    otp: {
      type: Number,
      default: null,
    },
    isProfile: {
      type: Boolean,
      default: false,
    },
    reward_points: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0, min: 0 },
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      trim: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "customers",
      default: null,
    },
    // Running total of referral rewards credited to this user, as either
    // referrer or referred user. Separate from reward_points (the unrelated
    // scratch-card system) so referral money is never conflated with it.
    referralEarnings: { type: Number, default: 0, min: 0 },
    // Spendable referral currency. `referralEarnings` remains the lifetime
    // earned total; this balance falls when the customer redeems money on a
    // service booking and rises again if that booking is cancelled/refunded.
    mrBikeMoneyBalance: { type: Number, default: 0, min: 0 },
    // Idempotency marker for referral rewards configured to credit as soon as
    // the referral code is accepted during profile/signup completion.
    referralSignupRewardCreditedAt: { type: Date, default: null },
    // Google Play Review Test Account
    // Do not remove without replacing the Play Store testing process.
    isPlayStoreTestAccount: { type: Boolean, default: false },
  },

  {
    timestamps: true,
  },
)

CustomerSchema.virtual("customerId").get(function () {
  if (!this.id) return null
  return `MRBDC${this.id.toString().padStart(4, "0")}`
})

CustomerSchema.set("toJSON", { virtuals: true })
CustomerSchema.set("toObject", { virtuals: true })

CustomerSchema.plugin(AutoIncrement, { id: "user_seq", inc_field: "id" })
module.exports = mongoose.model("customers", CustomerSchema)
