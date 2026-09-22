const mongoose = require('mongoose');
const booking = require("../models/Booking");
const AdditionalService = require("../models/additionalServiceSchema");
const service = require("../models/service_model");
const bike = require("../models/bikeModel");
const Tracking = require("../models/Tracking");
const jwt_decode = require("jwt-decode");
const { isEmpty } = require("../helper/validation");
const customers = require("../models/customer_model");
const Role = require('../models/Roles_modal')
const Admin = require('../models/admin_model')
const { Notification, sendBookingNotification } = require("../helper/pushNotification");
const { handleBookingCompletion } = require("../controller/reward")
const { generateBill } = require("../controller/payment")
const { getOrCreateInvoice } = require("../services/invoiceService")
const { settleBookingWallet } = require("../helper/walletSettlement")
const { cancelPendingPaymentSessions } = require("../helper/paymentSession")
const { deleteS3Object } = require("../utils/s3Upload")
const UserBike = require("../models/userBikeModel");
const AdminService = require("../models/adminService");
const Customer = require("../models/customer_model");
const Vendor = require("../models/dealerModel");
const {
  computePriceBreakdown,
  computeTransportCharges,
  resolveServiceAmount,
  applyBreakdownToBooking,
  applyRewardDiscount,
  round2,
  TRANSPORT_OPTIONS,
  BIKE_CONDITIONS,
  normalizeBikeCondition,
  isTowingRequired,
  resolveTowingCharge,
  PricingError,
} = require("../services/pricingEngine");
const { getPricingSettings } = require("../services/appSettingsService");
const { validatePromoCode } = require("../services/promoService");
const {
  calculateMrBikeMoneyRedemption,
  getServiceRedemptionLimit,
  debitForBooking,
  refundBookingMoney,
} = require("../services/mrBikeMoneyService");
const PromoCode = require("../models/PromoCode");
const PromoCodeUsage = require("../models/PromoCodeUsage");
const PickupnDrop = require("../models/PickupnDrop");
const { ACTIVE_BOOKING_QUERY } = require("../utils/bookingStatus");
const { isDealerBookable } = require("../helper/dealerStatus");
const {
  isPickupBooking,
  canMarkCustomerArrived,
  PICKUP_STATUSES,
} = require("../services/pickupLifecycle");
const { verifyPickupOtp } = require("./pickupLifecycleController");
const {
  resolveCancellationReason,
  canCustomerCancel,
} = require("../utils/bookingCancellation");

async function checkPermission(user_id, requiredPermission) {
  try {
    const userRole = await Role.findOne({ subAdmin: user_id });
    console.log(userRole, "1")
    if (!userRole) {
      return false;
    }
    const permissions = userRole.permissions;
    console.log(permissions, "2")

    const [module, permission] = requiredPermission.split('.');

    // Check if the module and permission exist in permissions object
    if (!permissions || !permissions[module] || !permissions[module][permission]) {
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error while checking permission:", error);
    return false;
  }
}

// DEPRECATED — legacy booking-creation path. Computed its own price from
// req.body.estimated_cost / a naive per-service price sum with no dealer
// validation, no tax/commission math, and no pricing snapshot — exactly the
// client-driven pricing this backend hardening pass exists to eliminate.
// Also already broken: the document it builds omits the schema-required
// user_id/dealer_id/userBike_id fields, so booking.create() would throw a
// validation error before ever persisting. Audited: no client (User App,
// Dealer App, Admin UI) calls /addbooking/:id. Disabled rather than fixed —
// live booking creation is createBooking() below, which routes through
// services/pricingEngine.js.
async function addbooking(req, res) {
  return res.status(410).json({
    success: false,
    message:
      "Deprecated. /addbooking/:id never computed pricing safely and has been disabled. " +
      "Use POST /bikedoctor/bookings/createBooking, which prices bookings via services/pricingEngine.js.",
  });
}

async function getbooking(req, res) {
  try {
    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;
    const user_type = data.user_type;
    const type = data.type;
    if (user_id == null || user_type != 1 && user_type != 2 && user_type != 4) {
      var response = {
        status: 401,
        message: "admin is un-authorised !",
      };
      return res.status(401).send(response);
    }

    let bookingresponce = await booking.findOne({ _id: req.params.id })
      .populate({ path: "service_id", select: ['name', 'image', 'description'] })
      .populate({ path: "created_by", select: ['first_name', 'email', 'last_name', 'phone', 'image', 'address', 'city'] })
    // .populate({path:"service_provider_id",select: ['name', 'email', 'phone']})

    if (bookingresponce) {
      var response = {
        status: 200,
        message: "successfull",
        data: bookingresponce,
        image_base_url: process.env.BASE_URL,
      };
      return res.status(200).send(response);
    } else {
      var response = {
        status: 201,
        data: [],
        message: "No bookings Found",
      };
      return res.status(201).send(response);
    }
  } catch (error) {
    console.log("error", error);
    response = {
      status: 201,
      message: "Operation was not successful",
    };
    return res.status(201).send(response);
  }
}

const getuserbookings = async (req, res) => {
  try {
    const { user_id } = req.params;
    const user_type = Number(req.query.user_type);

    if (!user_id) {
      return res.status(400).json({
        status: 400,
        message: "User ID is required in URL (e.g., /api/bookings/:user_id)."
      });
    }

    if (![2, 4].includes(user_type)) {
      return res.status(400).json({
        status: 400,
        message: "Valid user_type (2 for dealer, 4 for user) is required in query params."
      });
    }

    const targetField = user_type === 2 ? "dealer_id" : "user_id";

    // Build filter: accept Mongo ObjectId or numeric auto-increment id
    const filter = {};

    if (mongoose.Types.ObjectId.isValid(user_id)) {
      filter[targetField] = mongoose.Types.ObjectId(user_id);
    } else if (/^\d+$/.test(user_id)) {
      const numericId = Number(user_id);

      if (targetField === "user_id") {
        const cust = await Customer.findOne({ id: numericId }).select("_id").lean();
        if (!cust) {
          return res.status(404).json({ status: 404, message: `Customer with numeric id ${numericId} not found.` });
        }
        filter[targetField] = cust._id;
      } else {
        const vendor = await Vendor.findOne({ id: numericId }).select("_id").lean();
        if (!vendor) {
          return res.status(404).json({ status: 404, message: `Vendor with numeric id ${numericId} not found.` });
        }
        filter[targetField] = vendor._id;
      }
    } else {
      return res.status(400).json({
        status: 400,
        message: "Provided user_id must be either a Mongo ObjectId or a numeric id."
      });
    }

    // pagination
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Query and populate the bike details (userBike_id) + other fields
    const [total, userBookings] = await Promise.all([
      booking.countDocuments(filter),
      booking.find(filter)
        .populate({
        path: "services",
        model: "AdminService",
        populate: {
          path: "base_service_id",
          model: "BaseService",
          select: "name description image",
        },
      })
        .populate({
          path: "additionalServices",
          populate: { path: "base_additional_service_id", select: "name" },
        })
        .populate("dealer_id", "shopName fullAddress address city locality shopImages phone averageRating ratingCount status dealerStatus")
        .populate("reviewId", "rating createdAt")
        .populate("pickupAndDropId")
        // populate user with optional inner population of user's bikes
        .populate({
          path: "user_id",
          select: "first_name last_name phone email image address city",
          // uncomment to populate user.userBike array as well:
          // populate: { path: "userBike" }
        })
        // IMPORTANT: populate the userBike referenced in booking so we get bike details
        .populate({
          path: "userBike_id",
          populate: { path: "variant_id" } // optional: populate variant inside bike
        })
        .sort({ create_date: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    if (!userBookings || userBookings.length === 0) {
      return res.status(200).json({
        status: 200,
        success: true,
        message: "No bookings found for this user",
        data: [],
        meta: { total: 0, page, limit }
      });
    }

    // Fetch bill information for each booking (optional - for additional details)
    try {
      const Bill = require("../models/billSchema");
      const bookingIds = userBookings.map(b => b._id);
      const bills = await Bill.find({ booking_id: { $in: bookingIds } }).lean();
      
      // Create a map of booking_id -> bill for quick lookup
      const billMap = {};
      bills.forEach(bill => {
        billMap[bill.booking_id.toString()] = bill;
      });

      // Add pricing information to each booking
      // Priority: Bill data > Booking totalBill > 0
      const enrichedBookings = userBookings.map(b => {
        const bill = billMap[b._id.toString()];
        
        // Use bill data if available, otherwise use booking's totalBill
        const grandTotal = bill?.total_amount || b.totalBill || 0;
        const subtotal = bill?.subtotal || b.totalBill || 0;
        
        console.log(`=== Booking ${b.bookingId} ===`);
        console.log("Booking object keys:", Object.keys(b));
        console.log("totalBill:", b.totalBill);
        console.log("pickupCharges:", b.pickupCharges);
        console.log("services count:", b.services?.length);
        console.log("userBike_id:", b.userBike_id);
        console.log("Bill found:", !!bill);
        if (bill) {
          console.log("Bill total_amount:", bill.total_amount);
          console.log("Bill subtotal:", bill.subtotal);
        }
        console.log("Final grandTotal:", grandTotal);
        console.log("---");
        
        return {
          ...b,
          subtotal: subtotal,
          tax_amount: bill?.tax_amount || 0,
          grandTotal: grandTotal,
          pickupCharges: bill?.pickup_charges || b.pickupCharges || 0,
          dropCharges: bill?.drop_charges || b.dropCharges || 0,
          towingCharge: bill?.towing_charge || b.towingCharge || 0,
        };
      });

      return res.status(200).json({
        status: 200,
        success: true,
        data: enrichedBookings,
        meta: { total, page, limit, pages: Math.ceil(total / limit) }
      });
    } catch (billError) {
      console.log("Error fetching bills, using booking totalBill instead:", billError.message);
      
      // Fallback: Use booking's totalBill if bill fetch fails
      const enrichedBookings = userBookings.map(b => ({
        ...b,
        subtotal: b.totalBill || 0,
        tax_amount: 0,
        grandTotal: b.totalBill || 0,
        pickupCharges: b.pickupCharges || 0,
        dropCharges: b.dropCharges || 0,
      }));

      return res.status(200).json({
        status: 200,
        success: true,
        data: enrichedBookings,
        meta: { total, page, limit, pages: Math.ceil(total / limit) }
      });
    }

  } catch (error) {
    console.error("Error fetching bookings:", error);
    return res.status(500).json({
      status: 500,
      message: "Internal Server Error"
    });
  }
};


// const getuserbookings = async (req, res) => {
//   try {
//     const { user_id } = req.params;

//     const { user_type } = req.query;

//     if (!user_id) {
//       return res.status(400).json({
//         status: 400,
//         message: "User ID is required in URL (e.g., /api/bookings/123)"
//       });
//     }

//     if (!user_type || ![2, 4].includes(Number(user_type))) {
//       return res.status(400).json({
//         status: 400,
//         message: "Valid user_type (2 for dealer, 4 for user) is required in query params"
//       });
//     }

//     console.log("user_type", user_type, "user_id", user_id);

//     // Set filter based on user_type
//     let filter = {};
//     if (user_type == 2) {
//       filter = { dealer_id: user_id }; // Dealer's bookings
//     } else if (user_type == 4) {
//       filter = { user_id: user_id };   // User's bookings
//     }

//     const userBookings = await booking.find(filter)
//       .populate("services")
//       .populate("dealer_id")
//       .populate("pickupAndDropId")
//       .populate("user_id")
//       .sort({ create_date: -1 });

//     if (!userBookings?.length) {
//       return res.status(200).json({
//         status: 200,
//         success: true,
//         message: "No bookings found for this user",
//         data: userBookings
//       });
//     }

//     // Return successful response
//     res.status(200).json({
//       status: 200,
//       success: true,
//       data: userBookings
//     });

//   } catch (error) {
//     console.error("Error fetching bookings:", error);
//     res.status(500).json({
//       status: 500,
//       message: "Internal Server Error"
//     });
//   }
// };

async function deletebooking(req, res) {
  try {

    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;
    const user_type = data.user_type;
    const type = data.type;

    if (user_id == null || user_type != 1) {


      if (user_type === 3) {
        const subAdmin = await Admin.findById(user_id)

        if (!subAdmin) {
          var response = {
            status: 401,
            message: "Subadmin not found!",
          };
          return res.status(401).send(response);
        }

        if (user_type === 3) {
          const subAdmin = await Admin.findById(user_id)

          if (!subAdmin) {
            var response = {
              status: 401,
              message: "Subadmin not found!",
            };
            return res.status(401).send(response);
          }
        }

        const isAllowed = await checkPermission(user_id, "Booking.delete");

        if (!isAllowed) {
          var response = {
            status: 401,
            message: "Subadmin does not have permission to add Booking!",
          };
          return res.status(401).send(response);
        }

      }

    }



    const { booking_id } = req.body;
    const bookingRes = await booking.findOne({ _id: booking_id });
    if (bookingRes) {
      booking.findByIdAndDelete({ _id: booking_id }, async function (err, docs) {
        if (err) {
          var response = {
            status: 201,
            message: "Booking delete failed",
          };
          return res.status(201).send(response);
        } else {
          var response = {
            status: 200,
            message: "Booking deleted successfully",
          };
          return res.status(200).send(response);
        }
      });
    } else {
      var response = {
        status: 201,
        message: "Booking not Found",
      };

      return res.status(201).send(response);
    }
  } catch (error) {
    console.log("error", error);
    response = {
      status: 201,
      message: "Operation was not successful",
    };
    return res.status(201).send(response);
  }
}

async function updateBookings(req, res) {
  try {
    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;
    const user_type = data.user_type;
    const type = data.type;
    if (user_id == null || user_type != 1 && user_type != 2 && user_type != 4) {
      var response = {
        status: 401,
        message: "Admin is un-authorised !",
      };
      return res.status(401).send(response);
    }

    const { status, dealer_id, additonal_options, estimated_cost, final_cost, additonal_data_moveable } = req.body;

    let bookings = await booking.findById(req.params.id);

    if (!bookings) {
      res.status(201).json({ status: 201, error: "No Booking Found" });
      return;
    }

    const user = await customers.findById(bookings.created_by).exec();

    if (bookings.status === status) {
      res.status(201).json({ status: 201, message: `Booking is Already ${status}` });
      return;
    }

    if (status === "completed") {
      await handleBookingCompletion(bookings);
    }

    let dealers = await Vendor.findOne({ _id: dealer_id }); // changes

    if (!dealers) {
      res.status(201).json({ status: 201, error: "No Dealer Found" });
      return;
    }

    // Block booking acceptance if dealer has exceeded credit limit
    if (status === "confirmed") {
      const BOOKING_CREDIT_LIMIT = -500;
      if (parseFloat(dealers.wallet) < BOOKING_CREDIT_LIMIT) {
        return res.status(200).json({
          status: 200,
          message: "Booking cannot be accepted. Please clear your outstanding dues to continue accepting bookings."
        });
      }
    }

    const datas =
    {
      status: status,
      dealer_name: dealers.shopName,
      dealr_id: dealers.id,
      dealer_id: dealer_id,
      dealer_address: dealers.fullAddress,
      dealer_phone: dealers.phone,
      additonal_options: additonal_options,
      estimated_cost: estimated_cost,
      final_cost: final_cost,
      additonal_data_moveable,
    };

    booking.findByIdAndUpdate(
      { _id: req.params.id },
      { $set: datas },
      { new: true },
      async function (err, docs) {
        if (err) {
          var response = {
            status: 201,
            message: err,
          };
          return res.status(201).send(response);
        }
        else {
          // const sphone = vendors.phone
          // const uphone = user.phone
          // const service_provider_address = docs.service_provider_address
          // const user_address = user.address

          // const data = await otpAuth.pickndropotp(sphone,uphone,service_provider_address,user_address)
          // docs.otp = data.otp

          // push notification on booking update
          if (status == "rejected") {
            Notification(user?.device_token || user?.ftoken, `Sorry ${user?.first_name} , Your Booking of ${bookings?.brand} ${bookings?.model} has been Rejected`, user?.id);
          } else {
            Notification(user?.device_token || user?.ftoken, `Hi ${user?.first_name} , Your Booking of ${bookings?.brand} ${bookings?.model} ${status} successfully`, user?.id);
          }

          var response = {
            status: 200,
            message: "Booking updated successfully",
            // data: docs,
            // image_base_url: process.env.BASE_URL,
          };
          return res.status(200).send(response);
        }
      }
    );

  } catch (error) {
    console.log("error", error);
    response = {
      status: 201,
      message: "Operation was not successful",
    };
    return res.status(201).send(response);
  }
}

// Create Booking
// async function updateBookings(req, res) {
//   try {
//     const { user_id, booking_id } = req.params;
//     const { 
//       status, 
//       dealer_id, 
//       additional_options = [], 
//       estimated_cost, 
//       final_cost, 
//       additional_data_moveable 
//     } = req.body;

//     // Validate required parameters
//     if (!user_id || !booking_id) {
//       return res.status(400).json({
//         status: 400,
//         message: "User ID and Booking ID are required in params"
//       });
//     }

//     // Find booking
//     const bookings = await booking.findById(booking_id);
//     if (!bookings) {
//       return res.status(404).json({ 
//         status: 404, 
//         message: "No Booking Found" 
//       });
//     }

//     // Verify user exists and is authorized
//     const user = await customers.findById(user_id);
//     if (!user) {
//       return res.status(401).json({
//         status: 401,
//         message: "Unauthorized - User not found"
//       });
//     }

//     // Check if status is changing
//     if (booking.status === status) {
//       return res.status(200).json({ 
//         status: 200, 
//         message: `Booking is already ${status}` 
//       });
//     }

//     // Handle completion status
//     if (status === "completed") {
//       await handleBookingCompletion(booking);

//       if (!final_cost) {
//         return res.status(400).json({
//           status: 400,
//           message: "Final cost is required for completion"
//         });
//       }
//     }

//     // Verify dealer if provided
//     let dealer = null;
//     if (dealer_id) {
//       dealer = await Dealer.findById(dealer_id);
//       if (!dealer) {
//         return res.status(404).json({ 
//           status: 404, 
//           message: "No Dealer Found" 
//         });
//       }
//     }

//     // Prepare update data
//     const updateData = {
//       status,
//       ...(dealer_id && {
//         dealer_id,
//         dealer_name: dealer?.name,
//         dealer_address: dealer?.address,
//         dealer_phone: dealer?.phone
//       }),
//       ...(additional_options && { additional_options }),
//       ...(estimated_cost && { estimated_cost }),
//       ...(final_cost && { final_cost }),
//       ...(additional_data_moveable && { additional_data_moveable })
//     };

//     // Update booking
//     const updatedBooking = await booking.findByIdAndUpdate(
//       booking_id,
//       { $set: updateData },
//       { new: true }
//     );

//     // Send notification
//     const notificationMessage = status === "rejected" 
//       ? `Sorry ${user.first_name}, your booking of ${booking.brand} ${booking.model} has been rejected`
//       : `Hi ${user.first_name}, your booking of ${booking.brand} ${booking.model} has been ${status} successfully`;

//     if (user.device_token || user.ftoken) {
//       await Notification(
//         user.device_token || user.ftoken,
//         notificationMessage,
//         user._id
//       );
//     }

//     return res.status(200).json({
//       status: 200,
//       message: "Booking updated successfully",
//       data: {
//         booking_id: updatedBooking._id,
//         status: updatedBooking.status,
//         ...(updatedBooking.final_cost && { final_cost: updatedBooking.final_cost })
//       }
//     });

//   } catch (error) {
//     console.error("Booking update error:", error);
//     return res.status(500).json({
//       status: 500,
//       message: "Internal server error",
//       error: error.message
//     });
//   }
// }

// async function createBooking(req, res) {
//   try {
//     const data = jwt_decode(req.headers.token);
//     const user_id = data.user_id;

//     const { dealer_id, services, pickupAndDropId, userBike_id, pickupDate } = req.body;
//     if (!dealer_id || !services || services.length === 0) {
//       return res.status(400).json({ success: false, message: "Dealer and at least one service are required" });
//     }

//     const newBooking = new booking({
//       user_id,
//       dealer_id,
//       services,
//       pickupAndDropId: pickupAndDropId || null,
//       userBike_id,
//       pickupDate
//     });

//     await newBooking.save();
//     res.status(201).json({ success: true, message: "Booking created successfully", data: newBooking });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ success: false, message: "Internal Server Error" });
//   }
// }

// async function createBooking(req, res) {
//   try {
//     // still using token for user_id (as in your code)
//     const data = jwt_decode(req.headers.token);
//     const user_id = data.user_id;

//     const { dealer_id, services, pickupAndDropId, userBike_id, pickupDate } = req.body;

//     if (!dealer_id || !services || services.length === 0) {
//       return res.status(400).json({ success: false, message: "Dealer and at least one service are required" });
//     }
//     if (!userBike_id) {
//       return res.status(400).json({ success: false, message: "User bike is required" });
//     }

//     const otp = Math.floor(100000 + Math.random() * 900000);

//     const newBooking = new booking({
//       user_id,
//       dealer_id,
//       services,
//       pickupAndDropId: pickupAndDropId || null,
//       userBike_id,
//       pickupDate,
//       otp,
//     });

//     await newBooking.save();

//     return res.status(201).json({
//       success: true,
//       message: "Booking created successfully",
//       data: newBooking,
//       otp 
//     });

//   } catch (error) {
//     console.error("createBooking error:", error);
//     return res.status(500).json({ success: false, message: "Internal Server Error" });
//   }
// }

function genOtp() {
  return Math.floor(1000 + Math.random() * 9000);
}

// Mandatory profile fields required before a booking can be created.
function getMissingProfileFields(user) {
  const missing = [];
  if (!user.first_name || isEmpty(user.first_name)) missing.push("full name");
  if (!user.phone || isEmpty(String(user.phone))) missing.push("mobile number");
  return missing;
}

async function createBooking(req, res) {
  try {
    console.log('Booking Started');

    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;

    // ── 2. Entry logging ─────────────────────────────────────────────────────
    console.log('[createBooking] Authenticated user_id:', user_id);

    // ── 2b. Profile completeness check ───────────────────────────────────────
    const bookingUser = await customers.findById(user_id).select("first_name phone mrBikeMoneyBalance");
    if (!bookingUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const missingProfileFields = getMissingProfileFields(bookingUser);
    if (missingProfileFields.length > 0) {
      console.log('[createBooking] Blocked — incomplete profile, missing:', missingProfileFields);
      return res.status(400).json({
        success: false,
        errorCode: "PROFILE_INCOMPLETE",
        message: "Please complete your profile before booking a service.",
        missingFields: missingProfileFields,
      });
    }

    const {
      dealer_id,
      services,
      additionalServices,
      pickupAndDropId,
      userBike_id,
      pickupDate,
      scheduleDate,
      timeSlot,
      pickupAddress,
      promoCode,
      bikeCondition,
      towingNote,
    } = req.body;
    const useMrBikeMoney = req.body.useMrBikeMoney === true;
    // transportOption is optional for backward compatibility with clients
    // that predate this field (see legacy-inference block below).
    let { transportOption } = req.body;

    // ── 3. Field-level validation logging ────────────────────────────────────
    console.log('[createBooking] Field check — dealer_id:', dealer_id, '| valid ObjectId:', mongoose.Types.ObjectId.isValid(dealer_id));
    console.log('[createBooking] Field check — services:', services, '| isArray:', Array.isArray(services), '| length:', Array.isArray(services) ? services.length : 'N/A');
    console.log('[createBooking] Field check — userBike_id:', userBike_id, '| valid ObjectId:', mongoose.Types.ObjectId.isValid(userBike_id));
    console.log('[createBooking] Field check — pickupAndDropId:', pickupAndDropId, '| type:', typeof pickupAndDropId);
    console.log('[createBooking] Field check — pickupDate:', pickupDate, '| parsed Date:', pickupDate ? new Date(pickupDate) : null);

    if (!dealer_id || !services || services.length === 0) {
      return res.status(400).json({ success: false, message: "Dealer and at least one service are required" });
    }
    if (!userBike_id) {
      return res.status(400).json({ success: false, message: "User bike is required" });
    }

    // ── Bike condition / towing requirement ───────────────────────────────────
    // Absent means RIDEABLE, which is what every pre-feature client sends and
    // what every pre-feature booking implicitly was. `towingRequired` is derived
    // here and never read from the request body — a client must not be able to
    // declare a dead bike and then switch the towing charge off.
    let resolvedBikeCondition;
    try {
      resolvedBikeCondition = normalizeBikeCondition(bikeCondition);
    } catch (conditionError) {
      if (conditionError instanceof PricingError) {
        return res.status(400).json({
          success: false,
          message: conditionError.message,
          code: conditionError.code,
        });
      }
      throw conditionError;
    }
    // ── Validate Dealer ───────────────────────────────────────────────────────
    // Reload fresh from the DB on every booking attempt — never trust a garage
    // shown in the app that may have gone offline/inactive since it was fetched.
    const dealer = await Vendor.findById(dealer_id)
      .select("tax commission pickupCharges dropCharges providesPickup providesDrop providesTowing towingCharges online isActive isBlocked status registrationStatus dealerStatus")
      .lean();
    if (!dealer) {
      return res.status(404).json({ success: false, message: "Dealer not found" });
    }
    if (!isDealerBookable(dealer)) {
      return res.status(400).json({
        success: false,
        message: "This garage is currently unavailable.",
      });
    }

    // ── Validate Services (resolve BaseService IDs -> AdminService docs) ──────
    // User App sends BaseService IDs; resolve to AdminService IDs for correct pricing and refs
    let resolvedServiceIds = services;
    let serviceDocs = [];
    const bikeData = await UserBike.findOne({ _id: userBike_id, user_id }).populate({
      path: "variant_id",
      select: "model_id engine_cc",
    });
    if (!bikeData) {
      return res.status(400).json({ success: false, message: "User bike not found" });
    }
    const bikeCC = parseInt(bikeData.variant_id?.engine_cc || bikeData.bike_cc || 0);

    // ── Single Active Booking Per Bike ────────────────────────────────────────
    // Server-side source of truth: a bike cannot have two non-final bookings
    // at once, regardless of what the client UI allows. See utils/bookingStatus.js
    // for the definition of "active" vs. "final".
    const activeBookingForBike = await booking
      .findOne({ userBike_id, ...ACTIVE_BOOKING_QUERY })
      .select("_id bookingId status")
      .lean();
    if (activeBookingForBike) {
      return res.status(409).json({
        success: false,
        message: "This bike already has an active service booking.",
        booking_id: activeBookingForBike.bookingId || activeBookingForBike._id,
        status: activeBookingForBike.status,
      });
    }

    // Primary: incoming IDs are BaseService IDs — find AdminService for this dealer
    serviceDocs = await AdminService.find({
      base_service_id: { $in: services },
      dealer_id: dealer_id,
      isActive: true,
    }).populate("base_service_id", "mrBikeMoneyMaxRedeem");

    // Fallback: IDs may already be AdminService IDs (e.g. other clients)
    if (serviceDocs.length === 0) {
      serviceDocs = await AdminService.find({ _id: { $in: services } })
        .populate("base_service_id", "mrBikeMoneyMaxRedeem");
    }

    if (serviceDocs.length === 0) {
      return res.status(400).json({ success: false, message: "No valid services found for this dealer" });
    }
    resolvedServiceIds = serviceDocs.map(s => s._id);

    let additionalServiceDocs = [];
    if (Array.isArray(additionalServices) && additionalServices.length > 0) {
      additionalServiceDocs = await AdditionalService.find({ _id: { $in: additionalServices } });
    }

    // ── Validate Transport Option ──────────────────────────────────────────────
    // Legacy clients don't send transportOption yet — infer the best-fit
    // supported option from pickupAndDropId + dealer capabilities so existing
    // behavior is preserved without erroring. Clients that DO send
    // transportOption explicitly get the strict Task-2 validation.
    if (!transportOption) {
      if (pickupAndDropId) {
        if (dealer.providesPickup && dealer.providesDrop) transportOption = TRANSPORT_OPTIONS.PICKUP_AND_DROP;
        else if (dealer.providesPickup) transportOption = TRANSPORT_OPTIONS.PICKUP_ONLY;
        else if (dealer.providesDrop) transportOption = TRANSPORT_OPTIONS.DROP_ONLY;
        else transportOption = TRANSPORT_OPTIONS.SELF_VISIT;
      } else {
        transportOption = TRANSPORT_OPTIONS.SELF_VISIT;
      }
    }

    // Pickup distance enforcement depends on a server-owned coordinate record.
    // Also prevents a customer from attaching another user's pickup request.
    let pickupRequest = null;
    if ([TRANSPORT_OPTIONS.PICKUP_ONLY, TRANSPORT_OPTIONS.PICKUP_AND_DROP].includes(transportOption)) {
      if (!pickupAndDropId || !mongoose.Types.ObjectId.isValid(pickupAndDropId)) {
        return res.status(400).json({
          success: false,
          message: "A valid pickup location is required for PICKUP bookings",
        });
      }
      pickupRequest = await PickupnDrop.findOne({
        _id: pickupAndDropId,
        user_id,
        dealer_id,
        status: 1,
      }).select("otp user_lat user_lng");
      if (!pickupRequest) {
        return res.status(400).json({ success: false, message: "Pickup location not found for this customer and dealer" });
      }
    }

    // ── Towing requirement ────────────────────────────────────────────────────
    // Derived only now, because it takes BOTH halves: a bike that cannot be
    // ridden AND a transport option under which the garage collects it. A
    // customer who declares a dead bike but self-visits (or only wants it
    // dropped back) is bringing it in themselves, so nothing is towed and
    // nothing is charged for towing.
    const resolvedTowingRequired = isTowingRequired(resolvedBikeCondition, transportOption);
    // The note only describes a towing problem, so it is dropped entirely when
    // nothing is being towed rather than stored against a booking it cannot
    // apply to.
    const resolvedTowingNote = resolvedTowingRequired
      ? (typeof towingNote === "string" && towingNote.trim() ? towingNote.trim().slice(0, 500) : null)
      : null;

    // ── Call pricingEngine.computePriceBreakdown() ─────────────────────────────
    let breakdown;
    try {
      const serviceAmount = resolveServiceAmount({
        services: serviceDocs,
        additionalServices: additionalServiceDocs,
        bikeCC,
        bikeContext: {
          variantId: bikeData.variant_id?._id || bikeData.variant_id,
          modelId: bikeData.variant_id?.model_id,
        },
      });

      // ── Re-validate promo code at creation time ─────────────────────────────
      // Never trust a discount the client echoes back from the earlier
      // /pricing/quote "Apply Promo" call — the code could have been
      // deactivated, hit its usage limit, or expired in the meantime. This
      // is the ONLY place a promo is actually locked onto a booking.
      let promo = null;
      if (promoCode) {
        // Resolve the same subtotal computePriceBreakdown is about to produce —
        // towing included — so the promo's minimum-order check is made against
        // the real amount and not a partial one.
        const { pickupCharges, dropCharges } = computeTransportCharges({ transportOption, dealer });
        const towingCharge = resolveTowingCharge({
          towingRequired: resolvedTowingRequired,
          dealer,
        });
        const subtotal = round2(serviceAmount + pickupCharges + dropCharges + towingCharge);
        const validated = await validatePromoCode({ code: promoCode, userId: user_id, subtotal });
        promo = validated.promo;
      }

      // MR Bike's platform fee and commission-GST rate, read fresh from the
      // admin settings and locked onto the booking here — the same values
      // /pricing/quote just showed the customer. Every later recompute passes
      // the stored ones back in as overrides instead, so an admin changing
      // either can never re-price or re-rate this booking.
      const { platformFeeConfig, commissionTaxRate } = await getPricingSettings();

      const baseBreakdown = computePriceBreakdown({
        serviceAmount,
        transportOption,
        dealer,
        promo,
        bikeCondition: resolvedBikeCondition,
        platformFeeConfig,
        commissionTaxRate,
      });

      const redemption = calculateMrBikeMoneyRedemption({
        balance: bookingUser.mrBikeMoneyBalance || 0,
        serviceLimit: getServiceRedemptionLimit(serviceDocs),
        amountDueBeforeMoney: round2(baseBreakdown.customerTotal - baseBreakdown.discountAmount),
      });
      const mrBikeMoneyAmount = useMrBikeMoney ? redemption.maxRedeemable : 0;

      breakdown = computePriceBreakdown({
        serviceAmount,
        transportOption,
        dealer,
        promo,
        mrBikeMoneyAmount,
        bikeCondition: resolvedBikeCondition,
        platformFeeConfig,
        commissionTaxRate,
      });
      breakdown.mrBikeMoneyLimit = redemption.serviceLimit;
    } catch (pricingError) {
      if (pricingError instanceof PricingError) {
        return res.status(400).json({ success: false, message: pricingError.message, code: pricingError.code });
      }
      throw pricingError;
    }
    console.log("[createBooking] Pricing breakdown:", breakdown);

    // A pickup OTP must never exist on self-drop / drop-only bookings.
    const pickupOtp = pickupRequest
      ? (/^\d{4}$/.test(String(pickupRequest.otp ?? "")) ? pickupRequest.otp : genOtp())
      : null;
    const deliveryOtp = genOtp();

    // ── 4. Pre-save payload log ───────────────────────────────────────────────
    console.log('[createBooking] PRE-SAVE payload:', JSON.stringify({
      user_id,
      dealer_id,
      services: resolvedServiceIds,
      pickupAndDropId: pickupAndDropId || null,
      userBike_id,
      pickupDate: pickupDate || null,
      breakdown,
    }, null, 2));

    const newBooking = new booking({
      user_id,
      dealer_id,
      services: resolvedServiceIds,
      additionalServices: additionalServiceDocs.map(s => s._id),
      pickupAndDropId: pickupAndDropId || null,
      userBike_id,
      pickupDate: pickupDate || null,
      scheduleDate: scheduleDate || null,
      timeSlot: timeSlot || null,
      pickupAddress: pickupAddress || null,
      bikeCondition: resolvedBikeCondition,
      towingRequired: resolvedTowingRequired,
      towingNote: resolvedTowingNote,
      pickupOtp,
      deliveryOtp,
      status: "pending",
      dealerResponseStatus: "awaiting",
      timerExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
    });

    // Single sanctioned path for writing the pricing snapshot onto a Booking
    // document — see services/pricingEngine.js#applyBreakdownToBooking().
    applyBreakdownToBooking(newBooking, breakdown);
    newBooking.mrBikeMoneyLimit = breakdown.mrBikeMoneyLimit || 0;

    let moneyDebited = false;
    try {
      if (newBooking.mrBikeMoneyUsed > 0) {
        await debitForBooking({
          userId: user_id,
          bookingId: newBooking._id,
          amount: newBooking.mrBikeMoneyUsed,
        });
        moneyDebited = true;
      }
      await newBooking.save();
    } catch (saveError) {
      if (moneyDebited) {
        try {
          await refundBookingMoney(newBooking);
        } catch (refundError) {
          console.error("[MR-BIKE-MONEY] Failed to roll back booking debit:", refundError.message);
        }
      }
      if (saveError.code === "INSUFFICIENT_MR_BIKE_MONEY") {
        return res.status(409).json({
          success: false,
          code: saveError.code,
          errorCode: saveError.code,
          message: saveError.message,
        });
      }
      throw saveError;
    }

    console.log('[BOOKING-CREATED] Save successful');
    console.log(`[BOOKING-CREATED] _id: ${newBooking._id} | bookingId: ${newBooking.bookingId}`);
    console.log(`[BOOKING-CREATED] status: ${newBooking.status} | payment_method: ${newBooking.payment_method} (null = payment not yet selected — correct)`);
    console.log(`[BOOKING-CREATED] Booking created with timer: ${newBooking._id}`);

    // ── Notify dealer: socket + FCM ──────────────────────────────────────────
    //
    // Eligibility is re-read here rather than reusing the `dealer` document
    // loaded at the top of createBooking. That earlier read gated whether the
    // booking may be created at all; this one closes the logout race — a dealer
    // who logs out between the eligibility check and this point must not be
    // delivered the booking. Logout writes `online: false` and nulls
    // `device_token`/`ftoken` in a single atomic update (controller/dealerAuth.js
    // logout), so this re-read either sees the whole pre-logout state or the
    // whole post-logout state, never a half-applied mix.
    try {
      const dealerNow = await Vendor.findById(dealer_id)
        .select(
          "device_token ftoken online isBlocked isActive isDoc status registrationStatus dealerStatus"
        )
        .lean();

      const stillEligible = isDealerBookable(dealerNow);

      if (!stillEligible) {
        // The booking row stays as created; it simply is not delivered to this
        // dealer and the existing 60s expiry job releases it back to the
        // customer exactly as it does for an unanswered request.
        console.log(
          `[BOOKING-CREATED] dealer ${dealer_id} is no longer eligible (offline/logged out) — skipping socket + FCM delivery`
        );
      } else {
        // Socket: push booking:new to dealer's personal room
        const io = req.app.get("io");
        if (io) {
          io.to(`dealer:${dealer_id}`).emit("booking:new", {
            bookingId: newBooking._id,
            timerExpiresAt: newBooking.timerExpiresAt,
          });
        }

        // FCM: push notification to dealer app
        if (dealerNow?.device_token) {
          sendBookingNotification({
            token: dealerNow.device_token,
            title: "New Booking Request",
            body: "You have received a new booking request.",
            data: { type: "new_booking", bookingId: newBooking._id.toString() },
            receiverId: dealer_id,
            receiverType: "dealer",
            bookingId: newBooking._id,
          });
        }
      }
    } catch (notifyErr) {
      console.error("[BOOKING-CREATED] Dealer notification error:", notifyErr.message);
    }

    const bookingResponse = newBooking.toObject();
    delete bookingResponse.pickupOtp;
    return res.status(201).json({
      success: true,
      message: "Booking created successfully",
      data: bookingResponse,
      pricing: breakdown,
      deliveryOtp,
      timerExpiresAt: newBooking.timerExpiresAt,
      dealerResponseStatus: newBooking.dealerResponseStatus,
    });
  } catch (error) {
    console.error('[createBooking] FATAL ERROR — name:', error.name);
    console.error('[createBooking] FATAL ERROR — message:', error.message);
    console.error('[createBooking] failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
    });
  }
}

async function getBookingDetails(req, res) {
  try {
    let bookingId = req.params.id;

    if (!bookingId) {
      return res.status(400).json({ success: false, message: "Booking ID is required" });
    }

    console.log("=== getBookingDetails ===");
    console.log("Booking ID received:", bookingId);
    console.log("Is valid ObjectId:", mongoose.Types.ObjectId.isValid(bookingId));

    // Try to find the booking, scoped to whichever participant is authenticated
    // (requireBookingParticipant already verified this actor owns/participates
    // in this booking — this filter just mirrors that ownership for the query).
    const ownerFilter =
      req.auth?.role === "dealer" ? { _id: bookingId, dealer_id: req.user_id } :
      req.auth?.role === "admin" ? { _id: bookingId } :
      { _id: bookingId, user_id: req.user_id };
    const bookingQuery = booking.findOne(ownerFilter);
    // Legacy SELF_VISIT bookings still use this customer-visible visit OTP.
    // Tracked PICKUP bookings are sanitized below and use the narrow,
    // ARRIVED-only customer OTP endpoint instead.
    if (req.auth?.role === "customer") bookingQuery.select("+pickupOtp");

    const bookingData = await bookingQuery
      .populate("user_id", "first_name last_name phone email image address city")
      .populate("dealer_id", "shopName fullAddress address city locality shopImages phone averageRating ratingCount status dealerStatus")
      .populate("reviewId", "rating createdAt")
      .populate({
        path: "services",
        model: "AdminService",
        populate: {
          path: "base_service_id",
          model: "BaseService",
          select: "name description image",
        },
      })
      .populate({
        path: "additionalServices",
        populate: { path: "base_additional_service_id", select: "name" },
      })
      .populate("pickupAndDropId")
      .populate("userBike_id");

    console.log("Booking found:", !!bookingData);

    if (!bookingData) {
      console.log("Booking not found for ID:", bookingId);
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    console.log("Booking status:", bookingData.status);
    console.log("Booking ID (custom):", bookingData.bookingId);
    console.log("Booking totalBill:", bookingData.totalBill);

    // Fetch bill information if it exists (optional - for additional details)
    let billData = null;
    try {
      const Bill = require("../models/billSchema");
      billData = await Bill.findOne({ booking_id: bookingId });
      console.log("Bill found:", !!billData);
      if (billData) {
        console.log("Bill total_amount:", billData.total_amount);
      }
    } catch (err) {
      console.log("Error fetching bill:", err.message);
    }

    // Use bill data if available, otherwise use booking's totalBill
    const grandTotal = billData?.total_amount || bookingData.totalBill || 0;
    const subtotal = billData?.subtotal || bookingData.totalBill || 0;

    const result = {
      ...bookingData.toObject(),
      subtotal: subtotal,
      tax_amount: billData?.tax_amount || 0,
      grandTotal: grandTotal,
      pickupCharges: billData?.pickup_charges || bookingData.pickupCharges || 0,
      dropCharges: billData?.drop_charges || bookingData.dropCharges || 0,
      towingCharge: billData?.towing_charge || bookingData.towingCharge || 0,
    };
    if (isPickupBooking(bookingData)) {
      delete result.pickupOtp;
      delete result.pickupOtpExpiresAt;
    }

    console.log("Returning booking details with grandTotal:", grandTotal);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("Error in getBookingDetails:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal Server Error", 
    });
  }
}

// Business/logistics fields this endpoint is allowed to touch. Deliberately
// excludes every pricing snapshot field (serviceAmount, pickupCharges,
// dropCharges, subtotal, taxRate, taxAmount, platformFee, platformFeeLabel,
// customerTotal, commissionRate,
// commissionAmount, dealerEarnings, discountAmount, pricingVersion,
// priceSnapshotAt, totalBill, tax) and `status` (status transitions have
// their own guarded endpoint — updateBookingStatus — with timer/race-condition
// rules that must not be bypassed here). Pricing is immutable after creation;
// the schema-level guard in models/Booking.js rejects any attempt to slip a
// locked field through regardless, but we never even try here.
const UPDATE_BOOKING_ALLOWED_FIELDS = [
  "billGenerated",
  "lastServiceKm",
  "pickupDate",
  "scheduleDate",
  "timeSlot",
  "pickupAddress",
  "additionalNotes",
  "serviceDate",
  "pickupStatus",
];

async function updateBooking(req, res) {
  try {
    const { bookingId, ...updateFields } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, message: "Booking ID is required" });
    }

    // Scoped to whichever participant is authenticated (requireBookingParticipant
    // already verified this actor owns/participates in this booking).
    const ownerFilter =
      req.auth?.role === "dealer" ? { _id: bookingId, dealer_id: req.user_id } :
      req.auth?.role === "admin" ? { _id: bookingId } :
      { _id: bookingId, user_id: req.user_id };
    const existingBooking = await booking.findOne(ownerFilter);
    if (!existingBooking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const rejectedFields = Object.keys(updateFields).filter(
      (key) => key !== "services" && !UPDATE_BOOKING_ALLOWED_FIELDS.includes(key)
    );
    if (rejectedFields.length > 0) {
      console.warn(`[updateBooking] Ignoring disallowed field(s) on booking ${bookingId}:`, rejectedFields);
    }

    // --- handle `services` specially (these are AdditionalService IDs) ---
    // Changing them changes what the customer is being charged, so it can
    // NEVER just patch a total — it must trigger a full pricingEngine recompute
    // below (see "service list changed" block).
    let additionalServicesChanged = false;
    if (Object.prototype.hasOwnProperty.call(updateFields, "services")) {
      const services = updateFields.services;

      if (!Array.isArray(services)) {
        return res.status(400).json({
          success: false,
          message: "`services` must be an array of AdditionalService ids",
        });
      }

      // ❌ IMPORTANT: do NOT mirror into existingBooking.services
      //    That field in your schema is for core `service` model, not additionalServices.

      if (services.length === 0) {
        existingBooking.additionalServices = [];
        additionalServicesChanged = true;
      } else {
        // validate ids
        const invalid = services.filter((id) => !mongoose.Types.ObjectId.isValid(id));
        if (invalid.length) {
          return res.status(400).json({
            success: false,
            message: "Invalid service id(s) provided",
            invalid,
          });
        }

        // ensure all requested AdditionalService docs exist (optional but recommended)
        const svcDocs = await AdditionalService.find({ _id: { $in: services } })
          .select("_id") // we just need to verify existence
          .lean();

        const foundIds = new Set(svcDocs.map((s) => String(s._id)));
        const missing = services.filter((id) => !foundIds.has(String(id)));
        if (missing.length) {
          return res.status(400).json({
            success: false,
            message: "Some services do not exist",
            missing,
          });
        }

        // ✅ Assign ONLY ObjectIds to match your schema
        existingBooking.additionalServices = services.map((id) => new mongoose.Types.ObjectId(id));
        additionalServicesChanged = true;
      }
    }

    // --- apply ONLY whitelisted business fields — never a raw field spread ---
    UPDATE_BOOKING_ALLOWED_FIELDS.forEach((key) => {
      if (updateFields[key] !== undefined) {
        existingBooking[key] = updateFields[key];
      }
    });

    // --- service list changed: resolve services -> pricingEngine.computePriceBreakdown()
    // -> update ALL pricing snapshot fields together. Never touch totalBill alone. ---
    if (additionalServicesChanged) {
      const [dealer, bikeData, mainDocs, addlDocs] = await Promise.all([
        Vendor.findById(existingBooking.dealer_id)
          .select("tax commission pickupCharges dropCharges providesPickup providesDrop providesTowing towingCharges")
          .lean(),
        UserBike.findById(existingBooking.userBike_id)
          .select("bike_cc variant_id")
          .populate({ path: "variant_id", select: "model_id engine_cc" }),
        AdminService.find({ _id: { $in: existingBooking.services } }).select("bikes"),
        AdditionalService.find({ _id: { $in: existingBooking.additionalServices } }).select("bikes"),
      ]);

      if (!dealer) {
        return res.status(404).json({ success: false, message: "Dealer not found for this booking" });
      }

      const bikeCC = parseInt(bikeData?.variant_id?.engine_cc || bikeData?.bike_cc || 0);
      const serviceAmount = resolveServiceAmount({
        services: mainDocs,
        additionalServices: addlDocs,
        bikeCC,
        bikeContext: {
          variantId: bikeData?.variant_id?._id || bikeData?.variant_id,
          modelId: bikeData?.variant_id?.model_id,
        },
      });

      let breakdown;
      try {
        breakdown = computePriceBreakdown({
          serviceAmount,
          transportOption: existingBooking.transportOption,
          dealer,
          // Preserve any reward/coupon discount already applied to this booking.
          discountAmount: existingBooking.discountAmount,
          // …and the towing charge already agreed on this booking. Passing the
          // booking's own value as the override keeps it frozen here: changing
          // the service list must not silently re-derive towing from the
          // dealer's current rate, nor drop a charge the dealer already set.
          bikeCondition: existingBooking.bikeCondition,
          towingRequiredOverride: existingBooking.towingRequired,
          towingChargeOverride: existingBooking.towingCharge,
          // …and the platform fee this booking was created with, for the same
          // reason: a service-list edit must not pull in the admin's current
          // fee, nor drop one the customer has already agreed to.
          platformFeeOverride: existingBooking.platformFee,
          platformFeeLabelOverride: existingBooking.platformFeeLabel,
          commissionTaxRateOverride: existingBooking.commissionTaxRate,
        });
      } catch (pricingError) {
        if (pricingError instanceof PricingError) {
          return res.status(400).json({ success: false, message: pricingError.message, code: pricingError.code });
        }
        throw pricingError;
      }

      applyBreakdownToBooking(existingBooking, breakdown);
    }

    await existingBooking.save();

    // ✅ Populate the correct path for an ObjectId[] ref
    await existingBooking.populate({
      path: "additionalServices",
      select: "_id id name image description bikes",
      populate: { path: "base_additional_service_id", select: "name" }
    });

    const data = existingBooking.toObject();
    if (!Array.isArray(data.additionalServices)) data.additionalServices = [];

    return res.status(200).json({
      success: true,
      message: "Booking updated successfully",
      data,
    });
  } catch (error) {
    console.error("Update Booking Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

// async function updateBooking(req, res) {
//   try {
//     const { bookingId, ...updateFields } = req.body;

//     if (!bookingId) {
//       return res.status(400).json({ success: false, message: "Booking ID is required" });
//     }

//     let existingBooking = await booking.findById(bookingId);
//     if (!existingBooking) {
//       return res.status(404).json({ success: false, message: "Booking not found" });
//     }

//     if (Object.prototype.hasOwnProperty.call(updateFields, "services")) {
//       const services = updateFields.services;      
//       delete updateFields.services;                

//       if (!Array.isArray(services)) {
//         return res.status(400).json({
//           success: false,
//           message: "`services` must be an array of AdditionalService ids",
//         });
//       }

//       existingBooking.services = services;

//       if (services.length === 0) {
//         existingBooking.additionalServices = [];
//       } else {
//         const invalid = services.filter((id) => !mongoose.Types.ObjectId.isValid(id));
//         if (invalid.length) {
//           return res.status(400).json({
//             success: false,
//             message: "Invalid service id(s) provided",
//             invalid,
//           });
//         }

//         const svcDocs = await AdditionalService.find({ _id: { $in: services } })
//           .select("_id id name image description bikes")
//           .lean();

//         const foundIds = new Set(svcDocs.map((s) => String(s._id)));
//         const missing = services.filter((id) => !foundIds.has(String(id)));
//         if (missing.length) {
//           return res.status(400).json({
//             success: false,
//             message: "Some services do not exist",
//             missing,
//           });
//         }

//         existingBooking.additionalServices = svcDocs.map((s) => ({
//           service: s._id,  
//           id: s.id,        
//           name: s.name,
//           image: s.image,
//           description: s.description,
//           bikes: s.bikes,
//         }));
//       }
//     }

//     // --- generic field updates (everything except services) ---
//     Object.keys(updateFields).forEach((key) => {
//       if (updateFields[key] !== undefined) {
//         existingBooking[key] = updateFields[key];
//       }
//     });

//     await existingBooking.save();

//     // Always include additionalServices in response
//     if (typeof existingBooking.populate === "function") {
//       await existingBooking.populate("additionalServices.service");
//     }
//     const data = existingBooking.toObject ? existingBooking.toObject() : existingBooking;
//     if (!Array.isArray(data.additionalServices)) data.additionalServices = [];

//     return res.status(200).json({
//       success: true,
//       message: "Booking updated successfully",
//       data,
//     });
//   } catch (error) {
//     console.error("Update Booking Error:", error);
//     return res.status(500).json({ success: false, message: "Internal Server Error" });
//   }
// }

async function updateBookingStatus(req, res) {
  try {
    const { bookingId } = req.params;
    const { status } = req.body;
    const user_id = req.auth?.id || req.user_id;
    console.log("Booking id", bookingId)
    console.log("Status", req.body)
    if (!bookingId || !status || !user_id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID, status, and user ID are required"
      });
    }

    // Find and update booking
    let existingBooking = await booking.findById(bookingId);
    if (!existingBooking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found"
      });
    }

    // Verify the requesting user has rights to update this booking
    if (existingBooking.user_id.toString() !== user_id &&
      existingBooking.dealer_id.toString() !== user_id) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to update this booking"
      });
    }

    if (req.auth?.role === "customer" && !["cancelled", "user_cancelled"].includes(status)) {
      return res.status(403).json({ success: false, message: "Customers may only cancel their own booking" });
    }

    // ── Expiry window guard (confirmed / rejected only) ──────────────────────
    // Transitions like completed / cash received happen after the booking is
    // already confirmed, so timerExpiresAt being in the past is expected there.
    // Only dealer accept / reject responses must be within the 2-minute window.
    if (status === "confirmed" || status === "rejected") {
      if (
        existingBooking.status === "expired" ||
        existingBooking.dealerResponseStatus === "expired" ||
        (existingBooking.timerExpiresAt && existingBooking.timerExpiresAt < new Date())
      ) {
        console.log(`[BOOKING-EXPIRED-BLOCKED] Dealer blocked from "${status}" on expired booking: ${bookingId}`);
        return res.status(400).json({
          success: false,
          message: "Booking response window has expired. The user will be notified to choose another dealer."
        });
      }
    }

    // Block booking acceptance if dealer has exceeded credit limit
    if (status === "confirmed") {
      const BOOKING_CREDIT_LIMIT = -500;
      const dealerForCheck = await Vendor.findById(existingBooking.dealer_id).select("wallet").lean();
      const dealerWallet = parseFloat(dealerForCheck?.wallet) || 0;
      if (dealerWallet < BOOKING_CREDIT_LIMIT) {
        return res.status(200).json({
          success: false,
          message: "Booking cannot be accepted. Please clear your outstanding dues to continue accepting bookings."
        });
      }
    }

    // ── Update status ─────────────────────────────────────────────────────────
    if (status === "confirmed" || status === "rejected") {
      // Atomic write: only succeeds if the booking is still pending+awaiting
      // within the timer window. If the expiry job fired between our read above
      // and this update, findOneAndUpdate returns null and we block the response.
      const atomicResult = await booking.findOneAndUpdate(
        {
          _id: existingBooking._id,
          status: "pending",
          dealerResponseStatus: "awaiting",
          timerExpiresAt: { $gt: new Date() },
        },
        {
          $set: {
            status: status,
            dealerResponseStatus: status === "confirmed" ? "accepted" : "rejected",
            ...(status === "confirmed" && isPickupBooking(existingBooking)
              ? { pickupStatus: PICKUP_STATUSES.BOOKING_CONFIRMED }
              : {}),
          },
        },
        { new: true }
      );

      if (!atomicResult) {
        // Expiry job won the race between our read and this write
        console.log(`[BOOKING-EXPIRED-BLOCKED] Race condition caught — booking already expired: ${bookingId}`);
        return res.status(400).json({
          success: false,
          message: "Booking response window has expired. The user will be notified to choose another dealer."
        });
      }

      existingBooking = atomicResult;

      if (status === "rejected") {
        try {
          await refundBookingMoney(existingBooking);
        } catch (refundError) {
          console.error("[MR-BIKE-MONEY] Rejection refund failed:", refundError.message);
        }
      }

      if (status === "confirmed") {
        console.log(`[BOOKING-ACCEPTED] Dealer accepted booking: ${bookingId}`);
      } else {
        console.log(`[BOOKING-REJECTED] Dealer rejected booking: ${bookingId}`);
      }

      // ── Promo consumption — happens ONLY on dealer confirmation ────────────
      // Final business rule: applying a promo, requesting a quote, and
      // creating a pending booking never consume it; rejecting a booking
      // never consumes it either. Payment and invoice generation are fully
      // independent of promo usage (see services/invoiceService.js, which
      // only displays the snapshot locked here — it never touches usedCount
      // or PromoCodeUsage). This is the single place both are written.
      //
      // The promo snapshot itself (promoCodeId/promoCode/promoDiscountAmount)
      // is already locked onto the booking at createBooking() time — nothing
      // to (re)lock here; if it's missing there's simply no promo to consume.
      if (status === "confirmed" && existingBooking.promoCodeId) {
        try {
          // Atomic, race-safe increment: usage is only CHECKED (not reserved)
          // when the booking is created, so multiple pending bookings for the
          // same code can exist at once. $expr guards usedCount from ever
          // exceeding usageLimit even if several of them get confirmed
          // concurrently.
          const promoUpdateResult = await PromoCode.findOneAndUpdate(
            { _id: existingBooking.promoCodeId, $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            { $inc: { usedCount: 1 } },
            { new: true }
          );

          if (promoUpdateResult) {
            await PromoCodeUsage.create({
              promoCode: existingBooking.promoCodeId,
              code: existingBooking.promoCode,
              user_id: existingBooking.user_id,
              booking_id: existingBooking._id,
              discountApplied: existingBooking.promoDiscountAmount || 0,
              confirmedAt: new Date(),
            });
            console.log(`[PROMO-CONSUMED] ${existingBooking.promoCode} consumed on booking confirm: ${bookingId}`);
          } else {
            // Usage limit was reached by other confirmations between this
            // booking's creation and now. The customer already saw and was
            // promised this discount when the booking was created, so the
            // booking still confirms normally — we simply don't count usage
            // that no longer fits the limit.
            console.warn(`[PROMO-LIMIT-RACE] ${existingBooking.promoCode} usage limit reached before booking ${bookingId} could be counted.`);
          }
        } catch (promoErr) {
          // Promo bookkeeping must never block a dealer's booking confirmation.
          console.error("[PROMO-CONSUMED] Failed to record promo usage:", promoErr.message);
        }
      }

      // Notify user via socket
      const io = req.app.get("io");
      if (io) {
        const eventName = status === "confirmed" ? "booking:confirmed" : "booking:rejected";
        io.to(`booking:${bookingId}`).emit(eventName, {
          bookingId,
          dealerResponseStatus: existingBooking.dealerResponseStatus,
        });
      }

      // FCM: push notification to user on accept / reject
      try {
        const userForNotif = await Customer.findById(existingBooking.user_id)
          .select("device_token ftoken")
          .lean();
        const userToken = userForNotif?.device_token || userForNotif?.ftoken;
        if (userToken) {
          await sendBookingNotification({
            token: userToken,
            title: status === "confirmed" ? "Booking Accepted" : "Booking Rejected",
            body: status === "confirmed"
              ? "Your booking has been accepted by the dealer."
              : "The dealer rejected your booking request.",
            data: {
              type: status === "confirmed" ? "booking_accepted" : "booking_rejected",
              bookingId: bookingId.toString(),
            },
            receiverId: existingBooking.user_id,
            receiverType: "user",
            bookingId: existingBooking._id,
          });
        }
      } catch (notifyErr) {
        console.error("[BOOKING-RESPONSE] User FCM notification error:", notifyErr.message);
      }
    } else {
      // All other transitions (completed, cash received, cancelled, etc.) via
      // this generic legacy endpoint.
      //
      // The payment flow itself (awaiting_payment → payment_selected →
      // ready_for_delivery) is owned exclusively by serviceComplete() /
      // selectPaymentMethod() / generateUPIQRCode() / confirmCashReceived() —
      // those enforce their own preconditions and are the only sanctioned way
      // to enter or advance those statuses. This generic setter must never
      // write them directly, and must never move a booking OUT of an
      // in-flight payment status either: doing so from here (no precondition
      // checks) could strand a booking somewhere neither serviceComplete()
      // (requires status === "confirmed") nor selectPaymentMethod() (requires
      // status in ["awaiting_payment","payment_selected"]) will accept it
      // back from, permanently hiding payment options in the dealer app.
      const PAYMENT_FLOW_STATUSES = ["awaiting_payment", "payment_selected", "ready_for_delivery"];

      if (PAYMENT_FLOW_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Use the dedicated payment endpoints to reach "${status}" (service-complete / select-payment-method / generate-qr / confirm-cash-received).`,
        });
      }

      if (
        PAYMENT_FLOW_STATUSES.includes(existingBooking.status) &&
        status !== "cancelled" &&
        status !== "user_cancelled"
      ) {
        return res.status(400).json({
          success: false,
          message: `Booking is mid-payment ("${existingBooking.status}") — use the dedicated payment endpoints instead of a generic status update.`,
        });
      }

      existingBooking.status = status;

      if (status === "cash received") {
        existingBooking.billStatus = "paid";
      }

      await existingBooking.save();

      if (["cancelled", "user_cancelled", "rejected", "expired"].includes(status)) {
        try {
          await refundBookingMoney(existingBooking);
        } catch (refundError) {
          console.error("[MR-BIKE-MONEY] Status refund failed:", refundError.message);
        }
      }
    }

    // Handle completion logic if needed
    if (status === "completed") {
      await handleBookingCompletion(existingBooking);
    }

    // Fallback only: a booking reaching "completed" while payment was
    // already marked paid (billStatus === "paid") but no invoice exists yet
    // (e.g. the payment-success trigger fired before this status update was
    // saved). Payment completion remains the primary trigger — this never
    // fires for an unpaid booking, since billStatus !== "paid" short-circuits it.
    if (status === "completed" && existingBooking.billStatus === "paid" && !existingBooking.billGenerated) {
      try {
        await getOrCreateInvoice(existingBooking._id, {
          payment_method: existingBooking.payment_method || "N/A",
        });
      } catch (billError) {
        console.error("Bill generation failed on completion fallback:", billError.message);
      }
    }

    // Generate invoice for cash payment if not already generated
    if (status === "cash received" && !existingBooking.billGenerated) {
      try {
        await generateBill({
          booking_id: existingBooking._id,
          payment_method: "CASH",
          transaction_id: null,
          _id: null
        });
      } catch (billError) {
        console.error("Bill generation failed for cash payment:", billError);
      }
    }

    // Automatic wallet settlement — debit commission owed to platform for cash booking
    if (status === "cash received") {
      try {
        const settlement = await settleBookingWallet(existingBooking._id, "CASH");
        if (settlement) {
          console.log(`✅ Cash commission settled: dealer debited ₹${settlement.txnAmount} (order ₹${settlement.orderAmount}, commission ${settlement.commissionRate}%)`);
        } else {
          console.log(`ℹ️ Wallet already settled for booking: ${existingBooking._id}`);
        }
      } catch (settlementErr) {
        console.error(`❌ Cash commission settlement failed for booking ${existingBooking._id}:`, settlementErr.message);
      }
    }

    // Notify customer if they're not the one making the update
    if (existingBooking.user_id.toString() !== user_id) {
      const customer = await customers.findById(existingBooking.user_id);
      if (customer?.device_token) {
        Notification(
          customer.device_token,
          `Your booking status has been updated to: ${status}`,
          customer._id.toString()
        );
      }
    }

    res.status(200).json({
      success: true,
      message: "Booking status updated successfully",
      data: existingBooking
    });

  } catch (error) {
    console.error("Update Booking Status Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
}

const sendBookingOTP = async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(200).json({ success: false, message: "Booking ID is required" });
    }

    // Booking aur Dealer ka data fetch karna
    const bookingData = await booking.findById(bookingId).populate("dealer_id");
    if (!bookingData) {
      return res.status(200).json({ success: false, message: "Booking not found" });
    }
    const dealer = await Vendor.findById(bookingData.dealer_id);
    if (!dealer || !dealer.phone) {
      return res.status(200).json({ success: false, message: "Dealer phone number not found" });
    }

    const phoneNumber = dealer.phone;

    // OTP Generate karna
    const otp = Math.floor(100000 + Math.random() * 900000);

    // OTP ko database me save karna
    bookingData.otp = otp;
    await bookingData.save();

    // Twilio ya SMS API se OTP bhejna
    // const otpResponse = await sendotp(phoneNumber);

    res.status(200).json({ success: true, message: "OTP sent successfully to dealer" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const normalize10 = (p) => String(p).replace(/\D/g, "").slice(-10);
const with91 = (ten) => `91${ten}`;

const sendOtpToMobile = async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(200).json({ success: false, message: "Booking ID is required" });
    }

    // 1) Fetch booking + user
    const bookingData = await booking
      .findById(bookingId)
      .populate("user_id", "phone first_name last_name");

    if (!bookingData) {
      return res.status(200).json({ success: false, message: "Booking not found" });
    }
    if (!bookingData.user_id || !bookingData.user_id.phone) {
      return res.status(200).json({ success: false, message: "User phone number not found" });
    }

    const rawPhone = bookingData.user_id.phone;
    const ten = normalize10(rawPhone);
    const e164 = with91(ten);

    // 2) Find the same customer by any stored representation (Number/String, 10/12 digits)
    const customer =
      await customers.findOne({ phone: { $in: [Number(ten), ten, Number(e164), e164] } }) ||
      await customers.findById(bookingData.user_id._id); // fallback by id, just in case

    if (!customer) {
      return res.status(200).json({ success: false, message: "User not found for this booking" });
    }

    // 3) Generate & save OTP on customer
    const otp = genOtp();
    customer.otp = otp;
    // Optional expiry support if you add it to schema:
    // customer.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    await customer.save();

    // 4) Send SMS (plug your provider here)
    // await sendSms(`+${e164}`, `Your OTP is ${otp}`);

    return res.status(200).json({
      success: true,
      message: `OTP sent successfully to ${e164}`,
      phone: Number(ten)
    });
  } catch (error) {
    console.error("sendOtpToMobile error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const verifyOtpForMobile = async (req, res) => {
  try {
    const { bookingId, phone, otp } = req.body;

    if (!bookingId || !phone || !otp) {
      return res.status(200).json({ success: false, message: "Booking ID, phone and OTP are required" });
    }

    const ten = normalize10(phone);
    const e164 = with91(ten);

    // Flexible lookup to match existing stored shapes
    const customer = await customers.findOne({
      phone: { $in: [Number(ten), ten, Number(e164), e164] }
    });

    if (!customer) {
      return res.status(200).json({ success: false, message: "User not found" });
    }
    const assigned = await booking.exists({ _id: bookingId, user_id: customer._id, dealer_id: req.auth.id });
    if (!assigned) return res.status(404).json({ success: false, message: "Booking not found" });

    // Optional expiry check
    // if (customer.otpExpiry && customer.otpExpiry < new Date()) {
    //   return res.status(200).json({ success: false, message: "OTP expired" });
    // }

    if (Number(otp) !== Number(customer.otp)) {
      return res.status(200).json({ success: false, message: "Invalid OTP" });
    }

    customer.otp = null; // clear after success
    await customer.save();

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      data: { customerId: customer._id }
    });
  } catch (err) {
    console.error("verifyOtpForMobile error:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// const verifyBookingOTP = async (req, res) => {
//   try {
//     const { bookingId, otp } = req.body;

//     if (!bookingId || !otp) {
//       return res
//         .status(200)
//         .json({ success: false, message: "Booking ID and OTP are required" });
//     }

//     const bookingData = await booking.findById(bookingId).populate("dealer_id");
//     if (!bookingData) {
//       return res.status(200).json({ success: false, message: "Booking not found" });
//     }

//     const incomingOtp = String(otp).trim();

//     const storedOtp = bookingData.otp == null ? null : String(bookingData.otp);

//     const isValid =
//       incomingOtp === "9999" || (storedOtp && incomingOtp === storedOtp);

//     if (!isValid) {
//       return res.status(200).json({ success: false, message: "Invalid OTP" });
//     }

//     bookingData.otp = null;
//     bookingData.pickupStatus = "pickedup";
//     bookingData.pickupDate = new Date();
//     await bookingData.save();

//     return res
//       .status(200)
//       .json({ success: true, message: "OTP verified successfully by dealer" });
//   } catch (error) {
//     console.error(error);
//     return res
//       .status(500)
//       .json({ success: false, message: "Internal Server Error" });
//   }
// };

// POST /api/bookings/verify-otp

// const verifyBookingOTP = async (req, res) => {
//   try {
//     const { bookingId, otp, stage } = req.body;

//     if (!bookingId || !otp) {
//       return res.status(400).json({ success: false, message: "bookingId and otp are required" });
//     }

//     // optional: enforce 4-digit numeric
//     const incoming = String(otp).trim();
//     if (!/^\d{4}$/.test(incoming) && incoming !== "9999") {
//       return res.status(400).json({ success: false, message: "OTP must be 4 digits" });
//     }

//     const b = await booking.findById(bookingId);
//     if (!b) return res.status(404).json({ success: false, message: "Booking not found" });

//     // Decide which stage to verify
//     let targetStage = stage;
//     if (!targetStage) {
//       // Auto-detect if not provided:
//       if (b.pickupOtp != null) targetStage = "pickup";
//       else if (b.deliveryOtp != null) targetStage = "delivery";
//       else {
//         return res.status(200).json({ success: true, message: "Nothing to verify (both OTPs already verified)" });
//       }
//     }

//     if (!["pickup", "delivery"].includes(targetStage)) {
//       return res.status(400).json({ success: false, message: "stage must be 'pickup' or 'delivery'" });
//     }

//     // Prepare stored code and idempotency checks
//     const stored =
//       targetStage === "pickup"
//         ? (b.pickupOtp == null ? null : String(b.pickupOtp))
//         : (b.deliveryOtp == null ? null : String(b.deliveryOtp));

//     if (targetStage === "pickup" && b.pickupOtp == null) {
//       return res.status(200).json({ success: true, message: "Pickup already verified" });
//     }
//     if (targetStage === "delivery" && b.deliveryOtp == null) {
//       return res.status(200).json({ success: true, message: "Delivery already verified" });
//     }

//     // Validate (keep your override "9999" if you like)
//     const isValid = incoming === "9999" || (stored && incoming === stored);
//     if (!isValid) {
//       return res.status(200).json({ success: false, message: `Invalid ${targetStage} OTP` });
//     }

//     // Apply updates
//     if (targetStage === "pickup") {
//       b.pickupOtp = null;                       // clear after success
//       b.pickupStatus = "pickedup";
//       b.pickupDate = new Date();
//       if (b.status === "pending") b.status = "confirmed";
//       // optional if you add these fields:
//       // b.pickupVerifiedAt = new Date();
//     } else {
//       b.deliveryOtp = null;                     // clear after success
//       b.status = "completed";
//       b.serviceDate = b.serviceDate || new Date();
//       // b.deliveryVerifiedAt = new Date();
//     }

//     await b.save();

//     return res.status(200).json({
//       success: true,
//       message: `${targetStage[0].toUpperCase()}${targetStage.slice(1)} OTP verified`,
//     });
//   } catch (error) {
//     console.error("verifyBookingOTP error:", error);
//     return res.status(500).json({ success: false, message: "Internal Server Error" });
//   }
// };

const verifyBookingOTP = async (req, res) => {
  try {
    const { bookingId, otp, stage } = req.body;

    // require all 3 to avoid ambiguity
    if (!bookingId || !otp || !stage) {
      return res.status(400).json({
        success: false,
        message: "bookingId, otp and stage ('pickup'|'delivery') are required"
      });
    }

    // Keep the legacy URL compatible, but route pickup verification through
    // the guarded lifecycle so it cannot bypass ARRIVED or ownership checks.
    if (stage === "pickup") {
      const pickupCandidate = await booking.findById(bookingId).select("+pickupOtp");
      if (!pickupCandidate) {
        return res.status(404).json({ success: false, message: "Booking not found" });
      }
      if (isPickupBooking(pickupCandidate)) {
        req.params.bookingId = bookingId;
        return verifyPickupOtp(req, res);
      }
    }

    const incoming = String(otp).trim();
    if (!/^\d{4}$/.test(incoming)) {
      return res.status(400).json({ success: false, message: "OTP must be exactly 4 digits" });
    }

    if (!["pickup", "delivery"].includes(stage)) {
      return res.status(400).json({ success: false, message: "stage must be 'pickup' or 'delivery'" });
    }

    // fetch booking
    const b = await booking.findById(bookingId).select("+pickupOtp");
    if (!b) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (stage === "pickup" && !isPickupBooking(b) && b.pickupStatus !== "arrived") {
      return res.status(409).json({
        success: false,
        message: "Customer arrival must be recorded before verifying the visit OTP",
      });
    }

    // pick stored otp explicitly for the requested stage
    const storedOtpRaw = stage === "pickup" ? b.pickupOtp : b.deliveryOtp;

    // if otp already cleared -> cannot verify again
    if (storedOtpRaw == null) {
      return res.status(409).json({
        success: false,
        message: `${stage[0].toUpperCase() + stage.slice(1)} OTP not present or already verified`
      });
    }

    const storedOtp = String(storedOtpRaw).trim();

    // Strict equality only — no overrides, no fallback
    if (incoming !== storedOtp) {
      // optional: you can increment a failedAttempts counter here if you extend schema
      return res.status(401).json({ success: false, message: `Invalid ${stage} OTP` });
    }

    // If we reached here, OTP is valid — apply updates
    if (stage === "pickup") {
      b.pickupOtp = null;
      b.pickupStatus = "pickedup";
      b.pickupDate = new Date();
      if (b.status === "pending") b.status = "confirmed";
    } else {
      b.deliveryOtp = null;
      b.status = "completed";
      b.serviceDate = b.serviceDate || new Date();
    }

    await b.save();

    if (stage === "delivery") {
      await handleBookingCompletion(b);
    }

    return res.status(200).json({
      success: true,
      message: `${stage[0].toUpperCase() + stage.slice(1)} OTP verified`
    });
  } catch (error) {
    console.error("verifyBookingOTP error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const updatePickupStatus = async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "This legacy endpoint cannot safely update pickup state. Use the authenticated pickup lifecycle endpoints.",
  });
};

// SELF_VISIT / DROP_ONLY intake transition. Rider pickup has a separate GPS-
// guarded lifecycle; when the customer brings the bike to the garage we only
// need an authenticated dealer-owned booking transition plus a fresh visit OTP.
const markCustomerArrived = async (req, res) => {
  try {
    const bookingId = req.params.bookingId;
    const bookingDoc = await booking
      .findOne({ _id: bookingId, dealer_id: req.auth.id })
      .select("+pickupOtp");

    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (isPickupBooking(bookingDoc)) {
      return res.status(400).json({
        success: false,
        message: "Use the tracked pickup arrival flow for pickup bookings",
      });
    }
    if (bookingDoc.status !== "confirmed") {
      return res.status(409).json({
        success: false,
        message: "Customer arrival can be recorded only for a confirmed booking",
      });
    }

    // Idempotent retry: do not rotate the OTP after the customer has already
    // been shown one.
    if (bookingDoc.pickupStatus === "arrived" && bookingDoc.pickupOtp != null) {
      return res.status(200).json({
        success: true,
        message: "Customer arrival already recorded",
        data: { bookingId: bookingDoc._id, pickupStatus: bookingDoc.pickupStatus },
      });
    }
    if (!canMarkCustomerArrived(bookingDoc)) {
      return res.status(409).json({
        success: false,
        message: `Cannot record customer arrival from ${bookingDoc.pickupStatus}`,
      });
    }

    const now = new Date();
    const updated = await booking.findOneAndUpdate(
      {
        _id: bookingDoc._id,
        dealer_id: req.auth.id,
        status: "confirmed",
        pickupStatus: "pending",
      },
      {
        $set: {
          pickupStatus: "arrived",
          arrivedAt: now,
          pickupDate: now,
          pickupOtp: genOtp(),
        },
      },
      { new: true },
    );

    if (!updated) {
      return res.status(409).json({
        success: false,
        message: "Customer arrival was already recorded or booking state changed",
      });
    }

    const io = req.app.get("io");
    if (io) {
      io.to(`booking:${updated._id}`).emit("booking:customer-arrived", {
        bookingId: String(updated._id),
        pickupStatus: updated.pickupStatus,
      });
    }

    try {
      const customer = await Customer.findById(updated.user_id)
        .select("device_token ftoken")
        .lean();
      await sendBookingNotification({
        token: customer?.device_token || customer?.ftoken,
        title: "Bike Check-in Started",
        body: "The garage recorded your arrival. Open the booking and share the visit OTP.",
        data: { type: "customer_arrived", bookingId: String(updated._id) },
        receiverId: updated.user_id,
        receiverType: "user",
        bookingId: updated._id,
      });
    } catch (error) {
      // The state transition is already complete; notification delivery must
      // not turn a successful check-in into an API failure.
      console.error("customer-arrived notification failed:", error.message);
    }

    return res.status(200).json({
      success: true,
      message: "Customer arrival recorded",
      data: { bookingId: updated._id, pickupStatus: updated.pickupStatus },
    });
  } catch (error) {
    console.error("markCustomerArrived error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

async function addNoteToBooking(req, res) {
  try {
    const { bookingId, note } = req.body;

    if (!bookingId || !note) {
      return res.status(400).json({ success: false, message: "Booking ID and note are required" });
    }

    const updatedBooking = await booking.findByIdAndUpdate(
      bookingId,
      { $push: { additionalNotes: note } },
      { new: true }
    );

    if (!updatedBooking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    res.status(200).json({ success: true, message: "Note added successfully", data: updatedBooking.additionalNotes });
  } catch (error) {
    console.error("Add Note Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function getNotesFromBooking(req, res) {
  try {
    const { bookingId } = req.params;

    if (!bookingId) {
      return res.status(400).json({ success: false, message: "Booking ID is required" });
    }

    const bookingData = await booking.findById(bookingId, "additionalNotes");

    if (!bookingData) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    res.status(200).json({ success: true, data: bookingData.additionalNotes });
  } catch (error) {
    console.error("Get Notes Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function updateNoteInBooking(req, res) {
  try {
    const { bookingId, noteIndex, newNote } = req.body;

    if (!bookingId || noteIndex === undefined || !newNote) {
      return res.status(400).json({ success: false, message: "Booking ID, note index, and new note are required" });
    }

    const updatedBooking = await booking.findById(bookingId);

    if (!updatedBooking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (noteIndex < 0 || noteIndex >= updatedBooking.additionalNotes.length) {
      return res.status(400).json({ success: false, message: "Invalid note index" });
    }

    updatedBooking.additionalNotes[noteIndex] = newNote;
    await updatedBooking.save();

    res.status(200).json({ success: true, message: "Note updated successfully", data: updatedBooking.additionalNotes });
  } catch (error) {
    console.error("Update Note Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

// async function deleteNoteFromBooking(req, res) {
//   try {
//     const { bookingId, noteIndex } = req.body;

//     if (!bookingId || noteIndex === undefined) {
//       return res.status(400).json({ success: false, message: "Booking ID and note index are required" });
//     }

//     const updatedBooking = await booking.findById(bookingId);

//     if (!updatedBooking) {
//       return res.status(404).json({ success: false, message: "Booking not found" });
//     }

//     if (noteIndex < 0 || noteIndex >= updatedBooking.additionalNotes.length) {
//       return res.status(400).json({ success: false, message: "Invalid note index" });
//     }

//     updatedBooking.additionalNotes.splice(noteIndex, 1);
//     await updatedBooking.save();

//     res.status(200).json({ success: true, message: "Note deleted successfully", data: updatedBooking.additionalNotes });
//   } catch (error) {
//     console.error("Delete Note Error:", error);
//     res.status(500).json({ success: false, message: "Internal Server Error" });
//   }
// }

// By Prashant 

// Drop-in replacement: same signature, no schema changes required.
async function deleteNoteFromBooking(req, res) {
  try {
    const { bookingId, noteIndex } = req.body;
    console.log("Body", req.body)
    // Basic presence check
    if (!bookingId || noteIndex === undefined) {
      return res.status(400).json({
        success: false,
        message: "Booking ID and note index are required",
      });
    }

    // Coerce to integer and validate
    const idx = Number(noteIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({
        success: false,
        message: "noteIndex must be a non-negative integer",
      });
    }

    // Cheap fetch to verify existence and bounds
    const doc = await booking.findById(bookingId).select("additionalNotes");
    if (!doc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (!Array.isArray(doc.additionalNotes) || idx >= doc.additionalNotes.length) {
      return res.status(400).json({ success: false, message: "Invalid note index" });
    }

    // 1) Unset the element at the index (atomic)
    const unsetPath = `additionalNotes.${idx}`;
    await booking.updateOne(
      { _id: bookingId },
      { $unset: { [unsetPath]: 1 } }
    );

    // 2) Remove the created null hole
    const updated = await booking.findByIdAndUpdate(
      bookingId,
      { $pull: { additionalNotes: null } },
      { new: true, select: "additionalNotes" }
    );

    return res.status(200).json({
      success: true,
      message: "Note deleted successfully",
      data: updated?.additionalNotes ?? [],
    });
  } catch (error) {
    console.error("Delete Note Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

async function getallbookings(req, res) {
  try {
    // Directly fetch bookings without auth
    const bookingresponce = await booking
      .find(req.query)
      .populate({
        path: "services",
        model: "AdminService",
        populate: {
          path: "base_service_id",
          model: "BaseService",
          select: "name description image",
        },
      })
      .populate("dealer_id") // Fetch dealer details
      .populate("pickupAndDropId") // Fetch pickup & drop details
      .populate("user_id") // Fetch user details
      .populate({
        path: "userBike_id", // Fetch bike details
        populate: {
          path: "variant_id",
          model: "BikeVariant",
          select: "variant_name engine_cc model_id",
          populate: {
            path: "model_id",
            model: "BikeModel",
            select: "model_name company_id",
            populate: {
              path: "company_id",
              model: "BikeCompany",
              select: "name",
            },
          },
        },
      })
      .sort({ "_id": -1 });

    if (bookingresponce.length > 0) {
      const data = bookingresponce.map((doc) => {
        const item = doc.toObject({ virtuals: true });
        const userBike = item.userBike_id;
        const variant = userBike?.variant_id;
        const model = variant?.model_id;
        const company = model?.company_id;

        // Resolve real catalog names via variant_id chain; userBike_id.name/model
        // may hold stale free-text (or, for older records, raw ObjectIds) so they
        // are not used when the catalog chain is available.
        item.bike = {
          company_name: company?.name ?? null,
          model_name: model?.model_name ?? null,
          variant_name: variant?.variant_name ?? null,
          engine_cc: variant?.engine_cc ?? null,
          plate_number: userBike?.plate_number ?? null,
        };

        return item;
      });

      return res.status(200).json({
        status: 200,
        message: "Successfully retrieved bookings",
        data,
        image_base_url: process.env.BASE_URL,
      });
    } else {
      return res.status(200).json({
        status: 200,
        message: "No bookings found",
        data: [],
      });
    }
  } catch (error) {
    console.error("Error fetching bookings:", error);
    return res.status(500).json({
      status: 500,
      message: "Internal Server Error",
    });
  }
}

// Cancel Booking - authenticated customers can cancel their own pending request.
// The status predicate is repeated in the atomic update to prevent an accept /
// cancel race from cancelling a booking after a dealer has confirmed it.
async function cancelBooking(req, res) {
  try {
    const { bookingId } = req.params;
    const cancellationReason = resolveCancellationReason(req.body?.reasonCode);

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required"
      });
    }

    if (!cancellationReason) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CANCELLATION_REASON",
        message: "Please select a valid cancellation reason",
      });
    }

    const bookingData = await booking.findOne({ _id: bookingId, user_id: req.user_id });
    if (!bookingData) {
      return res.status(404).json({
        success: false,
        message: "Booking not found"
      });
    }

    // Retried requests are idempotent. Do not refund or notify twice.
    if (["user_cancelled", "cancelled"].includes(bookingData.status)) {
      return res.status(200).json({
        success: true,
        message: "Booking is already cancelled",
        data: bookingData,
      });
    }

    if (!canCustomerCancel(bookingData.status, bookingData.dealerResponseStatus)) {
      return res.status(409).json({
        success: false,
        code: "CANCELLATION_NOT_ALLOWED",
        message: "This booking can no longer be cancelled because the service center has already responded.",
      });
    }

    const updatedBooking = await booking.findOneAndUpdate(
      {
        _id: bookingId,
        user_id: req.user_id,
        status: "pending",
        dealerResponseStatus: { $ne: "expired" },
      },
      {
        $set: {
          status: "user_cancelled",
          cancellationReasonCode: cancellationReason.code,
          cancellationReason: cancellationReason.label,
          cancelledAt: new Date(),
          cancelledBy: req.user_id,
        },
      },
      { new: true }
    );

    if (!updatedBooking) {
      return res.status(409).json({
        success: false,
        code: "BOOKING_STATE_CHANGED",
        message: "Booking status changed before it could be cancelled. Please refresh and try again.",
      });
    }

    try {
      await refundBookingMoney(updatedBooking);
    } catch (refundError) {
      console.error("[MR-BIKE-MONEY] Cancellation refund failed:", refundError.message);
    }

    try {
      await Tracking.updateOne(
        { booking_id: bookingId },
        { $set: { status: "cancelled", updatedAt: new Date() } }
      );
    } catch (trackingError) {
      console.error("Cancellation tracking update failed:", trackingError.message);
    }

    const io = req.app.get("io");
    if (io) {
      const payload = {
        bookingId: String(updatedBooking._id),
        status: updatedBooking.status,
        cancellationReasonCode: cancellationReason.code,
      };
      io.to(`booking:${bookingId}`).emit("booking:cancelled", payload);
      io.to(`dealer:${updatedBooking.dealer_id}`).emit("booking:cancelled", payload);
    }

    // The cancellation is already committed; notification failures must not
    // turn a successful cancellation into an API error.
    try {
      const dealer = await Vendor.findById(updatedBooking.dealer_id)
        .select("device_token ftoken")
        .lean();
      await sendBookingNotification({
        token: dealer?.device_token || dealer?.ftoken,
        title: "Booking Cancelled",
        body: `The customer cancelled the booking: ${cancellationReason.label}.`,
        data: {type: "booking_cancelled", bookingId: String(updatedBooking._id)},
        receiverId: updatedBooking.dealer_id,
        receiverType: "dealer",
        bookingId: updatedBooking._id,
      });
    } catch (notifyError) {
      console.error("Cancellation notification failed:", notifyError.message);
    }

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
      data: updatedBooking
    });

  } catch (error) {
    console.error("Error cancelling booking:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
}

async function getBookingTimerStatus(req, res) {
  try {
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID" });
    }

    // Scoped to whichever participant is authenticated (requireBookingParticipant
    // already verified this actor owns/participates in this booking).
    const ownerFilter =
      req.auth?.role === "dealer" ? { _id: bookingId, dealer_id: req.user_id } :
      req.auth?.role === "admin" ? { _id: bookingId } :
      { _id: bookingId, user_id: req.user_id };
    const bookingData = await booking
      .findOne(ownerFilter)
      .select("_id bookingId status dealerResponseStatus timerExpiresAt")
      .lean();

    if (!bookingData) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const now = new Date();

    // secondsRemaining is 0 for any terminal dealer-response state
    const isTerminal =
      !bookingData.timerExpiresAt ||
      bookingData.status === "expired" ||
      bookingData.dealerResponseStatus === "accepted" ||
      bookingData.dealerResponseStatus === "rejected" ||
      bookingData.dealerResponseStatus === "expired";

    const secondsRemaining = isTerminal
      ? 0
      : Math.max(0, Math.floor((new Date(bookingData.timerExpiresAt) - now) / 1000));

    return res.status(200).json({
      success: true,
      bookingId: bookingData._id,
      status: bookingData.status,
      dealerResponseStatus: bookingData.dealerResponseStatus,
      timerExpiresAt: bookingData.timerExpiresAt,
      secondsRemaining,
    });
  } catch (error) {
    console.error("getBookingTimerStatus error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE COMPLETE → PAYMENT → DELIVERY OTP FLOW
// ─────────────────────────────────────────────────────────────────────────────

// 1. Dealer marks service as complete
// POST /bookings/:bookingId/service-complete  { user_id }
const serviceComplete = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const user_id = req.auth?.id;

    if (!bookingId || !user_id) {
      return res.status(400).json({
        success: false,
        message: "bookingId (param) and user_id (body) are required",
      });
    }

    const bookingDoc = await booking.findById(bookingId);
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (bookingDoc.dealer_id.toString() !== user_id) {
      return res.status(403).json({
        success: false,
        message: "Only the assigned dealer can mark service as complete",
      });
    }

    if (bookingDoc.status !== "confirmed") {
      return res.status(400).json({
        success: false,
        message: `Cannot mark service complete. Current status: ${bookingDoc.status}. Expected: confirmed`,
      });
    }

    if (isPickupBooking(bookingDoc) && bookingDoc.pickupStatus !== PICKUP_STATUSES.BIKE_PICKED_UP) {
      return res.status(409).json({
        success: false,
        message: "Bike pickup must be completed before the service can be marked complete",
      });
    }

    bookingDoc.status = "awaiting_payment";
    await bookingDoc.save();

    console.log(`[SERVICE-COMPLETE] Booking ${bookingId} → awaiting_payment`);

    // Push notification to user
    try {
      const user = await Customer.findById(bookingDoc.user_id)
        .select("device_token ftoken")
        .lean();
      const userToken = user?.device_token || user?.ftoken;
      if (userToken) {
        await sendBookingNotification({
          token: userToken,
          title: "Service Completed",
          body: "Your bike service has been completed. Please select a payment method.",
          data: { type: "service_completed", bookingId: bookingId.toString() },
          receiverId: bookingDoc.user_id,
          receiverType: "user",
          bookingId: bookingDoc._id,
        });
      }
    } catch (notifyErr) {
      console.error("[SERVICE-COMPLETE] FCM error:", notifyErr.message);
    }

    // Socket emit to user room
    const io = req.app.get("io");
    if (io) {
      io.to(`user:${bookingDoc.user_id}`).emit("booking:service_complete", {
        bookingId,
        status: "awaiting_payment",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service marked complete. User notified to select payment method.",
      data: { bookingId, status: "awaiting_payment" },
    });
  } catch (error) {
    console.error("[SERVICE-COMPLETE] Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// 2. Dealer selects ONLINE (QR) or CASH payment method on the customer's behalf
// POST /bookings/:bookingId/select-payment-method  { user_id, payment_method }
// NOTE: `user_id` here is the dealer's id (kept for backward compatibility with
// sibling endpoints in this flow, e.g. serviceComplete/confirmCashReceived, which
// already use `user_id` in the body to mean "the acting dealer").
const selectPaymentMethod = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { payment_method } = req.body;
    const user_id = req.auth?.id;

    if (!bookingId || !user_id || !payment_method) {
      return res.status(400).json({
        success: false,
        message: "bookingId (param), user_id and payment_method are required",
      });
    }

    if (!["ONLINE", "CASH"].includes(payment_method)) {
      return res.status(400).json({
        success: false,
        message: "payment_method must be 'ONLINE' or 'CASH'",
      });
    }

    const bookingDoc = await booking.findById(bookingId);
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // Dealer-only guard — the user app must not initiate payment anymore
    if (bookingDoc.dealer_id.toString() !== user_id) {
      return res.status(403).json({
        success: false,
        message: "Only the assigned dealer can select a payment method",
      });
    }

    // Status guard — the dealer may (re)select a payment method for as long as
    // the booking is still in the payment-collection stage. This allows e.g.
    // switching ONLINE → CASH after a QR was generated but never paid. Once
    // payment actually completes, the booking moves past both of these
    // statuses (see payment_status guard below and confirmCashReceived /
    // advanceBookingAfterOnlinePayment), so this list also implicitly blocks
    // changes after payment_success/ready_for_delivery/delivered/cancelled.
    const PAYMENT_METHOD_SELECTABLE_STATUSES = ["awaiting_payment", "payment_selected"];
    if (!PAYMENT_METHOD_SELECTABLE_STATUSES.includes(bookingDoc.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot select payment method. Current status: ${bookingDoc.status}. Expected one of: ${PAYMENT_METHOD_SELECTABLE_STATUSES.join(", ")}`,
      });
    }

    // Payment-completed guard — once payment has actually succeeded, the
    // method can never be changed, even if the status guard above were ever
    // loosened further.
    if (bookingDoc.payment_status === "completed") {
      return res.status(409).json({
        success: false,
        message: "Payment has already been completed. Payment method cannot be changed.",
      });
    }

    // Cancel any pending Cashfree session left over from a previous method
    // choice (e.g. dealer switched ONLINE → CASH after a QR was shown) so a
    // stale, abandoned order can never be paid later and mistaken by the
    // webhook for the customer's current session.
    await cancelPendingPaymentSessions(bookingDoc._id);

    bookingDoc.payment_method = payment_method;
    bookingDoc.status = "payment_selected";
    await bookingDoc.save();

    console.log(`[SELECT-PAYMENT] Booking ${bookingId} → payment_selected (${payment_method})`);

    const io = req.app.get("io");

    // ── ONLINE (QR) PATH ───────────────────────────────────────────────────────
    // QR generation itself is handled by the existing Cashfree UPI-QR flow
    // (POST /cashfree/generate-qr), which already lands on the same
    // invoice + wallet-settlement + delivery-OTP outcome as confirmCashReceived
    // once payment succeeds. We only flip the booking into payment_selected
    // (done above) and point the dealer at that endpoint — no second/duplicate
    // Cashfree order integration here.
    if (payment_method === "ONLINE") {
      try {
        const dealer = await Vendor.findById(bookingDoc.dealer_id)
          .select("device_token ftoken")
          .lean();
        const dealerToken = dealer?.device_token || dealer?.ftoken;
        if (dealerToken) {
          await sendBookingNotification({
            token: dealerToken,
            title: "Generate Payment QR",
            body: "Online payment selected. Generate a QR for the customer to scan and pay.",
            data: {
              type: "online_payment_selected",
              bookingId: bookingId.toString(),
            },
            receiverId: bookingDoc.dealer_id,
            receiverType: "dealer",
            bookingId: bookingDoc._id,
          });
        }
      } catch (notifyErr) {
        console.error("[SELECT-PAYMENT] Dealer FCM error:", notifyErr.message);
      }

      if (io) {
        io.to(`dealer:${bookingDoc.dealer_id}`).emit("booking:online_payment_selected", {
          bookingId,
          status: "payment_selected",
          payment_method: "ONLINE",
        });
      }

      return res.status(200).json({
        success: true,
        payment_method: "ONLINE",
        message: "Online payment selected. Generate a QR via /cashfree/generate-qr to collect payment.",
        data: {
          bookingId,
          status: "payment_selected",
          amount: bookingDoc.totalBill,
          next_step: {
            method: "POST",
            path: "/bikedoctor/cashfree/generate-qr",
            body: { booking_id: bookingId, amount: bookingDoc.totalBill },
          },
        },
      });
    }

    // ── CASH PATH ──────────────────────────────────────────────────────────────
    try {
      const dealer = await Vendor.findById(bookingDoc.dealer_id)
        .select("device_token ftoken")
        .lean();
      const dealerToken = dealer?.device_token || dealer?.ftoken;
      if (dealerToken) {
        await sendBookingNotification({
          token: dealerToken,
          title: "Cash Payment Expected",
          body: "Customer will pay cash at pickup. Please confirm when cash is received.",
          data: {
            type: "cash_payment_selected",
            bookingId: bookingId.toString(),
          },
          receiverId: bookingDoc.dealer_id,
          receiverType: "dealer",
          bookingId: bookingDoc._id,
        });
      }
    } catch (notifyErr) {
      console.error("[SELECT-PAYMENT] Dealer FCM error:", notifyErr.message);
    }

    if (io) {
      io.to(`dealer:${bookingDoc.dealer_id}`).emit("booking:cash_payment_selected", {
        bookingId,
        status: "payment_selected",
        payment_method: "CASH",
      });
    }

    return res.status(200).json({
      success: true,
      payment_method: "CASH",
      message: "Cash payment selected. Dealer has been notified.",
      data: { bookingId, status: "payment_selected" },
    });
  } catch (error) {
    console.error("[SELECT-PAYMENT] Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// 3. Dealer confirms cash received from customer
// POST /bookings/:bookingId/confirm-cash-received  { user_id }
const confirmCashReceived = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { user_id } = req.body;

    if (!bookingId || !user_id) {
      return res.status(400).json({
        success: false,
        message: "bookingId (param) and user_id (body) are required",
      });
    }

    const bookingDoc = await booking.findById(bookingId);
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // Dealer-only guard
    if (bookingDoc.dealer_id.toString() !== user_id) {
      return res.status(403).json({
        success: false,
        message: "Only the assigned dealer can confirm cash receipt",
      });
    }

    // Payment method guard — select-payment-method is always the entry point,
    // so payment_method must already be "CASH" by the time this is called.
    if (bookingDoc.payment_method !== "CASH") {
      return res.status(400).json({
        success: false,
        message: `This endpoint is for CASH payments only. Current payment_method: ${bookingDoc.payment_method}`,
      });
    }

    // Status guard
    if (bookingDoc.status !== "payment_selected") {
      return res.status(400).json({
        success: false,
        message: `Cannot confirm cash. Current status: ${bookingDoc.status}. Expected: payment_selected`,
      });
    }

    const freshOtp = genOtp();

    bookingDoc.payment_status   = "completed";
    bookingDoc.payment_verified = true;
    bookingDoc.deliveryOtp      = freshOtp;
    bookingDoc.status           = "ready_for_delivery";
    bookingDoc.billStatus       = "paid";
    await bookingDoc.save();

    console.log(`[CASH-CONFIRM] Booking ${bookingId} → ready_for_delivery | OTP: ${freshOtp}`);

    // Bill generation — reuse existing generateBill
    try {
      await generateBill({
        booking_id: bookingDoc._id,
        payment_method: "CASH",
        transaction_id: null,
        _id: null,
      });
    } catch (billErr) {
      console.error("[CASH-CONFIRM] Bill generation failed:", billErr.message);
    }

    // Wallet settlement — reuse existing settleBookingWallet
    try {
      const settlement = await settleBookingWallet(bookingDoc._id, "CASH");
      if (settlement) {
        console.log(`[CASH-CONFIRM] Wallet settled: ₹${settlement.txnAmount} debited (commission ${settlement.commissionRate}%)`);
      } else {
        console.log(`[CASH-CONFIRM] Wallet already settled for booking: ${bookingId}`);
      }
    } catch (settlErr) {
      console.error("[CASH-CONFIRM] Wallet settlement failed:", settlErr.message);
    }

    // Push OTP to user — OTP is in data payload only, NOT in notification body
    try {
      const user = await Customer.findById(bookingDoc.user_id)
        .select("device_token ftoken")
        .lean();
      const userToken = user?.device_token || user?.ftoken;
      if (userToken) {
        await sendBookingNotification({
          token: userToken,
          title: "Cash Confirmed — Show OTP to Dealer",
          body: "Cash payment confirmed. Show the OTP to the dealer to collect your bike.",
          data: {
            type: "otp_ready",
            bookingId: bookingId.toString(),
            otp: String(freshOtp),
          },
          receiverId: bookingDoc.user_id,
          receiverType: "user",
          bookingId: bookingDoc._id,
        });
      }
    } catch (notifyErr) {
      console.error("[CASH-CONFIRM] User FCM error:", notifyErr.message);
    }

    // Socket emit to user room
    const io = req.app.get("io");
    if (io) {
      io.to(`user:${bookingDoc.user_id}`).emit("booking:ready_for_delivery", {
        bookingId,
        status: "ready_for_delivery",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Cash confirmed. Delivery OTP sent to customer.",
      data: { bookingId, status: "ready_for_delivery" },
    });
  } catch (error) {
    console.error("[CASH-CONFIRM] Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// 4. Dealer verifies the handover OTP shown by the customer
// POST /bookings/verify-delivery-otp  { bookingId, otp, user_id }
const verifyDeliveryOtp = async (req, res) => {
  try {
    const { bookingId, otp } = req.body;
    const user_id = req.auth.id;

    if (!bookingId || !otp || !user_id) {
      return res.status(400).json({
        success: false,
        message: "bookingId, otp and user_id are required",
      });
    }

    const incoming = String(otp).trim();
    if (!/^\d{4}$/.test(incoming)) {
      return res.status(400).json({ success: false, message: "OTP must be exactly 4 digits" });
    }

    const bookingDoc = await booking.findById(bookingId);
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // Dealer-only guard
    if (bookingDoc.dealer_id.toString() !== user_id) {
      return res.status(403).json({
        success: false,
        message: "Only the assigned dealer can verify the handover OTP",
      });
    }

    // Status guard
    if (bookingDoc.status !== "ready_for_delivery") {
      return res.status(400).json({
        success: false,
        message: `Cannot verify delivery OTP. Current status: ${bookingDoc.status}. Expected: ready_for_delivery`,
      });
    }

    // Lockout guard — checked before touching DB again
    if (bookingDoc.otp_failed_attempts >= 5) {
      return res.status(423).json({
        success: false,
        message: "OTP verification locked after 5 failed attempts. Please contact support.",
        locked: true,
      });
    }

    // OTP presence guard
    if (bookingDoc.deliveryOtp == null) {
      return res.status(409).json({
        success: false,
        message: "Delivery OTP not present or already used.",
      });
    }

    const storedOtp = String(bookingDoc.deliveryOtp).trim();

    // ── OTP MISMATCH ───────────────────────────────────────────────────────────
    if (incoming !== storedOtp) {
      bookingDoc.otp_failed_attempts += 1;
      await bookingDoc.save();
      const remaining = 5 - bookingDoc.otp_failed_attempts;
      return res.status(401).json({
        success: false,
        message: `Invalid OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
        attempts_remaining: remaining,
      });
    }

    // ── OTP MATCHED — close the booking ───────────────────────────────────────
    bookingDoc.deliveryOtp          = null;
    bookingDoc.otp_verified         = true;
    bookingDoc.delivered_at         = new Date();
    bookingDoc.status               = "delivered";
    // Delivery is the final lifecycle gate. Payment and invoice guards above
    // have already succeeded before a delivery OTP can be issued/verified.
    bookingDoc.reviewStatus         = "pending";
    bookingDoc.reviewEligibleAt     = new Date();
    await bookingDoc.save();

    console.log(`[VERIFY-OTP] Booking ${bookingId} → delivered`);

    // Rewards / loyalty
    try {
      await handleBookingCompletion(bookingDoc);
    } catch (rewardErr) {
      console.error("[VERIFY-OTP] handleBookingCompletion error:", rewardErr.message);
    }

    // Push "Bike Delivered" to user
    try {
      const user = await Customer.findById(bookingDoc.user_id)
        .select("device_token ftoken")
        .lean();
      const userToken = user?.device_token || user?.ftoken;
      if (userToken) {
        await sendBookingNotification({
          token: userToken,
          title: "Bike Delivered",
          body: "Your bike has been handed over. Ride safe!",
          data: { type: "bike_delivered", bookingId: bookingId.toString() },
          receiverId: bookingDoc.user_id,
          receiverType: "user",
          bookingId: bookingDoc._id,
        });
        await sendBookingNotification({
          token: userToken,
          title: "How was your service?",
          body: "Please rate your MR Bike Doctor experience.",
          data: { type: "review_request", bookingId: bookingId.toString() },
          receiverId: bookingDoc.user_id,
          receiverType: "user",
          bookingId: bookingDoc._id,
        });
      }
    } catch (notifyErr) {
      console.error("[VERIFY-OTP] User FCM error:", notifyErr.message);
    }

    // Socket emit to user room
    const io = req.app.get("io");
    if (io) {
      io.to(`user:${bookingDoc.user_id}`).emit("booking:delivered", {
        bookingId,
        status: "delivered",
        delivered_at: bookingDoc.delivered_at,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Delivery OTP verified. Bike delivered successfully.",
      data: {
        bookingId,
        status: "delivered",
        delivered_at: bookingDoc.delivered_at,
      },
    });
  } catch (error) {
    console.error("[VERIFY-OTP] Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// 5. Dealer regenerates delivery OTP (customer didn't receive it)
// POST /bookings/:bookingId/regenerate-delivery-otp  { user_id }
const regenerateDeliveryOtp = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { user_id } = req.body;

    if (!bookingId || !user_id) {
      return res.status(400).json({
        success: false,
        message: "bookingId (param) and user_id (body) are required",
      });
    }

    const bookingDoc = await booking.findById(bookingId);
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // Dealer-only guard
    if (bookingDoc.dealer_id.toString() !== user_id) {
      return res.status(403).json({
        success: false,
        message: "Only the assigned dealer can regenerate the OTP",
      });
    }

    // Status guard
    if (bookingDoc.status !== "ready_for_delivery") {
      return res.status(400).json({
        success: false,
        message: `OTP can only be regenerated when status is ready_for_delivery. Current: ${bookingDoc.status}`,
      });
    }

    // Rate limit guard
    if (bookingDoc.otp_regen_count >= 5) {
      return res.status(429).json({
        success: false,
        message: "Maximum OTP regeneration limit (5) reached. Please contact support.",
        regens_used: 5,
        regens_remaining: 0,
      });
    }

    const freshOtp = genOtp();
    bookingDoc.deliveryOtp      = freshOtp;
    bookingDoc.otp_regen_count += 1;
    await bookingDoc.save();

    console.log(`[REGEN-OTP] Booking ${bookingId} | regen #${bookingDoc.otp_regen_count}`);

    // Push new OTP to user — in data payload only
    try {
      const user = await Customer.findById(bookingDoc.user_id)
        .select("device_token ftoken")
        .lean();
      const userToken = user?.device_token || user?.ftoken;
      if (userToken) {
        await sendBookingNotification({
          token: userToken,
          title: "New Handover OTP",
          body: "A new OTP has been generated for your bike handover.",
          data: {
            type: "otp_regenerated",
            bookingId: bookingId.toString(),
            otp: String(freshOtp),
          },
          receiverId: bookingDoc.user_id,
          receiverType: "user",
          bookingId: bookingDoc._id,
        });
      }
    } catch (notifyErr) {
      console.error("[REGEN-OTP] User FCM error:", notifyErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "New OTP sent to customer.",
      data: {
        bookingId,
        regens_used: bookingDoc.otp_regen_count,
        regens_remaining: 5 - bookingDoc.otp_regen_count,
      },
    });
  } catch (error) {
    console.error("[REGEN-OTP] Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /bikedoctor/bookings/:bookingId/towing-charge   { towingCharge }
//
// The one sanctioned way to add/revise the towing charge on an existing
// booking. Only the dealer handling the booking or an admin may call it, and
// only while the booking is still open for pricing — once the customer has
// paid or the invoice has been issued, the amount they agreed to is final.
//
// This never patches a total: it re-resolves the services and re-runs the
// FULL pricingEngine breakdown with the new towing amount, so subtotal, tax,
// customer total, commission and dealer earnings all move together and stay
// internally consistent. The customer's payable amount (Booking.amountDue,
// which every payment path charges against) follows automatically.
async function updateTowingCharge(req, res) {
  try {
    const { bookingId } = req.params;
    const { towingCharge } = req.body;

    if (towingCharge === undefined || towingCharge === null || towingCharge === "") {
      return res.status(400).json({ success: false, message: "towingCharge is required" });
    }
    const amount = Number(towingCharge);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        message: "towingCharge must be a non-negative number",
      });
    }

    // requireBookingParticipant already proved this actor belongs to the
    // booking; scope the query the same way it did.
    const ownerFilter =
      req.auth?.role === "admin"
        ? { _id: bookingId }
        : { _id: bookingId, dealer_id: req.user_id };
    const existingBooking = await booking.findOne(ownerFilter);
    if (!existingBooking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (!existingBooking.towingRequired) {
      return res.status(400).json({
        success: false,
        message: "This booking does not require towing.",
        code: "TOWING_NOT_REQUIRED",
      });
    }

    // Pricing may only move while the customer still owes the money. After
    // payment/invoice — or on a booking that is over — the agreed total is
    // what it is.
    const TERMINAL_STATUSES = ["rejected", "user_cancelled", "cancelled", "expired", "delivered"];
    const isClosedForPricing =
      existingBooking.billStatus !== "pending" ||
      existingBooking.payment_status === "completed" ||
      existingBooking.billGenerated === true ||
      TERMINAL_STATUSES.includes(existingBooking.status);

    if (isClosedForPricing) {
      return res.status(409).json({
        success: false,
        message: "Towing charge can no longer be changed — this booking is already billed, paid or closed.",
        code: "BOOKING_CLOSED_FOR_PRICING",
      });
    }

    const [dealer, bikeData, mainDocs, addlDocs] = await Promise.all([
      Vendor.findById(existingBooking.dealer_id)
        .select("tax commission pickupCharges dropCharges providesPickup providesDrop providesTowing towingCharges")
        .lean(),
      UserBike.findById(existingBooking.userBike_id)
        .select("bike_cc variant_id")
        .populate({ path: "variant_id", select: "model_id engine_cc" }),
      AdminService.find({ _id: { $in: existingBooking.services } }).select("bikes"),
      AdditionalService.find({ _id: { $in: existingBooking.additionalServices } }).select("bikes"),
    ]);

    if (!dealer) {
      return res.status(404).json({ success: false, message: "Dealer not found for this booking" });
    }

    const bikeCC = parseInt(bikeData?.variant_id?.engine_cc || bikeData?.bike_cc || 0);
    const serviceAmount = resolveServiceAmount({
      services: mainDocs,
      additionalServices: addlDocs,
      bikeCC,
      bikeContext: {
        variantId: bikeData?.variant_id?._id || bikeData?.variant_id,
        modelId: bikeData?.variant_id?.model_id,
      },
    });

    let breakdown;
    try {
      breakdown = computePriceBreakdown({
        serviceAmount,
        transportOption: existingBooking.transportOption,
        dealer,
        // Any reward/promo discount already on this booking is preserved as-is.
        discountAmount: existingBooking.discountAmount,
        bikeCondition: existingBooking.bikeCondition,
        // Replay the booking's own flag — the towing rule this booking was
        // created under is part of its frozen snapshot, exactly like the fee.
        towingRequiredOverride: existingBooking.towingRequired,
        towingChargeOverride: amount,
        // The platform fee is frozen at what the booking was created with —
        // revising towing must not re-read the admin's current setting.
        platformFeeOverride: existingBooking.platformFee,
        platformFeeLabelOverride: existingBooking.platformFeeLabel,
        commissionTaxRateOverride: existingBooking.commissionTaxRate,
      });
    } catch (pricingError) {
      if (pricingError instanceof PricingError) {
        return res.status(400).json({
          success: false,
          message: pricingError.message,
          code: pricingError.code,
        });
      }
      throw pricingError;
    }

    applyBreakdownToBooking(existingBooking, breakdown);
    existingBooking.towingChargeUpdatedAt = new Date();
    existingBooking.towingChargeUpdatedByRole = req.auth?.role === "admin" ? "admin" : "dealer";
    await existingBooking.save();

    console.log(
      `[TOWING-CHARGE] booking ${existingBooking.bookingId || existingBooking._id} set to ₹${breakdown.towingCharge} by ${existingBooking.towingChargeUpdatedByRole}`
    );

    return res.status(200).json({
      success: true,
      message: "Towing charge updated successfully",
      data: {
        bookingId: existingBooking._id,
        bikeCondition: existingBooking.bikeCondition,
        towingRequired: existingBooking.towingRequired,
        towingNote: existingBooking.towingNote,
        towingCharge: existingBooking.towingCharge,
        serviceAmount: existingBooking.serviceAmount,
        pickupCharges: existingBooking.pickupCharges,
        dropCharges: existingBooking.dropCharges,
        subtotal: existingBooking.subtotal,
        taxRate: existingBooking.taxRate,
        taxAmount: existingBooking.taxAmount,
        platformFee: existingBooking.platformFee,
        platformFeeLabel: existingBooking.platformFeeLabel,
        discountAmount: existingBooking.discountAmount,
        customerTotal: existingBooking.customerTotal,
        amountDue: existingBooking.amountDue,
        commissionRate: existingBooking.commissionRate,
        commissionAmount: existingBooking.commissionAmount,
        commissionTaxRate: existingBooking.commissionTaxRate,
        commissionTaxAmount: existingBooking.commissionTaxAmount,
        dealerEarnings: existingBooking.dealerEarnings,
      },
      pricing: breakdown,
    });
  } catch (error) {
    console.error("[updateTowingCharge] Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────


/* ======================================================================
   COMPLETION PHOTOS  —  ADMIN-INTERNAL SERVICE RECORD
   ----------------------------------------------------------------------
   Photos of the finished work, uploaded by the garage from the partner app
   before it marks the service complete. They exist so MR Bike staff can audit
   what a garage actually did; they are NOT customer-facing and must never be
   returned by a customer endpoint.

   Two things keep that true:
     1. `completionPhotos` is `select: false` on the schema, so it is absent
        from every booking query in the codebase unless a handler asks for it
        by name. Only the three handlers below do.
     2. All three sit behind requireBookingParticipant (which 404s a dealer who
        does not own the booking) AND an explicit role gate — dealer-only for
        the writes, dealer-or-admin for the read. A customer authenticated on
        their own booking is rejected by the role gate.

   Storage reuses utils/s3Upload.js#createS3Upload, the same multer-S3 factory
   behind dealer documents, review images and shop images. There is no
   pre-signed-upload infrastructure in this project, so there is nothing to
   reuse there and nothing new is introduced here.
====================================================================== */

// Shape a stored subdocument for the wire. Keeps the S3 `key` server-side:
// clients render `url` and address a photo by its `_id`, so no endpoint needs
// to accept a raw bucket key from a client.
const toCompletionPhotoResponse = (photo) => ({
  _id: photo._id,
  url: photo.url,
  mimeType: photo.mimeType || null,
  uploadedAt: photo.uploadedAt || null,
});

// Cap per booking. A completed service is a handful of photos; this stops a
// single booking's array (and the S3 folder) growing without bound.
const MAX_COMPLETION_PHOTOS = 12;

/**
 * POST /bookings/:bookingId/completion-photos   (dealer who owns the booking)
 * multipart/form-data, field name `photos` — see routes/bookingRoutes.js for
 * the multer-S3 middleware. By the time this runs the files are already in S3,
 * so all that is left is recording them on the booking.
 */
async function uploadCompletionPhotos(req, res) {
  try {
    const { bookingId } = req.params;
    const files = req.files || [];

    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No photos were uploaded. Attach at least one file as `photos`.",
      });
    }

    const bookingDoc = await booking
      .findById(bookingId)
      .select("+completionPhotos");
    if (!bookingDoc) {
      // The uploads already landed in S3 before we got here, so clean them up
      // rather than leaving orphans in the bucket.
      await Promise.all(files.map((file) => deleteS3Object(file.key || file.location)));
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const existing = bookingDoc.completionPhotos || [];
    if (existing.length + files.length > MAX_COMPLETION_PHOTOS) {
      await Promise.all(files.map((file) => deleteS3Object(file.key || file.location)));
      return res.status(400).json({
        success: false,
        message: `A booking can hold at most ${MAX_COMPLETION_PHOTOS} completion photos (${existing.length} already uploaded).`,
      });
    }

    const added = files.map((file) => ({
      url: file.location || file.path,
      key: file.key || null,
      mimeType: file.mimetype || null,
      uploadedAt: new Date(),
      uploadedBy: req.user_id,
    }));

    bookingDoc.completionPhotos = [...existing, ...added];
    await bookingDoc.save();

    console.log(
      `[COMPLETION-PHOTOS] Booking ${bookingId}: +${added.length} photo(s) by dealer ${req.user_id}`
    );

    return res.status(201).json({
      success: true,
      message: `${added.length} photo${added.length === 1 ? "" : "s"} uploaded`,
      data: bookingDoc.completionPhotos.map(toCompletionPhotoResponse),
    });
  } catch (error) {
    console.error("[COMPLETION-PHOTOS] upload error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

/**
 * GET /bookings/:bookingId/completion-photos   (owning dealer, or any admin)
 * The only read path for this field anywhere in the API.
 */
async function getCompletionPhotos(req, res) {
  try {
    const { bookingId } = req.params;

    const bookingDoc = await booking
      .findById(bookingId)
      .select("+completionPhotos")
      .lean();
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    return res.status(200).json({
      success: true,
      data: (bookingDoc.completionPhotos || []).map(toCompletionPhotoResponse),
    });
  } catch (error) {
    console.error("[COMPLETION-PHOTOS] fetch error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

/**
 * DELETE /bookings/:bookingId/completion-photos/:photoId   (owning dealer)
 * Lets a garage drop a photo it took by mistake. Admins deliberately cannot
 * delete here — this is the garage's own record of its work, and the audit
 * value of these photos depends on staff not being able to quietly remove
 * them.
 */
async function deleteCompletionPhoto(req, res) {
  try {
    const { bookingId, photoId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(photoId)) {
      return res.status(400).json({ success: false, message: "Invalid photo id" });
    }

    const bookingDoc = await booking
      .findById(bookingId)
      .select("+completionPhotos");
    if (!bookingDoc) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const photo = (bookingDoc.completionPhotos || []).find(
      (item) => String(item._id) === String(photoId)
    );
    if (!photo) {
      return res.status(404).json({ success: false, message: "Photo not found on this booking" });
    }

    bookingDoc.completionPhotos = bookingDoc.completionPhotos.filter(
      (item) => String(item._id) !== String(photoId)
    );
    await bookingDoc.save();

    // Drop the object too, the same way a replaced dealer document is cleaned
    // up. deleteS3Object logs and swallows its own errors, so a bucket hiccup
    // never fails a delete the database has already committed.
    await deleteS3Object(photo.key || photo.url);

    console.log(`[COMPLETION-PHOTOS] Booking ${bookingId}: removed photo ${photoId}`);

    return res.status(200).json({
      success: true,
      message: "Photo removed",
      data: bookingDoc.completionPhotos.map(toCompletionPhotoResponse),
    });
  } catch (error) {
    console.error("[COMPLETION-PHOTOS] delete error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

module.exports = {
  addbooking,
  getallbookings,
  getbooking,
  deletebooking,
  getuserbookings,
  updateBookings,
  createBooking,
  getBookingDetails,
  updateBooking,
  updateTowingCharge,
  updateBookingStatus,
  sendBookingOTP,
  verifyBookingOTP,
  updatePickupStatus,
  markCustomerArrived,
  addNoteToBooking,
  getNotesFromBooking,
  updateNoteInBooking,
  deleteNoteFromBooking,
  sendOtpToMobile,
  verifyOtpForMobile,
  cancelBooking,
  getBookingTimerStatus,
  serviceComplete,
  selectPaymentMethod,
  confirmCashReceived,
  verifyDeliveryOtp,
  regenerateDeliveryOtp,
  uploadCompletionPhotos,
  getCompletionPhotos,
  deleteCompletionPhoto,
}
