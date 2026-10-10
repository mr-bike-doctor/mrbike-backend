const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
var validation = require("../helper/validation");
const Vendor = require("../models/dealerModel");
const Admin = require("../models/admin_model");
const { getDealerStatus } = require("../helper/dealerStatus");
const {
  DEFAULT_SERVICE_RADIUS_KM,
  MIN_SERVICE_RADIUS_KM,
  MAX_SERVICE_RADIUS_KM,
  getDealerServiceRadiusKm,
  parseServiceRadiusKm,
} = require("../helper/dealerServiceRadius");
const { buildVerificationStatus } = require("../helper/dealerDocumentStatus");
const { sendBookingNotification } = require("../helper/pushNotification");
const { logDealerActivity } = require("../helper/dealerActivityLog");
const NotificationModel = require("../models/Notification");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { sendemails } = require("../helper/helper");
const twilio = require("twilio");
const { isDealerTestPhone, isDealerTestOtpValid } = require("../helper/playStoreTestAccounts");
const { reserveOtpRequest, finalizeSuccessfulOtpRequest, releaseOtpReservation, getNormalizedPhone } = require("../helper/otpRateLimiter");

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const verifySid  = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!verifySid) throw new Error("[Twilio] TWILIO_VERIFY_SERVICE_SID is undefined — check .env on server");
  if (!accountSid) throw new Error("[Twilio] TWILIO_ACCOUNT_SID is undefined — check .env on server");
  return twilio(accountSid, authToken);
}

async function sendOtp(req, res) {
  return res.status(410).json({
    success: false,
    message: "This endpoint is deprecated. Use /bikedoctor/dealerAuth/signin for production OTP.",
  });
}

// async function usersignin(req, res) {
//   try {
//     const { phone, ftoken, device_token } = req.body;

//     if (!phone) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number is required!'
//       });
//     }

//     let dealer = await Vendor.findOne({ phone, isActive: true, isBlock: false });

//     const otpData = await otpAuth.otp(phone);
//     const otp = otpData.otp;

//     if (!dealer) {
//       dealer = new Vendor({
//         phone,
//         otp,
//         ftoken,
//         device_token,
//         isActive: true,
//         isVerify: false,
//         isProfile: false,
//         isDoc: false,
//       });
//     } else {
//       dealer.otp = otp;
//       dealer.ftoken = ftoken;
//       dealer.device_token = device_token;
//       dealer.isActive = true;
//     }

//     await dealer.save();

//     res.status(dealer.isNew ? 201 : 200).json({
//       success: true,
//       message: 'OTP sent to your mobile.',
//       data: {
//         phone: dealer.phone,
//         isVerify: dealer.isVerify,
//         isDoc: dealer.isDoc,
//         isProfile: dealer.isProfile
//       }
//     });

//   } catch (error) {
//     console.error('Login error:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Internal server error',
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// }

async function usersignin(req, res) {
  try {
    const { phone, ftoken, device_token } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required!",
      });
    }

    let dealer = await Vendor.findOne({ phone });

    if (!dealer) {
      dealer = new Vendor({
        phone,
        ftoken,
        device_token,
        isActive: true,
        isVerify: false,
        isProfile: false,
        isDoc: false,
        wallet: 0,
      });
    } else {
      dealer.ftoken = ftoken || dealer.ftoken;
      dealer.device_token = device_token || dealer.device_token;
      dealer.isActive = true;
    }

    if (isDealerTestPhone(phone)) dealer.isPlayStoreTestAccount = true;
    await dealer.save({ validateModifiedOnly: true });

    // Google Play Review Test Account
    // Do not remove without replacing the Play Store testing process.
    // Fixed reviewer number: never hits Twilio, no OTP is actually sent — the
    // app-side verify step accepts only the hardcoded OTP for this number.
    if (isDealerTestPhone(phone)) {
      return res.status(dealer.isNew ? 201 : 200).json({
        success: true,
        message: "OTP sent to your mobile.",
        data: {
          phone: dealer.phone,
          isVerify: dealer.isVerify,
          isDoc: dealer.isDoc,
          isProfile: dealer.isProfile,
        },
      });
    }

    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
    const phoneNumber = getNormalizedPhone(phone);

    const reservation = await reserveOtpRequest(phoneNumber);
    if (!reservation.allowed) {
      return res.status(429).json({
        success: false,
        message: "OTP request limit reached. Please try again after 6 hours.",
        lockedUntil: reservation.lockedUntil || undefined,
      });
    }

    const twilioClient = getTwilioClient();
    try {
      const sendResult = await twilioClient.verify.v2
        .services(verifySid)
        .verifications
        .create({ to: phoneNumber, channel: "sms" });

      console.log("[dealerAuth/signin] Twilio send status:", sendResult.status, "| SID:", sendResult.sid);
      await finalizeSuccessfulOtpRequest(phoneNumber);
    } catch (twilioError) {
      await releaseOtpReservation(phoneNumber);
      throw twilioError;
    }

    return res.status(dealer.isNew ? 201 : 200).json({
      success: true,
      message: "OTP sent to your mobile.",
      data: {
        phone: dealer.phone,
        isVerify: dealer.isVerify,
        isDoc: dealer.isDoc,
        isProfile: dealer.isProfile,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV === "development"
        ? { error: error.message }
        : {}),
    });
  }
}

async function verifyOTP(req, res) {
  try {
    const { otp, phone } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone number and OTP are required",
      });
    }

    // Google Play Review Test Account
    // Do not remove without replacing the Play Store testing process.
    // Fixed reviewer number: bypasses Twilio entirely and only ever succeeds
    // for the exact hardcoded OTP below. The account is auto-created with
    // minimum fields if it doesn't already exist so reviewers never depend
    // on prior app state. No SMS is sent and no Twilio quota is consumed
    // for this number.
    let isTestAccountLogin = false;
    if (isDealerTestPhone(phone)) {
      if (!isDealerTestOtpValid(phone, otp)) {
        return res.status(401).json({
          success: false,
          message: "Incorrect OTP",
        });
      }
      isTestAccountLogin = true;
    }

    if (!isTestAccountLogin) {
      const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
      const phoneNumber = phone.trim().startsWith("+") ? phone.trim() : `+91${phone.trim()}`;

      const twilioClient = getTwilioClient();
      const verificationCheck = await twilioClient.verify.v2
        .services(verifySid)
        .verificationChecks
        .create({ to: phoneNumber, code: otp });

      if (verificationCheck.status !== "approved") {
        return res.status(401).json({
          success: false,
          message: "Incorrect OTP",
        });
      }
    }

    const dealer = await Vendor.findOne({ phone });

    if (!dealer) {
      const newDealer = new Vendor({
        phone,
        email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@autogen.dr`,
        isVerify: false,
        isProfile: false,
        isDoc: false,
        isActive: true,
        wallet: 0,
        ...(isTestAccountLogin ? { isPlayStoreTestAccount: true } : {}),
      });

      await newDealer.save();

      const token = validation.generateUserToken(newDealer._id, "dealer", "2h");

      return res.status(201).json({
        success: true,
        message: "New user created successfully",
        data: {
          dealer_id: newDealer._id,
          token,
          isNewUser: true,
          status: {
            isVerify: newDealer.isVerify,
            isDoc: newDealer.isDoc,
            isProfile: newDealer.isProfile,
          },
        },
      });
    }

    if (isTestAccountLogin && !dealer.isPlayStoreTestAccount) {
      dealer.isPlayStoreTestAccount = true;
      await dealer.save({ validateModifiedOnly: true });
    }

    const token = validation.generateUserToken(dealer._id, "dealer", "2h");
    // The onboarding wizard only ever runs once. `submittedAt` is set exactly
    // once, by submitForApproval(), when the dealer finishes it — so it (not
    // the legacy isProfile/isDoc/isVerify booleans, which are never updated
    // by the modern approve/reject/verifyDocument flow) is the only reliable
    // signal for "has this dealer completed onboarding at least once."
    // A rejected document post-approval must NEVER re-trigger onboarding —
    // that's what the verification-status API + Document Verification
    // Required screen are for.
    const isNewUser = !dealer.submittedAt;
    const verification = buildVerificationStatus(dealer);

    return res.status(200).json({
      success: true,
      message: isNewUser ? "Signup in progress" : "Login successful",
      data: {
        dealer_id: dealer._id,
        token,
        isNewUser,
        status: {
          isVerify: dealer.isVerify,
          isDoc: dealer.isDoc,
          isProfile: dealer.isProfile,
        },
        dealerStatus: getDealerStatus(dealer),
        registrationStatus: dealer.registrationStatus,
        verificationStatus: verification.overallStatus,
        documents: verification.documents,
      },
    });
  } catch (error) {
    console.error("OTP verification error:", error);

    if (error.code === 11000) {
      if (error.keyPattern && error.keyPattern.phone) {
        return res.status(409).json({
          success: false,
          message: "Phone number already registered",
        });
      }
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV === "development" && { error: error.message }),
    });
  }
}

async function changePassword(req, res) {
  try {
    const { new_password, confirm_password } = req.body;

    const dealers = await Vendor.findById(req.dealer._id).select("+password");

    if (!dealers) {
      return res.status(201).send({
        status: 201,
        message: "Dealer not found",
      });
    }

    if (validation.comparePassword(dealers.password, new_password)) {
      return res.status(201).send({
        status: 201,
        message: "New Password can not Same as Old Password",
      });
    }

    if (new_password != confirm_password) {
      return res.status(201).send({
        status: 201,
        message: "Password Not Matched",
      });
    }

    const datas = {
      password: validation.hashPassword(new_password),
    };

    var where = { _id: dealers._id };

    Vendor.findByIdAndUpdate(
      where,
      { $set: datas },
      { new: true },
      async (err, docs) => {
        if (err) {
          return res.status(201).send({
            status: 201,
            message: err,
          });
        } else {
          return res.status(200).send({
            status: 200,
            message: "Dealer Password Updated Successfully",
            // data: docs,
          });
        }
      },
    );
  } catch (error) {
    console.log("error", error);
    return res.status(201).send({
      status: 201,
      message: "Operation was not successful",
    });
  }
}

async function logout(req, res) {
  try {
    const dealerId = String(req.dealer._id);
    console.log(`[DEALER_LOGOUT] dealerId=${dealerId}`);

    // `online` is the dealer-controlled availability flag used by customer
    // discovery and booking eligibility.  Logout must never alter approval,
    // verification, account status, or any dealer business data.
    //
    // The device/FCM registration is cleared in the SAME atomic write as the
    // availability flip, so there is no window where the dealer is already
    // offline but a booking push can still be addressed to the device that
    // just logged out.  These fields are re-registered on the next login by
    // POST /bikedoctor/dealer/register-token (see registerDealerToken), which
    // the app calls right after verifyOTP — so clearing them here only ends
    // THIS device's session, it does not disable notifications for the dealer
    // permanently and does not touch any other dealer's registration.
    //
    // `activeSince`/`lastSeen` mirror what setDealerOnline(active:false) writes,
    // so a logout and a manual "go offline" leave identical availability state.
    await Vendor.findByIdAndUpdate(dealerId, {
      $set: {
        online: false,
        activeSince: null,
        lastSeen: new Date(),
        device_token: null,
        ftoken: null,
      },
    });
    console.log(
      `[DEALER_LOGOUT] dealerId=${dealerId} availability=offline, device/FCM registration cleared`
    );

    // A still-connected app must stop receiving dealer-only events after
    // logout. This does not disconnect unrelated customer/admin sockets.
    // Re-joining is blocked by the `booking:joinDealer` eligibility check in
    // server.js, which refuses rooms for a dealer that is not currently online.
    const io = req.app.get("io");
    if (io) {
      io.in(`dealer:${dealerId}`).socketsLeave(`dealer:${dealerId}`);
    }

    res
      .status(200)
      .cookie("token", null, { expires: new Date(Date.now()), httpOnly: true })
      .cookie("accessToken", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
      })
      .cookie("refreshToken", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
      })
      .cookie("authSession", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
      })
      .cookie("refreshTokenID", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
      })
      .json({
        success: true,
        message: "Logged out",
      });
  } catch (error) {
    console.error("[DEALER_LOGOUT] failed", error);
    return res.status(500).send({
      status: 500,
      message: "Operation was not successful",
    });
  }
}

async function getProgress(req, res) {
  try {
    // 1. Extract and validate token format
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization header with Bearer token required",
      });
    }

    const token = authHeader.split(" ")[1];

    // 2. Verify token with same secret used in generation
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      ignoreExpiration: false,
    });

    console.log("Decoded Token:", decoded);

    // 3. Check for required fields in payload
    if (!decoded.user_id) {
      return res.status(401).json({
        success: false,
        message: "Token missing required user_id field",
      });
    }

    // 4. Find vendor (now using user_id instead of _id)
    const vendor = await Vendor.findById(decoded.user_id);
    // .select("formProgress completionTimestamps isActive adminApproved");
    // .select("formProgress completionTimestamps");

    console.log("Vendor detaials", vendor);

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // 5. Build completedSteps with backward-compat for approved dealers
    const completedSteps = Object.fromEntries(vendor.formProgress.completedSteps);
    if (
      vendor.registrationStatus === "Approved" &&
      completedSteps.liveVerification === undefined
    ) {
      completedSteps.liveVerification = true;
    }

    // Build a Map-like proxy so determineNextStep can use .get()
    const completedStepsMap = {
      get: (key) => completedSteps[key],
    };

    res.status(200).json({
      success: true,
      totalSteps: 6,
      currentStep: vendor.formProgress.currentStep,
      nextStep: determineNextStep(completedStepsMap),
      completedSteps,
      timestamps: vendor.completionTimestamps,
      status: {
        adminApproved: vendor.status.adminApproved || false,
        isActive: vendor.status.isActive || false,
        isVerified: vendor.status.isVerified || false,
      },
      dealerStatus: getDealerStatus(vendor),
    });
  } catch (error) {
    // Enhanced error handling
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
        details: error.message,
      });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired",
      });
    }

    console.error("Progress Error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching progress",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

function determineNextStep(completedSteps) {
  const stepsOrder = [
    "basicInfo",
    "locationInfo",
    "shopDetails",
    "documents",
    "liveVerification",
    "bankDetails",
  ];
  for (const step of stepsOrder) {
    if (!completedSteps.get(step)) return step;
  }
  return null;
}

async function updateProgress(req, res) {
  try {
    const { section } = req.params;
    const validSections = [
      "basicInfo",
      "locationInfo",
      "shopDetails",
      "documents",
      "liveVerification",
      "bankDetails",
    ];

    if (!validSections.includes(section)) {
      return res.status(400).json({
        success: false,
        message: "Invalid section",
      });
    }

    const update = {
      [`formProgress.completedSteps.${section}`]: true,
      [`completionTimestamps.${section}`]: new Date(),
      "formProgress.lastActiveStep": getStepNumber(section),
      "formProgress.currentStep": getNextStepAfter(section),
    };

    await Vendor.findByIdAndUpdate(req.dealer._id, update);

    res.status(200).json({
      success: true,
      message: "Progress updated successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating progress",
      error: error.message,
    });
  }
}

async function updateBasicInfo(req, res) {
  try {
    const { id } = req.params;
    console.log("Updating basic info for vendor ID:", id);
    const {
      fullName,
      personalEmail,
      phone,
      alternatePhone,
      gender,
      dateOfBirth,
    } = req.body;

    if (!fullName || !personalEmail || !phone) {
      return res.status(400).json({
        success: false,
        message: "Full name, email, and phone are required",
      });
    }

    const vendor = await Vendor.findByIdAndUpdate(
      id,
      {
        ownerName: fullName,
        personalEmail,
        phone,
        alternatePhone,
        gender,
        dob: dateOfBirth,
        "formProgress.completedSteps.basicInfo": true,
      },
      { new: true },
    );

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Basic info updated successfully",
      data: {
        id: vendor._id,
        ownerName: vendor.ownerName,
        email: vendor.personalEmail,
        alternatePhone: vendor.alternatePhone,
        updatedFields: Object.keys(req.body),
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        message: `${field} already exists`,
        field: field,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating basic info",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function updateLocationInfo(req, res) {
  try {
    const { id } = req.params;
    const {
      address,
      shopNumber,
      locality,
      city,
      state,
      pincode,
      latitude,
      longitude,
      isPermanentAddress,
      serviceRadiusKm,
    } = req.body;

    // Validate required fields
    if (!city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: "City, state, and pincode are required",
      });
    }

    // How far around the shop this dealer will accept work. Optional here —
    // omitting it leaves whatever radius is already stored (the schema default
    // of 3 km for a new dealer) untouched. See helper/dealerServiceRadius.js.
    const radius = parseServiceRadiusKm(serviceRadiusKm);
    if (radius.error) {
      return res.status(400).json({
        success: false,
        message: radius.error,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor ID format",
      });
    }

    // Build full address from granular fields or fall back to provided address string
    const builtAddress = [shopNumber, locality, city, state ? `${state} - ${pincode}` : pincode]
      .filter(Boolean)
      .join(", ") || address;

    const updateData = {
      latitude,
      longitude,
      // Granular address fields
      shopNumber: shopNumber || null,
      locality: locality || null,
      city,
      state,
      shopPincode: pincode,
      fullAddress: builtAddress,
      "formProgress.completedSteps.locationInfo": true,
      "completionTimestamps.locationInfo": new Date(),
      updatedAt: new Date(),
    };

    if (radius.provided) {
      updateData.serviceRadiusKm = radius.value;
    }

    // Also maintain legacy address blocks for backward compatibility
    if (isPermanentAddress) {
      updateData.permanentAddress = { address: address || builtAddress, city, state };
    } else {
      updateData.presentAddress = { address: address || builtAddress, city, state };
    }

    const updatedVendor = await Vendor.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    }).select(
      "shopNumber locality city state shopPincode fullAddress presentAddress permanentAddress latitude longitude serviceRadiusKm formProgress completionTimestamps",
    );

    if (!updatedVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Location info updated successfully",
      data: {
        shopNumber: updatedVendor.shopNumber,
        locality: updatedVendor.locality,
        city: updatedVendor.city,
        state: updatedVendor.state,
        pincode: updatedVendor.shopPincode,
        fullAddress: updatedVendor.fullAddress,
        coordinates: {
          latitude: updatedVendor.latitude,
          longitude: updatedVendor.longitude,
        },
        serviceRadiusKm: getDealerServiceRadiusKm(updatedVendor),
        progress: {
          completed: updatedVendor.formProgress.completedSteps.locationInfo,
          lastUpdated: updatedVendor.completionTimestamps.locationInfo,
        },
      },
    });
  } catch (error) {
    console.error("Location update error:", error);

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating location info",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

/**
 * GET/PUT the dealer's own service radius.
 *
 * The radius is how far from the shop this garage is willing to serve; a user
 * outside it never sees the garage or its services in the User App. Lives on
 * its own endpoint (rather than only inside location-info) so the Dealer App
 * can offer a standalone "Service Area" setting after onboarding, without
 * re-submitting the whole address. Admin-side edits go through
 * PUT /dealer/editDealer, which writes the same field.
 */
async function getServiceRadius(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor ID format",
      });
    }

    const vendor = await Vendor.findById(id).select("serviceRadiusKm");
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service radius fetched successfully",
      data: {
        serviceRadiusKm: getDealerServiceRadiusKm(vendor),
        defaultRadiusKm: DEFAULT_SERVICE_RADIUS_KM,
        minRadiusKm: MIN_SERVICE_RADIUS_KM,
        maxRadiusKm: MAX_SERVICE_RADIUS_KM,
      },
    });
  } catch (error) {
    console.error("Get service radius error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching service radius",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function updateServiceRadius(req, res) {
  try {
    const { id } = req.params;
    const { serviceRadiusKm } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor ID format",
      });
    }

    const radius = parseServiceRadiusKm(serviceRadiusKm);
    if (radius.error) {
      return res.status(400).json({ success: false, message: radius.error });
    }
    if (!radius.provided) {
      return res.status(400).json({
        success: false,
        message: "serviceRadiusKm is required",
      });
    }

    const updatedVendor = await Vendor.findByIdAndUpdate(
      id,
      { $set: { serviceRadiusKm: radius.value } },
      { new: true, runValidators: true },
    ).select("serviceRadiusKm");

    if (!updatedVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service radius updated successfully",
      data: {
        serviceRadiusKm: getDealerServiceRadiusKm(updatedVendor),
        defaultRadiusKm: DEFAULT_SERVICE_RADIUS_KM,
        minRadiusKm: MIN_SERVICE_RADIUS_KM,
        maxRadiusKm: MAX_SERVICE_RADIUS_KM,
      },
    });
  } catch (error) {
    console.error("Service radius update error:", error);

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error updating service radius",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function updateShopDetails(req, res) {
  try {
    const { id } = req.params;
    const { shopName, shopEmail, shopContact, holiday, storeDescription, openingTime, closingTime } = req.body;

    console.log(
      `[updateShopDetails] Updating shop details for vendor ID: ${id}`,
    );
    console.log(`[updateShopDetails] Received files:`, req.files);

    const shopImages = req.files?.map((file) => file.location) || [];
    console.log(
      `[updateShopDetails] Extracted shop image locations:`,
      shopImages,
    );
    console.log(`[updateShopDetails] Request body:`, req.body);

    // Validate required fields
    if (!shopName || !shopEmail || !shopContact) {
      console.warn(
        `[updateShopDetails] Validation failed: Missing required fields for vendor ID: ${id}`,
      );
      return res.status(400).json({
        success: false,
        message: "Vendor ID, shop name, email, and contact are required",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(shopEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid shop email",
      });
    }

    const updateData = {
      $set: {
        shopName,
        shopEmail,
        shopContact,
        holiday,
        "formProgress.completedSteps.shopDetails": true,
        "completionTimestamps.shopDetails": new Date(),
        updatedAt: new Date(),
      },
    };

    if (storeDescription !== undefined) updateData.$set.storeDescription = storeDescription;
    if (openingTime !== undefined) updateData.$set["businessHours.open"] = openingTime;
    if (closingTime !== undefined) updateData.$set["businessHours.close"] = closingTime;

    if (shopImages.length > 0) {
      updateData.$push = { shopImages: { $each: shopImages } };
    }

    console.log(
      `[updateShopDetails] Update data prepared:`,
      JSON.stringify(updateData, null, 2),
    );

    const updatedVendor = await Vendor.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    }).select(
      "shopName shopEmail shopContact holiday storeDescription businessHours shopImages formProgress completionTimestamps",
    );

    if (!updatedVendor) {
      console.error(`[updateShopDetails] Vendor not found for ID: ${id}`);
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    console.log(
      `[updateShopDetails] Successfully updated vendor ID: ${id}. New image count: ${updatedVendor.shopImages.length}`,
    );

    res.status(200).json({
      success: true,
      message: "Shop details updated successfully",
      data: {
        shopDetails: {
          name: updatedVendor.shopName,
          email: updatedVendor.shopEmail,
          contact: updatedVendor.shopContact,
          holiday: updatedVendor.holiday,
          storeDescription: updatedVendor.storeDescription,
          openingTime: updatedVendor.businessHours?.open,
          closingTime: updatedVendor.businessHours?.close,
          imageCount: updatedVendor.shopImages.length,
        },
        progress: {
          completed: updatedVendor.formProgress.completedSteps.shopDetails,
          lastUpdated: updatedVendor.completionTimestamps.shopDetails,
        },
      },
    });
  } catch (error) {
    console.error("Shop update error:", error);

    // Handle duplicate key errors
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Shop email already exists",
        field: "shopEmail",
      });
    }

    // Handle validation errors
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating shop details",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

// async function uploadDocuments(req, res) {
//   try {
//     const { id } = req.params;
//     const files = req.files;

//     // Check if any files were uploaded
//     if (!files || Object.keys(files).length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "No documents were uploaded"
//       });
//     }

//     const updates = {
//       updatedAt: new Date(),
//       "formProgress.completedSteps.documents": true,
//       "completionTimestamps.documents": new Date()
//     };

//     // Add document paths only for the files that were actually uploaded
//     if (files.aadharFront) updates["documents.aadharFront"] = files.aadharFront[0].path;
//     if (files.aadharBack) updates["documents.aadharBack"] = files.aadharBack[0].path;
//     if (files.panCard) updates["documents.panCard"] = files.panCard[0].path;
//     if (files.shopCertificate) updates["documents.shopCertificate"] = files.shopCertificate[0].path;

//     const updatedVendor = await Vendor.findByIdAndUpdate(
//       id,
//       updates,
//       {
//         new: true,
//         runValidators: true
//       }
//     ).select('documents formProgress completionTimestamps');

//     if (!updatedVendor) {
//       return res.status(404).json({
//         success: false,
//         message: "Vendor not found"
//       });
//     }

//     res.status(200).json({
//       success: true,
//       message: "Documents uploaded successfully",
//       data: {
//         documents: {
//           aadharFront: !!updatedVendor.documents.aadharFront,
//           aadharBack: !!updatedVendor.documents.aadharBack,
//           panCard: !!updatedVendor.documents.panCard,
//           shopCertificate: !!updatedVendor.documents.shopCertificate
//         },
//         progress: {
//           completed: updatedVendor.formProgress.completedSteps.documents,
//           lastUpdated: updatedVendor.completionTimestamps.documents
//         }
//       }
//     });

//   } catch (error) {
//     console.error('Document upload error:', error);

//     // Handle file system errors
//     if (error.code === 'ENOENT') {
//       return res.status(500).json({
//         success: false,
//         message: "Error storing documents - file system error"
//       });
//     }

//     // Handle validation errors
//     if (error.name === 'ValidationError') {
//       return res.status(400).json({
//         success: false,
//         message: "Document validation failed",
//         errors: Object.values(error.errors).map(e => e.message)
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: "Error uploading documents",
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// }

// async function updateBankDetails(req, res) {
//   try {
//     const { accountHolderName, accountNumber, ifscCode, bankName } = req.body;
//     const passbookImage = req.file?.path;

//     if (!accountHolderName || !accountNumber || !ifscCode || !bankName || !passbookImage) {
//       return res.status(400).json({
//         success: false,
//         message: "All bank details and passbook image are required"
//       });
//     }

//     await Vendor.findByIdAndUpdate(
//       req.user._id,
//       {
//         bankDetails: { accountHolderName, accountNumber, ifscCode, bankName },
//         "documents.passbookImage": passbookImage,
//         "formProgress.completedSteps.bankDetails": true
//       }
//     );

//     res.status(200).json({
//       success: true,
//       message: "Bank details updated successfully"
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: "Error updating bank details",
//       error: error.message
//     });
//   }
// };

// Registration Submission & Status

// async function uploadDocuments(req, res) {
//   try {
//     const { id } = req.params;
//     const files = req.files;
//     const { aadharCardNo, panCardNo, shopOpeningDate } = req.body;

//     if (!files || Object.keys(files).length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "No documents were uploaded"
//       });
//     }

//     const updates = {
//       updatedAt: new Date(),
//       "formProgress.completedSteps.documents": true,
//       "completionTimestamps.documents": new Date()
//     };

//     // ✅ Add uploaded file paths
//     if (files.aadharFront) updates["documents.aadharFront"] = files.aadharFront[0].path;
//     if (files.aadharBack) updates["documents.aadharBack"] = files.aadharBack[0].path;
//     if (files.panCard) updates["documents.panCardFront"] = files.panCard[0].path;
//     if (files.shopCertificate) updates["documents.shopCertificate"] = files.shopCertificate[0].path;
//     if (files.faceVerificationImage) updates["documents.faceVerificationImage"] = files.faceVerificationImage[0].path;

//     // ✅ Add text fields if provided
//     if (aadharCardNo) updates["aadharCardNo"] = aadharCardNo;
//     if (panCardNo) updates["panCardNo"] = panCardNo;
//     if (shopOpeningDate) updates["shopOpeningDate"] = new Date(shopOpeningDate);

//     const updatedVendor = await Vendor.findByIdAndUpdate(
//       id,
//       updates,
//       { new: true, runValidators: true }
//     ).select('documents aadharCardNo panCardNo shopOpeningDate formProgress completionTimestamps');

//     if (!updatedVendor) {
//       return res.status(404).json({
//         success: false,
//         message: "Vendor not found"
//       });
//     }

//     res.status(200).json({
//       success: true,
//       message: "Documents and info uploaded successfully",
//       data: {
//         documents: updatedVendor.documents,
//         aadharCardNo: updatedVendor.aadharCardNo,
//         panCardNo: updatedVendor.panCardNo,
//         shopOpeningDate: updatedVendor.shopOpeningDate,
//         progress: {
//           completed: updatedVendor.formProgress.completedSteps.documents,
//           lastUpdated: updatedVendor.completionTimestamps.documents
//         }
//       }
//     });

//   } catch (error) {
//     console.error('Document upload error:', error);

//     if (error.code === 'ENOENT') {
//       return res.status(500).json({
//         success: false,
//         message: "Error storing documents - file system error"
//       });
//     }

//     if (error.name === 'ValidationError') {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         errors: Object.values(error.errors).map(e => e.message)
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: "Error uploading documents",
//       error: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// }

async function uploadDocuments(req, res) {
  try {
    const { id } = req.params;
    const files = req.files;
    const { aadharCardNo, panCardNo, shopOpeningDate } = req.body;

    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No documents were uploaded",
      });
    }

    // Fetch current vendor to check existing statuses
    const currentVendor = await Vendor.findById(id).select(
      "documentVerification formProgress",
    );
    if (!currentVendor) {
      return res
        .status(404)
        .json({ success: false, message: "Vendor not found" });
    }

    // A document already verified can only be re-uploaded once admin
    // explicitly requests it again (documentVerification flips to "requested").
    const currentDV = currentVendor.documentVerification || {};
    const fileToVerificationKey = {
      aadharFront: "aadharFront",
      aadharBack: "aadharBack",
      panCard: "pan",
      shopCertificate: "shop",
      faceVerificationImage: "face",
    };
    const uploadedVerificationKeys = Object.entries(fileToVerificationKey)
      .filter(([fileField]) => files[fileField])
      .map(([, verificationKey]) => verificationKey);

    const lockedDocs = uploadedVerificationKeys.filter(
      (verificationKey) => currentDV[verificationKey] === "verified",
    );

    if (lockedDocs.length > 0) {
      return res.status(400).json({
        success: false,
        message: `These documents are already verified and can only be re-uploaded if requested by admin: ${lockedDocs.join(", ")}`,
      });
    }

    const updates = {
      updatedAt: new Date(),
    };

    // ✅ Add uploaded file paths
    if (files.aadharFront)
      updates["documents.aadharFront"] = files.aadharFront[0].location;
    if (files.aadharBack)
      updates["documents.aadharBack"] = files.aadharBack[0].location;
    if (files.panCard)
      updates["documents.panCardFront"] = files.panCard[0].location;
    if (files.shopCertificate)
      updates["documents.shopCertificate"] = files.shopCertificate[0].location;
    if (files.faceVerificationImage)
      updates["documents.faceVerificationImage"] =
        files.faceVerificationImage[0].location;

    // ✅ Add text fields if provided
    if (aadharCardNo) updates["aadharCardNo"] = aadharCardNo;
    if (panCardNo) updates["panCardNo"] = panCardNo;
    if (shopOpeningDate) updates["shopOpeningDate"] = new Date(shopOpeningDate);

    // --- Update document flags and check for remaining rejections ---
    const dv = currentVendor.documentVerification || {};
    const newDV = { ...(dv.toObject?.() || dv) };

    updates.isDoc = true;
    if (files.aadharFront) newDV.aadharFront = "pending";
    if (files.aadharBack) newDV.aadharBack = "pending";
    if (files.panCard) newDV.pan = "pending";
    if (files.shopCertificate) newDV.shop = "pending";
    if (files.faceVerificationImage) newDV.face = "pending";

    // Map the new statuses back to updates
    Object.keys(newDV).forEach((key) => {
      updates[`documentVerification.${key}`] = newDV[key];
    });

    // Re-uploading a document the admin rejected/requested puts the dealer
    // back into the "waiting for admin review" state. Recorded explicitly
    // because the rejection note below is about to be cleared, and a bare
    // "pending" status no longer means the dealer is waiting on anyone.
    const reUploadedAfterAction = uploadedVerificationKeys.some((verificationKey) =>
      ["rejected", "requested"].includes(currentDV[verificationKey]),
    );
    if (reUploadedAfterAction) {
      updates["reVerification.active"] = true;
      updates["reVerification.startedAt"] = new Date();
    }

    // A re-upload resolves any outstanding admin request for that document —
    // clear it so only still-active requests remain.
    if (uploadedVerificationKeys.length > 0) {
      updates.$unset = {};
      uploadedVerificationKeys.forEach((verificationKey) => {
        updates.$unset[`documentRequests.${verificationKey}`] = "";
      });
    }

    // Check if any required doc is still "rejected"
    const hasRejected = [
      "aadharFront",
      "aadharBack",
      "pan",
      "shop",
      "face",
    ].some((k) => newDV[k] === "rejected");

    if (hasRejected) {
      updates["formProgress.completedSteps.documents"] = false;
    } else {
      updates["formProgress.completedSteps.documents"] = true;
      updates["completionTimestamps.documents"] = new Date();
    }

    const updatedVendor = await Vendor.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).select(
      "documents aadharCardNo panCardNo shopOpeningDate formProgress completionTimestamps isDoc documentVerification",
    );

    if (!updatedVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Documents and info uploaded successfully",
      data: {
        documents: updatedVendor.documents,
        aadharCardNo: updatedVendor.aadharCardNo,
        panCardNo: updatedVendor.panCardNo,
        shopOpeningDate: updatedVendor.shopOpeningDate,
        progress: {
          completed: updatedVendor.formProgress.completedSteps.documents,
          lastUpdated: updatedVendor.completionTimestamps.documents,
        },
        isDoc: updatedVendor.isDoc,
        documentVerification: updatedVendor.documentVerification,
      },
    });
  } catch (error) {
    console.error("Document upload error:", error);

    if (error.code === "ENOENT") {
      return res.status(500).json({
        success: false,
        message: "Error storing documents - file system error",
      });
    }

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    res.status(500).json({
      success: false,
      message: "Error uploading documents",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function updateBankDetails(req, res) {
  try {
    const { id } = req.params;
    const { accountHolderName, accountNumber, ifscCode, bankName, upiId } = req.body;
    const passbookImage = req.file?.location || req.file?.path;

    // Validate required fields
    if (
      !accountHolderName ||
      !accountNumber ||
      !ifscCode ||
      !bankName ||
      !passbookImage
    ) {
      return res.status(400).json({
        success: false,
        message: "All bank details and passbook image are required",
      });
    }

    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor ID format",
      });
    }

    // Validate IFSC code format (example validation)
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid IFSC code format",
      });
    }

    // Validate account number (basic check)
    if (!/^\d{9,18}$/.test(accountNumber)) {
      return res.status(400).json({
        success: false,
        message: "Account number must be 9-18 digits",
      });
    }

    // A passbook already verified can only be re-uploaded once admin
    // explicitly requests it again — same rule uploadDocuments() applies to
    // the other documents.
    const currentVendor = await Vendor.findById(id).select("documentVerification");
    if (!currentVendor) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }
    if ((currentVendor.documentVerification || {}).passbook === "verified") {
      return res.status(400).json({
        success: false,
        message: "Passbook is already verified and can only be re-uploaded if requested by admin",
      });
    }

    const bankDetailsUpdate = {
      accountHolderName,
      accountNumber,
      ifscCode,
      bankName,
      passbookImage,
    };
    if (upiId !== undefined) bankDetailsUpdate.upiId = upiId;

    const updatedVendor = await Vendor.findByIdAndUpdate(
      id,
      {
        bankDetails: bankDetailsUpdate,
        "formProgress.completedSteps.bankDetails": true,
        "completionTimestamps.bankDetails": new Date(),
        "documentVerification.passbook": "pending",
        updatedAt: new Date(),
        $unset: { "documentRequests.passbook": "" },
      },
      {
        new: true,
        runValidators: true,
      },
    ).select("bankDetails formProgress completionTimestamps documentVerification");

    if (!updatedVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Bank details updated successfully",
      data: {
        bankDetails: updatedVendor.bankDetails,
        hasPassbookImage: !!updatedVendor.bankDetails?.passbookImage,
        progress: {
          completed: updatedVendor.formProgress.completedSteps.bankDetails,
          lastUpdated: updatedVendor.completionTimestamps.bankDetails,
        },
        documentVerification: updatedVendor.documentVerification,
      },
    });
  } catch (error) {
    console.error("Bank details update error:", error);

    // Handle duplicate account errors
    if (error.code === 11000 && error.keyPattern?.bankDetails?.accountNumber) {
      return res.status(409).json({
        success: false,
        message: "Bank account already registered",
        field: "accountNumber",
      });
    }

    // Handle validation errors
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Bank details validation failed",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating bank details",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function uploadLiveVerification(req, res) {
  try {
    const { id } = req.params;
    const { latitude, longitude, timestamp } = req.body;
    const shopLivePhoto = req.file?.location || req.file?.path;

    if (!shopLivePhoto) {
      return res.status(400).json({
        success: false,
        message: "shopLivePhoto image is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor ID format",
      });
    }

    const liveVerificationData = {
      shopLivePhoto,
      capturedAt: new Date(),
    };
    if (latitude !== undefined) liveVerificationData.latitude = parseFloat(latitude);
    if (longitude !== undefined) liveVerificationData.longitude = parseFloat(longitude);
    if (timestamp) liveVerificationData.timestamp = new Date(timestamp);

    const updatedVendor = await Vendor.findByIdAndUpdate(
      id,
      {
        liveVerification: liveVerificationData,
        "formProgress.completedSteps.liveVerification": true,
        "completionTimestamps.liveVerification": new Date(),
        updatedAt: new Date(),
      },
      { new: true, runValidators: true },
    ).select("liveVerification formProgress completionTimestamps");

    if (!updatedVendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Live verification uploaded successfully",
      data: {
        liveVerification: updatedVendor.liveVerification,
        progress: {
          completed: updatedVendor.formProgress.completedSteps.get("liveVerification"),
          lastUpdated: updatedVendor.completionTimestamps.liveVerification,
        },
      },
    });
  } catch (error) {
    console.error("Live verification upload error:", error);

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    res.status(500).json({
      success: false,
      message: "Error uploading live verification",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function submitForApproval(req, res) {
  try {
    const { id } = req.params;
    const vendor = await Vendor.findById(id);
    console.log("Submitting registration for vendor ID:", id);
    console.log("Vendor details:", vendor);
    const allCompleted = Array.from(
      vendor.formProgress.completedSteps.values(),
    ).every((val) => val === true);

    if (!allCompleted) {
      return res.status(400).json({
        success: false,
        message: "Please complete all sections before submitting",
      });
    }

    if (
      !vendor.documents.aadharFront ||
      !vendor.documents.panCardFront ||
      !vendor.documents.shopCertificate
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please upload all required documents (Aadhar Front, PAN Card Front, and Shop Certificate)",
      });
    }

    vendor.registrationStatus = "Pending";
    vendor.submittedAt = new Date();
    await vendor.save();

    res.status(200).json({
      success: true,
      message: "Registration submitted for admin approval",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error submitting registration",
      error: error.message,
    });
  }
}

async function checkApprovalStatus(req, res) {
  try {
    const vendor = await Vendor.findById(req.dealer._id).select(
      "registrationStatus adminNotes submittedAt approvedAt dealerStatus isBlocked isActive status isDoc",
    );

    res.status(200).json({
      success: true,
      status: vendor.registrationStatus,
      dealerStatus: getDealerStatus(vendor),
      adminNotes: vendor.adminNotes,
      submittedAt: vendor.submittedAt,
      approvedAt: vendor.approvedAt,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error checking approval status",
      error: error.message,
    });
  }
}

// Document Re-Verification flow (post-onboarding document corrections).
// This never routes a dealer back into the onboarding wizard — it only
// reports/updates per-document status on top of the existing
// documentVerification/documentRequests fields.

async function getVerificationStatus(req, res) {
  try {
    const vendor = await Vendor.findById(req.dealer._id).select(
      "registrationStatus dealerStatus isBlocked isActive status isDoc documentVerification documentRequests reVerification documents bankDetails.passbookImage adminNotes submittedAt approvedAt",
    );

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Dealer not found" });
    }

    const verification = buildVerificationStatus(vendor);

    res.status(200).json({
      success: true,
      dealerStatus: getDealerStatus(vendor),
      registrationStatus: vendor.registrationStatus,
      adminNotes: vendor.adminNotes,
      overallVerificationStatus: verification.overallStatus,
      documents: verification.documents,
      approvedDocuments: verification.approvedDocuments,
      pendingDocuments: verification.pendingDocuments,
      rejectedDocuments: verification.rejectedDocuments,
    });
  } catch (error) {
    console.error("getVerificationStatus error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching verification status",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

async function submitReVerification(req, res) {
  try {
    const { id } = req.params;
    const vendor = await Vendor.findById(id).select(
      "documentVerification documentRequests reVerification registrationStatus formProgress shopName ownerName device_token ftoken",
    );

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Dealer not found" });
    }

    const verification = buildVerificationStatus(vendor);

    if (verification.rejectedDocuments.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Please upload the requested document(s) before submitting for review",
        rejectedDocuments: verification.rejectedDocuments,
      });
    }

    if (verification.pendingDocuments.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No re-uploaded documents are awaiting review",
      });
    }

    await Vendor.findByIdAndUpdate(id, {
      "formProgress.completedSteps.documents": true,
      updatedAt: new Date(),
    });

    logDealerActivity({
      dealerId: vendor._id,
      adminId: null,
      action: "Re-verification Submitted",
      reason: `Documents resubmitted for review: ${verification.pendingDocuments.join(", ")}`,
    });

    // Notify admins — reuses the existing Notification model's 'admin'
    // receiver type (already defined for this, just never used until now).
    try {
      const admins = await Admin.find({ status: "active" }).select("_id");
      await Promise.all(
        admins.map((admin) =>
          new NotificationModel({
            title: "Dealer Document Re-Verification",
            body: `${vendor.shopName || vendor.ownerName || "A dealer"} resubmitted document(s) for review: ${verification.pendingDocuments.join(", ")}.`,
            data: { type: "dealer_reverification_submitted", dealerId: String(vendor._id) },
            receiverId: admin._id,
            receiverType: "admin",
            status: "pending",
          }).save(),
        ),
      );
    } catch (notifyErr) {
      console.error("submitReVerification admin notify error:", notifyErr);
    }

    res.status(200).json({
      success: true,
      message: "Documents submitted for review",
      overallVerificationStatus: "waiting_for_review",
      pendingDocuments: verification.pendingDocuments,
    });
  } catch (error) {
    console.error("submitReVerification error:", error);
    res.status(500).json({
      success: false,
      message: "Error submitting documents for review",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

// Admin Endpoints
// async function getPendingRegistrations(req, res) {
//   try {
//     const pendingVendors = await Vendor.find({ registrationStatus: 'Pending' }).lean();

//     console.log("pendingVendors", pendingVendors)

//     // Map through vendors to ensure status structure is consistent
//     const formattedVendors = pendingVendors.map(vendor => {
//       return {
//         ...vendor,
//         status: {
//           adminApproved: vendor.status?.adminApproved || false,
//           isActive: vendor.status?.isActive || false,
//           isVerified: vendor.status?.isVerified || false
//         }
//       };
//     });

//     res.status(200).json({
//       success: true,
//       count: formattedVendors.length,
//       vendors: formattedVendors
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: "Error fetching pending registrations",
//       error: error.message
//     });
//   }
// };

async function getPendingRegistrations(req, res) {
  try {
    const pendingVendors = await Vendor.find({
      registrationStatus: "Pending",
      $or: [
        { "status.adminApproved": false },
        { "status.isActive": false },
        { "status.isVerified": false },
      ],
    }).lean();

    res.status(200).json({
      success: true,
      count: pendingVendors.length,
      vendors: pendingVendors,
    });
  } catch (error) {
    console.error("Error fetching pending registrations:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching pending registrations",
      error: error.message,
    });
  }
}

async function getDealerDetails(req, res) {
  try {
    const vendor = await Vendor.findById(req.params.id).select(
      "-password -otp -otpExpiry",
    );

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      vendor,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching vendor details",
      error: error.message,
    });
  }
}

async function verifyDocument(req, res) {
  try {
    const { id } = req.params;
    const { docType, status, reason } = req.body;

    const validDocTypes = ["aadharFront", "aadharBack", "pan", "shop", "face", "passbook"];
    // Admin can request/verify/reject one or more documents in a single call.
    const docTypes = Array.isArray(docType) ? docType : [docType];
    if (docTypes.length === 0 || docTypes.some((dt) => !validDocTypes.includes(dt))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid document type" });
    }

    // Map boolean status to string if necessary (for backward compatibility during transition)
    let verificationStatus = status;
    if (status === true) verificationStatus = "verified";
    if (status === false) verificationStatus = "rejected";

    const validStatuses = ["pending", "verified", "rejected", "none", "requested"];
    if (!validStatuses.includes(verificationStatus)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid verification status" });
    }

    if ((verificationStatus === "requested" || verificationStatus === "rejected") && !reason) {
      return res.status(400).json({
        success: false,
        message: "A reason is required when rejecting or requesting a document",
      });
    }

    const updates = {};
    const clearedRequestKeys = [];
    docTypes.forEach((dt) => {
      updates[`documentVerification.${dt}`] = verificationStatus;
      if (verificationStatus === "requested" || verificationStatus === "rejected") {
        // Same shape covers both cases: an outstanding admin note the dealer
        // must act on (re-upload), surfaced via getVerificationStatus.
        updates[`documentRequests.${dt}`] = {
          reason,
          requestedBy: req.admin_id,
          requestedAt: new Date(),
        };
      } else if (verificationStatus === "verified") {
        // Resolved — any earlier rejection/request note no longer applies.
        clearedRequestKeys.push(dt);
      }
    });
    if (clearedRequestKeys.length > 0) {
      updates.$unset = {};
      clearedRequestKeys.forEach((dt) => {
        updates.$unset[`documentRequests.${dt}`] = "";
      });
    }

    // Refresh current vendor state to check all documents
    const currentVendor = await Vendor.findById(id).select(
      "documentVerification formProgress",
    );
    if (!currentVendor) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }
    const dv = currentVendor.documentVerification || {};
    const newDV = { ...(dv.toObject?.() || dv) };
    docTypes.forEach((dt) => {
      newDV[dt] = verificationStatus;
    });

    // If any document is rejected, mark the documents section as incomplete
    const anyRejected = [
      "aadharFront",
      "aadharBack",
      "pan",
      "shop",
      "face",
      "passbook",
    ].some((k) => newDV[k] === "rejected");
    const allVerified = [
      "aadharFront",
      "aadharBack",
      "pan",
      "shop",
      "face",
      "passbook",
    ].every((k) => newDV[k] === "verified");

    if (anyRejected) {
      updates["formProgress.completedSteps.documents"] = false;
      updates["isVerify"] = false;
      updates["status.isVerified"] = false;
    } else if (allVerified) {
      updates["formProgress.completedSteps.documents"] = true;
      updates["completionTimestamps.documents"] = new Date();
      updates["isVerify"] = true;
      updates["status.isVerified"] = true;
      updates["isDoc"] = true;
    }

    // Open/close the post-approval re-verification cycle. While it is open the
    // dealer is held on the Document Verification Required / Waiting For Admin
    // Review screens; once nothing needs their action any more we close it so
    // a document left at "pending" doesn't keep them locked out of the app.
    const anyNeedsAction = [
      "aadharFront",
      "aadharBack",
      "pan",
      "shop",
      "face",
      "passbook",
    ].some((k) => newDV[k] === "rejected" || newDV[k] === "requested");

    if (anyNeedsAction) {
      updates["reVerification.active"] = true;
      updates["reVerification.startedAt"] = new Date();
    } else {
      updates["reVerification.active"] = false;
    }

    const vendor = await Vendor.findByIdAndUpdate(id, updates, {
      new: true,
    }).select("documentVerification documentRequests reVerification formProgress device_token ftoken isVerify status isDoc");

    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: "Vendor not found" });
    }

    const docToken = vendor.device_token || vendor.ftoken;
    if (docToken) {
      const docLabel = docTypes.join(", ");
      const docEventMap = {
        requested: {
          title: "Document Requested",
          body: `Admin requested re-upload of: ${docLabel}.${reason ? ` Reason: ${reason}` : ""}`,
          type: "document_requested",
        },
        verified: {
          title: "Document Approved",
          body: `Your document(s) were approved: ${docLabel}.`,
          type: "document_approved",
        },
        rejected: {
          title: "Document Rejected",
          body: `Your document(s) were rejected: ${docLabel}.`,
          type: "document_rejected",
        },
      };
      const docEvent = docEventMap[verificationStatus];
      if (docEvent) {
        sendBookingNotification({
          token: docToken,
          title: docEvent.title,
          body: docEvent.body,
          data: { type: docEvent.type, docTypes: docLabel },
          receiverId: id,
          receiverType: "dealer",
        });
      }
    }

    const docActionMap = {
      requested: "Document Requested",
      verified: "Document Approved",
      rejected: "Document Rejected",
    };
    const docAction = docActionMap[verificationStatus];
    if (docAction) {
      logDealerActivity({
        dealerId: id,
        adminId: req.admin_id,
        action: docAction,
        reason: reason || null,
      });
    }

    res.status(200).json({
      success: true,
      message: `Document status updated to ${verificationStatus} successfully`,
      documentVerification: vendor.documentVerification,
      documentRequests: vendor.documentRequests,
      formProgress: vendor.formProgress,
      isVerify: vendor.isVerify,
      status: vendor.status,
    });
  } catch (error) {
    res
      .status(500)
      .json({
        success: false,
        message: "Error updating document status",
        error: error.message,
      });
  }
}

async function approveDealer(req, res) {
  try {
    console.log("Id:- ", req.params.id);

    // First check if vendor exists
    const vendorExists = await Vendor.findById(req.params.id);
    if (!vendorExists) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    console.log("Dealer before update", vendorExists);

    const updateData = {
      registrationStatus: "Approved",
      approvedAt: new Date(),
      isActive: true,
      isVerify: true,
      isDoc: true,
      "status.adminApproved": true,
      "status.isActive": true,
      "status.isVerified": true,
      // Approving the dealer closes any open document re-verification cycle —
      // otherwise documents left at "pending" would keep the dealer stuck on
      // the Waiting For Admin Review screen after approval.
      "reVerification.active": false,
      "formProgress.completedSteps.documents": true,
      "completionTimestamps.documents": new Date(),
    };

    // Auto-verify all documents that were uploaded and not rejected/requested
    const docKeys = ["aadharFront", "aadharBack", "pan", "shop", "face", "passbook"];
    const existingDV = vendorExists.documentVerification || {};
    docKeys.forEach((key) => {
      if (existingDV[key] !== "rejected" && existingDV[key] !== "requested") {
        updateData[`documentVerification.${key}`] = "verified";
      }
    });
    console.log("Update object", updateData);

    const vendor = await Vendor.findByIdAndUpdate(req.params.id, updateData, { new: true });
    console.log("Dealer after update", vendor);

    const approvedToken = vendor.device_token || vendor.ftoken;
    if (approvedToken) {
      sendBookingNotification({
        token: approvedToken,
        title: "Dealer Approved",
        body: "Your dealer registration has been approved.",
        data: { type: "dealer_approved" },
        receiverId: vendor._id,
        receiverType: "dealer",
      });
    }
    logDealerActivity({
      dealerId: vendor._id,
      adminId: req.admin_id,
      action: "Dealer Approved",
      reason: null,
    });

    res.status(200).json({
      success: true,
      message: "Vendor approved successfully",
      data: {
        _id: vendor._id,
        isActive: vendor.isActive,
        status: {
          isActive: vendor.status?.isActive,
          adminApproved: vendor.status?.adminApproved,
        },
        isBlocked: vendor.isBlocked,
        blockedReason: vendor.blockedReason,
        registrationStatus: vendor.registrationStatus,
        dealerStatus: getDealerStatus(vendor),
      },
    });
  } catch (error) {
    console.error("Full error:", error); // Log the complete error
    res.status(500).json({
      success: false,
      message: "Error approving vendor",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
}

// async function rejectDealer(req, res) {
//   try {
//     const { notes } = req.body;

//     const vendor = await Vendor.findByIdAndUpdate(
//       req.params.id,
//       {
//         registrationStatus: 'Rejected',
//         adminNotes: notes,
//         isActive: false,
//         'status.adminApproved': false,
//         'status.isActive': false,
//       },
//       { new: true }
//     );

//     // Send rejection notification
//     await sendRejectionEmail(vendor, notes);

//     res.status(200).json({
//       success: true,
//       message: "Vendor rejected successfully",
//       data: {
//         status: {
//           adminApproved: false,
//           isActive: false,
//           isVerified: vendor.isVerify
//         }
//       }
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: "Error rejecting vendor",
//       error: error.message
//     });
//   }
// };

async function rejectDealer(req, res) {
  try {
    const { notes } = req.body;

    const vendorBefore = await Vendor.findById(req.params.id);
    if (!vendorBefore) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }
    console.log("Dealer before update", vendorBefore);

    const updateData = {
      registrationStatus: "Rejected",
      adminNotes: notes,
      isActive: false,
      "status.adminApproved": false,
      "status.isActive": false,
    };
    console.log("Update object", updateData);

    const vendor = await Vendor.findByIdAndUpdate(req.params.id, updateData, { new: true });
    console.log("Dealer after update", vendor);

    await sendRejectionEmail(vendor, notes);

    const rejectedToken = vendor.device_token || vendor.ftoken;
    if (rejectedToken) {
      sendBookingNotification({
        token: rejectedToken,
        title: "Dealer Rejected",
        body: notes || "Your dealer registration has been rejected.",
        data: { type: "dealer_rejected" },
        receiverId: vendor._id,
        receiverType: "dealer",
      });
    }
    logDealerActivity({
      dealerId: vendor._id,
      adminId: req.admin_id,
      action: "Dealer Rejected",
      reason: notes,
    });

    res.status(200).json({
      success: true,
      message: "Vendor rejected successfully",
      data: {
        _id: vendor._id,
        isActive: vendor.isActive,
        status: {
          isActive: vendor.status?.isActive,
          adminApproved: vendor.status?.adminApproved,
        },
        isBlocked: vendor.isBlocked,
        blockedReason: vendor.blockedReason,
        registrationStatus: vendor.registrationStatus,
        adminNotes: vendor.adminNotes,
        dealerStatus: getDealerStatus(vendor),
      },
    });
  } catch (error) {
    console.error("Reject dealer error:", error);

    res.status(500).json({
      success: false,
      message: "Error rejecting vendor",
      error: error.message,
    });
  }
}

function getStepNumber(section) {
  const stepMap = {
    basicInfo: 1,
    locationInfo: 2,
    shopDetails: 3,
    documents: 4,
    liveVerification: 5,
    bankDetails: 6,
  };
  return stepMap[section];
}

function getNextStepAfter(section) {
  const stepsOrder = [
    "basicInfo",
    "locationInfo",
    "shopDetails",
    "documents",
    "liveVerification",
    "bankDetails",
  ];
  const currentIndex = stepsOrder.indexOf(section);
  return currentIndex < stepsOrder.length - 1
    ? getStepNumber(stepsOrder[currentIndex + 1])
    : 6;
}

// async function notifyAdmin(vendorId) {
//   const admins = await Admin.find({ role: 'admin' }).select("email");
//   const adminEmails = admins.map(admin => admin.email);

//   await sendEmail({
//     to: adminEmails,
//     subject: 'New Vendor Registration Requires Approval',
//     html: `<p>A new vendor registration requires your approval.
//            <a href="${process.env.ADMIN_PORTAL_URL}/vendors/${vendorId}">Review now</a></p>`
//   });
// }

async function sendRejectionEmail(vendor, notes) {
  const emailAddress = vendor.personalEmail;
  const name = vendor.ownerName || "Vendor";
  const message = `Your vendor registration has been rejected.\n\nAdmin Notes: ${notes || "No additional notes provided."}`;
  const subject = "Your Vendor Registration Status - Rejected";

  // Using type 4 which allows custom subject and message
  await sendemails(emailAddress, name, message, 4, subject);
}

module.exports = {
  usersignin,
  sendOtp,
  verifyOTP,
  logout,
  changePassword,
  getProgress,
  updateProgress,
  updateBasicInfo,
  updateLocationInfo,
  getServiceRadius,
  updateServiceRadius,
  updateShopDetails,
  uploadDocuments,
  uploadLiveVerification,
  updateBankDetails,
  submitForApproval,
  checkApprovalStatus,
  getVerificationStatus,
  submitReVerification,
  getPendingRegistrations,
  getDealerDetails,
  approveDealer,
  rejectDealer,
  verifyDocument,
};
