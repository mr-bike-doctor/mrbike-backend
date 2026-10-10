var Tracking = require("../models/Tracking");
var booking  = require("../models/Booking");
var mongoose = require('mongoose'); // ES5 or below
const jwt_decode = require("jwt-decode");
const Vendor  = require("../models/dealerModel")


async function gettracking(req, res) {
    try{
        // The route has already verified the active actor and booking
        // participation. Do not decode a second token representation here.
        if (!req.auth) return res.status(401).json({ success: false, message: "Authentication required" });

        // let bookings = await booking.findById(req.params.id);
        let bookings = await booking.findById(req.params.id)
        .populate({ path: "service_id", select: ['name', 'image', 'description'] })
        .populate({ path: "created_by", select: ['first_name', 'last_name', 'phone', 'address', 'city'] })
        .populate({ path: "additonal_options"})
        .sort({ "_id": -1 })
        .lean();

        if(!bookings){
            res.status(401).json({ error: "No Booking Found" })
            return;
        }
        //console.log(bookings);
        const responses = await Tracking.findOne({booking_id:req.params.id}).populate({path:"service_id",select: ['name', 'image', 'description']}).populate({path:"user_id",select: ['first_name', 'last_name', 'phone','address','city']}).populate({path:"dealer_id",select: ['area','address', 'longitude', 'latitude','name','id', "_id"]})
        
        if (responses) {
            var responsess = {
              status: 200,
              message: "successfull",
              data: responses,
              image_base_url: process.env.BASE_URL,
            };
            return res.status(200).send(responsess);
        } else {
            var response = {
              status: 201,
              responses,
              message: "No Booking Found",
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


async function updatetracking(req, res){
  try {
    const data = jwt_decode(req.headers.token);
    const user_id = data.user_id;
    const user_type = data.user_type;
    const type = data.type;
    if (user_id == null || user_type != 1 && user_type != 2 && user_type != 3 ) {
      var response = {
        status: 401,
        message: "Admin is un-authorised !",
      };
      return res.status(401).send(response);
    }

    const {dealer_id, status} = req.body;

    let bookings = await booking.findById(req.params.id);
        if(!bookings){
            res.status(401).json({status: 401, error: "No Booking Found" })
            return;
    }

    const vendors = await Vendor.findOne({user_id:dealer_id});
    if(!vendors){
        res.status(401).json({status: 401, error: "No Service Provider Found" })
        return;
    }

    if (bookings && vendors) {

      //console.log(req.params.id);
      //console.log(mongoose.Types.ObjectId(req.params.id));
      Tracking.findOne({booking_id: req.params.id },async function (err, docs) {
          if (err) {
            var response = {
              status: 201,
              message: err,
            };
            return res.status(201).send(response);
          } else {
            const newdata = {
              status: status,
              dealer_id: dealer_id,
              dealrs_id:bookings?.dealr_id,
            };
            const datas = await Tracking.findByIdAndUpdate({_id:docs._id},{$set: newdata},{new:true}).populate({path:"booking_id"})
            var response = {
              status: 200,
              message: "Tracking updated successfully",
              data: datas,
            };
            return res.status(200).send(response);
          }
        }
      );
    } else {
      response = {
        status: 201,
        message: "Tracking not Found",
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


async function getAlltracking(req, res) {
  try{
      // requireAdmin and the route-level live_gps permission have already
      // authenticated and authorized this request.
      if (!req.admin) return res.status(401).json({ success: false, message: "Authentication required" });

      // const responses = await Tracking.find().populate({path:"service_id",select: ['name', 'image', 'description']}).populate({path:"user_id",select: ['first_name', 'last_name', 'phone','address','city']}).sort({"_id":-1});
      const responses = await Tracking.find(req.query)
      .populate({ path: "booking_id", select: ['id'] })
      .populate({path:"services"})
      .sort({"_id":-1});
      
      if (responses) {
          var responsess = {
            status: 200,
            message: "successfull",
            data: responses,
            image_base_url: process.env.BASE_URL,
          };
          return res.status(200).send(responsess);
      } else {
          var response = {
            status: 201,
            responses,
            message: "No Booking Found",
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



module.exports = {
    getAlltracking,
    gettracking,
    updatetracking,
}
