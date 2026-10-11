function coordinatesValid(lat, lng) {
  return Number.isFinite(Number(lat)) && Number(lat) >= -90 && Number(lat) <= 90 &&
    Number.isFinite(Number(lng)) && Number(lng) >= -180 && Number(lng) <= 180;
}
function validBoundary(boundary) {
  if (!boundary || !['Polygon', 'MultiPolygon'].includes(boundary.type) || !Array.isArray(boundary.coordinates)) return false;
  const polygons = boundary.type === 'Polygon' ? [boundary.coordinates] : boundary.coordinates;
  return polygons.length > 0 && polygons.every(poly => Array.isArray(poly) && poly.length > 0 && poly.every(ring =>
    Array.isArray(ring) && ring.length >= 4 && ring.every(pair => Array.isArray(pair) && pair.length === 2 && coordinatesValid(pair[1], pair[0])) &&
    JSON.stringify(ring[0]) === JSON.stringify(ring[ring.length - 1])));
}
function moneyValid(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100000; }
function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = x => x * Math.PI / 180, dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
module.exports = {coordinatesValid, validBoundary, moneyValid, distanceKm};
