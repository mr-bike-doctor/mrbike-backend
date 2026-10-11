const express = require('express');
const controller = require('../controller/rsaController');
const {requireAdmin} = require('../middlewares/requireAdmin');
const {verifyDealerToken} = require('../middlewares/dealerAuth');
const {requireCustomer} = require('../middlewares/customerAuth');
const {createS3Upload} = require('../utils/s3Upload');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const rsaPhotoUpload=createS3Upload('rsa-issue-photos',{allowedExtensions:['.jpg','.jpeg','.png','.webp'],allowedMimeTypes:['image/jpeg','image/png','image/webp'],maxFileSizeBytes:10*1024*1024});
const parsePhoto=(req,res,next)=>rsaPhotoUpload.single('photo')(req,res,error=>error?res.status(400).json({success:false,message:error.code==='LIMIT_FILE_SIZE'?'Photo must be 10MB or smaller.':error.message||'Photo upload failed'}):next());

// Publicly readable catalog is deliberately limited to globally active items.
router.get('/catalog', wrap(controller.customerCatalog));
router.get('/nearby', requireCustomer, wrap(controller.nearbyPartners));
router.post('/requests', requireCustomer, wrap(controller.createRequest));
router.get('/requests', requireCustomer, wrap(controller.customerRequests));
router.get('/requests/:id', requireCustomer, wrap(controller.getCustomerRequest));
router.post('/requests/:id/photo',requireCustomer,wrap(controller.authorizePhotoUpload),parsePhoto,wrap(controller.uploadRequestPhoto));
router.get('/dealer/requests/:id', verifyDealerToken, wrap(controller.getDealerRequest));
router.patch('/requests/:id/cancel', requireCustomer, wrap(controller.cancelRequest));
router.patch('/requests/:id/estimate', requireCustomer, wrap(controller.customerEstimateResponse));
router.post('/admin/requests/:id/assign', requireAdmin, wrap(controller.adminAssign));
router.get('/admin/requests', requireAdmin, wrap(controller.adminRequests));
router.get('/dealer/requests', verifyDealerToken, wrap(controller.dealerRequests));
router.patch('/dealer/requests/:id/respond', verifyDealerToken, wrap(controller.respondOffer));
router.patch('/dealer/requests/:id/status', verifyDealerToken, wrap(controller.dealerUpdateStatus));
router.patch('/dealer/requests/:id/location',verifyDealerToken,wrap(controller.updateDealerLocation));
router.patch('/dealer/requests/:id/towing',verifyDealerToken,wrap(controller.startTowing));
router.patch('/dealer/requests/:id/handover',verifyDealerToken,wrap(controller.verifyTowingHandover));
router.patch('/dealer/requests/:id/cash',verifyDealerToken,wrap(controller.confirmCashReceived));
router.patch('/requests/:id/completion',requireCustomer,wrap(controller.customerCompletion));

router.get('/admin/services', requireAdmin, wrap(controller.adminServices));
router.post('/admin/services', requireAdmin, wrap(controller.createService));
router.put('/admin/services/:id', requireAdmin, wrap(controller.updateService));
router.get('/admin/areas', requireAdmin, wrap(controller.adminAreas));
router.post('/admin/areas', requireAdmin, wrap(controller.createArea));
router.put('/admin/areas/:id', requireAdmin, wrap(controller.updateArea));
router.put('/admin/dealers/:dealerId/permission', requireAdmin, wrap(controller.setDealerPermission));
router.get('/admin/proposals', requireAdmin, wrap(controller.adminProposals));
router.patch('/admin/proposals/:id/review', requireAdmin, wrap(controller.reviewPrice));

router.get('/dealer/catalog', verifyDealerToken, wrap(controller.dealerCatalog));
router.get('/dealer/services', verifyDealerToken, wrap(controller.dealerServices));
router.post('/dealer/services', verifyDealerToken, wrap(controller.addDealerService));
router.put('/dealer/services/:id/price', verifyDealerToken, wrap(controller.submitPrice));
router.patch('/dealer/services/:id/status', verifyDealerToken, wrap(controller.toggleDealerService));
router.patch('/dealer/services/:id/revision', verifyDealerToken, wrap(controller.acceptRevision));

module.exports = router;
