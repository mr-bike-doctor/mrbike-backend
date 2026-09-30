var validation = require("../helper/validation");
require("dotenv").config();
const mongoose = require("mongoose");
var moment = require("moment");
const customers = require("../models/customer_model");
const { is } = require("express/lib/request");
const jwt_decode = require("jwt-decode");
const otpAuth = require("../helper/otpAuth");
const UserBike = require("../models/userBikeModel");
const BikeVariant = require("../models/bikeVariantModel");
const Booking = require("../models/Booking");
const ReferralSettings = require("../models/ReferralSettings");
const ReferralTransaction = require("../models/ReferralTransaction");
const MrBikeMoneyTransaction = require("../models/MrBikeMoneyTransaction");
const { generateUniqueReferralCode } = require("../utils/referralCodeGenerator");
const { awardReferralSignupRewardsIfEligible } = require("../services/referralRewardService");
const { normalizePlateNumber } = require("../utils/plateNumber");

async function getReferralSettingsSingleton() {
  let settings = await ReferralSettings.findOne({});
  if (!settings) settings = await ReferralSettings.create({});
  return settings;
}

// Resolves a referral code entered by `user` against the referrer it
// belongs to, enforcing: system/registration-referral enabled, one-time
// use (never overwrite an existing referredBy), code exists, and no
// self-referral. Returns { error } or { referrerId }.
async function resolveReferralCodeForUser(referralCode, user) {
  const settings = await getReferralSettingsSingleton();
  if (!settings.enableReferralSystem || !settings.allowReferralCodeDuringRegistration) {
    return { error: "Referral code entry is currently disabled" };
  }
  if (user.referredBy) {
    return { error: "Referral code has already been applied to this account" };
  }
  const code = String(referralCode).trim().toUpperCase();
  if (!code) return { error: "Referral code is required" };

  const referrer = await customers.findOne({ referralCode: code });
  if (!referrer) return { error: "Invalid referral code" };
  if (referrer._id.toString() === user._id.toString()) {
    return { error: "You cannot use your own referral code" };
  }
  return { referrerId: referrer._id };
}

// async function customersignup(req, res) {

//   try {

//     if (req.body.email != "" && req.body.passwords != "") {
//       var emailCheck = await customers.findOne({ email: req.body.email });

//       if(emailCheck){
//             res.status(401).json({success:false, message:"Customer Already Exists"});
//             return;
//       }

//       if (!emailCheck) {
//       if(req.file){
//         const data = {
//           first_name: req.body.first_name,
//           last_name: req.body.last_name,
//           email: req.body.email,
//           password: validation.hashPassword(req.body.password),
//           phone: req.body.phone,
//           image: req.file.filename,
//           state: req.body.state,
//           city: req.body.city,
//           address: req.body.address,
//           device_token: req.body.device_token,
//         };
//         const customerResposnse = await customers.create(data);
//         if (customerResposnse) {
//           var response = {
//             status: 200,
//             message: "Customer Registration successfull",
//             // data: customerResposnse,
//             image_base_url: process.env.BASE_URL,
//           };
//           return res.status(200).send(response);
//         } else {
//           var response = {
//             status: 201,
//             message: "Registration failed",
//           };
//           return res.status(201).send(response);
//         }
//       } else {
//         // var response = {
//         //   status: 201,
//         //   message: "please upload profile image",
//         // };
//         // return res.status(201).send(response);

//         const data = {
//           first_name: req.body.first_name,
//           last_name: req.body.last_name,
//           email: req.body.email,
//           password: validation.hashPassword(req.body.password),
//           phone: req.body.phone,
//           state: req.body.state,
//           city: req.body.city,
//           address: req.body.address,
//           device_token: req.body.device_token,
//         };
//         const customerResposnse = await customers.create(data);
//         if (customerResposnse) {
//           var response = {
//             status: 200,
//             message: "Customer Registration successfull",
//             // data: customerResposnse,
//             image_base_url: process.env.BASE_URL,
//           };
//           return res.status(200).send(response);
//         } else {
//           var response = {
//             status: 201,
//             message: "Registration failed",
//           };
//           return res.status(201).send(response);
//         }
//       }
//       } else {
//         var response = {
//           status: 201,
//           message: "Email already exist",
//         };
//         return res.status(201).send(response);
//       }
//     } else {
//       var response = {
//         status: 201,
//         message: "email and password not be empty value !",
//       };

//       return res.status(201).send(response);
//     }
//   } catch (error) {
//     console.log("error", error);
//     response = {
//       status: 201,
//       message: "Operation was not successful",
//     };

//     return res.status(201).send(response);
//   }
// }

const updateUserBike = async (req, res) => {
  try {
    const { id } = req.params; // Get bike ID from URL params
    const allowedFields = ["name", "model", "bike_cc", "plate_number", "variant_id", "status"];
    const updateData = Object.fromEntries(
      allowedFields.filter((field) => req.body[field] !== undefined).map((field) => [field, req.body[field]]),
    );
    if (updateData.plate_number !== undefined) {
      updateData.plate_number = normalizePlateNumber(updateData.plate_number);
    }

    // Check if the bike exists
    const existingBike = await UserBike.findOne({ _id: id, user_id: req.user_id });
    if (!existingBike) {
      return res.status(404).json({ message: "Bike not found" });
    }

    // Renaming a plate onto one of the rider's other bikes used to reach the
    // database unchecked and surface as a bare 500 from the duplicate-key
    // error. Same normalized comparison addUserBike makes, minus this bike.
    if (updateData.plate_number) {
      const ownedBikes = await UserBike.find({ user_id: req.user_id, _id: { $ne: id } })
        .select("plate_number")
        .lean();
      const clash = ownedBikes.some(
        (bike) => normalizePlateNumber(bike.plate_number) === updateData.plate_number,
      );
      if (clash) {
        return res
          .status(409)
          .json({ message: "You have already added a bike with this plate number!" });
      }
    }

    // Update the bike details
    const updatedBike = await UserBike.findOneAndUpdate({ _id: id, user_id: req.user_id }, updateData, {
      new: true, // Return the updated document
      runValidators: true, // Ensure validation rules are applied
    });

    res.status(200).json({
      message: "Bike details updated successfully",
      data: updatedBike,
    });
  } catch (error) {
    console.error("Update Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

async function addProfile(req, res) {
  try {
    const { first_name, last_name, state, city, address, pincode, referralCode } = req.body;

    // Extract user_id from request (set by authentication middleware)
    const user_id = req.user_id;
    console.log(user_id, "userid");
    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, message: "User ID is required" });
    }

    let user = await customers.findOne({ _id: user_id });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Update user profile fields
    user.first_name = first_name;
    user.last_name = last_name;
    user.state = state;
    user.city = city;
    user.address = address;
    user.pincode = pincode;
    user.isProfile = true;

    if (req.file) {
      user.image = req.file.location
    }

    if (referralCode) {
      const result = await resolveReferralCodeForUser(referralCode, user);
      if (result.error) {
        return res.status(400).json({ success: false, message: result.error });
      }
      user.referredBy = result.referrerId;
    }

    await user.save();

    if (referralCode) {
      try {
        await awardReferralSignupRewardsIfEligible(user._id);
      } catch (rewardError) {
        console.error("Referral signup reward error:", rewardError.message);
      }
    }

    res.status(200).json({
      success: true,
      message: "Profile added successfully.",
      profile: user,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
}

const deleteMyBike = async (req, res) => {
  try {
    const user_id = req.user_id;
    const { bike_id } = req.params; // Get bike ID from URL params

    if (!user_id) {
      return res.status(200).json({
        status: 200,
        message: "Unauthorized access!",
        data: [],
      });
    }

    // Ownership check and deletion happen in one database operation. A success
    // response therefore means the unique plate entry has actually gone and
    // the same customer can immediately add that registration number again.
    const deletedBike = await UserBike.findOneAndDelete({ _id: bike_id, user_id });

    if (!deletedBike) {
      return res.status(404).json({
        status: 404,
        message: "Bike not found!",
        data: [],
      });
    }

    return res.status(200).json({
      status: 200,
      message: "Bike deleted successfully",
      data: [],
    });
  } catch (error) {
    console.error("❌ Error deleting user bike:", error);

    return res.status(500).json({
      status: 500,
      message: "Internal Server Error",
      data: [],
    });
  }
};

// async function getcustomer(req, res) {
//   try {
//     const data = jwt_decode(req.headers.token);
//     let user_id;

//     if (data.user_type === 1) {
//       user_id = req.query.user_id; // Admin ke case mein user_id query params se lega
//     } else if (data.user_type === 4) {
//       user_id = data.user_id; // User ke case mein token se lega
//     } else {
//       return res.status(403).json({ success: false, message: "Unauthorized access" });
//     }

//     const customer = await customers.findById(user_id);

//     if (!customer) {
//       return res.status(404).json({ success: false, message: "No Customer Account Found" });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "success",
//       data: customer,
//       image_base_url: process.env.BASE_URL,
//     });

//   } catch (error) {
//     console.error("Error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Operation was not successful",
//     });
//   }
// }

// Bikes live in the UserBike collection keyed by user_id, not in
// customer.userBike (that ref array on the customer document is never
// written by addUserBike, so it can never be trusted / populated as-is).
async function fetchBikesForCustomer(customerId) {
  const userBikes = await UserBike.find({ user_id: customerId }).populate({
    path: "variant_id",
    model: "BikeVariant",
    select: "variant_name engine_cc model_id",
    populate: {
      path: "model_id",
      model: "BikeModel",
      select: "model_name company_id",
      populate: { path: "company_id", model: "BikeCompany", select: "name" },
    },
  });

  return userBikes.map((bike) => {
    const variant = bike.variant_id;
    const model = variant?.model_id;
    const company = model?.company_id;

    return {
      _id: bike._id,
      bike_id: bike.bike_id,
      company_name: company?.name || bike.name,
      model_name: model?.model_name || bike.model,
      variant_name: variant?.variant_name || "",
      engine_cc: variant?.engine_cc ?? bike.bike_cc,
      registration_number: bike.plate_number,
      status: bike.status,
    };
  });
}

async function getcustomer(req, res) {
  try {
    const { user_id } = req.params;

    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, message: "user_id is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(user_id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id" });
    }

    const customer = await customers
      .findById(user_id)
      .select("-password -passwords -otp -device_token -ftoken")
      .lean();

    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "No Customer Account Found" });
    }

    customer.userBike = await fetchBikesForCustomer(customer._id);

    console.log("Customer", customer);
    return res.status(200).json({
      success: true,
      message: "success",
      data: customer,
      image_base_url: process.env.BASE_URL,
    });
  } catch (error) {
    console.error("Error in getcustomer:", error);
    return res.status(500).json({
      success: false,
      message: "Operation was not successful",
    });
  }
}

async function getcustomersData(req, res) {
  try {
    const { user_id } = req.params;

    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, message: "user_id is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(user_id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id" });
    }

    const customer = await customers
      .findById(user_id)
      .select("-password -passwords -otp -device_token -ftoken")
      .lean();

    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "No Customer Account Found" });
    }

    customer.userBike = await fetchBikesForCustomer(customer._id);

    console.log("Customer", customer);
    return res.status(200).json({
      success: true,
      message: "success",
      data: customer,
      image_base_url: process.env.BASE_URL,
    });
  } catch (error) {
    console.error("Error in getcustomer:", error);
    return res.status(500).json({
      success: false,
      message: "Operation was not successful",
    });
  }
}

async function deletecustomer(req, res) {
  try {
    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;
    const user_type = data.user_type;
    const type = data.type;
    if (user_id == null || user_type != 1) {
      var response = {
        status: 401,
        message: "admin is un-authorised !",
      };
      return res.status(401).send(response);
    }
    const { customer_id } = req.body;
    //console.log('customer_id: ', customer_id);
    const customerRes = await customers.findOne({ _id: customer_id });
    if (customerRes) {
      customers.findByIdAndDelete(
        { _id: customer_id },
        async function (err, docs) {
          if (err) {
            var response = {
              status: 201,
              message: "customer delete failed",
            };
            return res.status(201).send(response);
          } else {
            var response = {
              status: 200,
              message: "customer deleted successfully",
            };
            return res.status(200).send(response);
          }
        },
      );
    } else {
      var response = {
        status: 201,
        message: "customer not Available",
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

async function editcustomer(req, res) {
  try {
    const user_id = req.user_id;
    if (!user_id || String(req.params.id) !== String(user_id)) {
      var response = {
        status: 401,
        message: "admin is un-authorised !",
      };
      return res.status(401).send(response);
    }

    const {
      first_name,
      last_name,
      email,
      phone,
      state,
      city,
      address,
      pincode,
      referralCode,
    } = req.body;

    const customerResp = await customers.findOne({ _id: user_id });
    // console.log("customerResp : ", customerResp);
    if (customerResp) {
      const data = {
        first_name: first_name,
        last_name: last_name,
        email: email,
        phone: phone,
        state: state,
        city: city,
        address: address,
        pincode: pincode,
        isProfile: true,
      };

      if (referralCode) {
        const result = await resolveReferralCodeForUser(referralCode, customerResp);
        if (result.error) {
          return res.status(400).json({ success: false, message: result.error });
        }
        data.referredBy = result.referrerId;
      }

      customers.findByIdAndUpdate(
        { _id: user_id },
        { $set: data },
        { new: true },
        async function (err, docs) {
          if (err) {
            var response = {
              status: 201,
              message: err,
            };
            return res.status(201).send(response);
          } else {
            if (referralCode) {
              try {
                await awardReferralSignupRewardsIfEligible(docs._id);
              } catch (rewardError) {
                console.error("Referral signup reward error:", rewardError.message);
              }
            }
            var response = {
              status: 200,
              message: "customer updated successfully",
              data: docs,
              image_base_url: docs.image?.startsWith("http") ? "" : process.env.BASE_URL,
            };
            return res.status(200).send(response);
          }
        },
      );
    } else {
      response = {
        status: 201,
        message: "customer not available",
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

async function changeImage(req, res) {
  try {
    const user_id = req.user_id;

    if (!user_id) {
      return res
        .status(200)
        .json({ success: false, message: "Unauthorized access!" });
    }

    const customer = await customers.findById(user_id);
    if (!customer) {
      return res
        .status(200)
        .json({ success: false, message: "No Customer Account Found" });
    }

    if (!req.file) {
      return res
        .status(200)
        .json({ success: false, message: "Please upload an image" });
    }

    // ✅ Update the image and return full URL
    customer.image = req.file.location

    await customer.save()

    const imageUrl = customer.image

    return res.status(200).json({
      success: true,
      message: "Profile Image updated successfully",
      image_name: customer.image,
      full_image_url: imageUrl,
    });
  } catch (error) {
    console.error("Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Operation was not successful" });
  }
}

const getMyBikes = async (req, res) => {
  try {
    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;

    console.log(`[getMyBikes] Fetching bikes for user ID: ${user_id}`);

    if (!user_id) {
      console.warn(
        `[getMyBikes] Unauthorized access attempt: No user ID in token`,
      );
      return res.status(200).json({
        status: 200,
        message: "Unauthorized access!",
        data: [],
      });
    }

    // Fetch user bikes and the most recent completed service for each bike.
    // The additive serviceInfo field keeps the existing response contract
    // intact for older clients.
    const userBikes = await UserBike.find({ user_id }).lean();
    const bikeIds = userBikes.map((bike) => bike._id);
    const latestServices = bikeIds.length
      ? await Booking.aggregate([
          { $match: { user_id: new mongoose.Types.ObjectId(user_id), userBike_id: { $in: bikeIds }, status: { $in: ["completed", "delivered", "cash received", "Payment"] } } },
          { $sort: { serviceDate: -1, updatedAt: -1 } },
          { $group: { _id: "$userBike_id", lastServiceDate: { $first: "$serviceDate" } } },
        ])
      : [];
    const serviceByBike = new Map(latestServices.map((row) => [String(row._id), row]));
    const bikesWithServiceInfo = userBikes.map((bike) => {
      const row = serviceByBike.get(String(bike._id));
      const lastServiceDate = row?.lastServiceDate || null;
      // No maintenance interval is currently stored in the database, so do
      // not manufacture a due date. The nullable field is explicit and lets
      // clients render an honest "not scheduled" state.
      return { ...bike, serviceInfo: { lastServiceDate, nextServiceDue: null } };
    });
    console.log(
      `[getMyBikes] Found ${userBikes.length} bikes for user ID: ${user_id}`,
    );

    res.status(200).json({
      status: 200,
      message:
        userBikes.length > 0
          ? "Bikes retrieved successfully"
          : "No bikes found",
      data: bikesWithServiceInfo,
    });
  } catch (error) {
    console.error("Error fetching user bikes:", error);
    res.status(200).json({
      status: 200,
      message: "Internal Server Error",
      data: [],
    });
  }
};

const addUserBike = async (req, res) => {
  try {
    // requireCustomer has already verified the JWT and confirmed the account.
    // Re-decoding an unverified header here duplicated that work and could throw
    // before the request reached any of the useful validation below.
    const user_id = req.user_id;

    console.log(`[addUserBike] Adding new bike for user ID: ${user_id}`);
    console.log(`[addUserBike] Request body:`, req.body);

    if (!user_id) {
      console.warn(
        `[addUserBike] Unauthorized access attempt: No user ID in token`,
      );
      return res.status(200).json({
        status: 200,
        message: "Unauthorized access!",
        data: [],
      });
    }

    const { variant_id } = req.body;
    const plate_number = normalizePlateNumber(req.body.plate_number);

    // Check if all required fields are provided
    if (!variant_id || !plate_number) {
      console.warn(
        `[addUserBike] Validation failed: Missing required fields for user ID: ${user_id}`,
      );
      return res.status(200).json({
        status: 200,
        message: "All fields (variant_id, plate_number) are required!",
        data: [],
      });
    }

    if (!mongoose.Types.ObjectId.isValid(variant_id)) {
      return res.status(400).json({
        status: 400,
        message: "Invalid bike variant selected!",
        data: [],
      });
    }

    // Resolve the real company/model names from the selected catalog variant
    // server-side, rather than trusting client-supplied name/model strings
    // (which previously leaked raw catalog ObjectIds into these fields).
    const variant = await BikeVariant.findById(variant_id).populate({
      path: "model_id",
      model: "BikeModel",
      select: "model_name company_id",
      populate: { path: "company_id", model: "BikeCompany", select: "name" },
    });

    const resolvedName = variant?.model_id?.company_id?.name;
    const resolvedModel = variant?.model_id?.model_name;

    if (!variant || !resolvedName || !resolvedModel) {
      console.warn(
        `[addUserBike] Validation failed: could not resolve catalog details for variant_id ${variant_id}`,
      );
      return res.status(200).json({
        status: 200,
        message: "Selected bike variant could not be found!",
        data: [],
      });
    }

    // Scoped to this rider's own garage. The check used to run across every
    // customer, so a plate registered on another account — one getMyBikes can
    // never show — rejected the rider in front of an empty bike list.
    //
    // Compared on normalized values rather than with a {user_id, plate_number}
    // query: plates stored before normalization are still raw, and "ts05 en
    // 5464" must not slip past as a second copy of "TS05EN5464". A rider owns
    // a handful of bikes, so this stays cheap.
    const ownedBikes = await UserBike.find({ user_id }).select("plate_number").lean();
    const existingBike = ownedBikes.find(
      (bike) => normalizePlateNumber(bike.plate_number) === plate_number,
    );

    if (existingBike) {
      console.warn(
        `[addUserBike] Plate number ${plate_number} is already in user ${user_id}'s garage`,
      );
      return res.status(200).json({
        status: 200,
        message: "You have already added a bike with this plate number!",
        data: [],
      });
    }

    // Create a new bike entry
    const newBike = new UserBike({
      user_id,
      name: resolvedName,
      model: resolvedModel,
      bike_cc: String(variant.engine_cc ?? ""),
      plate_number,
      variant_id,
    });

    await newBike.save();
    console.log(
      `[addUserBike] Successfully saved new bike for user ID: ${user_id}. Bike ID: ${newBike._id}`,
    );

    res.status(200).json({
      status: 200,
      message: "Bike added successfully",
      data: newBike,
    });
  } catch (error) {
    console.error("Error adding user bike:", error);

    // Concurrent requests for the same customer's plate can both pass the
    // readable pre-check; the per-user database index remains authoritative.
    if (error?.code === 11000) {
      return res.status(409).json({
        status: 409,
        message: "You have already added a bike with this plate number!",
        data: [],
      });
    }

    return res.status(500).json({
      status: 500,
      message: "Internal Server Error",
      data: [],
    });
  }
};

// By prashant
async function customerlist(req, res) {
  try {
    // Populate referredBy just far enough to read the referrer's own
    // referralCode (the code this customer entered at registration) — same
    // relationship/fields getCustomerById already reads, just for the list.
    const customerResponse = await customers
      .find()
      .populate({ path: "referredBy", select: "referralCode" });

    const data = customerResponse.map((c) => {
      const doc = c.toJSON();
      return {
        ...doc,
        referredBy: c.referredBy ? c.referredBy._id : null, // keep raw id shape for existing consumers
        joinedViaReferral: !!c.referredBy,
        referralCodeUsed: c.referredBy?.referralCode || null,
      };
    });

    const response = {
      status: 200,
      message: "success",
      data,
      image_base_url: process.env.BASE_URL, // Keep for list as individual items might vary
    };
    return res.status(200).send(response);
  } catch (error) {
    console.log("error", error);
    const response = {
      status: 500,
      message: "Operation was not successful",
    };
    return res.status(500).send(response);
  }
}

// Backs the admin UI's Customer Details page/modal (GET /customers/view/:id).
// Read-only: unlike getMyReferralCode/getReferralSummary (customer-facing),
// this never lazily generates a missing referralCode — viewing a customer
// as an admin must not have side effects on their record.
async function getCustomerById(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: "id is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const customerDoc = await customers
      .findById(id)
      .select("-password -passwords -otp -device_token -ftoken")
      .populate({ path: "referredBy", select: "first_name last_name referralCode" });

    if (!customerDoc) {
      return res.status(404).json({ success: false, message: "No Customer Account Found" });
    }

    const userBike = await fetchBikesForCustomer(customerDoc._id);

    const settings = await getReferralSettingsSingleton();
    const [totalReferrals, convertedReferredUsers, signupRewardedReferrals] = await Promise.all([
      customers.countDocuments({ referredBy: customerDoc._id }),
      ReferralTransaction.distinct("referredUserId", {
        referrerUserId: customerDoc._id,
        rewardType: "referrer",
      }),
      customers.countDocuments({
        referredBy: customerDoc._id,
        referralSignupRewardCreditedAt: { $ne: null },
      }),
    ]);

    const referrer = customerDoc.referredBy;
    const referrerName = referrer
      ? `${referrer.first_name || ""} ${referrer.last_name || ""}`.trim() || "N/A"
      : null;

    return res.status(200).json({
      success: true,
      message: "success",
      data: {
        ...customerDoc.toJSON(),
        userBike,
        referredBy: referrer ? { name: referrerName, referralCode: referrer.referralCode || null } : null,
        joinedViaReferral: !!referrer,
        referralCodeUsed: referrer?.referralCode || null,
        myReferralCode: customerDoc.referralCode || null,
        totalReferrals,
        successfulReferrals: settings.rewardOnReferralSignup !== false
          ? signupRewardedReferrals
          : convertedReferredUsers.length,
        referralEarnings: customerDoc.referralEarnings || 0,
        mrBikeMoneyBalance: customerDoc.mrBikeMoneyBalance || 0,
      },
      image_base_url: process.env.BASE_URL,
    });
  } catch (error) {
    console.error("getCustomerById error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// Backs the admin UI's Customer Details "Referrals" tab (GET /customers/:id/referrals).
// Read-only, admin-only: lists every customer this user referred, left-joined with
// their earliest booking (for first-booking status — reuses Booking's own
// vehicleLifecycleStatus virtual rather than re-deriving lifecycle text here) and
// with the referrer-side ReferralTransaction (for reward amount/status). Neither
// join implies the other — a referred customer may not have booked yet, and a
// booking may exist without (yet) being reward-eligible.
async function getReferredCustomers(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: "id is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const referredCustomers = await customers
      .find({ referredBy: id })
      .select("first_name last_name id createdAt")
      .sort({ createdAt: -1 })
      .lean();

    if (referredCustomers.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const referredIds = referredCustomers.map((c) => c._id);

    const [firstBookings, transactions] = await Promise.all([
      Booking.find({ user_id: { $in: referredIds } }).sort({ createdAt: 1 }),
      ReferralTransaction.find({
        referrerUserId: id,
        referredUserId: { $in: referredIds },
        rewardType: "referrer",
      })
        .populate({ path: "bookingId", select: "bookingId" })
        .lean(),
    ]);

    const firstBookingByUser = new Map();
    for (const booking of firstBookings) {
      const key = booking.user_id.toString();
      if (!firstBookingByUser.has(key)) firstBookingByUser.set(key, booking.toJSON());
    }

    const transactionByUser = new Map(
      transactions.map((txn) => [txn.referredUserId.toString(), txn]),
    );

    const data = referredCustomers.map((c) => {
      const firstBooking = firstBookingByUser.get(c._id.toString()) || null;
      const transaction = transactionByUser.get(c._id.toString()) || null;

      return {
        customerId: c.id ? `MRBDC${c.id.toString().padStart(4, "0")}` : null,
        customerName: `${c.first_name || ""} ${c.last_name || ""}`.trim() || "N/A",
        joinedDate: c.createdAt,
        firstBookingStatus: firstBooking ? firstBooking.vehicleLifecycleStatus : "No Booking Yet",
        rewardAmount: transaction?.rewardAmount || 0,
        rewardStatus: transaction ? transaction.status : "Pending",
        bookingId: transaction?.bookingId?.bookingId || firstBooking?.bookingId || null,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getReferredCustomers error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

async function deletecustomer(req, res) {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).send({
        status: 400,
        message: "customer_id is required",
      });
    }

    const customerRes = await customers.findOne({ _id: customer_id });

    if (!customerRes) {
      return res.status(404).send({
        status: 404,
        message: "Customer not found",
      });
    }

    await customers.findByIdAndDelete(customer_id);

    return res.status(200).send({
      status: 200,
      message: "Customer deleted successfully",
    });
  } catch (error) {
    console.log("error", error);
    return res.status(500).send({
      status: 500,
      message: "Operation was not successful",
    });
  }
}

async function getMyReferralCode(req, res) {
  try {
    const user_id = req.user_id;
    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const user = await customers.findOne({ _id: user_id });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.referralCode) {
      user.referralCode = await generateUniqueReferralCode(customers);
      await user.save({ validateModifiedOnly: true });
    }

    return res.status(200).json({ success: true, data: { referralCode: user.referralCode } });
  } catch (error) {
    console.error("getMyReferralCode error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

async function validateReferralCode(req, res) {
  try {
    const user_id = req.user_id;
    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const { referralCode } = req.body;
    if (!referralCode) {
      return res.status(400).json({ success: false, message: "Referral code is required" });
    }

    const user = await customers.findOne({ _id: user_id });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const result = await resolveReferralCodeForUser(referralCode, user);
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }

    const referrer = await customers.findById(result.referrerId).select("first_name last_name referralCode");
    return res.status(200).json({
      success: true,
      message: "Valid referral code",
      data: {
        valid: true,
        referrerId: referrer._id,
        referrerName: `${referrer.first_name || ""} ${referrer.last_name || ""}`.trim(),
      },
    });
  } catch (error) {
    console.error("validateReferralCode error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// Backs the Rewards & Referrals screen header. Also carries
// showRewardsReferralsMenu/enableReferralSystem so the Profile tab can
// decide whether to render the menu entry at all, without a separate
// settings-read endpoint for customers.
async function getReferralSummary(req, res) {
  try {
    const user_id = req.user_id;
    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const user = await customers.findOne({ _id: user_id });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.referralCode) {
      user.referralCode = await generateUniqueReferralCode(customers);
      await user.save({ validateModifiedOnly: true });
    }

    const settings = await getReferralSettingsSingleton();

    // Distinct referred users who produced a "referrer" reward for this
    // user — i.e. how many people they referred that actually converted,
    // not raw transaction count (which could exceed this if firstBookingOnly
    // is ever disabled and a referred user completes multiple bookings).
    const successfulReferralsCount = settings.rewardOnReferralSignup !== false
      ? await customers.countDocuments({
          referredBy: user_id,
          referralSignupRewardCreditedAt: { $ne: null },
        })
      : (await ReferralTransaction.distinct("referredUserId", {
          referrerUserId: user_id,
          rewardType: "referrer",
        })).length;

    return res.status(200).json({
      success: true,
      data: {
        referralCode: user.referralCode,
        referralEarnings: user.referralEarnings || 0,
        mrBikeMoneyBalance: user.mrBikeMoneyBalance || 0,
        successfulReferralsCount,
        showRewardsReferralsMenu: !!settings.showRewardsReferralsMenu,
        enableReferralSystem: !!settings.enableReferralSystem,
        enableReferrerReward: !!settings.enableReferrerReward,
        referrerRewardAmount: settings.referrerRewardAmount || 0,
      },
    });
  } catch (error) {
    console.error("getReferralSummary error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// Backs the Rewards & Referrals screen's transaction list. Includes
// transactions where the user was rewarded either as referrer (earnings
// from people they referred) or as the referred user (their own signup
// reward) — together these always sum to referralEarnings above.
async function getReferralTransactions(req, res) {
  try {
    const user_id = req.user_id;
    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const filter = {
      $or: [{ referrerUserId: user_id }, { referredUserId: user_id }],
    };

    const [transactions, total] = await Promise.all([
      ReferralTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "referredUserId", select: "first_name last_name" })
        .populate({ path: "bookingId", select: "bookingId" })
        .lean(),
      ReferralTransaction.countDocuments(filter),
    ]);

    const data = transactions.map((txn) => ({
      rewardAmount: txn.rewardAmount,
      rewardType: txn.rewardType,
      referredUserName: `${txn.referredUserId?.first_name || ""} ${txn.referredUserId?.last_name || ""}`.trim() || "N/A",
      bookingId: txn.bookingId?.bookingId || null,
      status: txn.status,
      createdDate: txn.createdAt,
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("getReferralTransactions error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

async function getMrBikeMoneyTransactions(req, res) {
  try {
    const user_id = req.user_id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      MrBikeMoneyTransaction.find({ userId: user_id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: "bookingId", select: "bookingId" })
        .lean(),
      MrBikeMoneyTransaction.countDocuments({ userId: user_id }),
    ]);
    return res.status(200).json({
      success: true,
      data: transactions.map((txn) => ({
        type: txn.type,
        amount: txn.amount,
        balanceAfter: txn.balanceAfter,
        description: txn.description,
        bookingId: txn.bookingId?.bookingId || null,
        createdDate: txn.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("getMrBikeMoneyTransactions error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// Keeps the customer's FCM registration current. The app sends a token at
// login, but FCM rotates tokens (reinstall-restore, data clear, periodic
// refresh) without a new login — a stale token makes every push, campaigns
// included, fail with "Requested entity was not found" while the app is
// backgrounded or killed. The app calls this on start and on onTokenRefresh.
async function registerCustomerToken(req, res) {
  try {
    const user_id = req.user_id;
    if (!user_id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { device_token } = req.body;
    if (!device_token || typeof device_token !== "string" || device_token.trim() === "") {
      return res.status(400).json({ success: false, message: "device_token is required" });
    }

    const customer = await customers.findByIdAndUpdate(
      user_id,
      { device_token: device_token.trim() },
      { new: true, select: "_id" }
    );
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.status(200).json({ success: true, message: "Device token registered successfully" });
  } catch (error) {
    console.error("registerCustomerToken error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  addProfile,
  customerlist,
  deletecustomer,
  editcustomer,
  getcustomer,
  getCustomerById,
  getReferredCustomers,
  changeImage,
  updateUserBike,
  getMyBikes,
  deleteMyBike,
  addUserBike,
  getcustomersData,
  getMyReferralCode,
  validateReferralCode,
  getReferralSummary,
  getReferralTransactions,
  getMrBikeMoneyTransactions,
  registerCustomerToken,
};
