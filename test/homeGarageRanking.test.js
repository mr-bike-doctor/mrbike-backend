const assert = require("assert")
const { rankHomeGarages } = require("../v1-api/controllers/homeController")

const garage = (name, averageRating, ratingCount, distanceKm) =>
  ({ dealerId: name, shopName: name, averageRating, ratingCount, distanceKm })

// Six rated garages and four unrated ones in the same area.
const ranked = rankHomeGarages([
  garage("R6", 4.0, 5, 1),
  garage("New far", 0, 0, 6),
  garage("R1", 4.9, 10, 5),
  garage("R3", 4.5, 2, 2),
  garage("New mid", 0, 0, 2.1),
  garage("R2", 4.8, 3, 1),
  garage("R5", 4.2, 1, 1),
  garage("New near", 0, 0, 0.5),
  garage("R4", 4.4, 1, 3),
  garage("New 4km", 0, 0, 4),
])

// Top 5 rated, then the 3 nearest new garages, then everyone else.
assert.deepStrictEqual(
  ranked.map(g => g.shopName),
  ["R1", "R2", "R3", "R4", "R5", "New near", "New mid", "New 4km", "R6", "New far"],
)

// Every garage is kept — nothing is cut off for having no ratings.
assert.strictEqual(ranked.length, 10)
assert.deepStrictEqual(ranked.filter(g => g.isNew).map(g => g.shopName), ["New near", "New mid", "New 4km", "New far"])

// An area with only new garages still lists all of them, nearest first.
assert.deepStrictEqual(
  rankHomeGarages([garage("B", 0, 0, 3), garage("A", 0, 0, 1)]).map(g => g.shopName),
  ["A", "B"],
)

console.log("homeGarageRanking.test.js — all assertions passed")
