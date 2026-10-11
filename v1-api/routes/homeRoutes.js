const express = require("express")
const router = express.Router()
const { requireAdmin } = require("../../middlewares/requireAdmin")
const controller = require("../controllers/homeController")
const { attachCustomerIfPresent } = require("../../middlewares/optionalCustomer")

// Public — user app. Bike-aware when we can tell who is asking; see
// serviceRoutes.js for why this is attached per route.
router.get("/home/quick-services", attachCustomerIfPresent, controller.quickServices)
router.get("/home/feed", attachCustomerIfPresent, controller.homeFeed)
router.get("/home/recommended", attachCustomerIfPresent, controller.recommended)
router.get("/home/most-booked", attachCustomerIfPresent, controller.mostBooked)
router.get("/home/top-garages", attachCustomerIfPresent, controller.topGarages)

// Admin — read-only sanity-check views, same real data, city-scoped instead of live GPS.
router.get("/admin/home/most-booked", requireAdmin, controller.mostBooked)
router.get("/admin/home/top-garages", requireAdmin, controller.topGarages)

module.exports = router
