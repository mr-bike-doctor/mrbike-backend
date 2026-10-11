const mongoose = require('mongoose');

const rsaAreaSchema = new mongoose.Schema({
  name: {type: String, required: true, trim: true, maxlength: 120},
  isActive: {type: Boolean, default: false, index: true},
  // GeoJSON coordinates [longitude, latitude]. Areas are disabled until an
  // admin supplies and enables a valid Polygon/MultiPolygon.
  boundary: {type: {type: String, enum: ['Polygon', 'MultiPolygon']}, coordinates: {type: Array, default: undefined}},
}, {timestamps: true});

rsaAreaSchema.index({boundary: '2dsphere'});
module.exports = mongoose.models.RSAArea || mongoose.model('RSAArea', rsaAreaSchema);
