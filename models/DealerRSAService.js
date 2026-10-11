const mongoose = require('mongoose');

const dealerRSAServiceSchema = new mongoose.Schema({
  dealerId: {type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true},
  serviceId: {type: mongoose.Schema.Types.ObjectId, ref: 'RSAService', required: true, index: true},
  proposedPrice: {type: Number, min: 0, required: true},
  approvedPrice: {type: Number, min: 0, default: null},
  priceStatus: {type: String, enum: ['pending', 'approved', 'rejected', 'revision_requested', 'acceptance_pending'], default: 'pending', index: true},
  dealerActive: {type: Boolean, default: false, index: true},
  revisionPrice: {type: Number, min: 0, default: null},
  reviewReason: {type: String, default: ''},
  reviewedBy: {type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null},
  reviewedAt: {type: Date, default: null},
  priceVersion: {type: Number, default: 1},
}, {timestamps: true, optimisticConcurrency: true});

dealerRSAServiceSchema.index({dealerId: 1, serviceId: 1}, {unique: true});
module.exports = mongoose.models.DealerRSAService || mongoose.model('DealerRSAService', dealerRSAServiceSchema);
