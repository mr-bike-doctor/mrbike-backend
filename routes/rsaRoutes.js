const express = require('express');
const controller = require('../controller/rsaController');
const {requireAdmin} = require('../middlewares/requireAdmin');
const {verifyDealerToken} = require('../middlewares/dealerAuth');
const {requireCustomer} = require('../middlewares/customerAuth');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Publicly readable catalog is deliberately limited to globally active items.
router.get('/catalog', wrap(controller.customerCatalog));
router.get('/nearby', requireCustomer, wrap(controller.nearbyPartners));
router.post('/requests', requireCustomer, wrap(controller.createRequest));
router.get('/requests', requireCustomer, wrap(controller.customerRequests));
router.get('/requests/:id', requireCustomer, wrap(controller.getCustomerRequest));
router.get('/dealer/requests/:id', verifyDealerToken, wrap(controller.getDealerRequest));
router.patch('/requests/:id/cancel', requireCustomer, wrap(controller.cancelRequest));
router.patch('/requests/:id/estimate', requireCustomer, wrap(controller.customerEstimateResponse));
router.post('/admin/requests/:id/assign', requireAdmin, wrap(controller.adminAssign));
router.post('/admin/requests/:id/assign-towing-provider',requireAdmin,wrap(controller.adminAssignTowingProvider));
router.get('/admin/requests', requireAdmin, wrap(controller.adminRequests));
router.get('/admin/requests/:id/audit',requireAdmin,wrap(controller.adminRequestAudit));
router.get('/dealer/requests', verifyDealerToken, wrap(controller.dealerRequests));
router.patch('/dealer/requests/:id/respond', verifyDealerToken, wrap(controller.respondOffer));
router.patch('/dealer/requests/:id/status', verifyDealerToken, wrap(controller.dealerUpdateStatus));
router.post('/dealer/requests/:id/towing-proposal',verifyDealerToken,wrap(controller.proposeTowing));
router.patch('/dealer/requests/:id/location',verifyDealerToken,wrap(controller.updateDealerLocation));
router.patch('/dealer/requests/:id/towing',verifyDealerToken,wrap(controller.startTowing));
router.patch('/dealer/requests/:id/towing-stage',verifyDealerToken,wrap(controller.updateTowingStage));
router.patch('/dealer/requests/:id/handover',verifyDealerToken,wrap(controller.verifyTowingHandover));
router.patch('/dealer/requests/:id/cash',verifyDealerToken,wrap(controller.confirmCashReceived));
router.patch('/requests/:id/completion',requireCustomer,wrap(controller.customerCompletion));
router.patch('/requests/:id/towing-destination',requireCustomer,wrap(controller.setTowingDestination));

router.get('/admin/services', requireAdmin, wrap(controller.adminServices));
router.post('/admin/services', requireAdmin, wrap(controller.createService));
router.put('/admin/services/:id', requireAdmin, wrap(controller.updateService));
router.get('/admin/areas', requireAdmin, wrap(controller.adminAreas));
router.get('/admin/dealers', requireAdmin, wrap(controller.adminDealers));
router.post('/admin/areas', requireAdmin, wrap(controller.createArea));
router.put('/admin/areas/:id', requireAdmin, wrap(controller.updateArea));
router.put('/admin/dealers/:dealerId/permission', requireAdmin, wrap(controller.setDealerPermission));
router.get('/admin/proposals', requireAdmin, wrap(controller.adminProposals));
router.patch('/admin/proposals/:id/review', requireAdmin, wrap(controller.reviewPrice));
router.get('/admin/services/:serviceId/dealers', requireAdmin, wrap(controller.adminServiceDealers));
router.get('/admin/dealer-directory', requireAdmin, wrap(controller.adminDealerDirectory));
router.post('/admin/services/:serviceId/dealers', requireAdmin, wrap(controller.adminAssignService));
router.patch('/admin/dealer-services/:id/status', requireAdmin, wrap(controller.adminToggleDealerService));
router.delete('/admin/dealer-services/:id', requireAdmin, wrap(controller.adminRevokeDealerService));

router.get('/dealer/catalog', verifyDealerToken, wrap(controller.dealerCatalog));
router.get('/dealer/availability', verifyDealerToken, wrap(controller.dealerAvailability));
router.patch('/dealer/availability', verifyDealerToken, wrap(controller.setDealerAvailability));
router.get('/dealer/services', verifyDealerToken, wrap(controller.dealerServices));
router.post('/dealer/services', verifyDealerToken, wrap(controller.addDealerService));
router.put('/dealer/services/:id/price', verifyDealerToken, wrap(controller.submitPrice));
router.patch('/dealer/services/:id/status', verifyDealerToken, wrap(controller.toggleDealerService));
router.patch('/dealer/services/:id/revision', verifyDealerToken, wrap(controller.acceptRevision));

module.exports = router;
