require("dotenv").config();
const Dealer = require("../models/dealerModel");
const Service = require("../models/service_model");
const Vendor = require("../models/dealerModel");
const jwt = require("jsonwebtoken");
var validation = require("../helper/validation");
const { getDealerStatus, isDealerBookable } = require("../helper/dealerStatus");
const { DEALER_LIST_TABS, STAGE_LABELS, getDealerStage, stageFilter } = require("../helper/dealerStage");
const Booking = require("../models/Booking");
const {
  getDealerServiceRadiusKm,
  isWithinServiceRadius,
  serviceRadiusBoundingBoxDegrees,
} = require("../helper/dealerServiceRadius");
const Rating = require("../models/rating_model");
const RatingSummary = require("../models/RatingSummary");
const Wallet = require("../models/Wallet_modal")
const Role = require('../models/Roles_modal')
const Admin = require('../models/admin_model')
const Bike = require('../models/bikeCompanyModel')
const UserBike = require("../models/userBikeModel")
const servicess = require("../models/service_model")
const AdminService = require("../models/adminService")
const {
  resolveDealerScope,
  resolveDiscoveryBikeContexts,
  matchingBikeContexts,
} = require("../v1-api/helpers/serviceEligibility");
const { sendBookingNotification } = require("../helper/pushNotification");
const { logDealerActivity } = require("../helper/dealerActivityLog");
const DealerActivityLog = require("../models/DealerActivityLog");
const fs = require("fs");
const mongoose = require('mongoose');
const { log } = require("console");
const { createWithdrawal, transitionWithdrawal } = require("../services/withdrawalService");

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in kilometers
  return distance;
}


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

// GET /bikedoctor/dealer/dealerWithInRange
//   ?userLat=&userLon=&serviceId=&bikeId=&bikeIds=&variant_id=&cc=&towingRequired=
//
// Nearby garages for the user app. Location + bookability now come from the
// shared scope resolver (v1-api/helpers/serviceEligibility.js) rather than a
// second hand-rolled copy of the same rules, so this list can never disagree
// with home/discovery or with the provider list BOOK NOW opens.
//
// Bike awareness is additive and follows the same rule as the rest of the app:
//   - bikeId / variant_id given  → BOOKING semantics, that one bike only
//   - signed-in rider, no bike   → DISCOVERY semantics, a garage stays if it
//                                  can serve AT LEAST ONE saved bike (union)
//   - anonymous, no bike         → no compatibility filter, as before
//
// The response shape (full dealer documents under `data`) is unchanged.
const dealerWithInRange = async (req, res) => {
  try {
    const { userLat, userLon, serviceId, bikeId, bikeIds, variant_id, cc, towingRequired } = req.query;

    if (!userLat || !userLon) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude are required."
      });
    }

    let scope;
    try {
      scope = await resolveDealerScope({
        lat: userLat,
        lng: userLon,
        towingRequired: towingRequired === "true" || towingRequired === "1",
        // Legacy contract: this endpoint has always returned whole dealer
        // documents, and the app reads fields well beyond the eligibility set.
        select: null,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: "Invalid latitude or longitude."
      });
    }

    let nearbyDealers = scope.dealerIds
      .map(id => scope.dealerById.get(String(id)))
      .filter(Boolean);

    // Which bikes to judge compatibility against. An explicitly selected bike
    // wins; otherwise a signed-in rider's whole garage is used, so a garage is
    // only dropped when it can serve none of their bikes.
    const { contexts: bikeContexts } = await resolveDiscoveryBikeContexts({
      userId: req.user_id || null,
      bikeId,
      bikeIds,
    });

    if (bikeContexts.length || (serviceId && variant_id)) {
      const filter = { isActive: true, dealer_id: { $in: nearbyDealers.map(d => d._id) } };
      if (serviceId) filter.$or = [{ base_service_id: serviceId }, { _id: serviceId }];
      if (bikeContexts.length) filter.companies = { $in: bikeContexts.map(ctx => ctx.companyId) };

      const rows = await AdminService.find(filter).select("dealer_id companies bikes").lean();

      const ccFilter = cc !== undefined && cc !== "" ? parseInt(cc, 10) : null;
      const eligibleDealerIds = new Set();

      rows.forEach(svc => {
        const servesASavedBike = bikeContexts.length
          ? matchingBikeContexts(svc, bikeContexts).length > 0
          : true;
        if (!servesASavedBike) return;

        // The pre-existing variant/cc narrowing, kept verbatim so clients that
        // only know the variant behave exactly as they did before.
        if (!bikeContexts.length && variant_id) {
          const hasConfiguredBike = (svc.bikes || []).some(bike => {
            if (!bike.variant_id || String(bike.variant_id) !== String(variant_id)) return false;
            if (ccFilter !== null && bike.cc !== ccFilter) return false;
            return bike.price != null && bike.price > 0;
          });
          if (!hasConfiguredBike) return;
        }

        eligibleDealerIds.add(String(svc.dealer_id));
      });

      // Honest empty result: no garage that can serve this rider's bike(s) for
      // this service means an empty list, never a fallback to other garages.
      nearbyDealers = nearbyDealers.filter(dealer => eligibleDealerIds.has(String(dealer._id)));
    }

    return res.status(200).json({
      success: true,
      data: nearbyDealers
    });

  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error."
    });
  }
};

// Helper: Calculate distance (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

const dealerWithInRange2 = async (req, res) => {
  try {
    const { userLat, userLon, variant_id } = req.query;

    if (!userLat || !userLon || !variant_id) {
      return res.status(200).json({ success: false, message: "User location (latitude & longitude) and variant_id are required!" });
    }

    console.log(`📍 Searching dealers near lat: ${userLat}, lon: ${userLon} with variant_id: ${variant_id}`);

    // Step 1: Fetch all bookable dealers, not blocked
    const dealers = (await Vendor.find({
      online: true,
      wallet: { $gt: -500 },
      isBlocked: { $ne: true },
    })).filter(isDealerBookable); // approved + active + online, not just online

    console.log(`✅ Total Dealers Found: ${dealers.length}`);

    // Step 2: Keep only dealers whose own service radius reaches this user
    // (serviceRadiusKm on the dealer, default 3 km).
    const nearbyDealers = dealers.filter((dealer) => {
      const distance = calculateDistance(
        parseFloat(userLat),
        parseFloat(userLon),
        parseFloat(dealer.latitude),
        parseFloat(dealer.longitude)
      );
      return isWithinServiceRadius(distance, dealer);
    });

    console.log(`✅ Nearby Dealers Count: ${nearbyDealers.length}`);

    // Step 3: Check if dealer's bikes array contains the given `variant_id`
    const dealersWithMatchingBikes = nearbyDealers.filter((dealer) => {
      return dealer.bikes.some((bikeId) => bikeId.toString() === variant_id);
    });

    if (dealersWithMatchingBikes.length === 0) {
      return res.status(200).json({ success: false, message: "No dealers found with this bike variant!", data: [] });
    }

    console.log("✅ Final Dealers Response:", dealersWithMatchingBikes);
    res.status(200).json({ success: true, data: dealersWithMatchingBikes });

  } catch (error) {
    console.error("❌ Error fetching nearby dealers:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

async function editDealerStatus(req, res) {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const user_id = data.user_id;
    const user_type = data.user_type;

    // const type = data.type;

    if (user_type === 3) {
      const subAdmin = await Admin.findById(user_id)

      if (!subAdmin) {
        var response = {
          status: 200,
          message: "Subadmin not found!",
        };
        return res.status(200).send(response);
      }

      if (user_type === 3) {
        const subAdmin = await Admin.findById(user_id)

        if (!subAdmin) {
          var response = {
            status: 200,
            message: "Subadmin not found!",
          };
          return res.status(200).send(response);
        }
      }

      const isAllowed = await checkPermission(user_id, "Dealers.update");

      if (!isAllowed) {
        var response = {
          status: 200,
          message: "Subadmin does not have permission to add dealers!",
        };
        return res.status(200).send(response);
      }


    }


    let { dealer_id, status, isBlock, isActive, isBlocked, blockedReason } = req.body;

    if (!dealer_id) {
      return res.status(400).json({ success: false, message: "dealer_id is required" });
    }

    // Legacy string contract: map `status` onto the canonical isActive/isBlocked
    // booleans instead of a nonexistent `is_online` field.
    if (status !== undefined) {
      if (status === "blocked" && isBlocked === undefined && isBlock === undefined) {
        isBlocked = true;
      } else if (status === "unblocked" && isBlocked === undefined && isBlock === undefined) {
        isBlocked = false;
      } else if (status === "inactive" && isActive === undefined) {
        isActive = false;
      } else if (status === "active" && isActive === undefined) {
        isActive = true;
      }
    }

    // Build update payload — support both old field names (isBlock, status) and
    // the new canonical names (isBlocked, isActive) sent by the admin panel.
    const updateData = {};

    // isActive / status.isActive  (activate / deactivate)
    if (isActive !== undefined) {
      updateData.isActive = isActive;
      updateData["status.isActive"] = isActive;
    }

    // isBlocked / blockedReason  (block / unblock)
    const blockedValue = isBlocked !== undefined ? isBlocked : (isBlock !== undefined ? isBlock : undefined);
    if (blockedValue !== undefined) {
      updateData.isBlocked = blockedValue;
    }
    if (blockedReason !== undefined) {
      updateData.blockedReason = blockedReason;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, message: "No valid status field provided" });
    }

    const dealerBefore = await Dealer.findById(dealer_id);
    if (!dealerBefore) {
      return res.status(404).json({ success: false, message: "Dealer not found" });
    }
    console.log("Dealer before update", dealerBefore);
    console.log("Update object", updateData);

    try {
      const updatedDealer = await Dealer.findByIdAndUpdate(
        dealer_id,
        { $set: updateData },
        { new: true }
      );
      console.log("Dealer after update", updatedDealer);

      const dealerToken = updatedDealer.device_token || updatedDealer.ftoken;
      if (blockedValue === true && !dealerBefore.isBlocked) {
        if (dealerToken) {
          sendBookingNotification({
            token: dealerToken,
            title: "Account Blocked",
            body: "Your dealer account has been blocked by admin.",
            data: { type: "dealer_blocked" },
            receiverId: dealer_id,
            receiverType: "dealer",
          });
        }
        logDealerActivity({
          dealerId: dealer_id,
          adminId: user_id,
          action: "Dealer Blocked",
          reason: blockedReason,
        });
      }
      if (isActive === true && !dealerBefore.isActive) {
        if (dealerToken) {
          sendBookingNotification({
            token: dealerToken,
            title: "Account Activated",
            body: "Your dealer account has been activated.",
            data: { type: "dealer_activated" },
            receiverId: dealer_id,
            receiverType: "dealer",
          });
        }
        logDealerActivity({
          dealerId: dealer_id,
          adminId: user_id,
          action: "Dealer Activated",
          reason: null,
        });
      }
      if (isActive === false && dealerBefore.isActive) {
        if (dealerToken) {
          sendBookingNotification({
            token: dealerToken,
            title: "Account Deactivated",
            body: "Your dealer account has been deactivated.",
            data: { type: "dealer_inactivated" },
            receiverId: dealer_id,
            receiverType: "dealer",
          });
        }
        logDealerActivity({
          dealerId: dealer_id,
          adminId: user_id,
          action: "Dealer Inactivated",
          reason: null,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Status updated successfully",
        data: {
          _id: updatedDealer._id,
          isActive: updatedDealer.isActive,
          status: {
            isActive: updatedDealer.status?.isActive,
            adminApproved: updatedDealer.status?.adminApproved,
          },
          isBlocked: updatedDealer.isBlocked,
          blockedReason: updatedDealer.blockedReason,
          registrationStatus: updatedDealer.registrationStatus,
          dealerStatus: getDealerStatus(updatedDealer),
        },
      });
    } catch (updateErr) {
      return res.status(500).json({ status: 201, message: updateErr.message });
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

async function getWallet(req, res) {
  try {
    let { dealer_id } = req.query;

    dealer_id = (dealer_id ?? '').toString().trim();

    const objectIdMatch = dealer_id.match(/^[Oo]bject[Ii]d\(["']?([a-fA-F0-9]{24})["']?\)$/);
    if (objectIdMatch) dealer_id = objectIdMatch[1];

    if (!dealer_id) {
      return res.status(400).json({ success: false, message: "Dealer ID is required!" });
    }
    if (!mongoose.Types.ObjectId.isValid(dealer_id)) {
      return res.status(400).json({ success: false, message: "Invalid dealer_id format!" });
    }

    const dealer = await Vendor.findById(dealer_id).select("wallet");
    if (!dealer) {
      return res.status(404).json({ success: false, message: "Dealer not found!" });
    }

    // Ratings
    const ratings = await Rating.find({ dealer_id });

    const totalRatings = ratings.length;
    const sumRatings = ratings.reduce((acc, curr) => acc + (Number(curr.rating) || 0), 0);
    const averageRating = totalRatings > 0 ? (sumRatings / totalRatings).toFixed(1) : "0.0";

    return res.status(200).json({
      success: true,
      message: "Wallet retrieved successfully!",
      data: {
        ...dealer.toObject(),
        averageRating,
        walletAmount: dealer.wallet?.amount || dealer.wallet || 0
      }
    });

  } catch (error) {
    console.error("Error in getWallet:", error);
    return res.status(500).json({ success: false, message: "Internal server error!" });
  }
}

const GetwalletInfo = async (req, res) => {
  try {
    let { id } = req.params;
    id = (id ?? "").toString().trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid dealer id" });
    }
    const dealerId = new mongoose.Types.ObjectId(id);

    // optional filters
    const {
      page = 1,
      limit = 20,
      type,                    // "Credit" | "Debit" | "Pending"
      status,                  // "ACTIVE" | "PAID" | ...
      from,                    // ISO date string
      to,                      // ISO date string
      search                   // orderId partial
    } = req.query;

    const match = { dealer_id: dealerId };
    if (type) match.Type = type;
    if (status) match.order_status = status;

    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) match.createdAt.$lte = new Date(to);
    }
    if (search) {
      match.orderId = { $regex: String(search).trim(), $options: "i" };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const perPage = Math.max(1, Math.min(100, Number(limit)));

    // ---- single aggregation: summary + paginated transactions ----
    const [agg] = await Wallet.aggregate([
      { $match: match },
      { $sort: { _id: -1 } },
      {
        $facet: {
          // transactions list (paginated)
          transactions: [
            { $skip: skip },
            { $limit: perPage },
            {
              $lookup: {
                from: "vendors",               // collection name for the Vendor model
                localField: "dealer_id",
                foreignField: "_id",
                as: "dealer"
              }
            },
            { $unwind: { path: "$dealer", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                _id: 0,
                id: "$id",
                orderId: 1,
                amount: "$Amount",
                type: "$Type",
                note: "$Note",
                totalAfterTxn: "$Total",
                status: "$order_status",
                createdAt: 1,
                dealer: { name: "$dealer.name", id: "$dealer.id" }
              }
            }
          ],
          // counts for pagination
          meta: [{ $count: "total" }],
          // summary (totals) — excludes REJECTED and rollback entries so they don't skew currentBalance
          summary: [
            { $match: { order_status: { $ne: "REJECTED" }, transaction_type: { $ne: "rollback" } } },
            {
              $group: {
                _id: null,
                credits: {
                  $sum: { $cond: [{ $eq: ["$Type", "Credit"] }, "$Amount", 0] }
                },
                debits: {
                  $sum: { $cond: [{ $eq: ["$Type", "Debit"] }, "$Amount", 0] }
                },
                pending: {
                  $sum: { $cond: [{ $eq: ["$Type", "Pending"] }, "$Amount", 0] }
                },
                count: { $sum: 1 }
              }
            },
            {
              $addFields: {
                currentBalance: { $subtract: ["$credits", "$debits"] }
              }
            },
            { $project: { _id: 0 } }
          ]
        }
      }
    ]);

    const transactions = agg?.transactions ?? [];
    const totalDocs = agg?.meta?.[0]?.total ?? 0;
    const summary = agg?.summary?.[0] ?? {
      credits: 0, debits: 0, pending: 0, count: 0, currentBalance: 0
    };

    const dealerDoc = await Vendor.findById(dealerId).select("wallet").lean();
    const walletAmount = parseFloat(dealerDoc?.wallet) || 0;
    const CREDIT_LIMIT = -500;

    return res.status(200).json({
      success: true,
      message: "Wallet information",
      data: {
        walletAmount,
        creditLimit: CREDIT_LIMIT,
        summary,
        transactions,
        pagination: {
          page: Number(page),
          limit: perPage,
          total: totalDocs,
          pages: Math.ceil(totalDocs / perPage)
        }
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

async function calculateDealerAmount(dealer, orderAmount) {
  // Commission math delegated to the pricing engine — single source of
  // truth for all monetary calculations (services/pricingEngine.js).
  const { round2 } = require("../services/pricingEngine");
  const percentageAmount = round2((Number(dealer.commission) / 100) * orderAmount);
  dealer.wallet += orderAmount - percentageAmount;
  await dealer.save();
}

const WalletAdd = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const { user_id, user_type } = data; // Extract user info from token
    const { Amount, Type, Note } = req.body;
    const dealer_id = req.params.id;

    // Validate required fields
    if (!Amount || !Type) {
      return res.status(200).json({
        status: 200,
        message: "Amount and Type are required"
      });
    }

    // Validate transaction type
    if (!['Credit', 'Debit'].includes(Type)) {
      return res.status(200).json({
        status: 200,
        message: 'Invalid transaction type. Use "Credit" or "Debit"'
      });
    }

    // Check if dealer exists
    const dealer = await Vendor.findById(dealer_id);
    if (!dealer) {
      return res.status(200).json({
        status: 200,
        message: "Dealer not found"
      });
    }

    // Authorization check
    if (user_type === 3) { // Subadmin
      const subAdmin = await Admin.findById(user_id);
      if (!subAdmin) {
        return res.status(200).json({
          status: 200,
          message: "Subadmin not found"
        });
      }

      const isAllowed = await checkPermission(user_id, "Dealers.wallet");
      if (!isAllowed) {
        return res.status(200).json({
          status: 200,
          message: "You do not have permission to perform this action"
        });
      }
    } else if (user_type === 2) { // Dealer
      if (dealer._id.toString() !== user_id) {
        return res.status(200).json({
          status: 200,
          message: "You can only manage your own wallet"
        });
      }
    } else if (user_type !== 1) { // Admin
      return res.status(200).json({
        status: 200,
        message: "Unauthorized access"
      });
    }

    // Enforce credit limit on admin debit
    if (Type === "Debit") {
      const CREDIT_LIMIT = -500;
      if ((dealer.wallet - Number(Amount)) < CREDIT_LIMIT) {
        return res.status(200).json({
          status: 200,
          message: `Insufficient balance. Wallet cannot go below the credit limit of ₹${Math.abs(CREDIT_LIMIT)}`
        });
      }
    }

    const preBalance = parseFloat(dealer.wallet) || 0;

    // Update wallet balance
    Type === "Credit"
      ? dealer.wallet = parseFloat((preBalance + Number(Amount)).toFixed(2))
      : dealer.wallet = parseFloat((preBalance - Number(Amount)).toFixed(2));

    // Create wallet transaction record
    const walletData = {
      orderId: `MANUAL-${Date.now()}`,
      dealer_id,
      Amount: Number(Amount),
      Type,
      Note: Note || `${Type} transaction`,
      Total: dealer.wallet,
      pre_balance: preBalance,
      order_status: "PENDING",
    };

    await Wallet.create(walletData);
    await dealer.save();

    return res.status(200).json({
      status: 200,
      success: true,
      message: "Transaction completed successfully",
      newBalance: dealer.wallet
    });

  } catch (error) {
    console.error("Wallet error:", error);
    return res.status(500).json({
      status: 500,
      message: "Internal server error"
    });
  }
};


async function addAmount(req, res) {
  try {
    const dealerId = req.params.id;
    const { user_id, orderAmount, booking_id, tracking_id } = req.body;

    // Convert booking_id and tracking_id to MongoDB ObjectIDs
    // const bookingIdAsObjectId = mongoose.Types.ObjectId(booking_id);
    // const trackingIdAsObjectId = mongoose.Types.ObjectId(tracking_id);

    const dealer = await Dealer.findById(dealerId);

    if (!dealer) {
      return res.status(200).json({ success: false, message: 'Dealer not found' });
    }
    if (!customer) {
      return res.status(200).json({ success: false, message: 'Customer not found' });
    }

    // Update booking status
    await booking.findOneAndUpdate({ _id: booking_id }, { status: 'Payment' });

    // Update tracking status
    await tracking.findOneAndUpdate({ _id: tracking_id }, { status: 'Payment' });

    return res.status(200).json({ success: true, message: 'Amount added successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function getShopDetails(req, res) {
  try {
    const { id } = req.params;
    const { cc, userLat, userLon } = req.query; // Get CC from query parameter
    const dealer_id = id.trim();

    if (!dealer_id) {
      return res.status(400).json({ success: false, message: "Dealer ID is required!" });
    }

    if (!mongoose.Types.ObjectId.isValid(dealer_id)) {
      return res.status(400).json({ success: false, message: "Invalid Dealer ID format!" });
    }

    // Fetch dealer details
    const dealer = await Vendor.findById(dealer_id)
      .select("id shopName shopImages shopDescription goDigital expertAdvice ourPromise latitude longitude pickupAndDropDescription pickupAndDrop address services commission pickupCharges dropCharges providesPickup providesDrop minWalletAmount ownerName phone fullAddress registrationStatus tax online isActive isBlocked status dealerStatus averageRating ratingCount serviceRadiusKm");

    if (!dealer) {
      return res.status(404).json({ success: false, message: "Dealer not found!" });
    }

    // A dealer that's gone offline, been deactivated/unapproved, or blocked
    // must not be viewable by users — even if the User App still has a
    // stale garage id from before the status changed (deep link, history, etc).
    if (!isDealerBookable(dealer)) {
      return res.status(403).json({
        success: false,
        message: "This garage is currently unavailable.",
      });
    }

    // Same rule the nearby-garage lists apply: this garage only serves users
    // inside its own radius (serviceRadiusKm, default 3 km). Enforced here too
    // so a deep link or a stale garage id can't open a shop that doesn't
    // actually serve where the user is standing. Callers that send no
    // coordinates are unchanged — there is nothing to measure against.
    const userLatitude = Number.parseFloat(userLat);
    const userLongitude = Number.parseFloat(userLon);
    const dealerLatitude = Number(dealer.latitude);
    const dealerLongitude = Number(dealer.longitude);
    const bothLocated =
      Number.isFinite(userLatitude) &&
      Number.isFinite(userLongitude) &&
      Number.isFinite(dealerLatitude) &&
      Number.isFinite(dealerLongitude);
    // A dealer with no stored coordinates can't be measured against, and
    // already never surfaces in the nearby lists — don't turn an unmeasurable
    // garage into a hard 403 here on top of that.
    if (bothLocated) {
      const distanceKm = calculateDistance(
        userLatitude,
        userLongitude,
        dealerLatitude,
        dealerLongitude
      );
      if (!isWithinServiceRadius(distanceKm, dealer)) {
        return res.status(403).json({
          success: false,
          message: "This garage does not serve your location.",
        });
      }
    }

    // Fetch AdminServices that include this dealer in their dealers array
    let adminServices = await AdminService.find({ dealers: dealer_id })
      .populate({
        path: 'base_service_id',
        select: 'name description image'
      })
      .populate({
        path: 'companies',
        select: 'name'
      })
      .populate({
        path: 'bikes.model_id',
        select: 'name'
      })
      .populate({
        path: 'bikes.variant_id',
        select: 'name'
      });

    // Filter services to only include bikes with matching CC if cc is provided
    if (cc) {
      const ccNumber = parseInt(cc); // Convert query string to number
      adminServices = adminServices.map(service => {
        const filteredBikes = service.bikes.filter(bike => bike.cc === ccNumber);
        return {
          ...service.toObject(),
          bikes: filteredBikes
        };
      }).filter(service => service.bikes.length > 0); // Remove services with no matching bikes
    }

    const summary = await RatingSummary.findOne({ entityType: "dealer", entityId: dealer_id }).select("averageRating reviewCount").lean();

    return res.status(200).json({
      success: true,
      message: "Shop details retrieved successfully!",
      data: {
        ...dealer.toObject(),
        serviceRadiusKm: getDealerServiceRadiusKm(dealer),
        services: adminServices,
        averageRating: summary?.averageRating ?? dealer.averageRating ?? 0,
        ratingCount: summary?.reviewCount ?? dealer.ratingCount ?? 0,
      }
    });

  } catch (error) {
    console.error("Error in getShopDetails:", error);
    return res.status(500).json({ success: false, message: "Internal server error!" });
  }
}

const addDealerShopDetails = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const user_id = data.user_id;
    const user_type = data.user_type;

    let dealerId;

    if (user_type === 2) {
      // If dealer, get ID from token
      dealerId = user_id;
    } else if (user_type === 1) {
      // If admin, get ID from request body
      dealerId = req.body.dealer_id;
      if (!dealerId) {
        return res.status(200).send({ status: 200, message: "Dealer ID is required!" });
      }
    } else {
      return res.status(200).send({ status: 200, message: "Unauthorized access!" });
    }

    // Find the dealer
    const dealer = await Dealer.findById(dealerId);
    if (!dealer) {
      return res.status(200).send({ status: 200, message: "Dealer not found!" });
    }

    // Build update object with allowed fields from body
    let updateData = {};

    const allowedFields = [
      "shopName",
      "shopDescription",
      "shopPinCode",
      "shopCity",
      "shopState",
      "shopPhone",
      "businessEmail"
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (req.files?.shopImages) {
      const newImages = req.files.shopImages.map(file => file.location);
      updateData.shopImages = dealer.shopImages
        ? [...dealer.shopImages, ...newImages]
        : newImages;
    }

    // Set shop detail flag
    updateData.isShopDetailsAdded = true;

    // Save update
    const updatedDealer = await Dealer.findByIdAndUpdate(
      dealerId,
      { $set: updateData },
      { new: true }
    );

    return res.status(200).send({
      status: 200,
      success: true,
      message: "Shop details updated successfully",
      shopAdded: true,
      data: updatedDealer
    });

  } catch (error) {
    console.error("Error updating shop details:", error);
    return res.status(500).send({
      status: 500,
      message: "Internal server error",
      shopAdded: false,
    });
  }
};

const addDealerDocuments = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const user_id = data.user_id;
    const user_type = data.user_type;

    let dealerId;

    if (user_type === 2) {
      // If dealer, get ID from token
      dealerId = user_id;
    } else if (user_type === 1) {
      // If admin, get ID from request body
      dealerId = req.body.dealer_id;
      if (!dealerId) {
        return res.status(200).send({ status: 200, message: "Dealer ID is required!" });
      }
    } else {
      return res.status(200).send({ status: 200, message: "Unauthorized access!" });
    }

    // Find the dealer
    const dealer = await Dealer.findById(dealerId);
    if (!dealer) {
      return res.status(200).send({ status: 200, message: "Dealer not found!" });
    }

    // ✅ Debugging: Check if files are received
    console.log("Uploaded Files:", req.files);

    // Prepare update object
    let updateData = {};

    // ✅ Handle Aadhar & PAN Card Image Uploads
    if (req.files?.adharCardFront) updateData.adharCardFront = req.files.adharCardFront[0].location;
    if (req.files?.adharCardBack) updateData.adharCardBack = req.files.adharCardBack[0].location;
    if (req.files?.panCardFront) updateData.panCardFront = req.files.panCardFront[0].location;
    if (req.files?.panCardBack) updateData.panCardBack = req.files.panCardBack[0].location;

    // ✅ Set confirmation flag
    updateData.isDocumentsAdded = true;

    // ✅ Update dealer document
    const updatedDealer = await Dealer.findByIdAndUpdate(dealerId, { $set: updateData }, { new: true });

    console.log("Updated Dealer Documents:", updatedDealer);

    return res.status(200).send({
      status: 200,
      success: true,
      message: "Dealer documents uploaded successfully",
      documentsAdded: true,
    });

  } catch (error) {
    console.error("Error uploading dealer documents:", error);
    return res.status(500).send({
      status: 500,
      message: "Internal server error",
      documentsAdded: false,
    });
  }
};

const getPendingWallets = async (req, res) => {
  console.log('getPendingWallets called');
  try {
    const data = await Wallet.find({
      order_status: 'PENDING',
      Type: { $nin: ['Credit', 'Pending'] }
    })
      .sort({ createdAt: -1 })
      .populate('dealer_id');

    console.log('pending wallets count', data.length);

    return res.status(200).json({
      status: true,
      message: "Filtered pending wallet entries retrieved successfully",
      data
    });
  } catch (error) {
    console.error("Error fetching pending wallets:", error);
    console.error(error.stack);
    return res.status(500).json({
      status: false,
      message: error.message || "Internal server error"
    });
  }
};

const updateWalletStatus = async (req, res) => {
  try {
    const { wallet_id } = req.params;
    const { new_status, payout_reference } = req.body;

    if (!wallet_id || !new_status) {
      return res.status(400).json({ status: false, message: "wallet_id and new_status are required" });
    }

    const updatedWallet = await transitionWithdrawal({
      walletId: wallet_id,
      nextStatus: new_status,
      payoutReference: payout_reference,
    });

    return res.status(200).json({
      status: true,
      message: "Wallet status updated successfully",
      data: updatedWallet
    });

  } catch (error) {
    console.error("Error updating wallet status:", error);
    return res.status(400).json({
      status: false,
      message: "Internal server error"
    });
  }
};

const getAllDealersWithDocFalse = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const user_type = data.user_type;
    if (user_type === 1) {
      const allDealers = await Dealer.find({ isDoc: false });
      if (!allDealers) {
        return res.status(404).json({
          success: false,
          message: "No Dealer found in the collection."
        })
      }
      return res.status(200).json({
        succcess: true,
        message: "Dealers list fetched successfully",
        data: allDealers
      })
    }
    else {
      return res.status(403).json({
        success: false,
        message: "Unauthorised access!"
      })
    }
  }
  catch (err) {
    console.error("Error fetching Dealers details:", err);
    return res.status(500).json({
      status: false,
      message: "Internal server error"
    });
  }
}

const getAllDealersWithVerifyFalse = async (req, res) => {
  try {
    const allDealers = await Dealer.find({ isVerify: false });

    if (!allDealers || allDealers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No Dealer found in the collection."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Dealers list fetched successfully",
      data: allDealers
    });

  } catch (err) {
    console.error("Error fetching Dealers details:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

const updateDealerDocStatus = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const user_type = data.user_type;
    const { id } = req.body;
    if (user_type === 1) {
      const dealerDetails = await Dealer.findByIdAndUpdate(id, { isDoc: true }, { new: true, runValidators: true });
      if (!dealerDetails) {
        return res.status(404).json({
          success: false,
          message: "No Dealer found in the collection."
        })
      }
      return res.status(200).json({
        succcess: true,
        message: "Dealer Doc status updated successfully",
        data: dealerDetails
      })
    }
    else {
      return res.status(403).json({
        success: false,
        message: "Unauthorised access!"
      })
    }
  }
  catch (err) {
    console.error("Error updating dealers details:", err);
    return res.status(500).json({
      status: false,
      message: "Internal server error"
    });
  }
}

const updateDealerVerfication = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const user_type = data.user_type;
    const { id } = req.body;
    if (user_type === 1) {
      const dealerDetails = await Dealer.findByIdAndUpdate(id, { isVerify: true }, { new: true, runValidators: true });
      if (!dealerDetails) {
        return res.status(404).json({
          success: false,
          message: "No Dealer found in the collection."
        })
      }
      return res.status(200).json({
        succcess: true,
        message: "Dealer Doc status updated successfully",
        data: dealerDetails
      })
    }
    else {
      return res.status(403).json({
        success: false,
        message: "Unauthorised access!"
      })
    }
  }
  catch (err) {
    console.error("Error updating dealers details:", err);
    return res.status(500).json({
      status: false,
      message: "Internal server error"
    });
  }
}

// By prashant 
async function dealerList(req, res) {
  try {
    // No filter by default — the admin dealer list must show every dealer
    // (including inactive/blocked ones), otherwise a dealer deactivated via
    // POST /update_status vanishes from the list and can never be
    // reactivated. Filtering is opt-in via query params for any consumer
    // that does need a narrowed set (e.g. status=active).
    const filter = {};
    const { adminApproved, isActive, isVerified, isBlocked } = req.query;
    if (adminApproved !== undefined) filter["status.adminApproved"] = adminApproved === "true";
    if (isActive !== undefined) filter["status.isActive"] = isActive === "true";
    if (isVerified !== undefined) filter["status.isVerified"] = isVerified === "true";
    if (isBlocked !== undefined) filter.isBlocked = isBlocked === "true";

    const dealerResponse = await Vendor.find(filter);

    if (dealerResponse.length > 0) {
      return res.status(200).send({
        status: 200,
        message: "Success",
        data: dealerResponse,
      });
    } else {
      return res.status(200).send({
        status: 200,
        message: "No Dealers Found",
        data: [],
      });
    }
  } catch (error) {
    console.error("Dealer list error:", error);
    return res.status(500).send({
      status: 500,
      message: "Operation was not successful",
    });
  }
}

// Fields the admin dealer list renders. Excludes OTP, session and sensitive
// credentials so a list page never ships passwords or auth tokens.
const ADMIN_DEALER_LIST_FIELDS = [
  "id", "shopName", "ownerName", "phone", "email", "shopEmail", "personalEmail",
  "shopContact", "city", "state", "permanentAddress.city", "permanentAddress.state",
  "providesPickup", "providesDrop", "registrationStatus", "dealerStatus",
  "isActive", "isBlocked", "status", "submittedAt", "approvedAt",
  "reVerification", "formProgress", "documentVerification", "minWalletAmount",
  "commission", "tax", "serviceRadiusKm", "services", "createdAt", "updatedAt", "online",
].join(" ");

const ADMIN_DEALER_SORT_FIELDS = ["createdAt", "updatedAt", "submittedAt", "approvedAt", "shopName", "ownerName", "city"];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * GET /bikedoctor/dealer/admin/dealers
 * Admin dealer list — all filtering, search, sorting, pagination and tab
 * counts happen here so the panel only renders what it gets back.
 *
 * Query: stage (all|new|waiting_review|reverification|approved|active|
 *        inactive|rejected|blocked), search, page (1-based), limit (≤100),
 *        sortBy, order (asc|desc).
 */
async function adminDealerList(req, res) {
  try {
    const stage = String(req.query.stage || "all");
    const baseFilter = stageFilter(stage);
    if (!baseFilter) {
      return res.status(400).json({
        status: false,
        message: `Invalid stage. Allowed: ${DEALER_LIST_TABS.join(", ")}`,
      });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const sortBy = ADMIN_DEALER_SORT_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
    const order = req.query.order === "asc" ? 1 : -1;

    // Search narrows every tab (and its count) the same way.
    const search = String(req.query.search || "").trim().slice(0, 100);
    let searchFilter = {};
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      const or = [
        { shopName: rx }, { ownerName: rx }, { phone: rx }, { shopContact: rx },
        { email: rx }, { shopEmail: rx }, { personalEmail: rx },
        { city: rx }, { "permanentAddress.city": rx },
      ];
      // "MRBD0012" / "12" → the auto-increment dealer id.
      const idMatch = search.match(/^(?:mrbd)?0*(\d+)$/i);
      if (idMatch) or.push({ id: Number(idMatch[1]) });
      searchFilter = { $or: or };
    }

    const listFilter = search ? { $and: [baseFilter, searchFilter] } : baseFilter;
    const countFor = (tab) => {
      const f = stageFilter(tab);
      return Vendor.countDocuments(search ? { $and: [f, searchFilter] } : f);
    };

    const [dealers, total, countValues] = await Promise.all([
      Vendor.find(listFilter)
        .select(ADMIN_DEALER_LIST_FIELDS)
        .sort({ [sortBy]: order, _id: order })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Vendor.countDocuments(listFilter),
      Promise.all(DEALER_LIST_TABS.map(countFor)),
    ]);

    const counts = Object.fromEntries(DEALER_LIST_TABS.map((tab, i) => [tab, countValues[i]]));

    // Cancellation rate for just this page's dealers.
    const pageIds = dealers.map((d) => d._id);
    const bookingStats = pageIds.length
      ? await Booking.aggregate([
          { $match: { dealer_id: { $in: pageIds } } },
          {
            $group: {
              _id: "$dealer_id",
              total: { $sum: 1 },
              cancelled: {
                $sum: { $cond: [{ $regexMatch: { input: { $ifNull: ["$status", ""] }, regex: /cancel/i } }, 1, 0] },
              },
            },
          },
        ])
      : [];
    const statsById = new Map(bookingStats.map((s) => [String(s._id), s]));

    const data = dealers.map((dealer) => {
      const stats = statsById.get(String(dealer._id));
      const stageId = getDealerStage(dealer);
      return {
        ...dealer,
        dealerId: dealer.id ? `MRBD${String(dealer.id).padStart(4, "0")}` : null,
        stage: stageId,
        stageLabel: STAGE_LABELS[stageId],
        bookingStats: {
          total: stats?.total || 0,
          cancelled: stats?.cancelled || 0,
          cancelRate: stats?.total ? Number(((stats.cancelled / stats.total) * 100).toFixed(1)) : 0,
        },
      };
    });

    return res.status(200).json({
      status: true,
      message: "Success",
      data,
      counts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      filters: { stage, search, sortBy, order: order === 1 ? "asc" : "desc" },
    });
  } catch (error) {
    console.error("Admin dealer list error:", error);
    return res.status(500).json({ status: false, message: "Failed to fetch dealers" });
  }
}

async function deleteDealer(req, res) {
  try {
    const { dealer_id } = req.body;
    console.log("Dealer id", req.body);

    if (!dealer_id) {
      return res.status(400).json({
        status: 400,
        message: "dealer_id is required"
      });
    }

    const dealerRes = await Vendor.findOne({ _id: dealer_id });
    if (!dealerRes) {
      return res.status(404).json({
        status: 404,
        message: "No Dealer Found"
      });
    }

    console.log("Dealer res:-", dealerRes);

    await Vendor.findByIdAndDelete({ _id: dealer_id });

    return res.status(200).json({
      status: 200,
      message: "Dealer deleted successfully"
    });

  } catch (error) {
    console.error("Delete dealer error:", error);
    return res.status(500).json({
      status: 500,
      message: "Operation was not successful",
      error: error.message
    });
  }
}

async function singledealer(req, res) {
  try {
    const dealerResposnse = await Vendor.findById(req.params.id)

    if (dealerResposnse) {
      return res.status(200).send({
        status: true,
        message: "success",
        data: dealerResposnse,
      });
    } else {
      return res.status(404).send({
        status: false,
        message: "No Dealer Found",
      });
    }
  } catch (error) {
    console.error("error", error);
    return res.status(500).send({
      status: false,
      message: "Operation was not successful",
    });
  }
}

async function setDealerOnline(req, res) {
  try {
    const { dealerId } = req.params;
    const { active } = req.body;

    if (!mongoose.Types.ObjectId.isValid(dealerId)) {
      return res.status(400).json({ success: false, message: "Invalid dealerId" });
    }
    if (typeof active !== "boolean") {
      return res.status(400).json({ success: false, message: "active must be boolean" });
    }

    const now = new Date();
    const update = active
      ? { online: true, activeSince: now, lastSeen: now }
      : { online: false, activeSince: null, lastSeen: now };

    const dealer = await Vendor.findByIdAndUpdate(
      dealerId,
      { $set: update },
      { new: true, lean: true }
    );

    if (!dealer) return res.status(404).json({ success: false, message: "Dealer not found" });

    return res.status(200).json({
      success: true,
      message: `Dealer is now ${dealer.online ? "Active" : "Inactive"}`,
      data: dealer,
    });
  } catch (err) {
    console.error("setDealerOnline error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

async function getActiveDealers(req, res) {
  try {
    const {
      city,
      state,
      page = 1,
      limit = 20,
      q
    } = req.query;

    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const sz = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const filter = { online: true }; // 🔑 active = online
    if (city) filter.city = city;
    if (state) filter.state = state;

    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim(), "i");
      filter.$or = [
        { shopName: rx },
        { ownerName: rx },
        { phone: rx },
        { email: rx },
      ];
    }

    const [data, total] = await Promise.all([
      Vendor.find(filter)
        .sort({ activeSince: -1, updatedAt: -1 })
        .skip((pg - 1) * sz)
        .limit(sz)
        .select(
          "shopName ownerName phone email city state latitude longitude online activeSince lastSeen services"
        )
        .lean(),
      Vendor.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: "Active dealers fetched successfully",
      page: pg,
      limit: sz,
      total,
      totalPages: Math.max(1, Math.ceil(total / sz)),
      data,
    });
  } catch (err) {
    console.error("getActiveDealers error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

// ─── Withdrawal Request ──────────────────────────────────────────────────────
// Dealer requests a payout. Balance is reserved (debited) immediately.
// Admin progresses: PENDING → IN_PROGRESS → COMPLETED  (or REJECTED to rollback)
const createWithdrawalRequest = async (req, res) => {
  try {
    const { dealer_id, amount, note } = req.body;

    if (!dealer_id || !amount) {
      return res.status(200).json({ status: false, message: "dealer_id and amount are required" });
    }

    const withdrawAmount = parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(200).json({ status: false, message: "Invalid withdrawal amount" });
    }

    if (!mongoose.Types.ObjectId.isValid(dealer_id)) {
      return res.status(400).json({ status: false, message: "Invalid dealer id" });
    }

    const result = await createWithdrawal({
      dealerId: req.dealer_id,
      amount: withdrawAmount,
      note,
      performedBy: req.dealer_id,
      idempotencyKey: req.get("x-idempotency-key") || null,
    });
    const walletEntry = result.wallet;

    return res.status(200).json({
      status: true,
      message: result.existing ? "Withdrawal request already submitted." : "Withdrawal request created. Pending admin approval.",
      data: walletEntry,
      newBalance: walletEntry.Total,
    });
  } catch (error) {
    console.error('Withdrawal Error:', error);
    console.error(error.stack);
    return res.status(500).json({ status: false, message: error.message || "Internal server error" });
  }
};

// ─── Deposit ─────────────────────────────────────────────────────────────────
// Admin credits a dealer's wallet (clears dues, manual top-up, etc.)
const createDeposit = async (req, res) => {
  try {
    const data = jwt.verify(req.headers.token, process.env.JWT_SECRET);
    const { user_id, user_type } = data;

    const { dealer_id, amount, note } = req.body;

    // Dealer-authenticated callers should use the PayU wallet
    // top-up flow instead of the admin/manual deposit flow. This keeps the
    // production gateway path in one place and avoids duplicating wallet
    // credit logic in the frontend.
    if (user_type === 2) {
      const { createOrderForAdd } = require("./payment");
      req.body = { dealer_id: dealer_id || user_id, amount, note };
      return createOrderForAdd(req, res);
    }

    if (!dealer_id || !amount) {
      return res.status(200).json({ status: false, message: "dealer_id and amount are required" });
    }

    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(200).json({ status: false, message: "Invalid deposit amount" });
    }

    const dealer = await Vendor.findById(dealer_id);
    if (!dealer) {
      return res.status(200).json({ status: false, message: "Dealer not found" });
    }

    const preBalance = parseFloat(dealer.wallet) || 0;
    dealer.wallet = parseFloat((preBalance + depositAmount).toFixed(2));
    await dealer.save();

    const walletEntry = await Wallet.create({
      orderId: `DEP-${Date.now()}`,
      dealer_id: dealer._id,
      Amount: depositAmount,
      Type: "Credit",
      Note: note || `Deposit of ₹${depositAmount}`,
      Total: dealer.wallet,
      pre_balance: preBalance,
      order_status: "APPROVED",
      transaction_type: "deposit",
      performed_by: user_id,
    });

    return res.status(200).json({
      status: true,
      message: "Deposit processed successfully",
      data: walletEntry,
      newBalance: dealer.wallet,
    });
  } catch (error) {
    console.error("Deposit error:", error);
    return res.status(500).json({ status: false, message: "Internal server error" });
  }
};

async function registerDealerToken(req, res) {
  try {
    // verifyDealerToken (route middleware) already authenticated the caller
    // via the Authorization: Bearer header and set req.dealer_id — reuse that
    // instead of re-parsing a separate, non-standard `token` header here.
    const dealer_id = req.dealer_id;

    if (!dealer_id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { device_token } = req.body;

    if (!device_token || typeof device_token !== "string" || device_token.trim() === "") {
      return res.status(400).json({ success: false, message: "device_token is required" });
    }

    const dealer = await Vendor.findByIdAndUpdate(
      dealer_id,
      { device_token: device_token.trim() },
      { new: true, select: "_id shopName device_token" }
    );

    if (!dealer) {
      return res.status(404).json({ success: false, message: "Dealer not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Device token registered successfully",
      data: { dealer_id: dealer._id, device_token: dealer.device_token },
    });
  } catch (error) {
    console.error("registerDealerToken error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

const getDealerActivityHistory = async (req, res) => {
  try {
    const { dealerId } = req.params;

    const logs = await DealerActivityLog.find({ dealerId }).sort({ timestamp: -1 }).lean();

    const adminIds = [...new Set(logs.filter((log) => log.adminId).map((log) => String(log.adminId)))];
    const admins = adminIds.length ? await Admin.find({ _id: { $in: adminIds } }).select("name").lean() : [];
    const adminNameById = new Map(admins.map((admin) => [String(admin._id), admin.name]));

    const data = logs.map((log) => ({
      _id: log._id,
      dealerId: log.dealerId,
      adminId: log.adminId,
      adminName: log.adminId ? adminNameById.get(String(log.adminId)) || null : null,
      action: log.action,
      reason: log.reason,
      timestamp: log.timestamp,
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getDealerActivityHistory error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = {
  getActiveDealers,
  getDealerActivityHistory,
  dealerList,
  adminDealerList,
  deleteDealer,
  singledealer,
  dealerWithInRange,
  editDealerStatus,
  GetwalletInfo,
  WalletAdd,
  addAmount,
  dealerWithInRange2,
  getShopDetails,
  addDealerShopDetails,
  addDealerDocuments,
  getWallet,
  getPendingWallets,
  updateWalletStatus,
  getAllDealersWithDocFalse,
  getAllDealersWithVerifyFalse,
  updateDealerDocStatus,
  updateDealerVerfication,
  setDealerOnline,
  createWithdrawalRequest,
  createDeposit,
  registerDealerToken,
};
