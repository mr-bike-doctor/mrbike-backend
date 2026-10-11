const mongoose = require('mongoose');

const rsaAuditSchema = new mongoose.Schema({
  entityType: {type: String, enum: ['service', 'dealer_service', 'area', 'dealer_permission', 'request'], required: true},
  entityId: {type: mongoose.Schema.Types.ObjectId, required: true, index: true},
  actorId: {type: mongoose.Schema.Types.ObjectId, required: true},
  actorRole: {type: String, enum: ['admin', 'dealer', 'customer'], required: true},
  action: {type: String, required: true},
  before: {type: mongoose.Schema.Types.Mixed, default: null},
  after: {type: mongoose.Schema.Types.Mixed, default: null},
  reason: {type: String, default: ''},
}, {timestamps: true});

module.exports = mongoose.models.RSAAudit || mongoose.model('RSAAudit', rsaAuditSchema);
