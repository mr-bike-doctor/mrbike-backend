const mongoose = require("mongoose");
const AutoIncrement = require('mongoose-sequence')(mongoose);

const bannerSchema = new mongoose.Schema({
  id: {
    type: Number,
  },
  bannerId: {
    type: String,
    unique: true,
  },
  name: String,
  banner_image: {
    type: String,
    default: "",
  },
  from_date: {
    type: Date,
    required: true,
  },
  expiry_date: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    enum: ["upcoming", "active", "expired"],
    default: "upcoming", // fallback until computed
  },
  baseServiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BaseService",
    default: null,
  },
  locationType: {
    type: String,
    enum: ["all", "specific"],
    default: "all",
  },
  placeId: {
    type: String,
    default: "",
  },
  placeName: {
    type: String,
    default: "",
  },
  latitude: {
    type: Number,
  },
  longitude: {
    type: Number,
  },
  radius: {
    type: Number,
  },
  displayOrder: {
    type: Number,
    default: 0,
  },
  // True when the uploaded artwork is already a finished creative (offer text,
  // logo, price baked in). Mirrors AppBanner.imageOnly and is carried across by
  // legacyBannerSyncService, so the apps render the poster on its own instead
  // of painting their gradient, title and Bike Service button over it.
  imageOnly: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
});

// parallel_hooks: false makes the plugin finish assigning `id` before the
// bannerId hook below runs, so that hook can build the ID from it.
bannerSchema.plugin(AutoIncrement, {
  id: "banner_seq",
  inc_field: "id",
  parallel_hooks: false,
});

// Pre-save hook to generate readable bannerId, e.g. BAN001, BAN002.
// Built from the auto-increment `id` (an atomic counter in the counters
// collection), never from a document count: the counter only moves forward,
// so deleting banners can never cause a later bannerId to collide with an
// existing one.
bannerSchema.pre("save", function (next) {
  if (!this.isNew || this.bannerId) return next();
  if (!this.id) return next(new Error("Banner sequence id was not assigned"));
  this.bannerId = `BAN${String(this.id).padStart(3, "0")}`;
  next();
});

module.exports = mongoose.model("Banner", bannerSchema);
