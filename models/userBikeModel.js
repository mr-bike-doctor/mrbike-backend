// UserBike.js (Updated Schema)
const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const userBikeSchema = new mongoose.Schema(
  {
    bike_id: { type: Number, unique: true },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "customers",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    bike_cc: {
      type: String,
      required: true,
    },
    plate_number: {
      type: String,
      required: true,
    },
    variant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BikeVariant", 
      required: true,
    },
    status: {
      type: Number,
      default: 1, 
    },
    // RSA-only write guard serializes concurrent active assistance requests per bike.
    rsaRequestGuardVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

// A plate is unique to its owner's garage, not to the whole platform: a bike
// gets resold, and two riders in the same household register the same bike on
// their own accounts. A global unique index on plate_number rejected both, and
// the rider could not see why — the plate blocking them sat in someone else's
// account, invisible to getMyBikes.
//
// Existing databases still carry the old `plate_number_1` index. Mongoose will
// build this compound index on boot but cannot drop that one:
// run `node scripts/fixUserBikePlateIndex.js` once per environment.
userBikeSchema.index({ user_id: 1, plate_number: 1 }, { unique: true });

userBikeSchema.plugin(AutoIncrement, { id: "UserBike", inc_field: "bike_id" });

module.exports = mongoose.model("UserBike", userBikeSchema);
