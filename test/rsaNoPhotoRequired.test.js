const assert = require('assert');
const mongoose = require('mongoose');
const RSARequest = require('../models/RSARequest');
const rsaRoutes = require('../routes/rsaRoutes');
const rsaController = require('../controller/rsaController');

const request = new RSARequest({
  customerId: new mongoose.Types.ObjectId(),
  serviceId: new mongoose.Types.ObjectId(),
  bikeId: new mongoose.Types.ObjectId(),
  location: {latitude: 17.4, longitude: 78.4},
  dispatchMode: 'auto',
  idempotencyKey: 'rsa-no-photo-required',
});

assert.strictEqual(request.validateSync(), undefined, 'a valid RSA request needs no photo');
assert.strictEqual(RSARequest.schema.path('photos'), undefined, 'new RSA request documents have no photo collection');
assert.strictEqual(RSARequest.schema.path('photoUrl'), undefined, 'new RSA request documents have no photo URL');
assert.strictEqual(Object.hasOwn(request.toObject(), 'photos'), false);
assert.strictEqual(Object.hasOwn(request.toObject(), 'photoUrl'), false);
assert.strictEqual(rsaController.uploadRequestPhoto, undefined);
assert.strictEqual(rsaController.authorizePhotoUpload, undefined);
assert.strictEqual(rsaController.readRequestPhoto, undefined);

const routePaths = rsaRoutes.stack
  .filter(layer => layer.route)
  .map(layer => layer.route.path);
assert.strictEqual(routePaths.some(path => /photo/i.test(path)), false, 'RSA API has no photo upload or read routes');

console.log('RSA requests require no photo field and expose no photo routes.');
