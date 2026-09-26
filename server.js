// // const express = require("express");
// // const crypto = require('crypto');
// // const app = express();
// // const path = require('path');
// // const http = require('http');
// // const bodyParser = require("body-parser");
// // const multer = require('multer');
// // const apiRouter = require("./routes/index");
// // const db = require("./models/index");
// // require("dotenv").config();
// // const cookieParser = require("cookie-parser");
// // const morgan = require("morgan");
// // const cors = require("cors")
// // const errorMiddleware = require("./middlewares/error");
// // var serveIndex = require('serve-index')

// // app.all("*", function (req, res, next) {
// //   res.header("Access-Control-Allow-Origin", "*");
// //   res.header("Access-Control-Allow-Methods", "PUT, GET, POST, DELETE, OPTIONS");
// //   res.header("Access-Control-Allow-Headers", "Content-Type", 'Authorization');
// //   next();
// // });

// // var server = http.createServer(app);

// // app.use(cors())
// // app.use(morgan("dev"));
// // app.use(bodyParser.urlencoded({ extended: true }));
// // app.use(bodyParser.json());
// // app.use(cookieParser());
// // app.use(express.static('public'));

// // app.use(express.static(path.join(__dirname, 'public')));
// // app.use('/image', express.static('image'), serveIndex('image', { 'icons': true }));

// // app.use(bodyParser.urlencoded({ extended: true }));

// // app.get('/', (req, res) => {
// //   res.send('API is running...');
// // });


// // app.get("/bikedoctor", (req, res) => {
// //   res.status(200).json({ message: "Bikedoctor API Working" })
// // });


// // app.post('/upload', (req, res) => {

// //   const { image } = req.files;

// //   if (!image) return res.sendStatus(400);

// //   if (!/^image/.test(image.mimetype)) return res.sendStatus(400);

// //   image.mv(__dirname + '/upload/' + Date.now() + "_" + image.name.replace(" ", ""));

// //   res.sendStatus(200);

// // });

// // app.use("/bikedoctor", apiRouter);
// // // --------------------------------------
// // app.use("/location", require("./routes/stateAndCityRoute"));
// // // app.use("/dealer", require("./routes/dealerRoutes"));
// // app.use("/service", require("./routes/serviceRoutes"));

// // app.use("/bikedoctor", require('./routes/policyRoutes'))
// // app.use("/testmulter", require("./routes/multerRoute"));



// // // ---------------------------------------------

// // // const DB_URL = "mongodb+srv://test:test@cluster0.mzwadhx.mongodb.net/?retryWrites=true&w=majority";


// // // const DB = "mongodb://0.0.0.0:27017/mechanictesting";
// // //const DB = process.env.DATABASE_URL || "mongodb://0.0.0.0:27017/BikeDoctor";
// // const DB = process.env.DATABASE_URL;

// // db.mongoose
// //   .connect(DB, {
// //     useUnifiedTopology: true,
// //     useNewUrlParser: true,
// //   })
// //   .then((data) => {
// //     console.log(`Mongodb connected with : ${data.connection.host} server`);
// //   })
// //   .catch((err) => {
// //     console.log("mongodb error", err);
// //   });

// // // test

// // const port = process.env.PORT || 8001;
// // server.listen(8001, () => {
// //   // server.listen(()=>{
// //   console.log(`Server is working on port : ${port}`)
// //   // console.log(`Bike Dcotor API Server is working`)
// // })


// // function errHandler(err, req, res, next) {
// //   if (err instanceof multer.MulterError) {
// //     res.json({
// //       success: 0,
// //       message: err.message
// //     })
// //   }
// // }


// // app.use(errHandler);
// // app.use(errorMiddleware);


// const express = require("express");
// const crypto = require("crypto");
// const path = require("path");
// const http = require("http");
// const bodyParser = require("body-parser");
// const multer = require("multer");
// const cookieParser = require("cookie-parser");
// const morgan = require("morgan");
// const cors = require("cors");
// const serveIndex = require("serve-index");
// const { Server } = require("socket.io");
// require("dotenv").config();

// const apiRouter = require("./routes/index");
// const db = require("./models/index");
// const errorMiddleware = require("./middlewares/error");

// const app = express();
// const server = http.createServer(app);

// /* ==============================
//    CORS (HTTP + WebSocket)
//    ============================== */
// const ALLOWED_ORIGINS = [
//   "https://dr-bike-frontend.vercel.app/",
//   "https://admin.mrbikedoctor.cloud",
// ];

// app.use(cors({
//   origin: (origin, cb) => cb(null, true), // or restrict using ALLOWED_ORIGINS.includes(origin)
//   methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
//   credentials: true,
// }));
// app.options("*", cors()); // preflight

// // Socket.IO with CORS
// const io = new Server(server, {
//   cors: {
//     origin: (origin, cb) => cb(null, true), // or ALLOWED_ORIGINS
//     methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
//     credentials: true,
//   }
// });

// // make io available in routes/controllers: req.app.get("io")//
// app.set("io", io);

// /* ==============================
//    Socket rooms per ticket
//    ============================== */
// io.on("connection", (socket) => {
//   // client should call: socket.emit("ticket:join", { ticketId })
//   socket.on("ticket:join", ({ ticketId }) => {
//     if (ticketId) socket.join(String(ticketId));
//   });
//   socket.on("ticket:leave", ({ ticketId }) => {
//     if (ticketId) socket.leave(String(ticketId));
//   });
// });

// /* ==============================
//    Middleware
//    ============================== */
// app.use(morgan("dev"));
// app.use(bodyParser.json());
// app.use(bodyParser.urlencoded({ extended: true }));
// app.use(cookieParser());

// app.use(express.static("public"));
// app.use(express.static(path.join(__dirname, "public")));
// app.use("/image", express.static("image"), serveIndex("image", { icons: true }));
// app.use(
//   "/uploads",
//   express.static("/var/www/service/uploads", {
//     fallthrough: false
//   })
// );
// app.use("/uploads", express.static(path.join(__dirname, "uploads")));
// app.use("/upload", express.static(path.join(__dirname, "upload")));

// /* ==============================
//    Health / test
//    ============================== */
// app.get("/", (req, res) => res.send("API is running..."));
// app.get("/bikedoctor", (req, res) =>
//   res.status(200).json({ message: "Bikedoctor API Working" })
// );

// /* ==============================
//    Upload (basic)
//    ============================== */
// app.post("/upload", (req, res) => {
//   const { image } = req.files || {};
//   if (!image) return res.sendStatus(400);
//   if (!/^image/.test(image.mimetype)) return res.sendStatus(400);

//   image.mv(
//     path.join(__dirname, "upload", `${Date.now()}_${image.name.replace(/\s+/g, "")}`),
//     (err) => {
//       if (err) return res.status(500).json({ message: "Upload failed" });
//       res.sendStatus(200);
//     }
//   );
// });

// /* ==============================
//    Routes
//    ============================== */
// app.use("/bikedoctor", apiRouter);
// app.use("/location", require("./routes/stateAndCityRoute"));
// app.use("/service", require("./routes/serviceRoutes"));
// app.use("/bikedoctor", require("./routes/policyRoutes"));
// app.use("/testmulter", require("./routes/multerRoute"));

// /* ==============================
//    DB
//    ============================== */
// const DB = process.env.DATABASE_URL;
// db.mongoose
//   .connect(DB, { useUnifiedTopology: true, useNewUrlParser: true })
//   .then((data) => console.log(`Mongodb connected with: ${data.connection.host}`))
//   .catch((err) => console.log("mongodb error", err));

// /* ==============================
//    Errors
//    ============================== */
// function errHandler(err, req, res, next) {
//   if (err instanceof multer.MulterError) {
//     return res.json({ success: 0, message: err.message });
//   }
//   next(err);
// }
// app.use(errHandler);
// app.use(errorMiddleware);

// //
// /* ==============================
//    Start
//    ============================== */
// const PORT = process.env.PORT || 8001;
// server.listen(PORT, () => console.log(`Server is working on port: ${PORT}`));




const express = require("express");
const crypto = require("crypto");

// Polyfill for Node.js < 19 to support Azure SDK's use of global crypto.randomUUID()
if (!global.crypto) {
  global.crypto = crypto;
}

const path = require("path");
const http = require("http");
const bodyParser = require("body-parser");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const cors = require("cors");
const serveIndex = require("serve-index");
const { Server } = require("socket.io");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const validateProductionEnv = require("./config/validateProductionEnv");
validateProductionEnv();
require("./config/reportSoftposConfig")();

const apiRouter = require("./routes/index");
const db = require("./models/index");
const errorMiddleware = require("./middlewares/error");
const bookingExpiryJob = require("./helper/bookingExpiryJob");
const campaignSchedulerJob = require("./helper/campaignSchedulerJob");
const reviewReminderJob = require("./helper/reviewReminderJob");
const paymentReconciliationJob = require("./helper/paymentReconciliationJob");
const validateRequest = require("./middlewares/requestValidation");
const sensitiveRateLimit = require("./middlewares/rateLimits");
// Used by the booking:joinDealer socket handler to refuse dealer rooms for a
// dealer that is offline / logged out.
const mongoose = require("mongoose");
const Vendor = require("./models/dealerModel");
const { isDealerBookable } = require("./helper/dealerStatus");
const { ensureUserBikePlateIndexes } = require("./utils/userBikeIndexes");

const app = express();
const server = http.createServer(app);

// The API sits behind nginx, so without this every request arrives with the
// proxy's address as req.ip and express-rate-limit counts all clients into a
// single bucket. Hop count is configurable for environments with a CDN in
// front of nginx.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

/* ==============================
   CORS - Allow All Origins for Development
   ============================== */
const corsOptions = {
  origin: function (origin, callback) {
    // Allow all origins for development
    callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "token", "x-idempotency-key"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* ==============================
   Socket.IO
   ============================== */
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    credentials: true,
  },
});
app.set("io", io);

io.on("connection", (socket) => {
  socket.on("ticket:join", ({ ticketId }) => {
    if (ticketId) socket.join(String(ticketId));
  });
  socket.on("ticket:leave", ({ ticketId }) => {
    if (ticketId) socket.leave(String(ticketId));
  });

  // Dealer joins their personal room to receive new booking alerts.
  //
  // Membership is gated on the dealer being currently bookable (approved,
  // active, not blocked, and `online: true`). Logout forces `online: false`
  // and evicts the existing sockets, so a client that reconnects immediately
  // after logout — or one that never noticed the logout — cannot re-subscribe
  // itself to booking events. The dealer re-joins normally once they manually
  // activate from the Home screen after the next login.
  socket.on("booking:joinDealer", async (payload) => {
    const dealerId = payload?.dealerId;
    if (!dealerId) return;
    try {
      if (!mongoose.Types.ObjectId.isValid(String(dealerId))) return;
      const dealer = await Vendor.findById(dealerId)
        .select("online isBlocked isActive isDoc status registrationStatus dealerStatus")
        .lean();
      if (!isDealerBookable(dealer)) {
        console.log(`[SOCKET] booking:joinDealer refused for ${dealerId} — dealer offline/ineligible`);
        socket.emit("booking:joinDealerDenied", { dealerId, reason: "offline" });
        return;
      }
      socket.join(`dealer:${dealerId}`);
    } catch (err) {
      console.error("[SOCKET] booking:joinDealer error:", err.message);
    }
  });

  // User joins their booking room to receive accept/reject/expired events
  socket.on("booking:joinUser", ({ bookingId }) => {
    if (bookingId) socket.join(`booking:${bookingId}`);
  });

  // Admin joins their personal room to receive support unread-count updates
  socket.on("admin:join", ({ adminId }) => {
    if (adminId) socket.join(`admin:${adminId}`);
  });
});

/* ==============================
   Middlewares
   ============================== */
app.use(morgan("dev"));
app.use(bodyParser.json({
  limit: "50mb",
  verify: (req, _res, buffer) => {
    const requestPath = req.originalUrl.split("?")[0];
    if (/\/webhook\/?$/i.test(requestPath)) {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// One validation boundary and category-specific throttling for every API mount.
app.use(validateRequest);
app.use(sensitiveRateLimit);

/* ==============================
   🔥 STATIC FILES (IMPORTANT PART)
   ============================== */

// optional public folder
app.use(express.static(path.join(process.cwd(), "public")));

/* ==============================
   Health Check
   ============================== */
app.get("/", (req, res) => res.send("API is running..."));

app.get("/bikedoctor", (req, res) =>
  res.status(200).json({ message: "Bikedoctor API Working" })
);

/* ==============================
   Public Legal Pages
   ============================== */
app.get("/privacy-policy", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "privacy-policy.html"));
});

app.get("/delete-account", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "delete-account.html"));
});

/* ==============================
   Routes
   ============================== */
app.use("/bikedoctor", apiRouter);
app.use("/location", require("./routes/stateAndCityRoute"));
app.use("/service", require("./routes/serviceRoutes"));
app.use("/bikedoctor", require("./routes/policyRoutes"));
app.use("/testmulter", require("./routes/multerRoute"));
app.use("/ai", require("./routes/geminiRoutes"));
app.use("/pricing", require("./routes/pricingRoutes"));
app.use("/api/v2", require("./v2-api/routes/index"));
app.use("/api/v2", require("./routes/chatbotRoutes"));
app.use("/api/v1", require("./v1-api/routes/index"));

/* ==============================
   Database
   ============================== */
const DB = process.env.DATABASE_URL;
const PORT = process.env.PORT || 8001;

db.mongoose
  .connect(DB, {
    useUnifiedTopology: true,
    useNewUrlParser: true,
  })
  .then(async (data) => {
    console.log("Mongodb connected with:", data.connection.host);
    const bikeIndexResult = await ensureUserBikePlateIndexes(data.connection.db);
    if (bikeIndexResult.createdPerUserIndex || bikeIndexResult.droppedGlobalIndexes.length) {
      console.log("UserBike registration indexes reconciled:", bikeIndexResult);
    }
    bookingExpiryJob.start(io);
    campaignSchedulerJob.start();
    reviewReminderJob.start();
    paymentReconciliationJob.start();
    server.listen(PORT, () =>
      console.log(`Server is working on port: ${PORT}`)
    );
  })
  .catch((err) => {
    console.error("Database startup error:", err);
    process.exitCode = 1;
  });

/* ==============================
   Errors
   ============================== */
function errHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
}
app.use(errHandler);
app.use(errorMiddleware);
