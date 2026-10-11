const assert = require('assert');
const mongoose = require('mongoose');
const RSAService = require('../models/RSAService');
const DealerRSAService = require('../models/DealerRSAService');
const RSAAudit = require('../models/RSAAudit');
const RSARequest = require('../models/RSARequest');
const RSAArea = require('../models/RSAArea');
const Vendor = require('../models/dealerModel');
const UserBike = require('../models/userBikeModel');
const controller = require('../controller/rsaController');
const router = require('../routes/rsaRoutes');
const { requireAdmin } = require('../middlewares/requireAdmin');

const uri = process.env.TEST_MONGO_URL;
if (!uri) {
  console.log('rsaAdminDealerServices.integration.test.js — SKIPPED (set TEST_MONGO_URL to an isolated loopback replica set)');
  process.exit(0);
}
const parsed = new URL(uri);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('TEST_MONGO_URL must be loopback');
parsed.pathname = `/rsa_admin_dealer_services_test_${process.pid}`;

function response() {
  return { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(body) { this.payload = body; return this; } };
}
async function call(fn, req) { const res = response(); await fn(req, res); return res; }
async function run() {
  process.env.RSA_REQUESTS_ENABLED = 'true';
  const adminId = new mongoose.Types.ObjectId();
  await mongoose.connect(parsed.toString(), { serverSelectionTimeoutMS: 3000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert(hello.setName, 'Admin service mutations require a replica set');
  await mongoose.connection.dropDatabase();
  await Promise.all([RSAService.init(), DealerRSAService.init(), RSAAudit.init(), RSARequest.init(), RSAArea.init(), Vendor.init(), UserBike.init()]);

  const adminRoutes = router.stack.filter(layer => layer.route && /\/admin\/(services\/.*\/dealers|dealer-directory|dealer-services)/.test(layer.route.path));
  assert.strictEqual(adminRoutes.length, 5, 'service assignment and management endpoints are registered');
  for (const layer of adminRoutes) assert(layer.route.stack.some(item => item.handle === requireAdmin), `${layer.route.path} requires Admin auth`);
  const denied = await call(requireAdmin, { headers: {} });
  assert.strictEqual(denied.statusCode, 401, 'Admin service APIs reject missing credentials');

  const dealer = await Vendor.create({
    shopName: 'RSA Admin Test Garage', ownerName: 'Test Owner', phone: '9000000091',
    rsaEnabled: true, rsaOnline: false, rsaCapabilities: [], rsaCapacityLimit: 2,
    rsaCapacityReserved: 0, rsaAvailableCapacity: 2, online: true, isBlocked: false,
    latitude: 17.4, longitude: 78.4, serviceRadiusKm: 15,
    status: { isActive: true, adminApproved: true, isVerified: true },
  });
  const service = await RSAService.create({ name: 'RSA admin management test', type: 'repair', isActive: false });
  await RSAArea.create({ name: 'RSA admin verification area', isActive: true, boundary: { type: 'Polygon', coordinates: [[[78, 17], [79, 17], [79, 18], [78, 18], [78, 17]]] } });
  const customerId = new mongoose.Types.ObjectId();
  const bike = await UserBike.create({ user_id: customerId, name: 'Honda', model: 'Activa', bike_cc: '110', plate_number: 'RSA-ADMIN-1', variant_id: new mongoose.Types.ObjectId(), status: 1 });
  const location = { latitude: 17.4, longitude: 78.4 };
  const req = { admin_id: adminId, params: { serviceId: String(service._id) }, body: { dealerId: String(dealer._id) }, query: {} };

  const [first, duplicate] = await Promise.all([
    call(controller.adminAssignService, req), call(controller.adminAssignService, req),
  ]);
  assert([200, 201].includes(first.statusCode));
  assert([200, 201].includes(duplicate.statusCode));
  assert.strictEqual(String(first.payload.data._id), String(duplicate.payload.data._id), 'duplicate assignment is idempotent');
  let assignment = await DealerRSAService.findById(first.payload.data._id);
  assert.strictEqual(assignment.priceStatus, 'pending');
  assert.strictEqual(assignment.proposedPrice, null);
  assert.strictEqual(assignment.approvedPrice, null);
  assert.strictEqual(assignment.dealerActive, false);
  assert.strictEqual(await DealerRSAService.countDocuments({ dealerId: dealer._id, serviceId: service._id }), 1);
  const preApproval = await require('../services/rsaDispatch').eligibleAt(service._id, bike._id, location, null);
  assert.strictEqual(preApproval.providers.length, 0, 'Admin assignment with pending unpriced approval is not discoverable');

  let activation = await call(controller.adminToggleDealerService, { params: { id: String(assignment._id) }, body: { active: true }, admin_id: adminId });
  assert.strictEqual(activation.statusCode, 409, 'pending/unpriced assignment cannot activate');
  const submit = await call(controller.submitPrice, { dealer_id: dealer._id, params: { id: String(assignment._id) }, body: { price: 245 } });
  assert.strictEqual(submit.statusCode, 200, 'dealer can submit price on Admin-created assignment');
  const approve = await call(controller.reviewPrice, { admin_id: adminId, params: { id: String(assignment._id) }, body: { action: 'approve', price: 245 } });
  assert.strictEqual(approve.statusCode, 200, 'Admin approves the exact dealer-submitted price');
  activation = await call(controller.adminToggleDealerService, { params: { id: String(assignment._id) }, body: { active: true }, admin_id: adminId });
  assert.strictEqual(activation.statusCode, 409, 'inactive global catalog blocks dealer activation');
  await RSAService.updateOne({ _id: service._id }, { $set: { isActive: true } });
  const beforeActivation = await require('../services/rsaDispatch').eligibleAt(service._id, bike._id, location, null);
  assert.strictEqual(beforeActivation.providers.length, 0, 'approved pricing alone does not make a dealer discoverable while assignment is inactive');
  activation = await call(controller.adminToggleDealerService, { params: { id: String(assignment._id) }, body: { active: true }, admin_id: adminId });
  assert.strictEqual(activation.statusCode, 200, 'approved service activates when all eligibility requirements pass');
  await call(controller.setDealerAvailability, { dealer_id: dealer._id, body: { available: true } });
  const afterActivation = await require('../services/rsaDispatch').eligibleAt(service._id, bike._id, location, null);
  assert.strictEqual(afterActivation.providers.length, 1, 'approved and activated eligible dealer becomes discoverable');

  const listing = await call(controller.adminServiceDealers, { params: { serviceId: String(service._id) }, query: { search: 'RSA Admin Test Garage' } });
  assert.strictEqual(listing.statusCode, 200);
  assert.strictEqual(listing.payload.data.rows.length, 1, 'service manager lists dealer assignment and searchable dealer data');
  assert.strictEqual(String(listing.payload.data.rows[0]._id), String(assignment._id));
  const dealerDetailsRows = await call(controller.adminProposals, {});
  assert(dealerDetailsRows.payload.data.some(row => String(row._id) === String(assignment._id)), 'Dealer Details proposal list sees the same assignment record');
  const catalog = await call(controller.adminServices, {});
  assert.strictEqual(catalog.payload.data.find(row => row.id === String(service._id)).assignmentCounts.assigned, 1, 'catalog count comes from the same assignment record');
  const directory = await call(controller.adminDealerDirectory, { query: { search: 'RSA Admin Test Garage', serviceId: String(service._id) } });
  assert.strictEqual(directory.payload.data.rows[0].alreadyAssigned, true);

  const requestResponse = await call(controller.createRequest, { user_id: customerId, body: { serviceId: String(service._id), bikeId: String(bike._id), latitude: location.latitude, longitude: location.longitude, dispatchMode: 'auto', idempotencyKey: 'rsa-admin-live-job' }, get: () => null, app: { get: () => null } });
  assert.strictEqual(requestResponse.statusCode, 201, 'activated assignment generates a real dispatch offer');
  const live = await RSARequest.findById(requestResponse.payload.data.id);
  assert.strictEqual(live.offers.length, 1);
  assert.strictEqual(live.offers[0].state, 'offered');
  const blockedRemove = await call(controller.adminRevokeDealerService, { params: { id: String(assignment._id) }, admin_id: adminId });
  assert.strictEqual(blockedRemove.statusCode, 409, 'active requests and reserved capacity block service removal');
  const deactivated = await call(controller.adminToggleDealerService, { params: { id: String(assignment._id) }, body: { active: false }, admin_id: adminId });
  assert.strictEqual(deactivated.statusCode, 200, 'deactivation succeeds while preserving an active job');
  const stillActiveJob = await RSARequest.findById(live._id).lean();
  assert.strictEqual(stillActiveJob.status, 'searching', 'deactivation leaves the existing request intact');
  assert.strictEqual(stillActiveJob.offers[0].state, 'offered', 'deactivation preserves the already-issued offer');
  const dealerReactivation = await call(controller.toggleDealerService, { params: { id: String(assignment._id) }, body: { active: true }, dealer_id: dealer._id });
  assert.strictEqual(dealerReactivation.statusCode, 409, 'dealer cannot override an Admin deactivation');
  const afterDeactivation = await require('../services/rsaDispatch').eligibleAt(service._id, bike._id, location, null);
  assert.strictEqual(afterDeactivation.providers.length, 0, 'deactivation immediately blocks discovery for new offers');
  const acceptedAfterDeactivation = await call(controller.respondOffer, { params: { id: String(live._id) }, body: { action: 'accept' }, dealer_id: dealer._id, app: { get: () => null } });
  assert.strictEqual(acceptedAfterDeactivation.statusCode, 200, 'deactivation lets a dealer resolve an offer that was already issued');
  const acceptedJob = await RSARequest.findById(live._id).lean();
  assert.strictEqual(acceptedJob.status, 'assigned', 'existing offer becomes an active assignment after deactivation');
  assert.strictEqual((await Vendor.findById(dealer._id).lean()).rsaCapacityReserved, 1, 'existing offer reserves its normal capacity once');
  const blockedAcceptedRemove = await call(controller.adminRevokeDealerService, { params: { id: String(assignment._id) }, admin_id: adminId });
  assert.strictEqual(blockedAcceptedRemove.statusCode, 409, 'removal also blocks while the accepted request reserves capacity');

  await RSARequest.updateOne({ _id: live._id }, { $set: { status: 'completed', assignedDealerId: null } });
  await Vendor.updateOne({ _id: dealer._id }, { $set: { rsaCapacityReserved: 0, rsaAvailableCapacity: 2 } });
  const removed = await call(controller.adminRevokeDealerService, { params: { id: String(assignment._id) }, admin_id: adminId });
  assert.strictEqual(removed.statusCode, 200, 'safe soft removal succeeds after requests and capacity are clear');
  const historical = await DealerRSAService.findById(assignment._id).lean();
  assert(historical.revokedAt && historical.approvedPrice === 245, 'removal preserves the dealer service record and approved pricing');
  const afterRevocation = await require('../services/rsaDispatch').eligibleAt(service._id, bike._id, location, null);
  assert.strictEqual(afterRevocation.providers.length, 0, 'revocation blocks future dispatch discovery');
  const serviceListAfterRemoval = await call(controller.adminServiceDealers, { params: { serviceId: String(service._id) }, query: {} });
  assert.strictEqual(serviceListAfterRemoval.payload.data.rows.length, 0, 'catalog management excludes the revoked assignment');
  const dealerListAfterRemoval = await call(controller.adminProposals, {});
  assert(!dealerListAfterRemoval.payload.data.some(row => String(row._id) === String(assignment._id)), 'revoked assignment is omitted from active Dealer Details proposals');
  const catalogAfterRemoval = await call(controller.adminServices, {});
  assert.strictEqual(catalogAfterRemoval.payload.data.find(row => row.id === String(service._id)).assignmentCounts.assigned, 0);
  const actions = await RSAAudit.find({ entityId: assignment._id }).distinct('action');
  for (const action of ['assigned', 'price_submitted', 'approve', 'activated', 'deactivated', 'revoked']) assert(actions.includes(action), `audit contains ${action}`);

  const towingDealer = await Vendor.create({ shopName: 'RSA Towing Test Garage', phone: '9000000092', rsaEnabled: true, rsaCapabilities: [], status: { isActive: true, adminApproved: true, isVerified: true } });
  const towingService = await RSAService.create({ name: 'RSA admin towing test', type: 'towing', requiresTowingCapability: true, isActive: true });
  const towingAssignment = await call(controller.adminAssignService, { ...req, params: { serviceId: String(towingService._id) }, body: { dealerId: String(towingDealer._id) } });
  assert.strictEqual(towingAssignment.statusCode, 201, 'service assignment does not grant towing or RSA permission');
  const deniedTowingActivation = await call(controller.adminToggleDealerService, { params: { id: String(towingAssignment.payload.data._id) }, body: { active: true }, admin_id: adminId });
  assert.strictEqual(deniedTowingActivation.statusCode, 409, 'towing service cannot activate without approved towing capability and price');
  const dealerCannotActivatePending = await call(controller.toggleDealerService, { params: { id: String(towingAssignment.payload.data._id) }, body: { active: true }, dealer_id: towingDealer._id });
  assert.strictEqual(dealerCannotActivatePending.statusCode, 409, 'dealer activation also enforces price and capability authorization');
  const dealerCannotReactivateRemoved = await call(controller.toggleDealerService, { params: { id: String(assignment._id) }, body: { active: true }, dealer_id: dealer._id });
  assert.strictEqual(dealerCannotReactivateRemoved.statusCode, 404, 'dealer cannot reactivate an Admin-removed service');

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log('rsaAdminDealerServices.integration.test.js — passed');
}
run().catch(async error => { console.error(error); try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch {} process.exitCode = 1; });
