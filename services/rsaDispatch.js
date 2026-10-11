const mongoose = require('mongoose');
const RSARequest = require('../models/RSARequest');
const RSAService = require('../models/RSAService');
const RSAArea = require('../models/RSAArea');
const DealerRSAService = require('../models/DealerRSAService');
const UserBike = require('../models/userBikeModel');
const Vendor = require('../models/dealerModel');
const {distanceKm} = require('./rsaValidation');

const boundedConfig=(value,fallback,min,max)=>{const parsed=Number(value);return Number.isFinite(parsed)?Math.max(min,Math.min(max,parsed)):fallback;};
const BATCH_SIZE = boundedConfig(process.env.RSA_OFFER_BATCH_SIZE,3,1,5);
const OFFER_TTL_MS = boundedConfig(process.env.RSA_OFFER_TTL_MS,90000,15000,10*60*1000);
const id = x => String(x?._id || x || '');

async function eligibleAt(serviceId, bikeId, location, session, lockAssignments = false, allowExistingOfferDealerId = null) {
  const service = await RSAService.findOne({_id: serviceId, isActive: true}).session(session).lean();
  if (!service) return {service: null, area: null, providers: []};
  const bike = await UserBike.findOne({_id: bikeId, status: 1}).session(session).lean();
  if (!bike) return {service, area: null, providers: []};
  const bikeName=`${bike.name||''} ${bike.model||''}`.toLowerCase();
  if(service.compatibleBikeModels?.length&&!service.compatibleBikeModels.some(model=>bikeName.includes(String(model).toLowerCase()))) return {service,area:null,providers:[],incompatible:true};
  const point = {type:'Point', coordinates:[location.longitude, location.latitude]};
  const area = await RSAArea.findOne({isActive:true,boundary:{$geoIntersects:{$geometry:point}}}).session(session).lean();
  if (!area) return {service, area: null, providers: []};
  const offeringFilter={serviceId,revokedAt:null,priceStatus:'approved',approvedPrice:{$type:'number'}};
  if(allowExistingOfferDealerId) offeringFilter.$or=[{dealerActive:true},{dealerId:allowExistingOfferDealerId}];
  else offeringFilter.dealerActive=true;
  const offerings = await DealerRSAService.find(offeringFilter).session(session).lean();
  const offerMap = new Map(offerings.map(o => [id(o.dealerId), o]));
  const dealers = await Vendor.find({_id:{$in:offerings.map(o=>o.dealerId)},rsaEnabled:true,rsaOnline:true,online:true,'status.isActive':true,'status.adminApproved':true,rsaAvailableCapacity:{$gt:0},rsaCapacityLimit:{$gt:0},$expr:{$lt:[{$ifNull:['$rsaCapacityReserved',0]},'$rsaCapacityLimit']},latitude:{$type:'number'},longitude:{$type:'number'},...(service.requiresTowingCapability?{rsaCapabilities:'towing'}:{})}).session(session).select('shopName latitude longitude serviceRadiusKm averageRating ratingCount status isBlocked rsaEnabled rsaOnline rsaAvailableCapacity rsaCapacityLimit rsaCapacityReserved').lean();
  const providers = dealers.map(dealer => ({dealer,offering:offerMap.get(id(dealer)),distanceKm:distanceKm(location.latitude,location.longitude,dealer.latitude,dealer.longitude)}))
    .filter(p => p.distanceKm <= Number(p.dealer.serviceRadiusKm || 0) && p.dealer.isBlocked !== true)
    .sort((a,b)=>a.distanceKm-b.distanceKm);
  if (lockAssignments && providers.length) {
    const offeringIds = providers.map(provider => provider.offering._id);
    const locked = await DealerRSAService.updateMany(
      {_id:{$in:offeringIds},revokedAt:null,priceStatus:'approved'},
      {$inc:{eligibilityVersion:1}},
      {session},
    );
    if (locked.modifiedCount !== offeringIds.length) throw Object.assign(new Error('RSA service eligibility changed; retry the request'), {httpStatus:409});
  }
  return {service,area,providers};
}

function emit(io, event, request, dealerIds = []) {
  if (!io || !request) return;
  const payload = {requestId:id(request), status:request.status, version:request.version};
  io.to(`rsa:customer:${id(request.customerId)}`).emit('rsa:updated',payload);
  for (const dealerId of new Set(dealerIds.map(id))) io.to(`dealer:${dealerId}`).emit(event,payload);
}

async function stageBatch(requestId, io, session) {
  const request = await RSARequest.findById(requestId).session(session);
  if (!request || request.status !== 'searching') return request;
  const liveOffers = request.offers.filter(o => o.state === 'offered' && o.expiresAt > new Date());
  if (liveOffers.length) return request;
  const expiredDealerIds=request.offers.filter(o=>o.state==='offered').map(o=>o.dealerId);
  request.offers.forEach(o => {if(o.state==='offered'){o.state='expired';o.respondedAt=new Date();}});
  let cursor = request.dispatchCursor;
  let dealers = request.candidateDealerIds.slice(cursor, cursor + BATCH_SIZE);
  if (request.dispatchMode === 'manual') dealers = request.candidateDealerIds.slice(0,1);
  const check = await eligibleAt(request.serviceId, request.bikeId, request.location, session, true);
  const current = new Map(check.providers.map(p=>[id(p.dealer._id),p]));
  dealers = dealers.filter(dealerId=>current.has(id(dealerId)) && !request.offers.some(o=>id(o.dealerId)===id(dealerId)&&['rejected','expired'].includes(o.state)));
  while (!dealers.length && request.dispatchMode === 'auto' && cursor < request.candidateDealerIds.length) {
    cursor += BATCH_SIZE;
    dealers = request.candidateDealerIds.slice(cursor, cursor+BATCH_SIZE).filter(dealerId=>current.has(id(dealerId)) && !request.offers.some(o=>id(o.dealerId)===id(dealerId)&&['rejected','expired'].includes(o.state)));
  }
  if (!dealers.length) {
    request.status='failed'; request.dispatchLeaseUntil=null; request.version+=1; await request.save({session});
    emit(io,'rsa:request-expired',request);
    emit(io,'rsa:request-expired',request,expiredDealerIds);
    return request;
  }
  const now = new Date();
  for (const dealerId of dealers) {
    const provider=current.get(id(dealerId));
    request.offers.push({dealerId,approvedPrice:provider.offering.approvedPrice,offeredAt:now,expiresAt:new Date(now.getTime()+OFFER_TTL_MS),state:'offered'});
  }
  request.dispatchCursor=request.dispatchMode==='manual'?cursor:cursor+dealers.length;
  request.dispatchLeaseUntil=new Date(now.getTime()+OFFER_TTL_MS); request.version+=1;
  await request.save({session});
  emit(io,'rsa:request-offered',request,dealers);
  emit(io,'rsa:request-expired',request,expiredDealerIds.filter(oldId=>!dealers.some(newId=>id(newId)===id(oldId))));
  return request;
}

async function withTransaction(fn) {
  const session=await mongoose.startSession();
  try {let result; await session.withTransaction(async()=>{result=await fn(session);}); return result;}
  finally {await session.endSession();}
}

async function advance(requestId, io) { return withTransaction(session=>stageBatch(requestId,io,session)); }

async function refreshExpired(io) {
  const ids=await RSARequest.distinct('_id',{status:'searching','offers.state':'offered','offers.expiresAt':{$lte:new Date()}});
  for(const requestId of ids) {try {await advance(requestId,io);} catch(e) {if(![112,251].includes(e.code)) console.warn('[RSA] dispatch retry:',e.message);}}
}

function start(io) {
  const timer=setInterval(()=>refreshExpired(io).catch(e=>console.warn('[RSA] expiry job:',e.message)),5000);
  timer.unref?.();
  return timer;
}

module.exports={eligibleAt,stageBatch,advance,withTransaction,refreshExpired,start,emit,BATCH_SIZE,OFFER_TTL_MS};
