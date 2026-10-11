const mongoose = require("mongoose")
const AutoIncrement = require("mongoose-sequence")(mongoose)

const baseServiceSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
    },
    // Service Name
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    // Service image
    image: {
      type: String,
      required: true,
    },
    // Service description
    description: {
      type: String,
      trim: true,
    },
    // One-line summary for cards and the top of the detail screen. Kept HERE
    // rather than on ServiceDetail because list responses render it, and the
    // whole point of the ServiceDetail split is that list queries never have
    // to touch that collection. Backfilled from `description` for services
    // that predate this field.
    shortDescription: {
      type: String,
      default: "",
      trim: true,
    },
    // Human-readable warranty promise, e.g. "30 days / 1000 km". The existing
    // `warranty` boolean is intentionally left in place and untouched: admin
    // UI, list responses and the user app all still read it.
    warrantyText: {
      type: String,
      default: "",
      trim: true,
    },
    // How often this service should be repeated, e.g. "Every 3000 km".
    recommendedInterval: {
      type: String,
      default: "",
      trim: true,
    },
    // Denormalized "a published ServiceDetail exists for this service" flag,
    // so list and card responses can decide whether to offer a detail screen
    // without a second query per service. Maintained by the admin detail
    // endpoints; false for every service until content is published.
    hasDetail: {
      type: Boolean,
      default: false,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceCategory",
      default: null,
    },
    // Reference/starting price shown to users before a dealer/bike-specific
    // price is resolved (AdminService.bikes[].price remains the source of
    // truth for what a customer is actually charged).
    basePrice: {
      type: Number,
      default: 0,
    },
    // Estimated duration in minutes.
    duration: {
      type: Number,
      default: 0,
    },
    pickupAvailable: {
      type: Boolean,
      default: false,
    },
    warranty: {
      type: Boolean,
      default: false,
    },
    // Additive Home merchandising controls. These never override provider,
    // bike, price, or location eligibility in the discovery resolver.
    isFeatured: {
      type: Boolean,
      default: false,
    },
    isQuickService: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Maximum MR Bike Money that can be redeemed when this service is part of
    // a booking. Zero disables redemption for the service.
    mrBikeMoneyMaxRedeem: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
)

baseServiceSchema.plugin(AutoIncrement, {
  id: "base_service_seq",
  inc_field: "id",
})

module.exports = mongoose.model("BaseService", baseServiceSchema)
