# BikeDoctor — Backend API (service)

## Project Overview
This is the **BikeDoctor** backend REST API server. It powers the customer mobile app, dealer app, and admin panel for a bike servicing platform. It handles user auth, bookings, payments, dealer management, notifications, and real-time ticket updates.

## Tech Stack
- **Runtime:** Node.js 16.x
- **Framework:** Express.js 4.x
- **Database:** MongoDB via Mongoose 6.x
- **Auth:** JWT (jsonwebtoken) + bcryptjs
- **Real-time:** Socket.IO 4.x (ticket room-based events)
- **File Storage:** AWS S3 (multer-s3) + local uploads fallback
- **Payments:** PayU (booking Dynamic UPI QR + dealer wallet top-up)
- **Notifications:** Firebase Admin SDK (FCM push) + Twilio (SMS/OTP)
- **AI:** Google Gemini API + OpenAI + Azure Form Recognizer (OCR)
- **Email:** Nodemailer

## Project Structure
```
server.js               # Entry point — Express app, Socket.IO, DB connect
routes/
  index.js              # Mounts all v1 routes under /bikedoctor
  userAuthRoutes.js     # /userAuth — login, OTP verify
  customerRoutes.js     # /customers — profile, data
  bookingRoutes.js      # /booking — v1 bookings
  dealerRoutes.js       # /dealer
  serviceRoutes.js      # /service
  paymentRoutes.js      # /payment
  trackingRoute.js      # /tracking
  notificationRoutes.js # /notification
  ... (many more)
  v2/                   # V2 route files (if any)

v2-api/                 # V2 API (new booking + banner system)
  routes/index.js       # Mounts v2 routes under /api/v2
  routes/bookingRoutes.js
  routes/bannerRoutes.js
  controllers/bookingController.js
  controllers/bannerController.js
  models/BookingV2.js
  models/BannerV2.js

controller/             # V1 controllers (one file per domain)
models/                 # Mongoose schemas
middlewares/
  error.js              # Global error handler
helper/
  verifyAuth.js         # JWT middleware
  otpAuth.js            # OTP generation/verification
  pushNotification.js   # FCM helper
  validation.js         # Input validators
utils/
  errorhandler.js       # Custom error class
  s3Upload.js           # S3 upload helper
  cache.js              # In-memory cache utility
  idGenerator.js        # Custom ID generation
services/               # OCR / AI parsing services
scripts/
  createIndexes.js      # DB index setup script
  performanceReport.js  # Performance diagnostics
uploads/                # Local file upload storage (fallback)
```

## API Route Prefixes
| Prefix | Description |
|--------|-------------|
| `GET /bikedoctor` | Health check |
| `/bikedoctor/userAuth` | User login + OTP |
| `/bikedoctor/customers` | Customer profile |
| `/bikedoctor/booking` | V1 bookings |
| `/bikedoctor/dealer` | Dealer management |
| `/bikedoctor/service` | Services catalog |
| `/bikedoctor/payment` | Payments |
| `/bikedoctor/tracking` | Booking tracking |
| `/bikedoctor/banner` | V1 banners |
| `/bikedoctor/notification` | Push notifications |
| `/bikedoctor/rating` | Ratings & reviews |
| `/bikedoctor/reward` | Rewards/wallet |
| `/bikedoctor/ticket` | Support tickets (Socket.IO) |
| `/api/v2/bookings` | **V2 booking lifecycle** |
| `/api/v2/banners` | **V2 dynamic banners** |
| `/ai/gemini` | Gemini AI endpoints |

## V2 API — Booking Lifecycle
The V2 booking system (`v2-api/`) is the current active booking flow used by the mobile app.

Key endpoints:
- `POST /api/v2/bookings` — Create booking (returns bookingId + OTP)
- `GET /api/v2/bookings/user/:userId` — Get all bookings for a user
- `GET /api/v2/bookings/:bookingId` — Get booking details + tracking timeline
- `POST /api/v2/bookings/verify-otp` — Dealer verifies handover OTP
- `PATCH /api/v2/bookings/:bookingId/status` — Update booking status

Booking status flow: `pending` → `picked-up` → `in-progress` → `ready-for-delivery` → `delivered`

## Authentication
- Users authenticate via phone OTP (Twilio SMS)
- JWT token returned on OTP verify, sent as `token` header in subsequent requests
- `helper/verifyAuth.js` is the auth middleware — apply to protected routes
- Dealer auth is separate (`/dealerAuth` routes, `controller/dealerAuth.js`)
- Admin auth is separate (`/adminAuth` routes, `controller/adminAuth.js`)

## Environment Variables (`.env`)
Required variables (never commit `.env`):
```
DATABASE_URL=           # MongoDB connection string
PORT=8001               # Server port
JWT_SECRET=             # JWT signing secret
TWILIO_*=               # Twilio credentials for OTP SMS
FIREBASE_*=             # Firebase Admin SDK credentials
AWS_*=                  # S3 bucket credentials
RAZORPAY_*=             # Razorpay payment keys
PAYU_*=                 # PayU key/salt/env/callback base URL
GEMINI_API_KEY=         # Google Gemini API key
OPENAI_API_KEY=         # OpenAI API key
```

## Socket.IO — Real-time Tickets
- `io` instance is set on `app` via `app.set("io", io)` — access in controllers with `req.app.get("io")`
- Clients join a room per ticket: `socket.emit("ticket:join", { ticketId })`
- Emit updates to a ticket room: `io.to(ticketId).emit("ticket:update", data)`

## Coding Conventions
- Use `async/await` with try/catch for all async controller logic
- Use the custom `ErrorHandler` from `utils/errorhandler.js` for consistent error responses
- Apply `helper/verifyAuth.js` middleware to all protected routes
- File uploads: use `utils/s3Upload.js` for S3; local `uploads/` is a fallback only
- New features that belong to the V2 API go in `v2-api/` (controllers, models, routes)
- Legacy/V1 features go in `controller/`, `models/`, `routes/`
- Response format convention:
  ```json
  { "success": true, "message": "...", "data": {} }
  { "success": false, "message": "Error description" }
  ```
- Use `moment` for date formatting; avoid raw `new Date()` in responses

## Running the Server
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start

# Create DB indexes
npm run create-indexes
```

## Deployment
- CI/CD via GitHub Actions (`.github/workflows/deploy.yml`)
- Production domain: `https://api.mrbikedoctor.cloud`
- Node.js engine pinned to `16.x`

## Key Notes
- The `package.json` `name` is `"hospital"` — this is a legacy artifact, the project is BikeDoctor
- `uploads/` directory contains subdirectories per entity type (banners, services, dealer-documents, etc.)
- Performance monitoring utilities are in `utils/performanceMonitor.js` and `scripts/performanceReport.js`
- The `services/` folder contains AI/OCR pipeline services (address extraction, document parsing)
