const assert = require('assert');
const RSAService = require('../models/RSAService');
const {coordinatesValid, validBoundary, moneyValid, distanceKm} = require('../services/rsaValidation');
const controller = require('../controller/rsaController');

const ring = [[77.5,12.9],[77.7,12.9],[77.7,13.1],[77.5,13.1],[77.5,12.9]];
assert.strictEqual(validBoundary({type:'Polygon',coordinates:[ring]}), true);
assert.strictEqual(validBoundary({type:'Polygon',coordinates:[ring.slice(0,-1)]}), false, 'open rings fail validation');
assert.strictEqual(validBoundary({type:'Polygon',coordinates:[[[181,0],[182,0],[182,1],[181,1],[181,0]]]}), false, 'out of range longitude fails');
assert.strictEqual(validBoundary({type:'Point',coordinates:[0,0]}), false, 'non-area GeoJSON fails');
assert.strictEqual(coordinatesValid('12.9','77.5'), true);
assert.strictEqual(coordinatesValid(91,77), false);
assert.strictEqual(moneyValid(0), true);
assert.strictEqual(moneyValid(100001), false);
assert.strictEqual(moneyValid(-1), false);
assert(Math.abs(distanceKm(12.9,77.5,12.9,77.5)) < 0.001);

(async () => {
  const originalFind = RSAService.find;
  let filter;
  RSAService.find = query => { filter = query; return {sort: () => ({lean: async () => []})}; };
  const response = {statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await controller.customerCatalog({}, response);
  assert.deepStrictEqual(filter, {isActive:true}, 'customer catalog only queries globally enabled services');
  assert.deepStrictEqual(response.body.data, [], 'unconfigured RSA catalog returns no fabricated services');
  RSAService.find = originalFind;
  console.log('RSA validation and fail-closed catalog checks passed.');
})().catch(error => { console.error(error); process.exitCode=1; });
