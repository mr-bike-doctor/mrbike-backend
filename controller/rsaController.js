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
const audit = (entityType, entityId, actorId, actorRole, action, before, after, reason = '', session = null) => RSAAudit.create([{entityType, entityId, actorId, actorRole, action, before, after, reason}], session ? {session} : undefined);
const ok = (res, data, status = 200) => res.status(status).json({success: true, data});
const fail = (res, status, message) => res.status(status).json({success: false, message});
const safeService = doc => ({id: String(doc._id), name: doc.name, description: doc.description, icon: doc.icon, type: doc.type, requiresTowingCapability: doc.requiresTowingCapability, compatibleBikeModels: doc.compatibleBikeModels||[], isActive: doc.isActive});

exports.customerCatalog = async (_req, res) => {
  try { const rows = await RSAService.find({isActive: true}).sort({name: 1}).lean(); return ok(res, rows.map(safeService)); }
  catch (e) { return fail(res, 500, 'Could not load roadside catalog'); }
};

exports.adminServices = async (_req, res) => {
  const services=await RSAService.find().sort({createdAt:-1}).lean();
  const counts=await DealerRSAService.aggregate([{$match:{revokedAt:null}},{$group:{_id:'$serviceId',assigned:{$sum:1},approvedActive:{$sum:{$cond:[{$and:[{$eq:['$priceStatus','approved']},{$eq:['$dealerActive',true]}]},1,0]}}}}]);
  const byId=new Map(counts.map(row=>[String(row._id),row]));
  return ok(res,services.map(service=>({...safeService(service),assignmentCounts:byId.get(String(service._id))||{assigned:0,approvedActive:0}})));
};
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
exports.adminDealers = async (_req, res) => {
  const rows = await Vendor.find({isBlocked: {$ne: true}})
    .select('shopName ownerName phone city rsaEnabled rsaOnline rsaCapabilities rsaCapacityLimit rsaCapacityReserved rsaAvailableCapacity online status.isActive status.adminApproved')
    .sort({shopName: 1, _id: 1}).limit(2000).lean();
  return ok(res, rows.map(dealer => ({
    id: String(dealer._id), shopName: dealer.shopName, ownerName: dealer.ownerName,
    phone: dealer.phone, city: dealer.city, rsaEnabled: dealer.rsaEnabled === true,
    rsaOnline: dealer.rsaOnline === true,
    capabilities: dealer.rsaCapabilities || [], capacity: dealer.rsaCapacityLimit || 0,
    reserved: dealer.rsaCapacityReserved || 0, availableCapacity: dealer.rsaAvailableCapacity || 0,
    online: dealer.online === true, active: dealer.status?.isActive === true,
    adminApproved: dealer.status?.adminApproved === true,
  })));
};
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
  const before = {rsaEnabled: dealer.rsaEnabled, rsaOnline: dealer.rsaOnline, rsaCapabilities: dealer.rsaCapabilities, rsaAvailableCapacity: dealer.rsaAvailableCapacity, rsaCapacityLimit: dealer.rsaCapacityLimit, rsaCapacityReserved: dealer.rsaCapacityReserved};
  if (capacity < Number(dealer.rsaCapacityReserved || 0)) return fail(res,409,'Capacity cannot be lower than currently reserved requests');
  dealer.rsaEnabled = rsaEnabled; if (!rsaEnabled) dealer.rsaOnline = false; dealer.rsaCapabilities = [...new Set(capabilities)]; dealer.rsaCapacityLimit = capacity; dealer.rsaAvailableCapacity = capacity - Number(dealer.rsaCapacityReserved || 0); await dealer.save();
  await audit('dealer_permission', dealer._id, req.admin_id, 'admin', 'updated', before, {rsaEnabled, capabilities: dealer.rsaCapabilities, capacity, reserved: dealer.rsaCapacityReserved});
  return ok(res, {dealerId: String(dealer._id), rsaEnabled: dealer.rsaEnabled, rsaOnline: dealer.rsaOnline === true, capabilities: dealer.rsaCapabilities, capacity: dealer.rsaCapacityLimit, reserved: dealer.rsaCapacityReserved});
};

exports.dealerCatalog = async (_req, res) => ok(res, (await RSAService.find({isActive:true}).sort({name:1}).lean()).map(safeService));
exports.dealerAvailability = async (req, res) => {
  const dealer = await Vendor.findById(req.dealer_id).select('rsaEnabled rsaOnline online status.isActive status.adminApproved').lean();
  if (!dealer) return fail(res, 404, 'Dealer not found');
  return ok(res, {rsaEnabled: dealer.rsaEnabled === true, rsaOnline: dealer.rsaOnline === true, dealerOnline: dealer.online === true, active: dealer.status?.isActive === true, adminApproved: dealer.status?.adminApproved === true});
};
exports.setDealerAvailability = async (req, res) => {
  const {available} = req.body || {};
  if (typeof available !== 'boolean') return fail(res, 400, 'available must be boolean');
  const dealer = await Vendor.findById(req.dealer_id).select('rsaEnabled rsaOnline online status.isActive status.adminApproved').lean();
  if (!dealer) return fail(res, 404, 'Dealer not found');
  if (available && (!dealer.rsaEnabled || dealer.online !== true || dealer.status?.isActive !== true || dealer.status?.adminApproved !== true)) return fail(res, 409, 'RSA access, dealer approval and regular online status are required before accepting roadside requests');
  const eligibilityFilter = available ? {_id:req.dealer_id,rsaEnabled:true,online:true,'status.isActive':true,'status.adminApproved':true} : {_id:req.dealer_id};
  const updated = await Vendor.findOneAndUpdate(eligibilityFilter,{$set:{rsaOnline:available}},{new:true}).select('rsaEnabled rsaOnline online status.isActive status.adminApproved').lean();
  if (!updated) return fail(res, 409, 'Dealer availability changed; reload and retry');
  await audit('dealer_permission', updated._id, req.dealer_id, 'dealer', available ? 'rsa_online' : 'rsa_offline', {rsaOnline:dealer.rsaOnline === true}, {rsaOnline:updated.rsaOnline === true});
  return ok(res, {rsaEnabled:updated.rsaEnabled === true, rsaOnline:updated.rsaOnline === true, dealerOnline:updated.online === true, active:updated.status?.isActive === true, adminApproved:updated.status?.adminApproved === true});
};
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
  const row = await DealerRSAService.findOne({ _id:req.params.id, dealerId:req.dealer_id, revokedAt:null }); if (!row) return fail(res,404,'RSA service not found');
  if (row.priceStatus === 'acceptance_pending') return fail(res,409,'Accept or decline the corrected price first');
  const before = row.toObject(); row.proposedPrice=Number(price); row.priceStatus='pending'; row.dealerActive=false; row.revisionPrice=null; row.reviewReason=''; row.priceVersion += 1; await row.save();
  await audit('dealer_service',row._id,req.dealer_id,'dealer',before.proposedPrice==null?'price_submitted':'price_resubmitted',before,row.toObject()); return ok(res,row);
};
exports.toggleDealerService = async (req,res) => {
  const {active} = req.body || {}; if (typeof active !== 'boolean') return fail(res,400,'active must be boolean');
  const row = await DealerRSAService.findOne({_id:req.params.id,dealerId:req.dealer_id,revokedAt:null}).populate('serviceId').populate('dealerId'); if (!row) return fail(res,404,'RSA service not found');
  if (active && (row.priceStatus !== 'approved' || row.approvedPrice == null || !row.serviceId?.isActive)) return fail(res,409,'Only approved services in the active global catalog can be enabled');
  if (active && row.adminDisabledAt) return fail(res,409,'Admin has deactivated this RSA service; only Admin can reactivate it');
  if (active && (!row.dealerId?.rsaEnabled || row.dealerId.status?.adminApproved !== true || row.dealerId.status?.isActive !== true || row.dealerId.isBlocked)) return fail(res,409,'Dealer RSA permission and active Admin approval are required');
  if (active && (row.serviceId?.requiresTowingCapability || row.serviceId?.type === 'towing') && (!row.dealerId.rsaCapabilities?.includes('towing') || row.dealerId.status?.isVerified !== true)) return fail(res,409,'Verified towing capability is required');
  const before=row.toObject(); row.dealerActive=active; await row.save(); await audit('dealer_service',row._id,req.dealer_id,'dealer',active?'activated':'deactivated',before,row.toObject()); return ok(res,row);
};
exports.acceptRevision = async (req,res) => {
  const {accept} = req.body || {}; if (typeof accept !== 'boolean') return fail(res,400,'accept must be boolean');
  const row=await DealerRSAService.findOne({_id:req.params.id,dealerId:req.dealer_id,revokedAt:null}); if (!row) return fail(res,404,'RSA service not found');
  if(row.priceStatus!=='acceptance_pending'||row.revisionPrice==null) return fail(res,409,'No corrected price is awaiting acceptance');
  const before=row.toObject();
  if(accept){row.proposedPrice=row.revisionPrice;row.approvedPrice=row.revisionPrice;row.priceStatus='approved';row.dealerActive=false;row.revisionPrice=null;} else {row.priceStatus='rejected';row.dealerActive=false;row.revisionPrice=null;}
  await row.save(); await audit('dealer_service',row._id,req.dealer_id,'dealer',accept?'revision_accepted':'revision_declined',before,row.toObject()); return ok(res,row);
};

exports.adminProposals = async (_req,res) => ok(res,await DealerRSAService.find({revokedAt:null}).populate('serviceId dealerId','name shopName phone').sort({updatedAt:-1}).lean());
exports.reviewPrice = async (req,res) => {
  const {action,price,reason=''}=req.body||{}; if(!['approve','reject','revise','revoke'].includes(action)) return fail(res,400,'Invalid review action');
  if(['revise','approve'].includes(action)&&!moneyValid(price)) return fail(res,400,'Valid price is required');
  if(['reject','revoke'].includes(action)&&!String(reason).trim()) return fail(res,400,'A reason is required');
  const row=await DealerRSAService.findById(req.params.id); if(!row) return fail(res,404,'Proposal not found');
  if(action==='approve'&&(row.proposedPrice==null||Number(price)!==Number(row.proposedPrice))) return fail(res,409,'Approve the dealer-submitted price as-is; use revise to suggest a different price');
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

const dealerAssignmentView = row => ({
  ...row,
  dealer: row.dealerId && typeof row.dealerId === 'object' ? {
    id: String(row.dealerId._id), dealerCode: row.dealerId.id ? `MRBD${String(row.dealerId.id).padStart(4,'0')}` : '',
    name: row.dealerId.ownerName || row.dealerId.shopName || '', shopName: row.dealerId.shopName || '',
    phone: row.dealerId.phone || '', verified: row.dealerId.status?.isVerified === true,
    rsaEnabled: row.dealerId.rsaEnabled === true, rsaOnline: row.dealerId.rsaOnline === true,
    online: row.dealerId.online === true, active: row.dealerId.status?.isActive === true,
    adminApproved: row.dealerId.status?.adminApproved === true,
    towingAuthorized: (row.dealerId.rsaCapabilities || []).includes('towing'),
  } : row.dealerId,
});

exports.adminServiceDealers = async (req,res) => {
  if (!idValid(req.params.serviceId)) return fail(res,400,'Invalid service id');
  const service = await RSAService.findById(req.params.serviceId).lean();
  if (!service) return fail(res,404,'RSA service not found');
  const page = Math.max(1, Number.parseInt(req.query.page,10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit,10) || 25));
  const filter = {serviceId: service._id, revokedAt:null};
  if (req.query.approval && ['pending','approved','rejected','revision_requested','acceptance_pending'].includes(req.query.approval)) filter.priceStatus = req.query.approval;
  if (['true','false'].includes(req.query.active)) filter.dealerActive = req.query.active === 'true';
  if (req.query.search) {
    const term = String(req.query.search).trim().slice(0,100);
    if (term) {
      const codeMatch=term.match(/^MRBD(\d+)$/i), escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const dealers = await Vendor.find({$or:[...(codeMatch?[{id:Number(codeMatch[1])}]:[]),{_id:idValid(term)?term:undefined},{shopName:{$regex:escaped,$options:'i'}},{ownerName:{$regex:escaped,$options:'i'}},{phone:{$regex:escaped,$options:'i'}}].filter(item=>Object.values(item)[0]!==undefined)}).select('_id').limit(500).lean();
      filter.dealerId = {$in:dealers.map(d=>d._id)};
    }
  }
  const [rows,total,counts] = await Promise.all([
    DealerRSAService.find(filter).populate('serviceId').populate({path:'dealerId',select:'id ownerName shopName phone online rsaEnabled rsaOnline rsaCapabilities status.isVerified status.isActive status.adminApproved'}).sort({updatedAt:-1}).skip((page-1)*limit).limit(limit).lean(),
    DealerRSAService.countDocuments(filter),
    DealerRSAService.aggregate([{$match:{serviceId:service._id,revokedAt:null}},{$group:{_id:null,total:{$sum:1},approved:{$sum:{$cond:[{$eq:['$priceStatus','approved']},1,0]}},active:{$sum:{$cond:['$dealerActive',1,0]}},pending:{$sum:{$cond:[{$in:['$priceStatus',['pending','acceptance_pending','revision_requested']]},1,0]}}}}]),
  ]);
  return ok(res,{service:{id:String(service._id),name:service.name,isActive:service.isActive,type:service.type,icon:service.icon},rows:rows.map(dealerAssignmentView),page,limit,total,pages:Math.ceil(total/limit),summary:counts[0]||{total:0,approved:0,active:0,pending:0}});
};

exports.adminDealerDirectory = async (req,res) => {
  const search=String(req.query.search||'').trim().slice(0,100);
  if(search.length<2) return ok(res,{rows:[],page:1,limit:25,total:0,pages:0});
  const page=Math.max(1,Number.parseInt(req.query.page,10)||1), limit=Math.min(50,Math.max(1,Number.parseInt(req.query.limit,10)||25));
  const escaped=search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const codeMatch=search.match(/^MRBD(\d+)$/i);
  const filter={isBlocked:{$ne:true},$or:[...(codeMatch?[{id:Number(codeMatch[1])}]:[]),...(idValid(search)?[{_id:new mongoose.Types.ObjectId(search)}]:[]),{shopName:{$regex:escaped,$options:'i'}},{ownerName:{$regex:escaped,$options:'i'}},{phone:{$regex:escaped,$options:'i'}}]};
  const [rows,total,assigned]=await Promise.all([Vendor.find(filter).select('id ownerName shopName phone status.isVerified status.isActive status.adminApproved rsaEnabled rsaOnline rsaCapabilities').sort({shopName:1,_id:1}).skip((page-1)*limit).limit(limit).lean(),Vendor.countDocuments(filter),idValid(req.query.serviceId)?DealerRSAService.find({serviceId:req.query.serviceId,revokedAt:null}).select('dealerId').lean():[]]);
  const assignedIds=new Set(assigned.map(row=>String(row.dealerId)));
  return ok(res,{rows:rows.map(d=>({id:String(d._id),dealerCode:d.id?`MRBD${String(d.id).padStart(4,'0')}`:'',name:d.ownerName||d.shopName||'',shopName:d.shopName||'',phone:d.phone||'',verified:d.status?.isVerified===true,adminApproved:d.status?.adminApproved===true,active:d.status?.isActive===true,rsaEnabled:d.rsaEnabled===true,towingAuthorized:(d.rsaCapabilities||[]).includes('towing'),alreadyAssigned:assignedIds.has(String(d._id))})),page,limit,total,pages:Math.ceil(total/limit)});
};

exports.adminAssignService = async (req,res) => {
  const {dealerId,price}=req.body||{};
  if(!idValid(req.params.serviceId)||!idValid(dealerId)) return fail(res,400,'Valid service and dealer ids are required');
  if(price!==undefined&&!moneyValid(price)) return fail(res,400,'Valid service price is required');
  const directApproval=price!==undefined;
  let row,created=false;
  try {
    row=await withTransaction(async session=>{
      created=false;
      const [service,dealer]=await Promise.all([
        RSAService.findById(req.params.serviceId).session(session),
        Vendor.findById(dealerId).session(session),
      ]);
      if(!service) throw Object.assign(new Error('RSA service not found'),{httpStatus:404});
      if(!dealer||dealer.isBlocked) throw Object.assign(new Error('Dealer not found or blocked'),{httpStatus:404});
      if(directApproval){
        if(!service.isActive) throw Object.assign(new Error('Activate the global RSA service before assigning it directly'),{httpStatus:409});
        if(!dealer.rsaEnabled||dealer.status?.adminApproved!==true||dealer.status?.isActive!==true) throw Object.assign(new Error('Dealer must be Admin-approved, active and enabled for RSA'),{httpStatus:409});
        if((service.requiresTowingCapability||service.type==='towing')&&(!dealer.rsaCapabilities?.includes('towing')||dealer.status?.isVerified!==true)) throw Object.assign(new Error('Verified towing capability is required'),{httpStatus:409});
      }
      const directFields=directApproval?{proposedPrice:Number(price),approvedPrice:Number(price),priceStatus:'approved',dealerActive:true,revisionPrice:null,reviewReason:'',reviewedBy:req.admin_id,reviewedAt:new Date(),adminDisabledAt:null}:null;
      const existing=await DealerRSAService.findOne({dealerId:dealer._id,serviceId:service._id}).session(session);
      if(existing&&!existing.revokedAt){
        if(!directApproval) return existing;
        const before=existing.toObject();
        const updated=await DealerRSAService.findOneAndUpdate({_id:existing._id,revokedAt:null,priceVersion:existing.priceVersion},{$set:directFields,$inc:{priceVersion:1,eligibilityVersion:1}},{new:true,runValidators:true,session});
        if(!updated) throw Object.assign(new Error('Assignment changed concurrently; reload and retry'),{httpStatus:409});
        await audit('dealer_service',updated._id,req.admin_id,'admin','direct_price_approved',before,updated.toObject(),'',session);
        return updated;
      }
      if(existing){
        const before=existing.toObject();
        const restored=await DealerRSAService.findOneAndUpdate({_id:existing._id,revokedAt:existing.revokedAt},{$set:{revokedAt:null,revokedBy:null,adminDisabledAt:null,proposedPrice:null,approvedPrice:null,priceStatus:'pending',dealerActive:false,revisionPrice:null,reviewReason:'',...(directFields||{})},$inc:{priceVersion:1,eligibilityVersion:1}},{new:true,runValidators:true,session});
        if(!restored) throw Object.assign(new Error('Assignment changed concurrently; reload and retry'),{httpStatus:409});
        await audit('dealer_service',restored._id,req.admin_id,'admin',directApproval?'restored_and_directly_approved':'restored',before,restored.toObject(),'',session);
        return restored;
      }
      created=true;
      const [assigned]=await DealerRSAService.create([{dealerId:dealer._id,serviceId:service._id,proposedPrice:null,approvedPrice:null,priceStatus:'pending',dealerActive:false,...(directFields||{})}],{session});
      await audit('dealer_service',assigned._id,req.admin_id,'admin',directApproval?'assigned_and_directly_approved':'assigned',null,assigned.toObject(),'',session);
      return assigned;
    });
    return ok(res,row,created?201:200);
  } catch(e) {
    if(e.code===11000){const duplicate=await DealerRSAService.findOne({dealerId,serviceId:req.params.serviceId}).lean();if(duplicate&&!duplicate.revokedAt)return ok(res,duplicate,200);}
    return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not assign RSA service');
  }
};

exports.adminSetDealerServicePrice = async (req,res) => {
  if(!idValid(req.params.id)) return fail(res,400,'Invalid dealer service id');
  const {price}=req.body||{};
  if(!moneyValid(price)) return fail(res,400,'Valid service price is required');
  try {
    const saved=await withTransaction(async session=>{
      const row=await DealerRSAService.findOne({_id:req.params.id,revokedAt:null}).session(session).populate('serviceId').populate('dealerId');
      if(!row) throw Object.assign(new Error('Active service assignment not found'),{httpStatus:404});
      const service=row.serviceId,dealer=row.dealerId;
      if(!service?.isActive) throw Object.assign(new Error('Activate the global RSA service before assigning it directly'),{httpStatus:409});
      if(!dealer?.rsaEnabled||dealer.status?.adminApproved!==true||dealer.status?.isActive!==true||dealer.isBlocked) throw Object.assign(new Error('Dealer must be Admin-approved, active and enabled for RSA'),{httpStatus:409});
      if((service.requiresTowingCapability||service.type==='towing')&&(!dealer.rsaCapabilities?.includes('towing')||dealer.status?.isVerified!==true)) throw Object.assign(new Error('Verified towing capability is required'),{httpStatus:409});
      const before=row.toObject(),now=new Date();
      const updated=await DealerRSAService.findOneAndUpdate({_id:row._id,revokedAt:null,priceVersion:row.priceVersion},{$set:{proposedPrice:Number(price),approvedPrice:Number(price),priceStatus:'approved',dealerActive:true,revisionPrice:null,reviewReason:'',reviewedBy:req.admin_id,reviewedAt:now,adminDisabledAt:null},$inc:{priceVersion:1,eligibilityVersion:1}},{new:true,runValidators:true,session});
      if(!updated) throw Object.assign(new Error('Assignment changed concurrently; reload and retry'),{httpStatus:409});
      await audit('dealer_service',updated._id,req.admin_id,'admin','price_set_and_directly_approved',before,updated.toObject(),'',session);
      return updated;
    });
    return ok(res,saved);
  } catch(e) { return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not directly approve RSA service'); }
};

exports.adminToggleDealerService = async (req,res) => {
  if(!idValid(req.params.id)) return fail(res,400,'Invalid dealer service id');
  const {active}=req.body||{}; if(typeof active!=='boolean') return fail(res,400,'active must be boolean');
  try {
    const saved=await withTransaction(async session=>{
      const row=await DealerRSAService.findOne({_id:req.params.id,revokedAt:null}).session(session).populate('serviceId').populate('dealerId');
      if(!row) throw Object.assign(new Error('Active service assignment not found'),{httpStatus:404});
      if(row.dealerActive===active) return row;
      if(active){
        const dealer=row.dealerId, service=row.serviceId;
        if(!service?.isActive) throw Object.assign(new Error('Global RSA service must be active'),{httpStatus:409});
        if(!dealer?.rsaEnabled||dealer.status?.adminApproved!==true||dealer.status?.isActive!==true||dealer.isBlocked) throw Object.assign(new Error('Dealer must be approved, active and enabled for RSA'),{httpStatus:409});
        if(row.priceStatus!=='approved'||row.approvedPrice==null) throw Object.assign(new Error('Dealer price must be approved before activation'),{httpStatus:409});
        if((service.requiresTowingCapability||service.type==='towing')&&(!dealer.rsaCapabilities?.includes('towing')||dealer.status?.isVerified!==true)) throw Object.assign(new Error('Verified towing capability is required'),{httpStatus:409});
      }
      const before=row.toObject();
      const updated=await DealerRSAService.findOneAndUpdate({_id:row._id,revokedAt:null,priceVersion:row.priceVersion,priceStatus:active?'approved':row.priceStatus},{$set:{dealerActive:active,adminDisabledAt:active?null:new Date()},$inc:{eligibilityVersion:1}},{new:true,runValidators:true,session});
      if(!updated) throw Object.assign(new Error('Assignment changed concurrently; reload and retry'),{httpStatus:409});
      await audit('dealer_service',updated._id,req.admin_id,'admin',active?'activated':'deactivated',before,updated.toObject(),'',session);
      return updated;
    });
    return ok(res,saved);
  } catch(e) { return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not update RSA service status'); }
};

exports.adminRevokeDealerService = async (req,res) => {
  if(!idValid(req.params.id)) return fail(res,400,'Invalid dealer service id');
  try {
    const saved=await withTransaction(async session=>{
      const row=await DealerRSAService.findById(req.params.id).session(session).populate('serviceId dealerId');
      if(!row) throw Object.assign(new Error('Service assignment not found'),{httpStatus:404});
      if(row.revokedAt) return row;
      const live=await RSARequest.exists({serviceId:row.serviceId._id,$or:[{assignedDealerId:row.dealerId._id},{offers:{$elemMatch:{dealerId:row.dealerId._id,state:{$in:['offered','accepted','won']}}}}],status:{$nin:['completed','cancelled','failed']}}).session(session);
      if(live) throw Object.assign(new Error('Dealer has an active RSA request or reserved offer; resolve it before removing this service'),{httpStatus:409});
      const dealerCapacity=await Vendor.findById(row.dealerId._id).select('rsaCapacityReserved').session(session).lean();
      if(Number(dealerCapacity?.rsaCapacityReserved||0)>0) throw Object.assign(new Error('Dealer still has reserved RSA capacity; finish or release the active request before removing this service'),{httpStatus:409});
      const before=row.toObject();
      const revokedAt=new Date();
      const updated=await DealerRSAService.findOneAndUpdate({_id:row._id,revokedAt:null,priceVersion:row.priceVersion},{$set:{revokedAt,revokedBy:req.admin_id,adminDisabledAt:revokedAt,dealerActive:false},$inc:{eligibilityVersion:1}},{new:true,runValidators:true,session});
      if(!updated) throw Object.assign(new Error('Assignment changed concurrently; reload and retry'),{httpStatus:409});
      await audit('dealer_service',updated._id,req.admin_id,'admin','revoked',before,updated.toObject(),'',session);
      return updated;
    });
    return ok(res,saved);
  } catch(e) { return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not remove RSA service'); }
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
    description:request.description, inspectionNotes:request.inspectionNotes, estimateAmount:request.estimateAmount,
    estimateLines:request.estimateLines||[],estimateVersion:request.estimateVersion||0,paymentStatus:request.paymentStatus||'pending',paymentAmount:request.paymentAmount,
    towingProposal:request.towingProposal||{status:'none'},
    customerCompletionConfirmedAt:request.customerCompletionConfirmedAt,repairStartedAt:request.repairStartedAt,towingDestination:request.towingDestination||null,
    towingStages:request.towingStages||[],handoverVerifiedAt:request.handoverVerifiedAt,handoverCodeSet:Boolean(request.handoverCodeHash),
    estimateStatus:request.estimateStatus, dealerWorkStatus:request.dealerWorkStatus, createdAt:request.createdAt, updatedAt:request.updatedAt,
  };
  if(includeLocation) data.location=request.location;
  if(includeLocation&&['on_the_way','towing'].includes(request.status)&&request.providerLocation){const capturedAt=new Date(request.providerLocation.capturedAt).getTime();if(Number.isFinite(capturedAt)&&Date.now()-capturedAt<=45000)data.providerLocation=request.providerLocation;}
  return data;
};

exports.createRequest = async (req,res) => {
  if(process.env.RSA_REQUESTS_ENABLED!=='true') return fail(res,503,'Roadside requests are not enabled yet');
  const {serviceId,bikeId,latitude,longitude,locationLabel='',dispatchMode='auto',dealerId,description=''}=req.body||{};
  if(!idValid(serviceId)||!idValid(bikeId)||!coordinatesValid(latitude,longitude)||!['auto','manual'].includes(dispatchMode)) return fail(res,400,'Valid service, bike, GPS coordinates and dispatch mode are required');
  if(dispatchMode==='manual'&&!idValid(dealerId)) return fail(res,400,'Choose an eligible garage');
  const idempotencyKey=String(req.get('x-idempotency-key')||req.body.idempotencyKey||'').trim();
  if(!idempotencyKey||idempotencyKey.length>128) return fail(res,400,'A valid idempotency key is required');
  if(typeof description!=='string'||description.length>1000) return fail(res,400,'Description must be 1000 characters or less');
  const session=await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async()=>{
      const existing=await RSARequest.findOne({customerId:req.user_id,idempotencyKey}).session(session);
      if(existing){created=existing;return;}
      const bike=await UserBike.findOne({_id:bikeId,user_id:req.user_id,status:1}).session(session).lean();
      if(!bike) throw Object.assign(new Error('Bike is not active or does not belong to this customer'),{httpStatus:403});
      // Make requests for a bike contend on one document inside the transaction.
      // This closes the race where simultaneous submissions use different
      // idempotency keys and both pass the active-request lookup.
      const guard=await UserBike.updateOne({_id:bikeId,user_id:req.user_id,status:1},{$inc:{rsaRequestGuardVersion:1}},{session});
      if(guard.modifiedCount!==1) throw Object.assign(new Error('Bike is not available for roadside assistance'),{httpStatus:409});
      const location={latitude:Number(latitude),longitude:Number(longitude),label:String(locationLabel).slice(0,200)};
      const found=await eligibleAt(serviceId,bikeId,location,session,true);
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
    if(e.code===11000){const existing=await RSARequest.findOne({customerId:req.user_id,idempotencyKey}).lean();if(existing)return ok(res,publicRequest(existing),200);const active=await RSARequest.findOne({customerId:req.user_id,bikeId,status:{$in:activeRequestStatuses}}).lean();if(active)return fail(res,409,'An active roadside request already exists for this bike');}
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
  return ok(res,{...publicRequest(request),service:request.serviceId,bike:request.bikeId});
};

exports.getDealerRequest=async(req,res)=>{
  if(!idValid(req.params.id))return fail(res,400,'Invalid request id');
  const request=await RSARequest.findById(req.params.id).populate('serviceId','name type description').populate('bikeId','name model bike_cc plate_number').populate('assignedDealerId','shopName phone').lean();
  if(!request)return fail(res,404,'Request not found');
  const terminal=['completed','cancelled','failed'].includes(request.status);
  const current=!terminal&&(String(request.assignedDealerId||'')===String(req.dealer_id)||request.offers.some(o=>String(o.dealerId)===String(req.dealer_id)&&o.state==='offered'&&o.expiresAt>new Date()&&request.status==='searching'));
  if(!current)return fail(res,403,'This offer is no longer active');
  const dealer=await Vendor.findById(req.dealer_id).select('rsaEnabled rsaOnline rsaCapabilities online status.isActive status.adminApproved').lean();
  return ok(res,{...publicRequest(request),service:request.serviceId,bike:request.bikeId,assignedDealer:request.assignedDealerId,towingAuthorized:dealer?.rsaEnabled===true&&dealer?.online===true&&dealer?.status?.isActive===true&&dealer?.status?.adminApproved===true&&dealer?.rsaCapabilities?.includes('towing')});
};

exports.dealerRequests=async(req,res)=>{
  const now=new Date();
  const dealer=await Vendor.findById(req.dealer_id).select('rsaEnabled rsaOnline rsaCapabilities online status.isActive status.adminApproved').lean();
  const rows=await RSARequest.find({$or:[{status:'searching',offers:{$elemMatch:{dealerId:req.dealer_id,state:'offered',expiresAt:{$gt:now}}}},{assignedDealerId:req.dealer_id,status:{$nin:['completed','cancelled','failed']}}]}).populate('serviceId','name type').populate('bikeId','name model plate_number bike_cc').sort({createdAt:-1}).limit(50).lean();
  return ok(res,rows.map(r=>({...publicRequest(r),towingAuthorized:dealer?.rsaEnabled===true&&dealer?.online===true&&dealer?.status?.isActive===true&&dealer?.status?.adminApproved===true&&dealer?.rsaCapabilities?.includes('towing')})));
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
      // Admin deactivation stops future discovery, while an already-issued
      // offer remains valid until its expiry or resolution.
      const fresh=await eligibleAt(request.serviceId,request.bikeId,request.location,session,true,req.dealer_id);
      const provider=fresh.providers.find(p=>String(p.dealer._id)===String(req.dealer_id));
      if(!provider)throw Object.assign(new Error('Dealer is no longer eligible for this request'),{httpStatus:409});
      if(action==='reject'){
        offer.state='rejected';offer.respondedAt=new Date();offer.rejectionReason=String(reason).slice(0,300);request.version+=1;await request.save({session});return {request,rejected:true};
      }
      const previousDealerIds=request.offers.filter(o=>o.state==='offered').map(o=>o.dealerId);
      const cap=await Vendor.updateOne({_id:req.dealer_id,rsaEnabled:true,rsaOnline:true,online:true,'status.isActive':true,'status.adminApproved':true,rsaAvailableCapacity:{$gt:0},rsaCapacityLimit:{$gt:0},$expr:{$lt:[{$ifNull:['$rsaCapacityReserved',0]},'$rsaCapacityLimit']},...(fresh.service?.requiresTowingCapability?{rsaCapabilities:'towing'}:{})},{$inc:{rsaCapacityReserved:1,rsaAvailableCapacity:-1}},{session});
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
    if(['repair','towing','payment_pending'].includes(row.status)||row.paymentStatus==='cash_confirmed'||row.repairStartedAt||row.towingStages.some(item=>item.stage==='trip_started'))throw Object.assign(new Error('This request can no longer be cancelled after roadside work or towing has started'),{httpStatus:409});
    previousDealerIds=row.offers.filter(o=>o.state==='offered').map(o=>o.dealerId);
    if(row.assignedDealerId)previousDealerIds.push(row.assignedDealerId);
    if(row.assignedDealerId){const released=await Vendor.updateOne({_id:row.assignedDealerId,rsaCapacityReserved:{$gt:0}},{$inc:{rsaCapacityReserved:-1,rsaAvailableCapacity:1}},{session});if(released.modifiedCount!==1)throw new Error('Could not release reserved RSA capacity');}
    row.status='cancelled';row.cancelledAt=new Date();row.providerLocation=undefined;row.version+=1;row.offers.forEach(o=>{if(o.state==='offered')o.state='expired';});await row.save({session});return row;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not cancel request');}
  emit(req.app.get('io'),'rsa:updated',request,previousDealerIds);return ok(res,publicRequest(request));
};

exports.dealerUpdateStatus=async(req,res)=>{
  const {status,inspectionNotes='',estimateAmount,estimateLines}=req.body||{};
  const allowed={assigned:['on_the_way','cancelled'],on_the_way:['arrived','cancelled'],arrived:['inspection','cancelled'],inspection:['inspection','repair','cancelled'],repair:['payment_pending'],towing:['payment_pending'],payment_pending:['completed']};
  if(status==='inspection'&&typeof inspectionNotes!=='string')return fail(res,400,'Inspection findings must be text');
  if(estimateAmount!==undefined&&!moneyValid(estimateAmount))return fail(res,400,'Invalid estimate amount');
  if(estimateLines!==undefined&&(!Array.isArray(estimateLines)||!estimateLines.length||estimateLines.length>30||estimateLines.some(line=>typeof line?.description!=='string'||!line.description.trim()||line.description.length>160||!moneyValid(line.amount))))return fail(res,400,'Estimate must contain valid item descriptions and amounts');
  let row;
  try {row=await withTransaction(async session=>{
    const current=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:{$nin:['completed','cancelled','failed']}}).session(session);
    if(!current)throw Object.assign(new Error('Assigned request not found'),{httpStatus:404});
    const previousStatus=current.status;
    if(!allowed[current.status]?.includes(status))throw Object.assign(new Error('Invalid roadside status transition'),{httpStatus:409});
    if(['pending_customer','declined'].includes(current.estimateStatus)&&['repair','towing','payment_pending','completed'].includes(status))throw Object.assign(new Error('Wait for customer estimate approval before continuing work'),{httpStatus:409});
    if(status==='inspection'&&(estimateAmount!==undefined||estimateLines!==undefined)){const lines=estimateLines||[{description:'Repair estimate',amount:Number(estimateAmount)}];const total=lines.reduce((sum,line)=>sum+Number(line.amount),0);if(!moneyValid(total))throw Object.assign(new Error('Estimate total is invalid'),{httpStatus:400});current.estimateAmount=total;current.estimateLines=lines.map(line=>({description:line.description.trim(),amount:Number(line.amount)}));current.estimateVersion+=1;current.estimateStatus='pending_customer';}
    if(status==='inspection'&&previousStatus==='inspection'&&estimateAmount===undefined&&estimateLines===undefined)throw Object.assign(new Error('Submit a revised estimate before resubmitting inspection'),{httpStatus:409});
    if(status==='payment_pending'){if(!['repair','towing'].includes(current.status))throw Object.assign(new Error('Complete the roadside work before requesting payment'),{httpStatus:409});if(current.estimateStatus!=='approved')throw Object.assign(new Error('Customer approval is required before requesting payment'),{httpStatus:409});if(current.serviceMode==='repair'&&!current.customerCompletionConfirmedAt)throw Object.assign(new Error('Customer must confirm roadside repair completion first'),{httpStatus:409});if(current.serviceMode==='towing'&&(!current.handoverVerifiedAt||!current.towingStages.some(item=>item.stage==='arrived_destination')))throw Object.assign(new Error('Approved towing destination arrival and secure handover are required before payment'),{httpStatus:409});current.paymentAmount=Number(current.estimateAmount??current.assignedPrice);current.paymentStatus=current.paymentAmount>0?'pending':'not_required';}
    if(inspectionNotes)current.inspectionNotes=inspectionNotes.slice(0,2000);
    current.status=status;current.dealerWorkStatus=status;current.version+=1;if(status!=='on_the_way')current.providerLocation=undefined;
    if(status==='repair'&&previousStatus==='inspection'){if(current.estimateStatus!=='approved')throw Object.assign(new Error('Customer estimate approval is required'),{httpStatus:409});current.serviceMode='repair';current.repairStartedAt=new Date();}
    if(status==='completed'){if(current.estimateStatus==='pending_customer'||current.estimateStatus==='declined')throw Object.assign(new Error('Customer approval is required before completion'),{httpStatus:409});if(current.paymentStatus==='pending'&&Number(current.paymentAmount||current.assignedPrice||0)>0)throw Object.assign(new Error('Cash payment must be confirmed before completion'),{httpStatus:409});if(current.serviceMode==='towing'&&!current.handoverVerifiedAt)throw Object.assign(new Error('Secure towing handover must be verified before completion'),{httpStatus:409});if(current.serviceMode==='repair'&&!current.customerCompletionConfirmedAt)throw Object.assign(new Error('Customer completion confirmation is required'),{httpStatus:409});current.completedAt=new Date();current.providerLocation=undefined;}
    if(status==='cancelled'){current.cancelledAt=new Date();current.providerLocation=undefined;}
    await current.save({session});
    if(['completed','cancelled'].includes(status)){
      const released=await Vendor.updateOne({_id:req.dealer_id,rsaCapacityReserved:{$gt:0}},{$inc:{rsaCapacityReserved:-1,rsaAvailableCapacity:1}},{session});
      if(released.modifiedCount!==1)throw new Error('Could not release reserved RSA capacity');
    }
    await audit('request',current._id,req.dealer_id,'dealer',status==='completed'?'request_completed':status==='cancelled'?'request_cancelled':'status_updated',{status:previousStatus},{status,version:current.version},'',session);
    return current;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not update request');}
  emit(req.app.get('io'),'rsa:updated',row,[req.dealer_id]);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`]);return ok(res,publicRequest(row));
};

exports.proposeTowing=async(req,res)=>{
  const {reason,inspectionNotes='',bikeCondition='',destination,distanceKm,estimateLines}=req.body||{};
  if(typeof reason!=='string'||!reason.trim()||reason.trim().length>1000)return fail(res,400,'A towing reason is required');
  if(typeof inspectionNotes!=='string'||inspectionNotes.length>2000||typeof bikeCondition!=='string'||bikeCondition.length>500)return fail(res,400,'Inspection notes or bike condition are invalid');
  if(!destination||typeof destination.label!=='string'||!destination.label.trim()||!coordinatesValid(destination.latitude,destination.longitude))return fail(res,400,'A named destination garage with valid map coordinates is required');
  if(distanceKm!==undefined&&distanceKm!==null&&(!Number.isFinite(Number(distanceKm))||Number(distanceKm)<0||Number(distanceKm)>1000))return fail(res,400,'Distance must be between 0 and 1000 km');
  if(!Array.isArray(estimateLines)||!estimateLines.length||estimateLines.length>30||estimateLines.some(line=>typeof line?.description!=='string'||!line.description.trim()||line.description.length>160||!moneyValid(line.amount)))return fail(res,400,'Enter valid itemized towing charges');
  const total=estimateLines.reduce((sum,line)=>sum+Number(line.amount),0);if(!moneyValid(total))return fail(res,400,'Towing total is invalid');
  const dealer=await Vendor.findOne({_id:req.dealer_id,rsaEnabled:true,online:true,'status.isActive':true,'status.adminApproved':true,rsaCapabilities:'towing'}).select('_id').lean();
  if(!dealer)return fail(res,403,'Only an Admin-authorized towing provider can propose towing');
  const row=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:'inspection'});
  if(!row)return fail(res,409,'Only the assigned provider can propose towing during inspection');
  if(row.estimateStatus==='pending_customer')return fail(res,409,'Wait for the current estimate response before proposing towing');
  row.inspectionNotes=inspectionNotes.trim().slice(0,2000);
  row.towingDestination={label:destination.label.trim().slice(0,200),latitude:Number(destination.latitude),longitude:Number(destination.longitude)};
  row.estimateLines=estimateLines.map(line=>({description:line.description.trim(),amount:Number(line.amount)}));
  row.estimateAmount=total;row.estimateVersion+=1;row.estimateStatus='pending_customer';
  row.towingProposal={status:'pending_customer',dealerId:req.dealer_id,reason:reason.trim(),inspectionNotes:inspectionNotes.trim(),bikeCondition:bikeCondition.trim(),distanceKm:distanceKm==null?null:Number(distanceKm),pickupLocation:{latitude:row.location.latitude,longitude:row.location.longitude,label:row.location.label},proposedAt:new Date()};
  row.version+=1;await row.save();
  await audit('request',row._id,req.dealer_id,'dealer','towing_proposed',null,{reason:row.towingProposal.reason,destination:row.towingDestination,total,estimateVersion:row.estimateVersion});
  emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(req.dealer_id)]);
  return ok(res,publicRequest(row));
};

exports.adminAssign=async(req,res)=>{
  if(process.env.RSA_REQUESTS_ENABLED!=='true') return fail(res,503,'Roadside requests are not enabled yet');
  const {dealerId}=req.body||{};if(!idValid(dealerId))return fail(res,400,'Valid dealerId is required');
  let request;
  try {request=await withTransaction(async session=>{
    const current=await RSARequest.findOne({_id:req.params.id,status:'searching'}).session(session);if(!current)throw Object.assign(new Error('Searching request not found'),{httpStatus:404});
    const found=await eligibleAt(current.serviceId,current.bikeId,current.location,session,true);
    const provider=found.providers.find(p=>String(p.dealer._id)===String(dealerId));if(!provider)throw Object.assign(new Error('Dealer is not currently eligible'),{httpStatus:409});
    const now=new Date();current.dispatchMode='manual';current.candidateDealerIds=[dealerId];current.dispatchCursor=0;current.offers=[{dealerId,approvedPrice:provider.offering.approvedPrice,offeredAt:now,expiresAt:new Date(now.getTime()+OFFER_TTL_MS),state:'offered'}];current.dispatchLeaseUntil=new Date(now.getTime()+OFFER_TTL_MS);current.version+=1;await current.save({session});return current;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not assign request');}
  emit(req.app.get('io'),'rsa:request-offered',request,[dealerId]);return ok(res,publicRequest(request));
};

exports.adminRequests=async(_req,res)=>{
  const rows=await RSARequest.find({status:{$in:['searching','assigned','on_the_way','arrived','inspection','repair','towing','payment_pending']}}).populate('serviceId','name type').populate('bikeId','name model plate_number').sort({createdAt:1}).limit(100).lean();
  return ok(res,rows.map(row=>({...publicRequest(row),customerId:String(row.customerId),service:row.serviceId,bike:row.bikeId})));
};

exports.adminRequestAudit=async(req,res)=>{if(!idValid(req.params.id))return fail(res,400,'Invalid request id');const request=await RSARequest.exists({_id:req.params.id});if(!request)return fail(res,404,'Roadside request not found');const rows=await RSAAudit.find({entityType:'request',entityId:req.params.id}).sort({createdAt:-1}).limit(100).lean();return ok(res,rows);};

exports.adminAssignTowingProvider=async(req,res)=>{
  const {dealerId}=req.body||{};if(!idValid(dealerId))return fail(res,400,'Valid towing provider ID is required');
  let row,previousDealerId;
  try{row=await withTransaction(async session=>{
    const current=await RSARequest.findOne({_id:req.params.id,status:'inspection'}).session(session);
    if(!current)throw Object.assign(new Error('Only an inspection-stage request can be reassigned'),{httpStatus:409});
    if(String(current.assignedDealerId)===String(dealerId))throw Object.assign(new Error('This dealer is already assigned'),{httpStatus:409});
    const reserved=await Vendor.updateOne({_id:dealerId,rsaEnabled:true,online:true,'status.isActive':true,'status.adminApproved':true,rsaCapabilities:'towing',rsaAvailableCapacity:{$gt:0},rsaCapacityLimit:{$gt:0},$expr:{$lt:[{$ifNull:['$rsaCapacityReserved',0]},'$rsaCapacityLimit']}},{$inc:{rsaCapacityReserved:1,rsaAvailableCapacity:-1}},{session});
    if(reserved.modifiedCount!==1)throw Object.assign(new Error('Dealer is not an active, available Admin-authorized towing provider'),{httpStatus:409});
    previousDealerId=current.assignedDealerId;
    if(previousDealerId){const released=await Vendor.updateOne({_id:previousDealerId,rsaCapacityReserved:{$gt:0}},{$inc:{rsaCapacityReserved:-1,rsaAvailableCapacity:1}},{session});if(released.modifiedCount!==1)throw new Error('Could not release previous dealer capacity');}
    current.assignedDealerId=dealerId;current.towingProposal={status:'none',dealerId:null,reason:'',inspectionNotes:'',bikeCondition:'',distanceKm:null,pickupLocation:null,proposedAt:null};current.towingDestination={label:'',latitude:null,longitude:null};current.handoverCodeHash='';current.towingStages=[];current.handoverVerifiedAt=null;current.estimateStatus='none';current.estimateAmount=null;current.estimateLines=[];current.version+=1;await current.save({session});
    await audit('request',current._id,req.admin_id,'admin','towing_provider_reassigned',{assignedDealerId:previousDealerId},{assignedDealerId:dealerId},'',session);return current;
  });}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not reassign towing provider');}
  emit(req.app.get('io'),'rsa:updated',row,[String(previousDealerId||''),String(dealerId),`rsa:customer:${row.customerId}`]);return ok(res,publicRequest(row));
};

exports.customerEstimateResponse=async(req,res)=>{
  const {accept,estimateVersion}=req.body||{};if(typeof accept!=='boolean'||!Number.isInteger(estimateVersion))return fail(res,400,'Estimate response and version are required');
  let row;try{row=await withTransaction(async session=>{const current=await RSARequest.findOne({_id:req.params.id,customerId:req.user_id,estimateStatus:'pending_customer',estimateVersion}).session(session);if(!current)throw Object.assign(new Error('Estimate changed or no longer awaits a response; reload and review it'),{httpStatus:409});current.estimateStatus=accept?'approved':'declined';if(current.towingProposal?.status==='pending_customer')current.towingProposal.status=accept?'approved':'declined';current.version+=1;const updated=await current.save({session});await audit('request',updated._id,req.user_id,'customer',accept?'estimate_approved':'estimate_declined',{estimateStatus:'pending_customer',estimateVersion},{estimateVersion:updated.estimateVersion,estimateAmount:updated.estimateAmount,estimateStatus:updated.estimateStatus},'',session);return updated;});}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not record estimate response');}emit(req.app.get('io'),'rsa:updated',row,row.assignedDealerId?[row.assignedDealerId]:[]);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`]);return ok(res,publicRequest(row));
};

const activeRequestStatuses=['searching','assigned','on_the_way','arrived','inspection','repair','towing','payment_pending'];
exports.updateDealerLocation=async(req,res)=>{const {latitude,longitude,accuracy,capturedAt,heading}=req.body||{};if(!coordinatesValid(latitude,longitude)||!Number.isFinite(Number(accuracy))||Number(accuracy)<0||Number(accuracy)>100)return fail(res,400,'Valid coordinates and GPS accuracy up to 100m are required');const captured=new Date(capturedAt);const now=Date.now();if(!Number.isFinite(captured.getTime())||captured.getTime()>now+5000||now-captured.getTime()>30000)return fail(res,400,'GPS fix is stale or invalid');if(heading!==undefined&&(!Number.isFinite(Number(heading))||Number(heading)<0||Number(heading)>=360))return fail(res,400,'Invalid heading');const fix={latitude:Number(latitude),longitude:Number(longitude),accuracy:Number(accuracy),...(heading!==undefined?{heading:Number(heading)}:{}),capturedAt:captured,receivedAt:new Date()};const row=await RSARequest.findOneAndUpdate({_id:req.params.id,assignedDealerId:req.dealer_id,status:{$in:['on_the_way','towing']},$or:[{'providerLocation.capturedAt':{$lt:captured}},{providerLocation:{$exists:false}}]},{$set:{providerLocation:fix},$inc:{version:1}},{new:true});if(!row)return fail(res,409,'Request is not assigned to you or is not accepting GPS updates');const payload={requestId:String(row._id),location:fix};emit(req.app.get('io'),'rsa:location',payload,[`rsa:customer:${row.customerId}`]);emit(req.app.get('io'),'rsa:location',payload,['admin:rsa']);return ok(res,{accepted:true,capturedAt:captured});};

exports.setTowingDestination=async(req,res)=>{const {destination}=req.body||{};if(!destination||typeof destination.label!=='string'||!destination.label.trim()||!coordinatesValid(destination.latitude,destination.longitude))return fail(res,400,'A named towing destination with valid coordinates is required');if(typeof req.body.handoverCode!=='string'||req.body.handoverCode.length<4||req.body.handoverCode.length>12)return fail(res,400,'Handover code must contain 4–12 characters');const row=await RSARequest.findOne({_id:req.params.id,customerId:req.user_id,status:'inspection'});if(!row)return fail(res,404,'Inspection-stage roadside request not found');if(row.estimateStatus==='pending_customer')return fail(res,409,'Resolve the current estimate before selecting a towing destination');const before=row.towingDestination;const nextDestination={label:destination.label.trim().slice(0,200),latitude:Number(destination.latitude),longitude:Number(destination.longitude)};const sameDestination=before&&before.label===nextDestination.label&&Number(before.latitude)===nextDestination.latitude&&Number(before.longitude)===nextDestination.longitude;row.towingDestination=nextDestination;row.handoverCodeHash=crypto.createHash('sha256').update(`${row._id}:${req.body.handoverCode}`).digest('hex');if(!sameDestination&&row.estimateStatus==='approved'){row.estimateStatus='none';if(row.towingProposal?.status==='approved')row.towingProposal.status='none';}row.handoverVerifiedAt=null;row.towingStages=[];row.version+=1;await row.save();await audit('request',row._id,req.user_id,'customer','towing_destination_selected',before,row.towingDestination);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(row.assignedDealerId)]);return ok(res,publicRequest(row));};

exports.customerCompletion=async(req,res)=>{const {confirm}=req.body||{};if(confirm!==true)return fail(res,400,'Customer completion confirmation is required');let row;try{row=await withTransaction(async session=>{const updated=await RSARequest.findOneAndUpdate({_id:req.params.id,customerId:req.user_id,status:'repair',customerCompletionConfirmedAt:null},{$set:{customerCompletionConfirmedAt:new Date()},$inc:{version:1}},{new:true,session});if(!updated)throw Object.assign(new Error('Request is not awaiting your repair completion confirmation'),{httpStatus:409});await audit('request',updated._id,req.user_id,'customer','completion_confirmed',null,{at:updated.customerCompletionConfirmedAt},'',session);return updated;});}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not confirm completion');}emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(row.assignedDealerId)]);return ok(res,publicRequest(row));};

exports.confirmCashReceived=async(req,res)=>{const {amount,idempotencyKey}=req.body||{};if(!moneyValid(amount)||typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>128)return fail(res,400,'Valid amount and idempotency key are required');let row;try{row=await withTransaction(async session=>{const current=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id}).session(session);if(!current)throw Object.assign(new Error('Payment request not found'),{httpStatus:404});if(current.paymentStatus==='cash_confirmed'){if(current.paymentIdempotencyKey===idempotencyKey&&Number(current.paymentAmount)===Number(amount))return current;throw Object.assign(new Error('Cash payment was already confirmed'),{httpStatus:409});}if(current.status!=='payment_pending')throw Object.assign(new Error('Request is not awaiting cash confirmation'),{httpStatus:409});if(current.estimateStatus!=='approved')throw Object.assign(new Error('Customer estimate approval is required'),{httpStatus:409});const expected=Number(current.estimateAmount??current.assignedPrice);if(Number(amount)!==expected)throw Object.assign(new Error('Cash amount must match the approved final amount'),{httpStatus:409});const saved=await RSARequest.findOneAndUpdate({_id:current._id,assignedDealerId:req.dealer_id,status:'payment_pending',paymentStatus:'pending',version:current.version},{$set:{paymentStatus:'cash_confirmed',paymentAmount:Number(amount),paymentIdempotencyKey:idempotencyKey,cashConfirmedAt:new Date()},$inc:{version:1}},{new:true,session});if(!saved)throw Object.assign(new Error('Payment changed concurrently; reload and retry'),{httpStatus:409});await audit('request',saved._id,req.dealer_id,'dealer','cash_confirmed',{paymentStatus:'pending'},{amount:saved.paymentAmount,idempotencyKey},'',session);return saved;});}catch(e){return fail(res,e.httpStatus||500,e.httpStatus?e.message:'Could not confirm cash payment');}emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(req.dealer_id)]);return ok(res,publicRequest(row));};

exports.startTowing=async(req,res)=>{const authorized=await Vendor.exists({_id:req.dealer_id,rsaEnabled:true,'status.isActive':true,'status.adminApproved':true,rsaCapabilities:'towing'});if(!authorized)return fail(res,403,'Only an Admin-authorized towing provider can start towing');const row=await RSARequest.findOneAndUpdate({_id:req.params.id,assignedDealerId:req.dealer_id,status:'inspection',estimateStatus:'approved','towingProposal.status':'approved','towingProposal.dealerId':req.dealer_id,'towingDestination.label':{$exists:true,$ne:''},handoverCodeHash:{$ne:''}},{$set:{towingStages:[{stage:'trip_started',at:new Date()}],status:'towing',serviceMode:'towing',dealerWorkStatus:'towing',providerLocation:undefined},$inc:{version:1}},{new:true});if(!row)return fail(res,409,'Customer-approved towing proposal, destination and handover code are required before towing');await audit('request',row._id,req.dealer_id,'dealer','towing_started',null,row.towingDestination);emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(req.dealer_id)]);return ok(res,publicRequest(row));};

exports.updateTowingStage=async(req,res)=>{const {stage}=req.body||{};if(stage!=='arrived_destination')return fail(res,400,'Invalid towing stage');const current=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:'towing',serviceMode:'towing'}).lean();if(!current)return fail(res,404,'Active towing request not found');if(current.towingStages?.some(item=>item.stage==='arrived_destination'))return ok(res,publicRequest(current));const fix=current.providerLocation;const fresh=fix?.capturedAt&&Date.now()-new Date(fix.capturedAt).getTime()<=45000;const distance=fix&&current.towingDestination?distanceKm(fix.latitude,fix.longitude,current.towingDestination.latitude,current.towingDestination.longitude):Infinity;const accuracyKm=Number(fix?.accuracy||0)/1000;if(!fresh||!Number.isFinite(distance)||distance>Math.max(.25,accuracyKm*2))return fail(res,409,'A fresh dealer GPS fix near the approved destination is required to mark arrival');const row=await RSARequest.findOneAndUpdate({_id:current._id,assignedDealerId:req.dealer_id,status:'towing','towingStages.stage':{$ne:'arrived_destination'},'providerLocation.capturedAt':fix.capturedAt},{$push:{towingStages:{stage:'arrived_destination',at:new Date(),latitude:fix.latitude,longitude:fix.longitude}},$inc:{version:1}},{new:true});if(!row)return fail(res,409,'Towing stage changed; reload and retry');await audit('request',row._id,req.dealer_id,'dealer','towing_stage_updated',null,{stage,location:{latitude:fix.latitude,longitude:fix.longitude}});emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(req.dealer_id)]);return ok(res,publicRequest(row));};

exports.verifyTowingHandover=async(req,res)=>{const {code}=req.body||{};if(typeof code!=='string'||code.length<4||code.length>12)return fail(res,400,'Valid customer handover code is required');const current=await RSARequest.findOne({_id:req.params.id,assignedDealerId:req.dealer_id,status:'towing',serviceMode:'towing',paymentStatus:{$in:['pending','cash_confirmed']}});if(!current)return fail(res,404,'Towing request not found');const digest=crypto.createHash('sha256').update(`${current._id}:${code}`).digest('hex');if(!current.handoverCodeHash||!crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(current.handoverCodeHash)))return fail(res,403,'Handover code is incorrect');if(current.handoverVerifiedAt)return ok(res,publicRequest(current));if(!current.towingStages.some(item=>item.stage==='arrived_destination'))return fail(res,409,'Mark arrival at the approved destination before handover');const row=await RSARequest.findOneAndUpdate({_id:current._id,assignedDealerId:req.dealer_id,status:'towing',handoverVerifiedAt:null,'towingStages.stage':'arrived_destination'},{$set:{handoverVerifiedAt:new Date()},$push:{towingStages:{stage:'bike_handed_over',at:new Date()}},$inc:{version:1}},{new:true});if(!row)return fail(res,409,'Handover changed; reload and retry');await audit('request',row._id,req.dealer_id,'dealer','towing_handover_verified',null,{at:row.handoverVerifiedAt});emit(req.app.get('io'),'rsa:updated',row,[`rsa:customer:${row.customerId}`,String(req.dealer_id)]);return ok(res,publicRequest(row));};
