const mongoose = require("mongoose")
const BaseService = require("../../models/baseService")
const { getRatingsMap } = require("../helpers/geoAndRatings")
const ServiceDetail = require("../../models/serviceDetail")
const { mergeServiceDetail } = require("../helpers/serviceDetail")
const {
  resolveDiscoveryBikeContexts,
  resolveBikeContextById,
  resolveDealerScope,
  resolveEligibleServices,
  resolveEligibleGarages,
} = require("../helpers/serviceEligibility")

function formatImage(url, req) {
  if (url && !url.startsWith("http")) {
    return `${req.protocol}://${req.get("host")}/${url}`
  }
  return url
}

function parseCc(cc) {
  if (cc === undefined || cc === null || String(cc).trim() === "") return null
  const parsed = Number.parseInt(cc, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function parseBool(value) {
  return value === true || value === "true" || value === "1" || value === 1
}

// GET /api/v1/services?categoryId=&bikeId=&bikeIds=&lat=&lng=&city=
//
// The All Services / category list. Same DISCOVERY = ALL SAVED BIKES rule as
// the home feeds: a service is listed when at least ONE of the rider's saved
// bikes has a bookable, in-range provider for it — the union across the whole
// garage, de-duplicated by service.
//
// This list used to be a plain BaseService.find(): with no bike it showed
// every active service in the catalog whether or not anybody could perform it,
// and with a bike it checked compatibility but not dealer bookability or
// location. Both routes ended at an empty garage list on BOOK NOW.
async function listByCategory(req, res) {
  try {
    const { categoryId, bikeId, bikeIds, lat, lng, city } = req.query
    const filter = { isActive: true }

    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({ status: false, message: "Invalid categoryId" })
      }
      filter.categoryId = categoryId
    }
    if (bikeId && !mongoose.Types.ObjectId.isValid(bikeId)) {
      return res.status(400).json({ status: false, message: "Invalid bikeId" })
    }

    const { contexts: bikeContexts } = await resolveDiscoveryBikeContexts({
      userId: req.user_id || null,
      bikeId,
      bikeIds,
    })

    let scope
    try {
      scope = await resolveDealerScope({ lat, lng, city })
    } catch (err) {
      return res.status(400).json({ status: false, message: "Invalid lat/lng" })
    }

    const eligibility = await resolveEligibleServices({ scope, bikeContexts })
    // Honest empty result: no eligible provider means no services, never a
    // fallback to the raw catalog.
    if (!eligibility.serviceIds.length) {
      return res.status(200).json({
        status: true,
        message: "No services found",
        data: [],
        meta: {
          bikeMatched: bikeContexts.length > 0,
          bikeCount: bikeContexts.length,
          evaluatedBikeIds: bikeContexts.map(ctx => ctx.bikeId),
          scope: scope.kind === "network" ? "network" : "area",
          scopeKind: scope.kind,
        },
      })
    }

    filter._id = { $in: eligibility.serviceIds }

    // Same guard as homeController's SERVICE_CARD_FIELDS: this list must never
    // start carrying Service Detail content just because a field was added to
    // BaseService. Detail content lives in `servicedetails` and is read only by
    // getServiceById below.
    const services = await BaseService.find(filter)
      .select("name image description categoryId basePrice duration pickupAvailable warranty")
      .populate("categoryId", "name icon")
      .sort({ name: 1 })

    return res.status(200).json({
      status: true,
      message: services.length ? "Services fetched" : "No services found",
      data: services.map(s => {
        const bucket = eligibility.byServiceId.get(String(s._id))
        return {
          serviceId: s._id,
          name: s.name,
          image: formatImage(s.image, req),
          description: s.description,
          category: s.categoryId ? { id: s.categoryId._id, name: s.categoryId.name, icon: s.categoryId.icon } : null,
          basePrice: s.basePrice,
          duration: s.duration,
          pickupAvailable: s.pickupAvailable,
          warranty: s.warranty,
          // Additive: how many garages can take it, and which saved bikes it
          // is bookable for. Phase B uses these; existing clients ignore them.
          providerCount: bucket ? bucket.dealerIds.size : 0,
          eligibleBikeIds: bucket ? Array.from(bucket.eligibleBikeIds) : [],
        }
      }),
      meta: {
        bikeMatched: bikeContexts.length > 0,
        bikeCount: bikeContexts.length,
        evaluatedBikeIds: bikeContexts.map(ctx => ctx.bikeId),
        scope: scope.kind === "network" ? "network" : "area",
        scopeKind: scope.kind,
      },
    })
  } catch (error) {
    console.error("Error fetching services:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

// GET /api/v1/services/:id/garages?lat=&lng=&bikeId=&variant_id=&cc=&towingRequired=
//
// BOOKING = ONE SELECTED BIKE. This is the provider-selection list, so the
// union used by discovery does NOT apply here: the rider has picked a bike,
// and every garage returned must be able to service THAT bike.
//
// Pass `bikeId` for the full rule (brand + model + variant + cc + price row).
// `variant_id`/`cc` remain supported and behave exactly as before for clients
// that only know the variant.
async function garagesForService(req, res) {
  try {
    const { id } = req.params
    const { lat, lng, city, bikeId, variant_id, cc, towingRequired } = req.query

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: false, message: "Invalid service id" })
    }
    if (bikeId && !mongoose.Types.ObjectId.isValid(bikeId)) {
      return res.status(400).json({ status: false, message: "Invalid bikeId" })
    }
    if (variant_id && !mongoose.Types.ObjectId.isValid(variant_id)) {
      return res.status(400).json({ status: false, message: "Invalid variant_id" })
    }

    const baseService = await BaseService.findOne({ _id: id, isActive: true }).select("_id").lean()
    if (!baseService) {
      return res.status(404).json({ status: false, message: "Service not found" })
    }

    // A rider's own bike is resolved against their account when we know who
    // they are; anonymous callers can still resolve a bike id, exactly as the
    // pre-existing variant_id path allowed.
    const bikeContext = bikeId ? await resolveBikeContextById(bikeId, req.user_id || null) : null
    if (bikeId && !bikeContext) {
      return res.status(404).json({ status: false, message: "Bike not found" })
    }

    const needsTowing = parseBool(towingRequired)

    let result
    try {
      result = await resolveEligibleGarages({
        baseServiceId: id,
        bikeContext,
        variantId: bikeContext ? null : variant_id || null,
        cc: parseCc(cc),
        lat,
        lng,
        city,
        towingRequired: needsTowing,
      })
    } catch (err) {
      return res.status(400).json({ status: false, message: "Invalid lat/lng" })
    }

    const { scope, entries } = result
    const ratingsMap = await getRatingsMap(entries.map(e => e.dealer._id))

    const data = entries
      .map(e => {
        const rating = ratingsMap.get(String(e.dealer._id)) || { averageRating: 0, ratingCount: 0 }
        return {
          dealerId: e.dealer._id,
          shopName: e.dealer.shopName,
          fullAddress: e.dealer.fullAddress || e.dealer.address || null,
          address: e.dealer.address || null,
          city: e.dealer.city,
          locality: e.dealer.locality,
          latitude: e.dealer.latitude,
          longitude: e.dealer.longitude,
          distanceKm: e.distanceKm != null ? Number(e.distanceKm.toFixed(2)) : null,
          serviceRadiusKm: e.serviceRadiusKm,
          price: e.price,
          averageRating: rating.averageRating,
          ratingCount: rating.ratingCount,
          providesPickup: !!e.dealer.providesPickup,
          providesDrop: !!e.dealer.providesDrop,
          // A bike declared NOT_RIDEABLE/COMPLETELY_DEAD has to be towed, so
          // the app can only offer garages that actually tow. Pass
          // towingRequired=true and the list is filtered on it server-side.
          providesTowing: !!e.dealer.providesTowing,
          towingCharges: e.dealer.towingCharges ?? 0,
          // adminServiceId is what POST /pricing/quote takes as `serviceIds`
          // (it resolves AdminService docs, not BaseService ids). Returning it
          // here is what lets the provider list hand the booking screen a
          // priceable id directly, instead of re-querying every dealer's full
          // service list one call at a time.
          adminServiceId: e.adminServiceId,
          shopImages: (e.dealer.shopImages || []).map(url => formatImage(url, req)),
        }
      })
      .sort((a, b) => {
        if (b.averageRating !== a.averageRating) return b.averageRating - a.averageRating
        if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm
        return 0
      })

    return res.status(200).json({
      status: true,
      message: data.length ? "Garages fetched" : "No garages found for this service nearby",
      data,
      meta: {
        scope: scope.kind === "network" ? "network" : "area",
        scopeKind: scope.kind,
        bikeMatched: !!bikeContext,
        bikeId: bikeContext ? bikeContext.bikeId : null,
        towingRequired: needsTowing,
      },
    })
  } catch (error) {
    console.error("Error fetching garages for service:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

// GET /api/v1/services/:id?lat=&lng=&bikeId=&variant_id=&cc=&towingRequired=
//
// The Service Detail screen's single read: BaseService merged with its
// optional ServiceDetail content, plus the two numbers the screen puts next
// to BOOK NOW — the cheapest available price and how many garages can
// actually take the booking.
//
// Eligibility runs through the same resolveEligibleGarages() the garage list
// uses, so providerCount can never disagree with the list BOOK NOW opens.
// `fromPrice` is indicative only — the payable amount still comes solely from
// /pricing/quote (services/pricingEngine.js).
async function getServiceById(req, res) {
  try {
    const { id } = req.params
    const { lat, lng, city, bikeId, variant_id, cc, towingRequired } = req.query

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: false, message: "Invalid service id" })
    }
    if (variant_id && !mongoose.Types.ObjectId.isValid(variant_id)) {
      return res.status(400).json({ status: false, message: "Invalid variant_id" })
    }
    if (bikeId && !mongoose.Types.ObjectId.isValid(bikeId)) {
      return res.status(400).json({ status: false, message: "Invalid bikeId" })
    }

    const baseService = await BaseService.findOne({ _id: id, isActive: true }).populate("categoryId", "name icon")
    if (!baseService) {
      return res.status(404).json({ status: false, message: "Service not found" })
    }

    // A service with no detail row (every service does, until admins author
    // content) is not an error — the merge falls back to the base fields.
    const detail = await ServiceDetail.findOne({ baseServiceId: id }).lean()

    const bikeContext = bikeId ? await resolveBikeContextById(bikeId, req.user_id || null) : null

    let entries = []
    let scope = null
    try {
      const result = await resolveEligibleGarages({
        baseServiceId: id,
        bikeContext,
        variantId: bikeContext ? null : variant_id || null,
        cc: parseCc(cc),
        lat,
        lng,
        city,
        towingRequired: parseBool(towingRequired),
      })
      entries = result.entries
      scope = result.scope
    } catch (err) {
      return res.status(400).json({ status: false, message: "Invalid lat/lng" })
    }

    const prices = entries.map(e => e.price).filter(p => typeof p === "number")
    const providerCount = new Set(entries.map(e => String(e.dealer._id))).size

    const service = mergeServiceDetail(baseService, detail, {
      formatUrl: url => formatImage(url, req),
    })

    return res.status(200).json({
      status: true,
      message: "Service fetched",
      data: {
        ...service,
        fromPrice: prices.length ? Math.min(...prices) : null,
        providerCount,
      },
      meta: {
        scope: scope.kind === "network" ? "network" : "area",
        scopeKind: scope.kind,
        bikeMatched: !!bikeContext,
        bikeId: bikeContext ? bikeContext.bikeId : null,
      },
    })
  } catch (error) {
    console.error("Error fetching service detail:", error)
    return res.status(500).json({ status: false, message: "Internal Server Error" })
  }
}

module.exports = { listByCategory, garagesForService, getServiceById }
