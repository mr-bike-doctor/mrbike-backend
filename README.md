# BikeDoctor Backend Service

Node.js Express backend for the BikeDoctor platform. Handles bookings, dealer management, payments, and AI-driven features.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v16.x (as specified in `package.json`)
- **MongoDB**: A running instance (local or Atlas)

### Installation

1. Clone the repository.
2. Navigate to the `service` directory:
   ```bash
   cd service
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

### Environment Variables

Create a `.env` file in the root of the `service` directory. Use the following template:

```env
# Server Configuration
PORT=8001
BASE_URL="https://api.mrbikedoctor.com/"
BACKEND_URL="https://api.mrbikedoctor.com"
FRONTEND_URL="https://mrbikedoctor.com"

# Database
DATABASE_URL="mongodb://your_mongodb_uri"

# Authentication
JWT_SECRET="your_jwt_secret"
JWT_AUTH_TOKEN="your_auth_token"
JWT_REFRESH_TOKEN="your_refresh_token"

# AI Integration
GEMINI_API_KEY="your_gemini_api_key"

# Firebase (Push Notifications & Admin)
FIREBASE_PROJECT_ID="your_project_id"
FIREBASE_PRIVATE_KEY="your_private_key"
FIREBASE_CLIENT_EMAIL="your_client_email"
# ... other FIREBASE variables

# Payment Gateway (PayU) — booking UPI QR + dealer wallet top-up
PAYU_KEY="your_merchant_key"
PAYU_SALT="your_merchant_salt"
PAYU_ENV="test"            # "production" for live
PAYU_CALLBACK_BASE_URL="https://api.mrbikedoctor.cloud"
RAZORPAY_KEY_ID="your_razorpay_key"
RAZORPAY_KEY_SECRET="your_razorpay_secret"

# Third-party Services
TWILIO_ACCOUNT_SID="your_twilio_sid"
TWILIO_AUTH_TOKEN="your_twilio_token"
TWILIO_VERIFY_SERVICE_SID="your_twilio_verify_service_sid"
MAPKEY="your_google_maps_key"

# AWS S3 Storage
AWS_ACCESS_KEY_ID="your_aws_key"
AWS_SECRET_ACCESS_KEY="your_aws_secret"
AWS_REGION="your_region"
AWS_S3_BUCKET="your_bucket_name"
```

### Running the App

- **Development mode** (with nodemon):
  ```bash
  npm run dev
  ```
- **Production mode**:
  ```bash
  npm start
  ```

## 📂 Project Structure

- `server.js`: Application entry point.
- `controller/`: Business logic for different entities (bookings, dealers, payments, etc.).
- `routes/`: API route definitions.
- `models/`: Mongoose schemas and models.
- `middlewares/`: Custom middlewares (auth, error handling, etc.).
- `helper/`: Utility functions and integrations (Firebase, Twilio, etc.).
- `utils/`: S3 upload and other technical utilities.

## 🛠 Features

- **Booking Management**: Real-time service booking and tracking via Socket.io.
- **Payment Integration**: PayU (booking UPI QR, dealer wallet top-up).
- **AI Integration**: Powered by Google Gemini for intelligent bike diagnostics or automation.
- **Notifications**: Push notifications via Firebase and SMS via Twilio Verify where applicable.
- **Storage**: Image uploads managed via AWS S3.
