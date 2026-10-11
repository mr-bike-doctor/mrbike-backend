/**
 * Bike-aware service & garage eligibility — the single source of truth.
 *
 * The rule this file exists to enforce:
 *
 *   DISCOVERY = ALL SAVED BIKES   (union across the rider's whole garage)
 *   BOOKING   = ONE SELECTED BIKE (intersection for that one bike)
 *
 * Before this module, "which services can I show?" was answered independently
 * in homeController (quick-services / recommended / most-booked / top-garages)
 * and in serviceController (listByCategory / getServiceById / garagesForService),
 * each with a slightly different subset of the rules. The user-visible symptom
 * was a service card that opened onto an empty garage list: the card had been
 * filtered on bike compatibility only, while the garage list also applied
 * dealer bookability and per-dealer service radius.
 *
 * A service/garage is eligible only when ALL of these hold for at least one
 * saved bike (discovery) or for the selected bike (booking):
 *   - the BaseService is active
 *   - some AdminService for it is active                    (adminService.isActive)
 *   - its dealer is bookable                                (helper/dealerStatus)
 *   - that AdminService supports the bike's brand/model/variant/cc
 *     with a real price row                                 (geoAndRatings matchers)
 *   - the dealer's own radius reaches the user              (helper/dealerServiceRadius)
 *   - the dealer tows, when towing is required              (dealer.providesTowing)
 *
 * Nothing here prices a booking. AdminService.bikes[].price is read only to
 * produce indicative "from ₹" figures; the payable amount still comes solely
 * from services/pricingEngine.js via /pricing/quote.
 */

const mongoose = require("mongoose")
const Vendor = require("../../models/dealerModel")
const AdminService = require("../../models/adminService")
const UserBike = require("../../models/userBikeModel")
const { isDealerBookable } = require("../../helper/dealerStatus")
const {
  getDealerServiceRadiusKm,
  isWithinServiceRadius,
  serviceRadiusBoundingBoxDegrees,
} = require("../../helper/dealerServiceRadius")
const {
  calculateDistanceKm,
  isAdminServiceCompatibleWithBike,
  priceForBike,
} = require("./geoAndRatings")

// Everything the eligibility rules read off a dealer: isDealerBookable()'s
// inputs, the coordinates + radius the location rule needs, and the towing
// capability flag. Projected rather than pulling whole Vendor documents —
// discovery touches every nearby dealer on every home load.
const ELIGIBILITY_DEALER_FIELDS =
  "isBlocked online dealerStatus registrationStatus status isActive isDoc latitude longitude serviceRadiusKm providesTowing"

// Dealer fields a garage card renders, on top of the eligibility fields above.
const GARAGE_DEALER_FIELDS =
  `${ELIGIBILITY_DEALER_FIELDS} shopName city locality shopImages providesPickup providesDrop towingCharges pickupCharges`

// A dealer must also be solvent to take work — same floor the nearby-dealer
// lookup in geoAndRatings.js applies.
const MINIMUM_SERVICE_WALLET = -500
const SOLVENCY_FILTER = { wallet: { $gt: MINIMUM_SERVICE_WALLET } }

function hasEligibleWalletBalance(wallet) {
  return typeof wallet === "number" && Number.isFinite(wallet) && wallet > MINIMUM_SERVICE_WALLET
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function toPositiveNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== ""
}

/**
 * The non-geographic half of "may a user see this dealer": online, solvent,
 * not blocked, and — when the bike has to be towed — actually able to tow.
 * isDealerBookable() applies the rest (approval/active) in memory, because it
 * has to reconcile the legacy status fields.
 */
function dealerScopeBaseFilter({ towingRequired = false } = {}) {
  const filter = { online: true, isBlocked: { $ne: true }, ...SOLVENCY_FILTER }
  if (towingRequired) filter.providesTowing = true
  return filter
}

function toBikeContext(bike) {
  const variant = bike && bike.variant_id
  const model = variant && variant.model_id
  const company = model && model.company_id
  if (!variant || !model || !company) return null

  // Number(null) is 0, and a cc of 0 matches no price row at all — it would
  // quietly make the bike incompatible with everything rather than falling
  // back. Anything missing or non-positive must read as "unknown cc" instead.
  const ccFromVariant = toPositiveNumber(variant.engine_cc)
  const ccFromBike = toPositiveNumber(bike.bike_cc)

  return {
    bikeId: String(bike._id),
    bikeName: bike.name,
    plateNumber: bike.plate_number,
    companyId: company._id,
    modelId: model._id,
    variantId: variant._id,
    // engine_cc on the variant is authoritative; the denormalized string on
    // the saved bike is only a fallback for rows written before variants
    // carried a cc.
    cc: ccFromVariant != null ? ccFromVariant : ccFromBike,
  }
}

const BIKE_POPULATE = {
  path: "variant_id",
  populate: { path: "model_id", populate: { path: "company_id" } },
}

/**
 * Every saved bike of a rider, as eligibility contexts.
 *
 * One find() plus mongoose's batched populate (one query per nesting level,
 * regardless of how many bikes the rider has) — never one query per bike.
 * Bikes whose variant/model/brand chain is broken are skipped rather than
 * treated as "matches everything".
 */
async function resolveBikeContextsForUser(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return []
  const bikes = await UserBike.find({ user_id: userId, status: { $ne: 0 } }).sort({ createdAt: 1, _id: 1 }).populate(BIKE_POPULATE)
  let customer = null
  try {
    customer = await UserBike.db.model("customers").findById(userId).select("primaryBikeId").lean()
  } catch (error) {
    if (error?.name !== "MissingSchemaError") throw error
  }
  const storedId = customer?.primaryBikeId ? String(customer.primaryBikeId) : null
  const chosen = bikes.some(bike => String(bike._id) === storedId) ? storedId : String(bikes[0]?._id || "")
  return bikes.map(bike => {
    const context = toBikeContext(bike)
    return context ? { ...context, isPrimary: context.bikeId === chosen } : null
  }).filter(Boolean)
}

/** A single saved bike, optionally pinned to its owner. */
async function resolveBikeContextById(bikeId, userId = null) {
  if (!bikeId || !mongoose.Types.ObjectId.isValid(bikeId)) return null
  const filter = { _id: bikeId }
  if (userId && mongoose.Types.ObjectId.isValid(userId)) filter.user_id = userId
  const bike = await UserBike.findOne({ ...filter, status: { $ne: 0 } }).populate(BIKE_POPULATE)
  return bike ? toBikeContext(bike) : null
}

/**
 * Which bikes a DISCOVERY request should be evaluated against.
 *
 * Precedence, most explicit first:
 *   1. bikeIds=a,b,c   — caller named the exact set
 *   2. bikeId=a        — caller named one bike (legacy param, still honoured)
 *   3. authenticated rider — ALL saved bikes, which is the default and the
 *      whole point of Phase A: discovery must never be narrowed to whichever
 *      bike the app happened to have selected.
 *   4. nothing         — anonymous/no-bike discovery, no compatibility filter
 */
async function resolveDiscoveryBikeContexts({ userId = null, bikeId = null, bikeIds = null } = {}) {
  const explicitIds = normalizeIdList(bikeIds)
  if (explicitIds.length) {
    const contexts = await resolveBikeContextsByIds(explicitIds, userId)
    return { contexts, source: "explicit" }
  }

  if (bikeId) {
    const context = await resolveBikeContextById(bikeId, userId)
    return { contexts: context ? [context] : [], source: "bike" }
  }

  if (userId) {
    const contexts = await resolveBikeContextsForUser(userId)
    const storedId = contexts.find(ctx => ctx.isPrimary)?.bikeId || null
    const primaryBikeId = contexts.some(ctx => ctx.bikeId === storedId) ? storedId : contexts[0]?.bikeId || null
    return { contexts, primaryBikeId, source: contexts.length ? "user" : "none" }
  }

  return { contexts: [], primaryBikeId: null, source: "none" }
}

function normalizeIdList(value) {
  if (!value) return []
  const raw = Array.isArray(value) ? value : String(value).split(",")
  return raw.map(v => String(v).trim()).filter(v => mongoose.Types.ObjectId.isValid(v))
}

/** Several saved bikes in one query (used by the explicit `bikeIds` path). */
async function resolveBikeContextsByIds(ids, userId = null) {
  if (!ids.length) return []
  const filter = { _id: { $in: ids } }
  if (userId && mongoose.Types.ObjectId.isValid(userId)) filter.user_id = userId
  const bikes = await UserBike.find({ ...filter, status: { $ne: 0 } }).populate(BIKE_POPULATE)
  return bikes.map(toBikeContext).filter(Boolean)
}

/**
 * The set of dealers a request is allowed to see, in ONE query.
 *
 * - live coordinates → bookable dealers whose own radius reaches the point
 * - city             → bookable dealers in that city (admin/no-GPS fallback)
 * - neither          → every bookable dealer on the network
 *
 * That last case is the one that used to leak: with no location, discovery
 * fell back to "any AdminService row", including rows belonging to dealers
 * that are offline, blocked or not approved. Network scope is still network
 * scope, but it is now bookable dealers only.
 *
 * Returns `dealerIds` (never null) plus `allowedDealerIds` as a Set so a
 * caller can filter AdminService rows in memory instead of shipping a huge
 * `$in` to mongo on network scope.
 */
async function resolveDealerScope({
  lat,
  lng,
  city,
  radiusKm = null,
  towingRequired = false,
  select = GARAGE_DEALER_FIELDS,
} = {}) {
  const baseFilter = dealerScopeBaseFilter({ towingRequired })

  const coordsSupplied = hasValue(lat) || hasValue(lng)
  const latitude = Number.parseFloat(lat)
  const longitude = Number.parseFloat(lng)
  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude)

  // A caller that meant to send coordinates but sent them malformed (or sent
  // only one half of the pair) must be told, never silently widened to the
  // whole network — that is exactly the kind of fallback Phase A removes.
  if (coordsSupplied && !hasCoords) throw new Error("INVALID_COORDINATES")

  if (hasCoords) {
    // Coarse box sized off the widest radius any dealer may configure, so a
    // far-reaching garage is never dropped before its own radius is consulted.
    const boxDelta = serviceRadiusBoundingBoxDegrees()
    const dealers = await Vendor.find({
      ...baseFilter,
      latitude: { $gte: latitude - boxDelta, $lte: latitude + boxDelta },
      longitude: { $gte: longitude - boxDelta, $lte: longitude + boxDelta },
    })
      .select(select)
      .lean()

    const callerCap = Number(radiusKm)
    const hasCallerCap = Number.isFinite(callerCap) && callerCap > 0

    const entries = dealers
      .filter(isDealerBookable)
      .map(dealer => ({ dealer, distanceKm: calculateDistanceKm(latitude, longitude, dealer.latitude, dealer.longitude) }))
      .filter(entry => isWithinServiceRadius(entry.distanceKm, entry.dealer))
      .filter(entry => !hasCallerCap || entry.distanceKm <= callerCap)
      .sort((a, b) => a.distanceKm - b.distanceKm)

    return buildScope("area", entries)
  }

  if (city) {
    // City comes straight off the query string, so it is escaped before it
    // becomes a regex — an unescaped value would let a caller inject a pattern.
    const dealers = await Vendor.find({ ...baseFilter, city: new RegExp(`^${escapeRegex(String(city).trim())}$`, "i") })
      .select(select)
      .lean()
    return buildScope("city", dealers.filter(isDealerBookable).map(dealer => ({ dealer, distanceKm: null })))
  }

  const dealers = await Vendor.find(baseFilter).select(select).lean()
  return buildScope("network", dealers.filter(isDealerBookable).map(dealer => ({ dealer, distanceKm: null })))
}

function buildScope(kind, entries) {
  const dealerById = new Map()
  const distanceByDealerId = new Map()
  entries.forEach(({ dealer, distanceKm }) => {
    const key = String(dealer._id)
    dealerById.set(key, dealer)
    if (distanceKm != null) distanceByDealerId.set(key, distanceKm)
  })

  return {
    kind,
    // "area"/"city" narrow the world and are safe to push into mongo as $in.
    // "network" can be every dealer on the platform, so it is applied as an
    // in-memory Set instead of a multi-thousand-element $in.
    dealerIds: entries.map(e => e.dealer._id),
    allowedDealerIds: new Set(dealerById.keys()),
    dealerById,
    distanceByDealerId,
    isEmpty: dealerById.size === 0,
  }
}

/** Mongo filter fragment restricting AdminService rows to a scope. */
function adminServiceScopeFilter(scope) {
  if (!scope || scope.kind === "network") return {}
  return { dealer_id: { $in: scope.dealerIds } }
}

/**
 * Does this AdminService work for this bike?
 *
 * Delegates to the existing matchers so cards, detail screens and garage
 * lists can never drift apart: brand must be listed, and some price row must
 * match the bike's model/variant/cc.
 */
function adminServiceSupportsBike(adminService, bikeContext) {
  if (!bikeContext) return true
  return isAdminServiceCompatibleWithBike(adminService, bikeContext)
}

/** The first saved bike (if any) this AdminService can actually serve. */
function matchingBikeContexts(adminService, bikeContexts) {
  if (!bikeContexts || !bikeContexts.length) return []
  return bikeContexts.filter(ctx => adminServiceSupportsBike(adminService, ctx))
}

/**
 * THE discovery query. One AdminService read, one pass in memory.
 *
 * `bikeContexts` is the rider's whole garage: a base service is eligible when
 * AT LEAST ONE saved bike has a bookable, in-range provider for it. That is
 * the union the spec calls for — bikes A(1,2) + B(2,3) + C(4,5) yield
 * {1,2,3,4,5}, de-duplicated by base_service_id.
 *
 * With no bike contexts, compatibility is not applied at all (there is no
 * bike to be compatible with) but provider availability still is.
 */
async function resolveEligibleServices({ scope, bikeContexts = [], baseServiceIds = null } = {}) {
  if (!scope || scope.isEmpty) return { serviceIds: [], byServiceId: new Map() }

  const filter = { isActive: true, ...adminServiceScopeFilter(scope) }
  if (bikeContexts.length) {
    // Brand narrowing is pushed into mongo; model/variant/cc narrowing needs
    // the price rows and happens in the single in-memory pass below.
    filter.companies = { $in: bikeContexts.map(ctx => ctx.companyId) }
  }
  if (baseServiceIds && baseServiceIds.length) {
    filter.base_service_id = { $in: baseServiceIds }
  }

  const rows = await AdminService.find(filter).select("base_service_id dealer_id companies bikes").lean()

  return buildServiceEligibilityIndex({ rows, scope, bikeContexts })
}

/**
 * The union itself, as a pure function over already-fetched rows — no mongo,
 * so test/serviceEligibility.test.js can assert the multi-bike behaviour
 * directly.
 *
 * Bikes A(services 1,2) + B(2,3) + C(4,5) produce {1,2,3,4,5}: one bucket per
 * base service, carrying which saved bikes and which dealers made it eligible.
 */
function buildServiceEligibilityIndex({ rows = [], scope, bikeContexts = [] } = {}) {
  const byServiceId = new Map()

  rows.forEach(row => {
    const dealerKey = String(row.dealer_id)
    if (scope && !scope.allowedDealerIds.has(dealerKey)) return

    const matches = bikeContexts.length ? matchingBikeContexts(row, bikeContexts) : []
    // With saved bikes in play, a row that serves none of them is not
    // eligible for anybody — no "show it anyway" fallback.
    if (bikeContexts.length && !matches.length) return

    const key = String(row.base_service_id)
    let bucket = byServiceId.get(key)
    if (!bucket) {
      bucket = {
        baseServiceId: key,
        dealerIds: new Set(),
        eligibleBikeIds: new Set(),
        adminServiceIds: [],
        minPrice: null,
        minDistanceKm: null,
        nearestDealerId: null,
      }
      byServiceId.set(key, bucket)
    }

    bucket.dealerIds.add(dealerKey)
    bucket.adminServiceIds.push(row._id)
    matches.forEach(ctx => bucket.eligibleBikeIds.add(ctx.bikeId))

    const price = resolveIndicativePrice(row, matches)
    if (price != null && (bucket.minPrice == null || price < bucket.minPrice)) bucket.minPrice = price

    const distanceKm = scope ? scope.distanceByDealerId.get(dealerKey) : null
    if (distanceKm != null && (bucket.minDistanceKm == null || distanceKm < bucket.minDistanceKm)) {
      bucket.minDistanceKm = distanceKm
      bucket.nearestDealerId = row.dealer_id
    } else if (bucket.nearestDealerId == null) {
      bucket.nearestDealerId = row.dealer_id
    }
  })

  return { serviceIds: Array.from(byServiceId.keys()), byServiceId }
}

/**
 * Indicative price for a card: the cheapest price across the saved bikes this
 * row actually serves, or — with no bike context — the row's cheapest entry.
 * Display only; never a quote.
 */
function resolveIndicativePrice(adminService, matchedContexts) {
  if (matchedContexts && matchedContexts.length) {
    const prices = matchedContexts.map(ctx => priceForBike(adminService, ctx)).filter(p => typeof p === "number")
    return prices.length ? Math.min(...prices) : null
  }
  const prices = (adminService.bikes || []).map(b => b.price).filter(p => typeof p === "number")
  return prices.length ? Math.min(...prices) : null
}

/**
 * BOOKING side: the garages that can take THIS service for THIS one bike.
 *
 * Returns entries, not a response body — the caller decides what a garage card
 * looks like. Returns an empty array rather than falling back to garages that
 * cannot serve the bike: a rider shown a garage here and refused at checkout
 * is strictly worse than an honest "none nearby".
 */
async function resolveEligibleGarages({
  baseServiceId,
  bikeContext = null,
  variantId = null,
  cc = null,
  lat,
  lng,
  city,
  radiusKm = null,
  towingRequired = false,
} = {}) {
  const scope = await resolveDealerScope({ lat, lng, city, radiusKm, towingRequired })
  if (scope.isEmpty) return { scope, entries: [] }

  const filter = { isActive: true, base_service_id: baseServiceId, ...adminServiceScopeFilter(scope) }
  if (bikeContext) filter.companies = bikeContext.companyId

  const rows = await AdminService.find(filter).select("base_service_id dealer_id companies bikes").lean()

  return { scope, entries: buildGarageEntries({ rows, scope, bikeContext, variantId, cc }) }
}

/**
 * Pure counterpart of resolveEligibleGarages: turn AdminService rows into
 * garage entries for one selected bike. Exported so the booking-side rules can
 * be unit-tested without a DB.
 */
function buildGarageEntries({ rows = [], scope, bikeContext = null, variantId = null, cc = null } = {}) {
  const entries = []

  rows.forEach(row => {
    const dealerKey = String(row.dealer_id)
    const dealer = scope ? scope.dealerById.get(dealerKey) : null
    if (!dealer) return

    let price = null
    if (bikeContext) {
      if (!adminServiceSupportsBike(row, bikeContext)) return
      price = priceForBike(row, bikeContext)
      // No price for this bike means this garage cannot actually take the
      // booking, whatever its brand list says.
      if (price == null) return
    } else if (variantId) {
      // Legacy narrowing: the caller knows the variant (and maybe the cc) but
      // not the brand/model. Matches exactly what the old garagesForService
      // did, so existing clients see no change.
      const wantedCc = cc == null || cc === "" ? null : Number(cc)
      const match = (row.bikes || []).find(
        b =>
          b.variant_id &&
          String(b.variant_id) === String(variantId) &&
          (wantedCc === null || Number.isNaN(wantedCc) || Number(b.cc) === wantedCc) &&
          typeof b.price === "number",
      )
      if (!match) return
      price = match.price
    } else {
      const prices = (row.bikes || []).map(b => b.price).filter(p => typeof p === "number")
      price = prices.length ? Math.min(...prices) : null
    }

    entries.push({
      adminServiceId: row._id,
      dealer,
      price,
      distanceKm: scope.distanceByDealerId.get(dealerKey) ?? null,
      serviceRadiusKm: getDealerServiceRadiusKm(dealer),
    })
  })

  return entries
}

module.exports = {
  ELIGIBILITY_DEALER_FIELDS,
  GARAGE_DEALER_FIELDS,
  MINIMUM_SERVICE_WALLET,
  hasEligibleWalletBalance,
  toBikeContext,
  normalizeIdList,
  resolveBikeContextsForUser,
  resolveBikeContextById,
  resolveBikeContextsByIds,
  resolveDiscoveryBikeContexts,
  resolveDealerScope,
  dealerScopeBaseFilter,
  adminServiceScopeFilter,
  adminServiceSupportsBike,
  matchingBikeContexts,
  resolveEligibleServices,
  buildServiceEligibilityIndex,
  resolveIndicativePrice,
  resolveEligibleGarages,
  buildGarageEntries,
  buildScope,
}
