const assert=require('assert');
const mongoose=require('mongoose');
process.env.RSA_OFFER_BATCH_SIZE='1';
const RSAService=require('../models/RSAService');
const RSAArea=require('../models/RSAArea');
const DealerRSAService=require('../models/DealerRSAService');
const RSARequest=require('../models/RSARequest');
const Vendor=require('../models/dealerModel');
const UserBike=require('../models/userBikeModel');
const controller=require('../controller/rsaController');

const uri=process.env.TEST_MONGO_URL;
if(!uri){console.log('rsaDispatch.integration.test.js — SKIPPED (set TEST_MONGO_URL to isolated loopback replica set)');process.exit(0);}
const parsed=new URL(uri);
if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname))throw new Error('TEST_MONGO_URL must be loopback');

function response(){return {statusCode:200,payload:null,status(code){this.statusCode=code;return this;},json(body){this.payload=body;return this;}};}
async function call(fn,req){const res=response();await fn(req,res);return res;}

async function run(){
 process.env.RSA_REQUESTS_ENABLED='true';
 await mongoose.connect(uri,{serverSelectionTimeoutMS:3000});
 const hello=await mongoose.connection.db.admin().command({hello:1});assert(hello.setName,'transactions require a replica set');
 await mongoose.connection.dropDatabase();
 const customerId=new mongoose.Types.ObjectId();
 const bike=await UserBike.create({user_id:customerId,name:'Honda',model:'Activa',bike_cc:'110',plate_number:'RSA-TEST-1',variant_id:new mongoose.Types.ObjectId(),status:1});
 const service=await RSAService.create({name:'RSA puncture test',type:'puncture',isActive:true});
 await RSAArea.create({name:'Test coverage',isActive:true,boundary:{type:'Polygon',coordinates:[[[78,17],[79,17],[79,18],[78,18],[78,17]]]}});
 const dealers=[];
 for(let i=0;i<2;i++){
   const dealer=await Vendor.create({shopName:`RSA dealer ${i}`,phone:`900000000${i}`,online:true,rsaEnabled:true,rsaAvailableCapacity:1,rsaCapacityLimit:1,rsaCapacityReserved:0,latitude:17.4+i*.01,longitude:78.4,serviceRadiusKm:15,status:{isActive:true,adminApproved:true,isVerified:true}});
   dealers.push(dealer);
   await DealerRSAService.create({dealerId:dealer._id,serviceId:service._id,proposedPrice:199,approvedPrice:199,priceStatus:'approved',dealerActive:true});
 }
 const location={latitude:17.4,longitude:78.4,label:'test breakdown point'};
 const createReq={user_id:customerId,body:{serviceId:String(service._id),bikeId:String(bike._id),latitude:location.latitude,longitude:location.longitude,locationLabel:location.label,dispatchMode:'auto',idempotencyKey:'rsa-idempotency-test'},get:()=>null,app:{get:()=>null}};
 const created=await call(controller.createRequest,createReq);assert.strictEqual(created.statusCode,201,'owned bike and eligible area create an RSA request');
 const duplicate=await call(controller.createRequest,createReq);assert.strictEqual(duplicate.payload.data.id,created.payload.data.id,'idempotency key returns the original request');
 const otherBikeRequest=await call(controller.createRequest,{...createReq,body:{...createReq.body,bikeId:String(new mongoose.Types.ObjectId()),idempotencyKey:'rsa-other-bike'}});assert.strictEqual(otherBikeRequest.statusCode,403,'customer cannot request help for another customer bike');
 const request=await RSARequest.findById(created.payload.data.id);
 request.offers.push({dealerId:dealers[1]._id,approvedPrice:199,expiresAt:new Date(Date.now()+60000),state:'offered'});await request.save();
 const eligible=await require('../services/rsaDispatch').eligibleAt(service._id,bike._id,location,null);assert.strictEqual(eligible.providers.length,2,'active services, area, approved providers and capacity are eligible');
 const outcomes=await Promise.all(dealers.map(dealer=>call(controller.respondOffer,{params:{id:String(request._id)},body:{action:'accept'},dealer_id:dealer._id,app:{get:()=>null}})));
 assert.strictEqual(outcomes.filter(x=>x.statusCode===200).length,1,'only the first concurrent dealer acceptance wins');
 const assigned=await RSARequest.findById(request._id);assert(assigned.assignedDealerId);assert.strictEqual(assigned.status,'assigned');
 assert.strictEqual(await RSARequest.countDocuments({assignedDealerId:{$ne:null}}),1,'request cannot be assigned to multiple dealers');
 const capacities=await Vendor.find({_id:{$in:dealers.map(x=>x._id)}}).sort({shopName:1}).lean();assert.strictEqual(capacities.reduce((n,d)=>n+d.rsaCapacityReserved,0),1,'winner has one reserved capacity slot');
 const wrongCustomer=await call(controller.getCustomerRequest,{params:{id:String(request._id)},user_id:new mongoose.Types.ObjectId()});assert.strictEqual(wrongCustomer.statusCode,403,'another customer cannot read exact request location');
 const cancelled=await call(controller.cancelRequest,{params:{id:String(request._id)},user_id:customerId,app:{get:()=>null}});assert.strictEqual(cancelled.statusCode,200);
 const released=await Vendor.findById(assigned.assignedDealerId).lean();assert.strictEqual(released.rsaCapacityReserved,0,'cancellation releases capacity');assert.strictEqual(released.rsaAvailableCapacity,1);
 const manualCreated=await call(controller.createRequest,{...createReq,body:{...createReq.body,dispatchMode:'manual',dealerId:String(dealers[0]._id),idempotencyKey:'rsa-manual-test'}});assert.strictEqual(manualCreated.statusCode,201);
 const manualRequest=await RSARequest.findById(manualCreated.payload.data.id);assert.strictEqual(manualRequest.candidateDealerIds.length,1,'manual dispatch targets only the selected garage');assert.strictEqual(manualRequest.offers.length,1);
 await call(controller.cancelRequest,{params:{id:String(manualRequest._id)},user_id:customerId,app:{get:()=>null}});
 const retryReq={...createReq,body:{...createReq.body,idempotencyKey:'rsa-retry-test'}};
 const retryCreated=await call(controller.createRequest,retryReq);const retryRequest=await RSARequest.findById(retryCreated.payload.data.id);
 const firstDealer=String(retryRequest.offers[0].dealerId);
 const rejected=await call(controller.respondOffer,{params:{id:String(retryRequest._id)},body:{action:'reject',reason:'busy'},dealer_id:firstDealer,app:{get:()=>null}});assert.strictEqual(rejected.statusCode,200);
 const retried=await RSARequest.findById(retryRequest._id);assert.strictEqual(retried.status,'searching','a rejection advances auto dispatch');assert(retried.offers.some(o=>o.state==='offered'&&String(o.dealerId)!==firstDealer),'next eligible dealer receives a fresh offer');
 const lastOffer=retried.offers.find(o=>o.state==='offered');
 const finalReject=await call(controller.respondOffer,{params:{id:String(retryRequest._id)},body:{action:'reject'},dealer_id:lastOffer.dealerId,app:{get:()=>null}});assert.strictEqual(finalReject.statusCode,200);
 assert.strictEqual((await RSARequest.findById(retryRequest._id)).status,'failed','all eligible providers rejecting closes the request');
 const expiryCreated=await call(controller.createRequest,{...createReq,body:{...createReq.body,idempotencyKey:'rsa-expiry-test'}});const expiring=await RSARequest.findById(expiryCreated.payload.data.id);expiring.offers[0].expiresAt=new Date(Date.now()-1000);await expiring.save();
 await require('../services/rsaDispatch').advance(expiring._id,null);
 const afterExpiry=await RSARequest.findById(expiring._id);assert.strictEqual(afterExpiry.status,'searching','expired offer retries the next eligible dealer');assert(afterExpiry.offers.some(o=>o.state==='offered'&&String(o.dealerId)!==String(expiring.offers[0].dealerId)));
 const nearbyReq={query:{serviceId:String(service._id),bikeId:String(bike._id),latitude:String(location.latitude),longitude:String(location.longitude)},user_id:customerId};
 const available=await call(controller.nearbyPartners,nearbyReq);assert.strictEqual(available.payload.data.available,true,'active service, area and providers are returned as available');
 await RSAArea.updateMany({},{$set:{isActive:false}});const areaDisabled=await call(controller.nearbyPartners,nearbyReq);assert.strictEqual(areaDisabled.payload.data.reason,'area_unavailable','disabled area fails closed');
 await RSAArea.updateMany({},{$set:{isActive:true}});await RSAService.updateOne({_id:service._id},{$set:{isActive:false}});const serviceDisabled=await call(controller.nearbyPartners,nearbyReq);assert.strictEqual(serviceDisabled.payload.data.reason,'service_unavailable','globally disabled service fails closed');
 await RSAService.updateOne({_id:service._id},{$set:{isActive:true}});await Vendor.updateMany({},{$set:{rsaAvailableCapacity:0}});const noCapacity=await call(controller.nearbyPartners,nearbyReq);assert.strictEqual(noCapacity.payload.data.reason,'no_eligible_providers','zero-capacity dealers are unavailable');
 console.log('RSA dispatch transaction, concurrent accept, authorization and capacity release tests passed');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(mongoose.connection.readyState){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
