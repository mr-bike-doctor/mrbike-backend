const mongoose = require('mongoose');

const offerSchema = new mongoose.Schema({
  dealerId: {type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true},
  state: {type: String, enum: ['offered', 'accepted', 'rejected', 'expired', 'won'], default: 'offered'},
  approvedPrice: {type: Number, min: 0, required: true},
  offeredAt: {type: Date, default: Date.now},
  expiresAt: {type: Date, required: true},
  respondedAt: {type: Date, default: null},
  rejectionReason: {type: String, default: ''},
}, {_id: false});

const rsaRequestSchema = new mongoose.Schema({
  customerId: {type: mongoose.Schema.Types.ObjectId, ref: 'customers', required: true, index: true},
  serviceId: {type: mongoose.Schema.Types.ObjectId, ref: 'RSAService', required: true},
  bikeId: {type: mongoose.Schema.Types.ObjectId, ref: 'UserBike', required: true},
  location: {latitude: {type: Number, required: true}, longitude: {type: Number, required: true}, label: {type: String, default: ''}},
  description: {type: String, default: '', maxlength: 1000},
  photoUrl: {type: String, default: ''},
  providerLocation: {latitude:Number,longitude:Number,accuracy:Number,heading:Number,capturedAt:Date,receivedAt:Date},
  dispatchMode: {type: String, enum: ['auto', 'manual'], required: true},
  status: {type: String, enum: ['searching','assigned','on_the_way','arrived','inspection','repair','towing','payment_pending','completed','cancelled','failed'], default: 'searching', index: true},
  offers: {type: [offerSchema], default: []},
  candidateDealerIds: [{type: mongoose.Schema.Types.ObjectId, ref: 'Vendor'}],
  assignedDealerId: {type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true},
  assignedPrice: {type: Number, min: 0, default: null},
  idempotencyKey: {type: String, required: true},
  dispatchCursor: {type: Number, default: 0},
  dispatchLeaseUntil: {type: Date, default: null},
  inspectionNotes: {type: String, default: '', maxlength: 2000},
  estimateAmount: {type: Number, min: 0, default: null},
  estimateLines: {type: [{description:{type:String,required:true,maxlength:160},amount:{type:Number,min:0,required:true}}], default: []},
  estimateVersion: {type:Number,default:0},
  estimateStatus: {type: String, enum: ['none','pending_customer','approved','declined'], default: 'none'},
  dealerWorkStatus: {type: String, default: ''},
  repairStartedAt: {type:Date,default:null},
  paymentStatus: {type:String,enum:['not_required','pending','cash_confirmed'],default:'pending'},
  paymentAmount: {type:Number,min:0,default:null},
  paymentIdempotencyKey: {type:String,default:''},
  cashConfirmedAt: {type:Date,default:null},
  customerCompletionConfirmedAt: {type:Date,default:null},
  towingDestination: {label:{type:String,default:''},latitude:Number,longitude:Number},
  towingStages: {type:[{stage:String,at:{type:Date,default:Date.now},latitude:Number,longitude:Number}],default:[]},
  handoverCodeHash: {type:String,default:''},
  handoverVerifiedAt: {type:Date,default:null},
  photos: {type:[{url:String,key:String,uploadedAt:{type:Date,default:Date.now}}],default:[]},
  version: {type: Number, default: 0},
  completedAt: {type: Date, default: null},
  cancelledAt: {type: Date, default: null},
}, {timestamps: true});

rsaRequestSchema.index({customerId: 1, idempotencyKey: 1}, {unique: true});
rsaRequestSchema.index({status: 1, 'offers.state': 1, 'offers.expiresAt': 1});
module.exports = mongoose.models.RSARequest || mongoose.model('RSARequest', rsaRequestSchema);
