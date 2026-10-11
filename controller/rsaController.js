const mongoose = require('mongoose');
const crypto = require('crypto');
const RSAService = require('../models/RSAService');
const DealerRSAService = require('../models/DealerRSAService');
const RSAArea = require('../models/RSAArea');
const RSAAudit = require('../models/RSAAudit');
const Vendor = require('../models/dealerModel');
const UserBike = require('../models/userBikeModel');
const RSARequest = require('../models/RSARequest');
const {eligibleAt,advance,withTransaction,emit,BATCH_SIZE,OFFER_TTL_MS} = require('../services/rsaDispatch');
const {coordinatesValid, validBoundary, moneyValid, distanceKm} = require('../services/rsaValidation');

const idValid = value => mongoose.Types.ObjectId.isValid(String(value || ''));
const refId = value => String(value?._id || value || '');
const audit = (entityType, entityId, actorId, actorRole, action, before, after, reason = '') => RSAAudit.create({entityType, entityId, actorId, actorRole, action, before, after, reason});
const ok = (res, data, status = 200) => res.status(status).json({success: true, data});
const fail = (res, status, message) => res.status(status).json({success: false, message});
const safeService = doc => ({id: String(doc._id), name: doc.name, description: doc.description, icon: doc.icon, type: doc.type, requiresTowingCapability: doc.requiresTowingCapability, compatibleBikeModels: doc.compatibleBikeModels||[], isActive: doc.isActive});

exports.customerCatalog = async (_req, res) => {
  try { const rows = await RSAService.find({isActive: true}).sort({name: 1}).lean(); return ok(res, rows.map(safeService)); }
  catch (e) { return fail(res, 500, 'Could not load roadside catalog'); }
};

exports.adminServices = async (_req, res) => ok(res, (await RSAService.find().sort({createdAt: -1}).lean()).map(safeService));
exports.createService = async (req, res) => {
  try {
    const {name, description = '', icon = 'wrench', type, requiresTowingCapability = false, compatibleBikeModels = []} = req.body || {};
    if (!name?.trim() || !['repair','puncture','battery','towing','fuel','other'].includes(type)) return fail(res, 400, 'Valid name and type are required');
    if (!Array.isArray(compatibleBikeModels) || compatibleBikeModels.some(x=>typeof x!=='string'||x.length>100)) return fail(res,400,'Compatible bike models must be a list of model names');
    const row = await RSAService.create({name: name.trim(), description, icon, type, compatibleBikeModels, requiresTowingCapability: type === 'towing' || requiresTowingCapability, isActive: false});
    await audit('service', row._id, req.admin_id, 'admin', 'created', null, safeService(row));
    return ok(res, safeService(row), 201);
  } catch (e) { return fail(res, e.code === 11000 ? 409 : 400, e.code === 11000 ? 'Service name already exists' : 'Could not create service'); }
};
exports.updateService = async (req, res) => {
  try {
    if (!idValid(req.params.id)) return fail(res, 400, 'Invalid service id');
    const allowed = ['name','description','icon','type','isActive','requiresTowingCapability','compatibleBikeModels'];
    const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
    if (patch.name !== undefined && !String(patch.name).trim()) return fail(res, 400, 'Name cannot be empty');
    if (patch.type && !['repair','puncture','battery','towing','fuel','other'].includes(patch.type)) return fail(res, 400, 'Invalid service type');
    if (patch.type === 'towing') patch.requiresTowingCapability = true;
    if (patch.compatibleBikeModels !== undefined && (!Array.isArray(patch.compatibleBikeModels)||patch.compatibleBikeModels.some(x=>typeof x!=='string'||x.length>100))) return fail(res,400,'Compatible bike models must be a list of model names');
    const before = await RSAService.findById(req.params.id); if (!before) return fail(res, 404, 'Service not found');
    const row = await RSAService.findOneAndUpdate({_id: before._id, __v: before.__v}, {$set: patch, $inc: {__v: 1}}, {new: true, runValidators: true});
    if (!row) return fail(res, 409, 'Service changed; reload and retry');
    await audit('service', row._id, req.admin_id, 'admin', 'updated', safeService(before), safeService(row));
    return ok(res, safeService(row));
  } catch (e) { return fail(res, 400, 'Could not update service'); }
};

exports.adminAreas = async (_req, res) => ok(res, await RSAArea.find().sort({name: 1}).lean());
exports.createArea = async (req, res) => {
  const {name, boundary} = req.body || {};
  if (!name?.trim() || !validBoundary(boundary)) return fail(res, 400, 'Name and valid closed GeoJSON Polygon/MultiPolygon are required');
  try { const row = await RSAArea.create({name: name.trim(), boundary, isActive: false}); await audit('area', row._id, req.admin_id, 'admin', 'created', null, row.toObject()); return ok(res, row, 201); }
  catch (e) { return fail(res, 400, 'Could not create RSA area'); }
};
exports.updateArea = async (req, res) => {
  if (!idValid(req.params.id)) return fail(res, 400, 'Invalid area id');
  const patch = {};
  if (req.body.name !== undefined) { if (!String(req.body.name).trim()) return fail(res, 400, 'Area name cannot be empty'); patch.name = String(req.body.name).trim(); }
  if (req.body.boundary !== undefined) { if (!validBoundary(req.body.boundary)) return fail(res, 400, 'Invalid GeoJSON boundary'); patch.boundary = req.body.boundary; }
  if (req.body.isActive !== undefined) { if (typeof req.body.isActive !== 'boolean') return fail(res, 400, 'isActive must be boolean'); if (req.body.isActive && !req.body.boundary) { const old = await RSAArea.findById(req.params.id); if (!old?.boundary) return fail(res, 400, 'Set a valid boundary before enabling this area'); } patch.isActive = req.body.isActive; }
  const before = await RSAArea.findById(req.params.id); if (!before) return fail(res, 404, 'Area not found');
  const row = await RSAArea.findByIdAndUpdate(req.params.id, {$set: patch}, {new:true, runValidators:true});
  await audit('area', row._id, req.admin_id, 'admin', 'updated', before.toObject(), row.toObject()); return ok(res, row);
};

exports.setDealerPermission = async (req, res) => {
  const {rsaEnabled, capabilities = [], capacity = 0} = req.body || {};
  if (!idValid(req.params.dealerId) || typeof rsaEnabled !== 'boolean' || !Array.isArray(capabilities) || capabilities.some(x => x !== 'towing') || !Number.isInteger(capacity) || capacity < 0 || capacity > 100) return fail(res, 400, 'Invalid RSA permission settings');
  const dealer = await Vendor.findById(req.params.dealerId); if (!dealer) return fail(res, 404, 'Dealer not found');
  const before = {rsaEnabled: dealer.rsaEnabled, rsaCapabilities: dealer.rsaCapabilities, rsaAvailableCapacity: dealer.rsaAvailableCapacity, rsaCapacityLimit: dealer.rsaCapacityLimit, rsaCapacityReserved: dealer.rsaCapacityReserved};
  if (capacity < Number(dealer.rsaCapacityReserved || 0)) return fail(res,409,'Capacity cannot be lower than currently reserved requests');
  dealer.rsaEnabled = rsaEnabled; dealer.rsaCapabilities = [...new Set(capabilities)]; dealer.rsaCapacityLimit = capacity; dealer.rsaAvailableCapacity = capacity - Number(dealer.rsaCapacityReserved || 0); await dealer.save();
  await audit('dealer_permission', dealer._id, req.admin_id, 'admin', 'updated', before, {rsaEnabled, capabilities: dealer.rsaCapabilities, capacity, reserved: dealer.rsaCapacityReserved});
  return ok(res, {dealerId: String(dealer._id), rsaEnabled: dealer.rsaEnabled, capabilities: dealer.rsaCapabilities, capacity: dealer.rsaCapacityLimit, reserved: dealer.rsaCapacityReserved});
};

exports.dealerCatalog = async (_req, res) => ok(res, (await RSAService.find({isActive:true}).sort({name:1}).lean()).map(safeService));
exports.dealerServices = async (req, res) => ok(res, await DealerRSAService.find({dealerId:req.dealer_id}).populate('serviceId').sort({updatedAt:-1}).lean());
exports.addDealerService = async (req, res) => {
  const {serviceId, price} = req.body || {};
  if (!idValid(serviceId) || !moneyValid(price)) return fail(res, 400, 'Valid serviceId and price are required');
  const [service, dealer] = await Promise.all([RSAService.findOne({_id:serviceId,isActive:true}), Vendor.findById(req.dealer_id)]);
  if (!service) return fail(res, 404, 'Active RSA service not found');
  if (!dealer.rsaEnabled || (service.requiresTowingCapability && !dealer.rsaCapabilities?.includes('towing'))) return fail(res, 403, 'Dealer is not approved for this RSA capability');
  try {
    const row = await DealerRSAService.create({dealerId:req.dealer_id,serviceId,proposedPrice:Number(price),priceStatus:'pending',dealerActive:false});
    await audit('dealer_service',row._id,req.dealer_id,'dealer','price_submitted',null,row.toObject()); return ok(res,row,201);
  } catch (e) { return fail(res,e.code===11000?409:400,e.code===11000?'RSA service is already assigned':'Could not submit service'); }
};
exports.submitPrice = async (req,res) => {
  const {price} = req.body || {}; if (!moneyValid(price)) return fail(res,400,'Valid price is required');
  const row = await DealerRSAService.findOne({ _id:req.params.id, dealerId:req.dealer_id }); if (!row) return fail(res,404,'RSA service not found');
  if (row.priceStatus === 'acceptance_pending') return fail(res,409,'Accept or decline the corrected price first');
  const before = row.toObject(); row.proposedPrice=Number(price); row.priceStatus='pending'; row.dealerActive=false; row.revisionPrice=null; row.reviewReason=''; row.priceVersion += 1; await row.save();
  await audit('dealer_service',row._id,req.dealer_id,'dealer','price_resubmitted',before,row.toObject()); return ok(res,row);
};
exports.toggleDealerService = async (req,res) => {
  const {active} = req.body || {}; if (typeof active !== 'boolean') return fail(res,400,'active must be boolean');
  const row = await DealerRSAService.findOne({_id:req.params.id,dealerId:req.dealer_id}).populate('serviceId'); if (!row) return fail(res,404,'RSA service not found');
  if (active && (row.priceStatus !== 'approved' || !row.serviceId?.isActive)) return fail(res,409,'Only approved services in the active global catalog can be enabled');
  const before=row.toObject(); row.dealerActive=active; await row.save(); await audit('dealer_service',row._id,req.dealer_id,'dealer',active?'activated':'deactivated',before,row.toObject()); return ok(res,row);
};
exports.acceptRevision = async (req,res) => {
  const {accept} = req.body || {}; if (typeof accept !== 'boolean') return fail(res,400,'accept must be boolean');
  const row=await DealerRSAService.findOne({_id:req.params.id,dealerId:req.dealer_id}); if (!row) return fail(res,404,'RSA service not found');
  if(row.priceStatus!=='acceptance_pending'||row.revisionPrice==null) return fail(res,409,'No corrected price is awaiting acceptance');
  const before=row.toObject();
  if(accept){row.proposedPrice=row.revisionPrice;row.approvedPrice=row.revisionPrice;row.priceStatus='approved';row.dealerActive=false;row.revisionPrice=null;} else {row.priceStatus='rejected';row.dealerActive=false;row.revisionPrice=null;}
  await row.save(); await audit('dealer_service',row._id,req.dealer_id,'dealer',accept?'revision_accepted':'revision_declined',before,row.toObject()); return ok(res,row);
};

exports.adminProposals = async (_req,res) => ok(res,await DealerRSAService.find().populate('serviceId dealerId','name shopName phone').sort({updatedAt:-1}).lean());
exports.reviewPrice = async (req,res) => {
  const {action,price,reason=''}=req.body||{}; if(!['approve','reject','revise','revoke'].includes(action)) return fail(res,400,'Invalid review action');
  if(['revise','approve'].includes(action)&&!moneyValid(price)) return fail(res,400,'Valid price is required');
  if(['reject','revoke'].includes(action)&&!String(reason).trim()) return fail(res,400,'A reason is required');
  const row=await DealerRSAService.findById(req.params.id); if(!row) return fail(res,404,'Proposal not found');
  if(row.priceStatus==='acceptance_pending') return fail(res,409,'Dealer response is pending');
  const before=row.toObject();
  if(action==='approve'){row.approvedPrice=Number(price);row.proposedPrice=Number(price);row.priceStatus='approved';row.revisionPrice=null;row.reviewReason='';}
  if(action==='reject'){row.priceStatus='rejected';row.dealerActive=false;row.reviewReason=String(reason).slice(0,500);}
  if(action==='revise'){row.priceStatus='acceptance_pending';row.revisionPrice=Number(price);row.dealerActive=false;row.reviewReason=String(reason).slice(0,500);}
  if(action==='revoke'){row.priceStatus='rejected';row.dealerActive=false;row.reviewReason=String(reason).slice(0,500);}
  row.reviewedBy=req.admin_id;row.reviewedAt=new Date();row.priceVersion+=1;
  const saved=await DealerRSAService.findOneAndUpdate(
    {_id:row._id,priceVersion:before.priceVersion},
    {$set:{proposedPrice:row.proposedPrice,approvedPrice:row.approvedPrice,priceStatus:row.priceStatus,dealerActive:row.dealerActive,revisionPrice:row.revisionPrice,reviewReason:row.reviewReason,reviewedBy:row.reviewedBy,reviewedAt:row.reviewedAt},$inc:{priceVersion:1}},
    {new:true,runValidators:true}
  );
  if(!saved) return fail(res,409,'Price changed concurrently; reload and retry');
  await audit('dealer_service',saved._id,req.admin_id,'admin',action,before,saved.toObject(),reason); return ok(res,saved);
};

exports.nearbyPartners = async (req,res) => {
  const {serviceId,latitude,longitude,bikeId}=req.query;
  if(!idValid(serviceId)||!coordinatesValid(latitude,longitude)||!idValid(bikeId)) return fail(res,400,'Valid service, bike and breakdown coordinates are required');
  if(process.env.RSA_REQUESTS_ENABLED!=='true') return ok(res,{available:false,reason:'rsa_temporarily_unavailable',providers:[]});
  const bike = await UserBike.findOne({_id:bikeId,user_id:req.user_id,status:1}).select('_id').lean();
  if(!bike) return fail(res,403,'Bike is not active or does not belong to this customer');
  const found=await eligibleAt(serviceId,bikeId,{latitude:Number(latitude),longitude:Number(longitude)},null);
  if(!found.service)return ok(res,{available:false,reason:'service_unavailable',providers:[]});
  if(found.incompatible)return ok(res,{available:false,reason:'bike_incompatible',providers:[]});
  if(!found.area)return ok(res,{available:false,reason:'area_unavailable',providers:[]});
  const bikeRecord=await UserBike.findById(bikeId).select('name model').lean();
  const bikeName=`${bikeRecord?.name||''} ${bikeRecord?.model||''}`.toLowerCase();
  const providers=found.providers.filter(p=>!p.offering.compatibleBikes?.length||p.offering.compatibleBikes.some(pattern=>bikeName.includes(String(pattern).toLowerCase()))).map(({dealer,offering,distanceKm:value})=>({dealerId:String(dealer._id),garageName:dealer.shopName,verified:dealer.status?.isVerified===true,rating:dealer.ratingCount?dealer.averageRating:null,distanceKm:Number(value.toFixed(2)),approvedPrice:offering.approvedPrice}));
  return ok(res,{available:providers.length>0,area:{id:String(found.area._id),name:found.area.name},reason:providers.length?'eligible_providers_found':'no_eligible_providers',providers});
};

const publicRequest = (request, includeLocation = true) => {
  if (!request) return null;
  const data = {
    id:String(request._id), serviceId:refId(request.serviceId), bikeId:refId(request.bikeId), status:request.status,
    dispatchMode:request.dispatchMode, assignedDealerId:request.assignedDealerId ? refId(request.assignedDealerId) : null,
    assignedPrice:request.assignedPrice, offers:(request.offers||[]).map(o=>({dealerId:String(o.dealerId),state:o.state,approvedPrice:o.approvedPrice,expiresAt:o.expiresAt})),
    description:request.description, photoUrl:request.photoUrl, inspectionNotes:request.inspectionNotes, estimateAmount:request.estimateAmount,
    estimateLines:request.estimateLines||[],estimateVersion:request.estimateVersion||0,paymentStatus:request.paymentStatus||'pending',paymentAmount:request.paymentAmount,
    customerCompletionConfirmedAt:request.customerCompletionConfirmedAt,repairStartedAt:request.repairStartedAt,towingDestination:request.towingDestination||null,
    towingStages:request.towingStages||[],handoverVerifiedAt:request.handoverVerifiedAt,
    estimateStatus:request.estimateStatus, dealerWorkStatus:request.dealerWorkStatus, createdAt:request.createdAt, updatedAt:request.updatedAt,
  };
  if(includeLocation) data.location=request.location;
  if(includeLocation&&request.status==='on_the_way'&&request.providerLocation){const capturedAt=new Date(request.providerLocation.capturedAt).getTime();if(Number.isFinite(capturedAt)&&Date.now()-capturedAt<=45000)data.providerLocation=request.providerLocation;}
  if(request.photos)data.photoCount=request.photos.length;
  return data;
};

const photosFor = request => ({photos:(request.photos||[]).map(({url,uploadedAt})=>({url,uploadedAt}))});

exports.createRequest = async (req,res) => {
  if(process.env.RSA_REQUESTS_ENABLED!=='true') return fail(res,503,'Roadside requests are not enabled yet');
  const {serviceId,bikeId,latitude,longitude,locationLabel='',dispatchMode='auto',dealerId,description=''}=req.body||{};
  if(!idValid(serviceId)||!idValid(bikeId)||!coordinatesValid(latitude,longitude)||!['auto','manual'].includes(dispatchMode)) return fail(res,400,'Valid service, bike, GPS coordinates and dispatch mode are required');
  if(dispatchMode==='manual'&&!idValid(dealerId)) return fail(res,400,'Choose an eligible garage');
  const idempotencyKey=String(req.get('x-idempotency-key')||req.body.idempotencyKey||'').trim();
  if(!idempotencyKey||idempotencyKey.length>128) return fail(res,400,'A valid idempotency key is required');
  if(typeof description!=='string'||description.length>1000||req.body.photoUrl) return fail(res,400,'Description is invalid; upload photos through the secure RSA photo endpoint');
  const session=await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async()=>{
      const existing=await RSARequest.findOne({customerId:req.user_id,idempotencyKey}).session(session);
      if(existing){created=existing;return;}
      const bike=await UserBike.findOne({_id:bikeId,user_id:req.user_id,status:1}).session(session).lean();
      if(!bike) throw Object.assign(new Error('Bike is not active or does not belong to this customer'),{httpStatus:403});
      const location={latitude:Number(latitude),longitude:Number(longitude),label:String(locationLabel).slice(0,200)};
      const found=await eligibleAt(serviceId,bikeId,location,session);
      if(!found.service) throw Object.assign(new Error('RSA service is unavailable'),{httpStatus:409});
      if(found.incompatible) throw Object.assign(new Error('This RSA service is not available for the selected bike'),{httpStatus:409});
      if(!found.area) throw Object.assign(new Error('RSA service is unavailable in this area'),{httpStatus:409});
      const bikeModel=`${bike.name||''} ${bike.model||''}`.toLowerCase();
      let providers=found.providers.filter(p=>!p.offering.compatibleBikes?.length||p.offering.compatibleBikes.some(pattern=>bikeModel.includes(String(pattern).toLowerCase())));
      if(dispatchMode==='manual') providers=providers.filter(p=>String(p.dealer._id)===String(dealerId));
      if(!providers.length) throw Object.assign(new Error('No eligible roadside partner is currently available'),{httpStatus:409});
      const activeDuplicate=await RSARequest.findOne({customerId:req.user_id,bikeId,status:{$in:['searching','assigned','on_the_way','arrived','inspection','repair','towing','payment_pending']}}).session(session);
      if(activeDuplicate) throw Object.assign(new Error('An active roadside request already exists for this bike'),{httpStatus:409});
      const candidateDealerIds=providers.map(p=>p.dealer._id);
      const offerProviders=dispatchMode==='manual'?providers.slice(0,1):providers.slice(0,BATCH_SIZE);
      const now=new Date(), ttl=OFFER_TTL_MS;
      created=(await RSARequest.create([{customerId:req.user_id,serviceId,bikeId,location,description:description.trim(),dispatchMode,status:'searching',candidateDealerIds,dispatchCursor:offerProviders.length,idempotencyKey,dispatchLeaseUntil:new Date(now.getTime()+ttl),offers:offerProviders.map(p=>({dealerId:p.dealer._id,approvedPrice:p.offering.approvedPrice,offeredAt:now,expiresAt:new Date(now.getTime()+ttl),state:'offered'}))}],{session}))[0];
    });
    const io=req.app.get('io');
    if(created?.offers?.length) emit(io,'rsa:request-offered',created,created.offers.map(o=>o.dealerId));
    return ok(res,publicRequest(created),201);
  } catch(e) {
    if(e.code===11000){const existing=await RSARequest.findOne({customerId:req.user_id,idempotencyKey}).lean();if(existing)return ok(res,publicRequest(existing),200);}
    return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not create roadside request');
  } finally {await session.endSession();}
};

exports.customerRequests=async(req,res)=>{
  const rows=await RSARequest.find({customerId:req.user_id}).sort({createdAt:-1}).limit(30).lean();
  return ok(res,rows.map(r=>publicRequest(r)));
};

exports.getCustomerRequest=async(req,res)=>{
  if(!idValid(req.params.id))return fail(res,400,'Invalid request id');
  let request=await RSARequest.findById(req.params.id).populate('serviceId','name type description').populate('bikeId','name model bike_cc plate_number').lean();
  if(!request)return fail(res,404,'Request not found');
  if(String(request.customerId)!==String(req.user_id))return fail(res,403,'You cannot access this roadside request');
  return ok(res,{...publicRequest(request),...photosFor(request),service:request.serviceId,bike:request.bikeId});
};

exports.getDealerRequest=async(req,res)=>{
  if(!idValid(req.params.id))return fail(res,400,'Invalid request id');
  const request=await RSARequest.findById(req.params.id).populate('serviceId','name type description').populate('bikeId','name model bike_cc plate_number').populate('assignedDealerId','shopName phone').lean();
  if(!request)return fail(res,404,'Request not found');
  const terminal=['completed','cancelled','failed'].includes(request.status);
  const current=!terminal&&(String(request.assignedDealerId||'')===String(req.dealer_id)||request.offers.some(o=>String(o.dealerId)===String(req.dealer_id)&&o.state==='offered'&&o.expiresAt>new Date()&&request.status==='searching'));
  if(!current)return fail(res,403,'This offer is no longer active');
  return ok(res,{...publicRequest(request),...photosFor(request),service:request.serviceId,bike:request.bikeId,assignedDealer:request.assignedDealerId});
};

exports.dealerRequests=async(req,res)=>{
  const now=new Date();
  const rows=await RSARequest.find({$or:[{status:'searching',offers:{$elemMatch:{dealerId:req.dealer_id,state:'offered',expiresAt:{$gt:now}}}},{assignedDealerId:req.dealer_id,status:{$nin:['completed','cancelled','failed']}}]}).populate('serviceId','name type').populate('bikeId','name model plate_number bike_cc').sort({createdAt:-1}).limit(50).lean();
  return ok(res,rows.map(r=>({...publicRequest(r),...photosFor(r)})));
};

exports.respondOffer=async(req,res)=>{
  const {action,reason=''}=req.body||{};
  if(!['accept','reject'].includes(action))return fail(res,400,'Action must be accept or reject');
  let outcome;
  try {
    outcome=await withTransaction(async session=>{
      const request=await RSARequest.findOne({_id:req.params.id,status:'searching',offers:{$elemMatch:{dealerId:req.dealer_id,state:'offered',expiresAt:{$gt:new Date()}}}}).session(session);
      if(!request)throw Object.assign(new Error('Offer is expired or no longer available'),{httpStatus:409});
      const offer=request.offers.find(o=>String(o.dealerId)===String(req.dealer_id)&&o.state==='offered'&&o.expiresAt>new Date());
      const fresh=await eligibleAt(request.serviceId,request.bikeId,request.location,session);
      const provider=fresh.providers.find(p=>String(p.dealer._id)===String(req.dealer_id));
      if(!provider)throw Object.assign(new Error('Dealer is no longer eligible for this request'),{httpStatus:409});
      if(action==='reject'){
        offer.state='rejected';offer.respondedAt=new Date();offer.rejectionReason=String(reason).slice(0,300);request.version+=1;await request.save({session});return {request,rejected:true};
      }
      const previousDealerIds=request.offers.filter(o=>o.state==='offered').map(o=>o.dealerId);
      const cap=await Vendor.updateOne({_id:req.dealer_id,rsaEnabled:true,online:true,'status.isActive':true,'status.adminApproved':true,rsaAvailableCapacity:{$gt:0},rsaCapacityLimit:{$gt:0},$expr:{$lt:[{$ifNull:['$rsaCapacityReserved',0]},'$rsaCapacityLimit']},...(fresh.service?.requiresTowingCapability?{rsaCapabilities:'towing'}:{})},{$inc:{rsaCapacityReserved:1,rsaAvailableCapacity:-1}},{session});
      if(cap.modifiedCount!==1)throw Object.assign(new Error('Dealer RSA capacity is no longer available'),{httpStatus:409});
      offer.state='accepted';offer.respondedAt=new Date();
      request.offers.forEach(o=>{if(o!==offer&&o.state==='offered'){o.state='expired';o.respondedAt=new Date();}});
      request.assignedDealerId=req.dealer_id;request.assignedPrice=offer.approvedPrice;request.status='assigned';request.dispatchLeaseUntil=null;request.version+=1;
      await request.save({session});return {request,assigned:true,previousDealerIds};
    });
  } catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not respond to offer');}
  if(outcome.rejected){
    await advance(req.params.id,req.app.get('io')).catch(()=>{});
    emit(req.app.get('io'),'rsa:request-rejected',outcome.request,[req.dealer_id]);
  }
  emit(req.app.get('io'),'rsa:updated',outcome.request,[req.dealer_id,...(outcome.previousDealerIds||[])]);
  return ok(res,publicRequest(outcome.request));
};

exports.cancelRequest=async(req,res)=>{
  let request,previousDealerIds=[];
  try {request=await withTransaction(async session=>{
    const row=await RSARequest.findOne({_id:req.params.id,customerId:req.user_id,status:{$nin:['completed','cancelled','failed']}}).session(session);
    if(!row)throw Object.assign(new Error('Request cannot be cancelled'),{httpStatus:404});
    previousDealerIds=row.offers.filter(o=>o.state==='offered').map(o=>o.dealerId);
    if(row.assignedDealerId)previousDealerIds.push(row.assignedDealerId);
    if(row.assignedDealerId){const released=await Vendor.updateOne({_id:row.assignedDealerId,rsaCapacityReserved:{$gt:0}},{$inc:{rsaCapacityReserved:-1,rsaAvailableCapacity:1}},{session});if(released.modifiedCount!==1)throw new Error('Could not release reserved RSA capacity');}
    row.status='cancelled';row.cancelledAt=new Date();row.providerLocation=undefined;row.version+=1;row.offers.forEach(o=>{if(o.state==='offered')o.state='expired';});await row.save({session});return row;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not cancel request');}
  emit(req.app.get('io'),'rsa:updated',request,previousDealerIds);return ok(res,publicRequest(request));
};

exports.dealerUpdateStatus=async(req,res)=>{
  const {status,inspectionNotes='',estimateAmount}=req.body||{};
  const allowed={assigned:['on_the_way','cancelled'],on_the_way:['arrived','cancelled'],arrived:['inspection','cancelled'],inspection:['repair','payment_pending','cancelled'],repair:['payment_pending','cancelled'],towing:['payment_pending','cancelled'],payment_pending:['completed','cancelled']};
  if(status==='inspection'&&typeof inspectionNotes!=='string')return fail(res,400,'Inspection findings must be text');
  if(estimateAmount!==undefined&&!moneyValid(estimateAmount))return fail(res,400,'Invalid estimate amount');
  let row;
  try {row=await withTransaction(async session=>{
    const current=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:{$nin:['completed','cancelled','failed']}}).session(session);
    if(!current)throw Object.assign(new Error('Assigned request not found'),{httpStatus:404});
    if(!allowed[current.status]?.includes(status))throw Object.assign(new Error('Invalid roadside status transition'),{httpStatus:409});
    if(['pending_customer','declined'].includes(current.estimateStatus)&&['repair','towing','payment_pending','completed'].includes(status))throw Object.assign(new Error('Wait for customer estimate approval before continuing work'),{httpStatus:409});
    if(status==='inspection'&&estimateAmount!==undefined){current.estimateAmount=Number(estimateAmount);current.estimateLines=[{description:'Repair estimate',amount:Number(estimateAmount)}];current.estimateVersion+=1;current.estimateStatus='pending_customer';}
    if(status==='inspection'&&estimateAmount===undefined&&current.estimateStatus==='pending_customer')throw Object.assign(new Error('Submit a revised estimate before leaving inspection'),{httpStatus:409});
    if(status==='payment_pending'){if(!['repair','towing'].includes(current.status))throw Object.assign(new Error('Complete the roadside work before requesting payment'),{httpStatus:409});if(current.estimateStatus==='pending_customer'||current.estimateStatus==='declined')throw Object.assign(new Error('Customer approval is required before requesting payment'),{httpStatus:409});current.paymentAmount=Number(current.estimateAmount??current.assignedPrice);current.paymentStatus=current.paymentAmount>0?'pending':'not_required';}
    if(inspectionNotes)current.inspectionNotes=inspectionNotes.slice(0,2000);
    current.status=status;current.dealerWorkStatus=status;current.version+=1;
    if(status==='repair'&&current.status==='inspection'){if(current.estimateStatus==='pending_customer'||current.estimateStatus==='declined')throw Object.assign(new Error('Customer estimate approval is required'),{httpStatus:409});current.repairStartedAt=new Date();}
    if(status==='completed'){if(current.estimateStatus==='pending_customer'||current.estimateStatus==='declined')throw Object.assign(new Error('Customer approval is required before completion'),{httpStatus:409});if(current.paymentStatus==='pending'&&Number(current.paymentAmount||current.assignedPrice||0)>0)throw Object.assign(new Error('Cash payment must be confirmed before completion'),{httpStatus:409});if(current.status==='towing'&&!current.handoverVerifiedAt)throw Object.assign(new Error('Secure towing handover must be verified before completion'),{httpStatus:409});if(current.status==='repair'&&!current.customerCompletionConfirmedAt)throw Object.assign(new Error('Customer completion confirmation is required'),{httpStatus:409});current.completedAt=new Date();current.providerLocation=undefined;}
    if(status==='cancelled'){current.cancelledAt=new Date();current.providerLocation=undefined;}
    await current.save({session});
    if(['completed','cancelled'].includes(status)){
      const released=await Vendor.updateOne({_id:req.dealer_id,rsaCapacityReserved:{$gt:0}},{$inc:{rsaCapacityReserved:-1,rsaAvailableCapacity:1}},{session});
      if(released.modifiedCount!==1)throw new Error('Could not release reserved RSA capacity');
    }
    return current;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not update request');}
  emit(req.app.get('io'),'rsa:updated',row,[req.dealer_id]);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`]);return ok(res,publicRequest(row));
};

exports.adminAssign=async(req,res)=>{
  if(process.env.RSA_REQUESTS_ENABLED!=='true') return fail(res,503,'Roadside requests are not enabled yet');
  const {dealerId}=req.body||{};if(!idValid(dealerId))return fail(res,400,'Valid dealerId is required');
  let request;
  try {request=await withTransaction(async session=>{
    const current=await RSARequest.findOne({_id:req.params.id,status:'searching'}).session(session);if(!current)throw Object.assign(new Error('Searching request not found'),{httpStatus:404});
    const found=await eligibleAt(current.serviceId,current.bikeId,current.location,session);
    const provider=found.providers.find(p=>String(p.dealer._id)===String(dealerId));if(!provider)throw Object.assign(new Error('Dealer is not currently eligible'),{httpStatus:409});
    const now=new Date();current.dispatchMode='manual';current.candidateDealerIds=[dealerId];current.dispatchCursor=0;current.offers=[{dealerId,approvedPrice:provider.offering.approvedPrice,offeredAt:now,expiresAt:new Date(now.getTime()+OFFER_TTL_MS),state:'offered'}];current.dispatchLeaseUntil=new Date(now.getTime()+OFFER_TTL_MS);current.version+=1;await current.save({session});return current;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not assign request');}
  emit(req.app.get('io'),'rsa:request-offered',request,[dealerId]);return ok(res,publicRequest(request));
};

exports.adminRequests=async(_req,res)=>{
  const rows=await RSARequest.find({status:'searching'}).populate('serviceId','name type').populate('bikeId','name model plate_number').sort({createdAt:1}).limit(100).lean();
  return ok(res,rows.map(row=>({...publicRequest(row),customerId:String(row.customerId),service:row.serviceId,bike:row.bikeId})));
};

exports.customerEstimateResponse=async(req,res)=>{
  const {accept}=req.body||{};if(typeof accept!=='boolean')return fail(res,400,'accept must be boolean');
  const row=await RSARequest.findOne({_id:req.params.id,customerId:req.user_id,estimateStatus:'pending_customer'});if(!row)return fail(res,404,'No estimate is awaiting a response');
  row.estimateStatus=accept?'approved':'declined';row.version+=1;await row.save();await audit('request',row._id,req.user_id,'customer',accept?'estimate_approved':'estimate_declined',null,{estimateVersion:row.estimateVersion,estimateAmount:row.estimateAmount,estimateStatus:row.estimateStatus});emit(req.app.get('io'),'rsa:updated',row,row.assignedDealerId?[row.assignedDealerId]:[]);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`]);return ok(res,publicRequest(row));
};

const activeRequestStatuses=['assigned','on_the_way','arrived','inspection','repair','towing','payment_pending'];
exports.authorizePhotoUpload=async(req,res,next)=>{try{const row=await RSARequest.findById(req.params.id).select('customerId assignedDealerId status photos').lean();if(!row)return fail(res,404,'Roadside request not found');const customer=String(row.customerId)===String(req.user_id);if(!customer||!activeRequestStatuses.includes(row.status))return fail(res,403,'Only the request customer can upload photos to an active request');req.rsaPhotoRequest=row;next();}catch(_){return fail(res,500,'Could not authorize photo upload');}};
exports.uploadRequestPhoto=async(req,res)=>{const file=req.file;if(!file)return fail(res,400,'Choose an image to upload');const row=await RSARequest.findOne({_id:req.params.id,customerId:req.user_id,status:{$in:activeRequestStatuses},photos:{$size:0}});if(!row)return fail(res,409,'Photo limit reached or request is no longer active');row.photos=[{url:file.location,key:file.key,uploadedAt:new Date()}];row.photoUrl=file.location;row.version+=1;await row.save();await audit('request',row._id,req.user_id,'customer','photo_uploaded',null,{key:file.key});return ok(res,{id:String(row._id),photos:row.photos.map(({url,uploadedAt})=>({url,uploadedAt}))},201);};

exports.updateDealerLocation=async(req,res)=>{const {latitude,longitude,accuracy,capturedAt,heading}=req.body||{};if(!coordinatesValid(latitude,longitude)||!Number.isFinite(Number(accuracy))||Number(accuracy)<0||Number(accuracy)>100)return fail(res,400,'Valid coordinates and GPS accuracy up to 100m are required');const captured=new Date(capturedAt);const now=Date.now();if(!Number.isFinite(captured.getTime())||captured.getTime()>now+5000||now-captured.getTime()>30000)return fail(res,400,'GPS fix is stale or invalid');if(heading!==undefined&&(!Number.isFinite(Number(heading))||Number(heading)<0||Number(heading)>=360))return fail(res,400,'Invalid heading');const fix={latitude:Number(latitude),longitude:Number(longitude),accuracy:Number(accuracy),...(heading!==undefined?{heading:Number(heading)}:{}),capturedAt:captured,receivedAt:new Date()};const row=await RSARequest.findOneAndUpdate({_id:req.params.id,assignedDealerId:req.dealer_id,status:'on_the_way',$or:[{'providerLocation.capturedAt':{$lt:captured}},{providerLocation:{$exists:false}}]},{$set:{providerLocation:fix},$inc:{version:1}},{new:true});if(!row)return fail(res,409,'Request is not assigned to you or is not accepting GPS updates');const payload={requestId:String(row._id),location:fix};emit(req.app.get('io'),'rsa:location',payload,[`rsa:customer:${row.customerId}`]);emit(req.app.get('io'),'rsa:location',payload,['admin:rsa']);return ok(res,{accepted:true,capturedAt:captured});};

exports.customerCompletion=async(req,res)=>{const {confirm}=req.body||{};if(confirm!==true)return fail(res,400,'Customer completion confirmation is required');const row=await RSARequest.findOneAndUpdate({_id:req.params.id,customerId:req.user_id,status:{$in:['repair','towing']},customerCompletionConfirmedAt:null},{$set:{customerCompletionConfirmedAt:new Date()},$inc:{version:1}},{new:true});if(!row)return fail(res,409,'Request is not awaiting your completion confirmation');await audit('request',row._id,req.user_id,'customer','completion_confirmed',null,{at:row.customerCompletionConfirmedAt});emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(row.assignedDealerId)]);return ok(res,publicRequest(row));};

exports.confirmCashReceived=async(req,res)=>{const {amount,idempotencyKey}=req.body||{};if(!moneyValid(amount)||typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>128)return fail(res,400,'Valid amount and idempotency key are required');const row=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:'payment_pending'});if(!row)return fail(res,404,'Payment request not found');if(row.paymentStatus==='cash_confirmed')return row.paymentIdempotencyKey===idempotencyKey?ok(res,publicRequest(row)):fail(res,409,'Cash payment was already confirmed');if(row.estimateStatus==='pending_customer'||row.estimateStatus==='declined')return fail(res,409,'Customer estimate approval is required');const expected=Number(row.estimateAmount??row.assignedPrice);if(Number(amount)!==expected)return fail(res,409,'Cash amount must match the approved final amount');const saved=await RSARequest.findOneAndUpdate({_id:row._id,assignedDealerId:req.dealer_id,status:'payment_pending',paymentStatus:'pending',version:row.version},{$set:{paymentStatus:'cash_confirmed',paymentAmount:Number(amount),paymentIdempotencyKey:idempotencyKey,cashConfirmedAt:new Date()},$inc:{version:1}},{new:true});if(!saved)return fail(res,409,'Payment changed concurrently; reload and retry');await audit('request',saved._id,req.dealer_id,'dealer','cash_confirmed',{paymentStatus:'pending'},{amount:saved.paymentAmount,idempotencyKey});emit(req.app.get('io'),'rsa:updated',saved,[`rsa:customer:${saved.customerId}`,String(req.dealer_id)]);return ok(res,publicRequest(saved));};

exports.startTowing=async(req,res)=>{const {destination}=req.body||{};if(!destination||typeof destination.label!=='string'||!destination.label.trim()||!coordinatesValid(destination.latitude,destination.longitude))return fail(res,400,'A named towing destination with valid coordinates is required');const row=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:'inspection',estimateStatus:'approved'});if(!row)return fail(res,409,'Customer-approved estimate is required before towing');row.towingDestination={label:destination.label.trim().slice(0,200),latitude:Number(destination.latitude),longitude:Number(destination.longitude)};row.towingStages=[{stage:'trip_started',at:new Date()}];row.status='towing';row.dealerWorkStatus='towing';row.version+=1;await row.save();await audit('request',row._id,req.dealer_id,'dealer','towing_started',null,row.towingDestination);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(req.dealer_id)]);return ok(res,publicRequest(row));};

exports.verifyTowingHandover=async(req,res)=>{const {code}=req.body||{};if(typeof code!=='string'||code.length<4||code.length>12)return fail(res,400,'Valid customer handover code is required');const row=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:'towing',paymentStatus:{$in:['pending','cash_confirmed']}});if(!row)return fail(res,404,'Towing request not found');const digest=crypto.createHash('sha256').update(`${row._id}:${code}`).digest('hex');if(!row.handoverCodeHash||!crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(row.handoverCodeHash)))return fail(res,403,'Handover code is incorrect');row.handoverVerifiedAt=new Date();row.towingStages.push({stage:'bike_handed_over',at:new Date()});row.version+=1;await row.save();await audit('request',row._id,req.dealer_id,'dealer','towing_handover_verified',null,{at:row.handoverVerifiedAt});return ok(res,publicRequest(row));};
