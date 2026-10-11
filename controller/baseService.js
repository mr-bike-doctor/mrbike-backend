const BaseService = require("../models/baseService")
const AdminService = require("../models/adminService")
const Booking = require("../models/Booking")
const Offer = require("../models/offer_model")
const Vendor = require("../models/dealerModel")
const jwt_decode = require("jwt-decode")
const mongoose = require("mongoose")

/**
 * Helper: Format service with full image URL
 */
function formatServiceResponse(service, req) {
  const serviceObj = service.toObject ? service.toObject() : service
  if (serviceObj.image && !serviceObj.image.startsWith("http")) {
    const protocol = req.protocol
    const host = req.get("host")
    serviceObj.image = `${protocol}://${host}/${serviceObj.image}`
  }
  return serviceObj
}

/**
 * CREATE BaseService (Admin Only)
 * POST /admin/base-services
 */
async function createBaseService(req, res) {
  try {
    // Auth check
    if (!req.headers.token) {
      return res.status(401).json({
        status: false,
        message: "Token required",
      })
    }

    const data = jwt_decode(req.headers.token)
    // Support both custom JWT (user_id/id) and Google ID Token (sub)
    const user_id = data.user_id || data.id || data.sub

    if (!user_id) {
      return res.status(401).json({
        status: false,
        message: "Unauthorized - Invalid token payload",
      })
    }

    const { name, description, categoryId, basePrice, duration, pickupAvailable, warranty, isFeatured, isQuickService } = req.body

    /* =========================
       1. Validate name
    ========================== */
    if (!name || name.trim() === "") {
      return res.status(400).json({
        status: false,
        message: "Service name is required",
        field: "name",
      })
    }

    /* =========================
       2. Validate image
    ========================== */
    if (!req.file) {
      return res.status(400).json({
        status: false,
        message: "Service image is required",
        field: "image",
      })
    }

    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        status: false,
        message: "Invalid categoryId",
        field: "categoryId",
      })
    }

    /* =========================
       3. Check if name already exists
    ========================== */
    const existingService = await BaseService.findOne({
      name: name.trim(),
    })

    if (existingService) {
      return res.status(400).json({
        status: false,
        message: "Service with this name already exists",
        field: "name",
      })
    }

    /* =========================
       4. Create BaseService
    ========================== */
    const newService = await BaseService.create({
      name: name.trim(),
      description: description?.trim(),
      image: req.file.location, // S3 URL
      categoryId: categoryId || null,
      basePrice: basePrice !== undefined ? Number(basePrice) : 0,
      duration: duration !== undefined ? Number(duration) : 0,
      pickupAvailable: pickupAvailable === true || pickupAvailable === "true",
      warranty: warranty === true || warranty === "true",
      isFeatured: isFeatured === true || isFeatured === "true",
      isQuickService: isQuickService === true || isQuickService === "true",
    })

    return res.status(201).json({
      status: true,
      message: "Base service created successfully",
      data: formatServiceResponse(newService, req),
    })
  } catch (error) {
    console.error("Error creating base service:", error)
    return res.status(500).json({
      status: false,
      message: "Internal Server Error",
    })
  }
}

/**
 * LIST BaseServices (Admin Only)
 * GET /admin/base-services
 */
async function listBaseServices(req, res) {
  try {
    const { categoryId } = req.query
    const filter = { isActive: { $ne: false } }
    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          status: false,
          message: "Invalid categoryId",
        })
      }
      filter.categoryId = categoryId
    }

    const services = await BaseService.find(filter).populate("categoryId", "name icon").sort({ id: -1 })

    return res.status(200).json({
      status: true,
      message: services.length > 0 ? "Base services fetched successfully" : "No base services found",
      data: services.map(s => formatServiceResponse(s, req)),
    })
  } catch (error) {
    console.error("Error fetching base services:", error)
    return res.status(500).json({
      status: false,
      message: "Internal Server Error",
    })
  }
}

/**
 * GET BaseService By ID (Admin Only)
 * GET /admin/base-services/:id
 */
async function getBaseServiceById(req, res) {
  try {
    const { id } = req.params

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        status: false,
        message: "Valid service ID is required",
      })
    }

    const service = await BaseService.findById(id).populate("categoryId", "name icon")

    if (!service) {
      return res.status(404).json({
        status: false,
        message: "Base service not found",
      })
    }

    return res.status(200).json({
      status: true,
      message: "Base service fetched successfully",
      data: formatServiceResponse(service, req),
    })
  } catch (error) {
    console.error("Error fetching base service:", error)
    return res.status(500).json({
      status: false,
      message: "Internal Server Error",
    })
  }
}

/**
 * UPDATE BaseService (Admin Only)
 * PUT /admin/base-services/:id
 */
async function updateBaseService(req, res) {
  try {
    const { id } = req.params
    const { name, description, categoryId, basePrice, duration, pickupAvailable, warranty, isFeatured, isQuickService } = req.body

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        status: false,
        message: "Valid service ID is required",
      })
    }

    if (!name || name.trim() === "") {
      return res.status(400).json({
        status: false,
        message: "Service name is required",
        field: "name",
      })
    }

    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        status: false,
        message: "Invalid categoryId",
        field: "categoryId",
      })
    }

    // Check if another service has the same name
    const existingService = await BaseService.findOne({
      name: name.trim(),
      _id: { $ne: id },
    })

    if (existingService) {
      return res.status(400).json({
        status: false,
        message: "Service with this name already exists",
        field: "name",
      })
    }

    const updateData = {
      name: name.trim(),
    }

    if (description !== undefined) {
      updateData.description = description?.trim()
    }

    if (categoryId !== undefined) {
      updateData.categoryId = categoryId || null
    }

    if (basePrice !== undefined) {
      updateData.basePrice = Number(basePrice)
    }

    if (duration !== undefined) {
      updateData.duration = Number(duration)
    }

    if (pickupAvailable !== undefined) {
      updateData.pickupAvailable = pickupAvailable === true || pickupAvailable === "true"
    }

    if (warranty !== undefined) {
      updateData.warranty = warranty === true || warranty === "true"
    }

    if (isFeatured !== undefined) {
      updateData.isFeatured = isFeatured === true || isFeatured === "true"
    }
    if (isQuickService !== undefined) {
      updateData.isQuickService = isQuickService === true || isQuickService === "true"
    }

    if (req.file) {
      updateData.image = req.file.location // S3 URL
    }

    const updatedService = await BaseService.findByIdAndUpdate(id, updateData, {
      new: true,
    })

    if (!updatedService) {
      return res.status(404).json({
        status: false,
        message: "Base service not found",
      })
    }

    return res.status(200).json({
      status: true,
      message: "Base service updated successfully",
      data: formatServiceResponse(updatedService, req),
    })
  } catch (error) {
    console.error("Error updating base service:", error)
    return res.status(500).json({
      status: false,
      message: "Internal Server Error",
    })
  }
}

/**
 * DELETE BaseService (Admin Only)
 * DELETE /admin/base-services/:id
 * Prevent deletion if referenced by any AdminService, unless ?force=true and no bookings exist.
 * If bookings exist, allow ?deactivate=true to hide the service.
 */
async function deleteBaseService(req, res) {
  try {
    const { id } = req.params
    const { force, deactivate } = req.query

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        status: false,
        message: "Valid service ID is required",
      })
    }

    // 0. DEACTIVATE MODE (Soft Delete)
    if (deactivate === "true") {
      console.log(`[v0] Deactivating base service ${id} and its associated admin services.`)
      
      const adminServiceIds = await AdminService.find({ base_service_id: id }).distinct("_id")
      
      // Deactivate BaseService
      await BaseService.findByIdAndUpdate(id, { isActive: false })
      
      // Deactivate all associated AdminServices
      if (adminServiceIds.length > 0) {
        await AdminService.updateMany(
          { _id: { $in: adminServiceIds } },
          { isActive: false }
        )
      }

      return res.status(200).json({
        status: true,
        message: "Base service and associated admin services deactivated successfully.",
      })
    }

    // 1. Find all AdminServices referencing this BaseService
    const referencingAdminServices = await AdminService.find({
      base_service_id: id,
      isActive: { $ne: false }, // Only care about active ones for blocking
    }).populate("dealer_id", "shopName")

    const referencedCount = referencingAdminServices.length

    if (referencedCount > 0) {
      if (force !== "true") {
        return res.status(400).json({
          status: false,
          isReferenced: true,
          message: `Cannot delete this base service. It is referenced by ${referencedCount} admin service(s).`,
          referencingDetails: referencingAdminServices.map(as => ({
            admin_service_id: as._id,
            serviceId: as.serviceId,
            dealerName: as.dealer_id?.shopName || "Unknown Dealer",
          })),
          hint: "Use ?force=true to cascadingly delete if NO bookings exist.",
        })
      }

      // 2. FORCE DELETE MODE: Check for Bookings
      const adminServiceIds = referencingAdminServices.map(as => as._id)
      const bookingCount = await Booking.countDocuments({
        services: { $in: adminServiceIds },
      })

      if (bookingCount > 0) {
        return res.status(400).json({
          status: false,
          canDeactivate: true,
          message: `Cannot force delete. There are ${bookingCount} project/booking(s) referencing the associated admin services.`,
          bookingCount,
          hint: "You can use ?deactivate=true to hide this service without breaking booking records.",
        })
      }

      // 3. NO BOOKINGS: Proceed with cascading delete
      console.log(`[v0] Cascadingly deleting base service ${id} and ${referencedCount} admin services.`)

      // Clean up Offers
      await Offer.deleteMany({ service_id: { $in: adminServiceIds } })

      // Clean up Vendor (Dealer) services arrays
      await Vendor.updateMany(
        { services: { $in: adminServiceIds } },
        { $pull: { services: { $in: adminServiceIds } } }
      )

      // Delete AdminServices
      await AdminService.deleteMany({ _id: { $in: adminServiceIds } })
    }

    const deletedService = await BaseService.findByIdAndDelete(id)

    if (!deletedService) {
      return res.status(404).json({
        status: false,
        message: "Base service not found",
      })
    }

    return res.status(200).json({
      status: true,
      message: referencedCount > 0 
        ? `Base service and ${referencedCount} associated admin services deleted successfully.` 
        : "Base service deleted successfully.",
    })
  } catch (error) {
    console.error("Error deleting base service:", error)
    return res.status(500).json({
      status: false,
      message: "Internal Server Error",
    })
  }
}

module.exports = {
  createBaseService,
  listBaseServices,
  getBaseServiceById,
  updateBaseService,
  deleteBaseService,
}
