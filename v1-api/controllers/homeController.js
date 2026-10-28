const mongoose = require("mongoose")
const BaseService = require("../../models/baseService")
const ServiceCategory = require("../../models/serviceCategoryModel")
const {
  getRatingsMap,
  computeServicePopularity,
  DEFAULT_RADIUS_KM,
} = require("../helpers/geoAndRatings")
const {
  resolveDiscoveryBikeContexts,
  resolveDealerScope,
  resolveEligibleServices,
} = require("../helpers/serviceEligibility")

function formatImage(url, req) {
  if (url && !url.startsWith("http")) {
    return `${req.protocol}://${req.get("host")}/${url}`
  }
  return url
}

// Exactly the fields serializeService() below reads. Home responses are the
// hottest reads in the app, and rich Service Detail content is deliberately
// kept in the separate `servicedetails` collection — this projection is the
// belt to that braces, guaranteeing nothing added to BaseService later can
// silently inflate a home payload.
const SERVICE_CARD_FIELDS = "name image description categoryId basePrice duration pickupAvailable warranty"
const FEED_SERVICE_FIELDS = `${SERVICE_CARD_FIELDS} isFeatured isQuickService`

function serializeService(service, req) {
  return {
    serviceId: service._id,
    name: service.name,
    image: formatImage(service.image, req),
    description: service.description,
    categoryId: service.categoryId || null,
    basePrice: service.basePrice,
    duration: service.duration,
    pickupAvailable: service.pickupAvailable,
    warranty: service.warranty,
  }
}

function feedSection(key, title, itemType, items, limit) {
  const boundedItems = limit == null ? items : items.slice(0, limit)
  return { key, title, itemType, visible: boundedItems.length > 0, items: boundedItems }
}

// Home's garage row and its "See All" list. Every eligible nearby garage is
// returned, so a newly onboarded garage with no ratings is
// never hidden behind established ones. The row on Home shows the head of this
// list: top-rated first, then a few new garages, then everyone else.
const HOME_GARAGE_LIMIT = 500
const HOME_TOP_RATED_SLOTS = 5
const HOME_NEW_GARAGE_SLOTS = 3

const byDistance = (a, b) =>
  (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER)

function rankHomeGarages(garages) {
  const tagged = garages.map(garage => ({ ...garage, isNew: !garage.ratingCount }))
  const rated = tagged
    .filter(garage => !garage.isNew)
    .sort((a, b) => b.averageRating - a.averageRating || byDistance(a, b) ||
      a.shopName.localeCompare(b.shopName) || String(a.dealerId).localeCompare(String(b.dealerId)))
  const fresh = tagged
    .filter(garage => garage.isNew)
    .sort((a, b) => byDistance(a, b) ||
      a.shopName.localeCompare(b.shopName) || String(a.dealerId).localeCompare(String(b.dealerId)))
  return [
    ...rated.slice(0, HOME_TOP_RATED_SLOTS),
    ...fresh.slice(0, HOME_NEW_GARAGE_SLOTS),
    ...rated.slice(HOME_TOP_RATED_SLOTS),
    ...fresh.slice(HOME_NEW_GARAGE_SLOTS),
  ]
}

function sortByPopularityThenDistance(a, b) {
  return b.popularityCount - a.popularityCount ||
    (a.nearestDealerDistanceKm ?? Number.MAX_SAFE_INTEGER) - (b.nearestDealerDistanceKm ?? Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name) || String(a.serviceId).localeCompare(String(b.serviceId))
}

// Additive composed feed. Eligibility is resolved once, then every service
// section is selected from that same eligible id set. Individual legacy feeds
// below remain untouched for older app versions.
async function homeFeed(req, res) {
  try {
    const context = await resolveDiscoveryContext(req, res)
    if (context === null) return
    const { bikeContexts, primaryBikeId, scope, eligibility } = context

    const pricedEligibleServiceIds = eligibility.serviceIds.filter(id =>
      eligibility.byServiceId.get(String(id))?.minPrice != null,
    )
    if (!pricedEligibleServiceIds.length) {
      return res.status(200).json({
        status: true,
        message: "Home feed fetched",
        data: {
          sections: [
            feedSection("categories", "Browse by Category", "categories", [], 12),
            feedSection("featured", "Featured Services", "services", [], 8),
            feedSection("quickServices", "Quick Services", "services", [], 8),
            feedSection("mostBooked", "Most Booked", "services", [], 6),
            feedSection("recommended", "Recommended For Your Bike", "services", [], 10),
            feedSection("explore", "Explore Services", "services", [], 12),
            feedSection("topGarages", "Top Rated Garages", "garages", [], 5),
          ],
          primaryBike: bikeContexts.find(ctx => ctx.bikeId === primaryBikeId)
            ? { bikeId: primaryBikeId, name: bikeContexts.find(ctx => ctx.bikeId === primaryBikeId).bikeName }
            : null,
          emptyState: { key: "coverage", message: "Services are not available in this area yet", action: "changeLocation" },
        },
        meta: scopeMeta(scope, bikeContexts, context.primaryBikeId),
      })
    }

    const [services, categories, popularity] = await Promise.all([
      BaseService.find({ _id: { $in: pricedEligibleServiceIds }, isActive: true })
        .select(FEED_SERVICE_FIELDS)
        .sort({ name: 1, _id: 1 })
        .lean(),
      ServiceCategory.find({ isActive: true }).sort({ sortOrder: 1, name: 1, _id: 1 }).lean(),
      computeServicePopularity(popularityScopeIds(scope)),
    ])

    const categoryById = new Map(categories.map(category => [String(category._id), category]))
    const rankedServices = services.map(service => {
      const id = String(service._id)
      const bucket = eligibility.byServiceId.get(id)
      const pop = popularity.get(id) || { count: 0, source: "dealerCount" }
      const distance = bucket?.minDistanceKm
      const serialized = {
        ...serializeService(service, req),
        category: service.categoryId ? (() => {
          const category = categoryById.get(String(service.categoryId))
          return category ? { id: category._id, name: category.name, icon: category.icon } : null
        })() : null,
        basePrice: bucket?.minPrice ?? service.basePrice,
        providerCount: bucket?.dealerIds.size || 0,
        eligibleBikeIds: Array.from(bucket?.eligibleBikeIds || []),
        compatibleBikeIds: Array.from(bucket?.eligibleBikeIds || []),
        compatibleBikeCount: bucket?.eligibleBikeIds?.size || 0,
        isPrimaryBikeCompatible: !!primaryBikeId && bucket?.eligibleBikeIds?.has(primaryBikeId),
        popularityCount: pop.count,
        popularitySource: pop.source,
        nearestDealerDistanceKm: distance != null ? Number(distance.toFixed(2)) : null,
      }
      return {
        ...serialized,
        _isFeatured: !!service.isFeatured,
        _isQuickService: !!service.isQuickService,
      }
    })

    const comparePrimaryFirst = (a, b) => Number(b.isPrimaryBikeCompatible) - Number(a.isPrimaryBikeCompatible) || sortByPopularityThenDistance(a, b)
    const used = new Set()
    const take = (rows, limit) => {
      const selected = []
      rows.forEach(item => {
        const id = String(item.serviceId)
        if (used.has(id) || selected.length >= limit) return
        used.add(id)
        const { _isFeatured, _isQuickService, ...publicItem } = item
        selected.push(publicItem)
      })
      return selected
    }
    const featured = take(rankedServices.filter(item => item._isFeatured).sort(comparePrimaryFirst), 8)
    const quick = take(rankedServices.filter(item => item._isQuickService).sort(comparePrimaryFirst), 8)
    const mostBooked = take(rankedServices
      .filter(item => item.popularitySource === "bookings" && item.popularityCount > 0)
      .sort(sortByPopularityThenDistance), 6)
      .map(item => ({ ...item, bookingCount: item.popularityCount, isFallback: false }))

    const maxCount = Math.max(1, ...rankedServices.map(item => item.popularityCount))
    const distanceValues = rankedServices.map(item => item.nearestDealerDistanceKm).filter(value => value != null)
    const proximityScale = Math.max(DEFAULT_RADIUS_KM, ...distanceValues)
    const recommendedCandidates = rankedServices
      .filter(item => !used.has(String(item.serviceId)))
      .map(item => {
        const popularityScore = item.popularityCount / maxCount
        const distance = item.nearestDealerDistanceKm
        const proximityScore = distance != null ? Math.max(0, 1 - distance / proximityScale) : 0
        const score = bikeContexts.length
          ? 0.5 * popularityScore + 0.3 * proximityScore + 0.2
          : 0.6 * popularityScore + 0.4 * proximityScore
        let reasonCode = "popular"
        let reasonLabel = "Popular near you"
        if (bikeContexts.length && popularityScore < 0.5 && proximityScore < 0.5) {
          reasonCode = "compatible_with_bike"
          reasonLabel = "Great match for your bike"
        } else if (proximityScore > popularityScore) {
          reasonCode = "nearby"
          reasonLabel = "Available nearby"
        }
        return { ...item, score: Number(score.toFixed(3)), reasonCode, reasonLabel }
      })
      .sort((a, b) => Number(b.isPrimaryBikeCompatible) - Number(a.isPrimaryBikeCompatible) || b.score - a.score || sortByPopularityThenDistance(a, b))
    const recommended = take(recommendedCandidates, 10)
    const explore = take(rankedServices.slice().sort(comparePrimaryFirst), 12)

    const representedCategories = new Set(rankedServices
      .map(item => item.category?.id && String(item.category.id))
      .filter(Boolean))
    const visibleCategories = categories
      .filter(category => representedCategories.has(String(category._id)))
      .slice(0, 12)
      .map(category => ({ _id: category._id, id: category.id, name: category.name, icon: category.icon }))

    const eligibleDealerIds = new Set()
    services.forEach(service => {
      const bucket = eligibility.byServiceId.get(String(service._id))
      bucket?.dealerIds.forEach(id => eligibleDealerIds.add(id))
    })
    const dealers = Array.from(eligibleDealerIds).map(id => scope.dealerById.get(id)).filter(Boolean)
    const ratingsMap = await getRatingsMap(dealers.map(dealer => dealer._id))
    const garages = dealers.map(dealer => {
      const rating = ratingsMap.get(String(dealer._id)) || { averageRating: 0, ratingCount: 0 }
      const distanceKm = scope.distanceByDealerId.get(String(dealer._id))
      return {
        dealerId: dealer._id,
        shopName: dealer.shopName,
        city: dealer.city,
        locality: dealer.locality,
        latitude: dealer.latitude,
        longitude: dealer.longitude,
        distanceKm: distanceKm != null ? Number(distanceKm.toFixed(2)) : null,
        averageRating: rating.averageRating,
        ratingCount: rating.ratingCount,
        shopImages: (dealer.shopImages || []).map(url => formatImage(url, req)),
      }
    })
    const rankedGarages = rankHomeGarages(garages)

    const sections = [
      feedSection("categories", "Browse by Category", "categories", visibleCategories, 12),
      feedSection("featured", "Featured Services", "services", featured, 8),
      feedSection("quickServices", "Quick Services", "services", quick, 8),
      feedSection("mostBooked", "Most Booked", "services", mostBooked, 6),
      feedSection("recommended", "Recommended For Your Bike", "services", recommended, 10),
      feedSection("explore", "Explore Services", "services", explore, 12),
      feedSection("topGarages", "Top Rated & New Garages", "garages", rankedGarages),
    ]
    return res.status(200).json({
      status: true,
      message: "Home feed fetched",
      data: {
        sections,
        primaryBike: bikeContexts.find(ctx => ctx.bikeId === primaryBikeId)
          ? { bikeId: primaryBikeId, name: bikeContexts.find(ctx => ctx.bikeId === primaryBikeId).bikeName }
          : null,
        emptyState: rankedServices.length
          ? null
          : { key: "coverage", message: "Services are not available in this area yet", action: "changeLocation" },
      },
      meta: scopeMeta(scope, bikeContexts, primaryBikeId),
    })
  } catch (error) {
    console.error("Error fetching composed Home feed:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

/**
 * Everything every home feed needs, resolved once per request:
 * the rider's whole garage (DISCOVERY = ALL SAVED BIKES), the dealers that can
 * actually reach them, and the union of base services at least one saved bike
 * can be booked for.
 *
 * Three queries, flat: bikes, dealers, AdminService rows. Nothing here scales
 * with the number of services or the number of dealers found.
 */
async function resolveDiscoveryContext(req, res) {
  const { lat, lng, city, bikeId, bikeIds } = req.query

  if (bikeId && !mongoose.Types.ObjectId.isValid(bikeId)) {
    res.status(400).json({ status: false, message: "Invalid bikeId" })
    return null
  }

    const { contexts: bikeContexts, primaryBikeId } = await resolveDiscoveryBikeContexts({
    userId: req.user_id || null,
    bikeId,
    bikeIds,
  })

  let scope
  try {
    scope = await resolveDealerScope({ lat, lng, city })
  } catch (err) {
    res.status(400).json({ status: false, message: "Invalid lat/lng" })
    return null
  }

  const eligibility = await resolveEligibleServices({ scope, bikeContexts })

  return { bikeContexts, primaryBikeId: primaryBikeId || null, scope, eligibility }
}

// Popularity is a ranking signal, not an eligibility gate — eligibility is
// already enforced by the service-id union. Network scope therefore stays
// network-wide rather than shipping every dealer id on the platform into an
// aggregation $in.
function popularityScopeIds(scope) {
  return scope.kind === "network" ? null : scope.dealerIds
}

// `meta.scope` keeps its original two values so existing clients keep working;
// `meta.scopeKind` carries the finer area/city/network distinction.
function scopeMeta(scope, bikeContexts, primaryBikeId = null) {
  return {
    scope: scope.kind === "network" ? "network" : "area",
    scopeKind: scope.kind,
    bikeMatched: bikeContexts.length > 0,
    bikeCount: bikeContexts.length,
    evaluatedBikeIds: bikeContexts.map(ctx => ctx.bikeId),
    primaryBikeId: primaryBikeId || null,
  }
}

// GET /api/v1/home/quick-services?bikeId=&bikeIds=&lat=&lng=
//
// Cards come from what nearby bookable dealers actually offer for the rider's
// saved bikes — never from a standalone catalog. A card that appears here is
// guaranteed to open onto at least one garage that can take the booking.
async function quickServices(req, res) {
  try {
    const context = await resolveDiscoveryContext(req, res)
    if (context === null) return
    const { bikeContexts, scope, eligibility } = context

    if (!eligibility.serviceIds.length) {
      return res.status(200).json({
        status: true,
        message: "No quick services found",
        data: [],
        meta: scopeMeta(scope, bikeContexts),
      })
    }

    const popularity = await computeServicePopularity(popularityScopeIds(scope))

    const baseServices = await BaseService.find({ _id: { $in: eligibility.serviceIds }, isActive: true })
      .select(SERVICE_CARD_FIELDS)
      .lean()

    const ranked = baseServices
      .map(service => {
        const bucket = eligibility.byServiceId.get(String(service._id))
        return {
          service,
          bucket,
          popularity: popularity.get(String(service._id)) || { count: 0, source: "dealerCount" },
        }
      })
      .sort((a, b) => b.popularity.count - a.popularity.count)
      .slice(0, 8)
      .map(({ service, bucket, popularity: p }) => ({
        ...serializeService(service, req),
        // Indicative only — the payable amount still comes from /pricing/quote.
        basePrice: bucket.minPrice != null ? bucket.minPrice : service.basePrice,
        dealerId: bucket.nearestDealerId,
        distanceKm: bucket.minDistanceKm != null ? Number(bucket.minDistanceKm.toFixed(2)) : null,
        providerCount: bucket.dealerIds.size,
        // Which of the rider's saved bikes this card is actually bookable for.
        // Phase B uses this to label a card and to preselect the bike.
        eligibleBikeIds: Array.from(bucket.eligibleBikeIds),
        popularityCount: p.count,
        popularitySource: p.source,
      }))

    return res.status(200).json({
      status: true,
      message: ranked.length ? "Quick services fetched" : "No quick services found",
      data: ranked,
      meta: scopeMeta(scope, bikeContexts),
    })
  } catch (error) {
    console.error("Error fetching quick services:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

// GET /api/v1/home/recommended?bikeId=&bikeIds=&lat=&lng=
async function recommended(req, res) {
  try {
    const context = await resolveDiscoveryContext(req, res)
    if (context === null) return
    const { bikeContexts, scope, eligibility } = context

    if (!eligibility.serviceIds.length) {
      return res.status(200).json({
        status: true,
        message: "No recommendations available",
        data: [],
        meta: scopeMeta(scope, bikeContexts),
      })
    }

    const services = await BaseService.find({ _id: { $in: eligibility.serviceIds }, isActive: true })
      .select(SERVICE_CARD_FIELDS)
      .lean()

    const popularity = await computeServicePopularity(popularityScopeIds(scope))
    const maxCount = Math.max(1, ...Array.from(popularity.values()).map(p => p.count))

    // Nearest eligible dealer per service already came out of the eligibility
    // pass, so this no longer re-reads AdminService a second time.
    const distances = Array.from(eligibility.byServiceId.values())
      .map(b => b.minDistanceKm)
      .filter(d => d != null)

    // Proximity is scored relative to the farthest service actually in scope,
    // never a fixed 3 km: dealers now set their own service radius, so in an
    // area served mostly by wide-radius garages a hard 3 km scale would flatten
    // every proximity score to 0 and stop it ranking anything.
    const proximityScale = Math.max(DEFAULT_RADIUS_KM, ...distances)
    const bikeMatched = bikeContexts.length > 0

    const ranked = services
      .map(s => {
        const key = String(s._id)
        const bucket = eligibility.byServiceId.get(key)
        const pop = popularity.get(key) || { count: 0, source: "dealerCount" }
        const minDistance = bucket.minDistanceKm
        const popularityScore = pop.count / maxCount
        const proximityScore = minDistance != null ? Math.max(0, 1 - minDistance / proximityScale) : 0
        const score = bikeMatched
          ? 0.5 * popularityScore + 0.3 * proximityScore + 0.2
          : 0.6 * popularityScore + 0.4 * proximityScore

        let reasonCode = "popular"
        let reasonLabel = "Popular near you"
        if (bikeMatched && popularityScore < 0.5 && proximityScore < 0.5) {
          reasonCode = "compatible_with_bike"
          reasonLabel = "Great match for your bike"
        } else if (proximityScore > popularityScore) {
          reasonCode = "nearby"
          reasonLabel = "Available nearby"
        }

        return {
          ...serializeService(s, req),
          score: Number(score.toFixed(3)),
          reasonCode,
          reasonLabel,
          popularityCount: pop.count,
          popularitySource: pop.source,
          nearestDealerDistanceKm: minDistance != null ? Number(minDistance.toFixed(2)) : null,
          providerCount: bucket.dealerIds.size,
          eligibleBikeIds: Array.from(bucket.eligibleBikeIds),
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    return res.status(200).json({
      status: true,
      message: ranked.length ? "Recommended services fetched" : "No recommendations available",
      data: ranked,
      meta: scopeMeta(scope, bikeContexts),
    })
  } catch (error) {
    console.error("Error fetching recommended services:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

// GET /api/v1/home/most-booked?lat=&lng=&days=&bikeId=&bikeIds=
// `days` windows the booking count (e.g. days=7 for "this week"); omitted = all-time.
async function mostBooked(req, res) {
  try {
    const { days } = req.query
    let sinceDate = null
    if (days !== undefined) {
      const numDays = Number.parseInt(days, 10)
      if (Number.isNaN(numDays) || numDays <= 0) {
        return res.status(400).json({ status: false, message: "days must be a positive integer" })
      }
      sinceDate = new Date(Date.now() - numDays * 24 * 60 * 60 * 1000)
    }

    const context = await resolveDiscoveryContext(req, res)
    if (context === null) return
    const { bikeContexts, scope, eligibility } = context

    const meta = { ...scopeMeta(scope, bikeContexts), windowDays: sinceDate ? Number.parseInt(days, 10) : null }

    if (!eligibility.serviceIds.length) {
      return res.status(200).json({
        status: true,
        message: "No booking data available yet for this area",
        data: [],
        meta,
      })
    }

    const popularity = await computeServicePopularity(popularityScopeIds(scope), sinceDate)
    const eligibleIds = new Set(eligibility.serviceIds)
    const topIds = Array.from(popularity.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .filter(([id]) => eligibleIds.has(String(id)))
      .slice(0, 6)
      .map(([id]) => String(id))

    const services = await BaseService.find({ _id: { $in: topIds }, isActive: true }).select(SERVICE_CARD_FIELDS).lean()
    const byId = new Map(services.map(s => [String(s._id), s]))

    const ranked = topIds
      .filter(id => byId.has(id))
      .map(id => {
        const p = popularity.get(id)
        const bucket = eligibility.byServiceId.get(id)
        return {
          ...serializeService(byId.get(id), req),
          bookingCount: p.source === "bookings" ? p.count : null,
          dealerCount: p.source === "dealerCount" ? p.count : null,
          isFallback: p.source === "dealerCount",
          providerCount: bucket.dealerIds.size,
          eligibleBikeIds: Array.from(bucket.eligibleBikeIds),
        }
      })

    return res.status(200).json({
      status: true,
      message: ranked.length ? "Most booked services fetched" : "No booking data available yet for this area",
      data: ranked,
      meta,
    })
  } catch (error) {
    console.error("Error fetching most-booked services:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

// GET /api/v1/home/top-garages?lat=&lng=&serviceId=&bikeId=&bikeIds=
//
// A garage is listed only when it can actually serve at least one of the
// rider's saved bikes (and the named service, when one is given). No garage
// appears here that BOOK NOW would then refuse.
async function topGarages(req, res) {
  try {
    const { lat, lng, city, serviceId } = req.query
    if (!lat && !lng && !city) {
      return res.status(400).json({ status: false, message: "lat/lng (or city) is required" })
    }
    if (serviceId && !mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ status: false, message: "Invalid serviceId" })
    }

    const context = await resolveDiscoveryContext(req, res)
    if (context === null) return
    const { bikeContexts, scope } = context

    // When a service is named, re-run the union narrowed to it; otherwise the
    // union already computed covers every service.
    const eligibility = serviceId
      ? await resolveEligibleServices({ scope, bikeContexts, baseServiceIds: [serviceId] })
      : context.eligibility

    const eligibleDealerIds = new Set()
    eligibility.byServiceId.forEach(bucket => bucket.dealerIds.forEach(id => eligibleDealerIds.add(id)))

    const dealers = Array.from(eligibleDealerIds)
      .map(id => scope.dealerById.get(id))
      .filter(Boolean)

    const ratingsMap = await getRatingsMap(dealers.map(d => d._id))

    // Optional page size; defaults to the Home row (top-rated + new garages).
    const requestedLimit = Number.parseInt(req.query.limit, 10)
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, HOME_GARAGE_LIMIT)
      : HOME_TOP_RATED_SLOTS + HOME_NEW_GARAGE_SLOTS

    const ranked = rankHomeGarages(dealers
      .map(dealer => {
        const rating = ratingsMap.get(String(dealer._id)) || { averageRating: 0, ratingCount: 0 }
        const distanceKm = scope.distanceByDealerId.get(String(dealer._id))
        return {
          dealerId: dealer._id,
          shopName: dealer.shopName,
          city: dealer.city,
          locality: dealer.locality,
          latitude: dealer.latitude,
          longitude: dealer.longitude,
          distanceKm: distanceKm != null ? Number(distanceKm.toFixed(2)) : null,
          averageRating: rating.averageRating,
          ratingCount: rating.ratingCount,
          shopImages: (dealer.shopImages || []).map(url => formatImage(url, req)),
        }
      }))
      .slice(0, limit)

    return res.status(200).json({
      status: true,
      message: ranked.length ? "Top garages fetched" : "No garages found nearby",
      data: ranked,
      meta: scopeMeta(scope, bikeContexts),
    })
  } catch (error) {
    console.error("Error fetching top garages:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

module.exports = { homeFeed, quickServices, recommended, mostBooked, topGarages, rankHomeGarages }
