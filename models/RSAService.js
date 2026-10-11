const mongoose = require('mongoose');

const rsaServiceSchema = new mongoose.Schema({
  name: {type: String, required: true, trim: true, maxlength: 100},
  description: {type: String, default: '', trim: true, maxlength: 500},
  icon: {type: String, default: 'wrench', trim: true, maxlength: 80},
  type: {type: String, enum: ['repair', 'puncture', 'battery', 'towing', 'fuel', 'other'], required: true},
  requiresTowingCapability: {type: Boolean, default: false},
  compatibleBikeModels: {type: [String], default: []},
  isActive: {type: Boolean, default: false, index: true},
}, {timestamps: true, optimisticConcurrency: true});

rsaServiceSchema.index({name: 1}, {unique: true, collation: {locale: 'en', strength: 2}});
module.exports = mongoose.models.RSAService || mongoose.model('RSAService', rsaServiceSchema);
