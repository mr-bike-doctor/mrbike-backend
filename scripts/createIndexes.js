/**
 * Database Performance Optimization Script
 * Run this script to create indexes for better query performance
 */

const mongoose = require('mongoose')
require('dotenv').config()

async function createIndexes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bikedoctor')
    
    console.log('Creating performance indexes...')
    
    // BikeCompany indexes
    await mongoose.connection.db.collection('bikecompanies').createIndex({ name: 1 })
    console.log('✓ BikeCompany name index created')
    
    // BikeModel indexes
    await mongoose.connection.db.collection('bikemodels').createIndex({ company_id: 1 })
    await mongoose.connection.db.collection('bikemodels').createIndex({ company_id: 1, model_name: 1 })
    console.log('✓ BikeModel indexes created')
    
    // BikeVariant indexes
    await mongoose.connection.db.collection('bikevariants').createIndex({ model_id: 1 })
    await mongoose.connection.db.collection('bikevariants').createIndex({ model_id: 1, engine_cc: 1 })
    await mongoose.connection.db.collection('bikevariants').createIndex({ engine_cc: 1 })
    console.log('✓ BikeVariant indexes created')
    
    // AdminService indexes
    await mongoose.connection.db.collection('adminservices').createIndex({ dealer_id: 1 })
    await mongoose.connection.db.collection('adminservices').createIndex({ dealers: 1 })
    await mongoose.connection.db.collection('adminservices').createIndex({ base_service_id: 1 })
    await mongoose.connection.db.collection('adminservices').createIndex({ isActive: 1 })
    await mongoose.connection.db.collection('adminservices').createIndex({ dealer_id: 1, isActive: 1 })
    await mongoose.connection.db.collection('adminservices').createIndex({ dealers: 1, isActive: 1 })
    await mongoose.connection.db.collection('adminservices').createIndex({ createdAt: -1 })
    // Bike-aware discovery (v1-api/helpers/serviceEligibility.js) reads
    // AdminService once per request, filtering on isActive + the saved bikes'
    // brands, optionally narrowed to the in-range dealers. `companies` is an
    // array, so this is a multikey index on the brand fan-out.
    await mongoose.connection.db.collection('adminservices').createIndex({ isActive: 1, companies: 1 })
    // Provider selection for one service (GET /api/v1/services/:id and
    // /:id/garages) filters base_service_id + isActive together.
    await mongoose.connection.db.collection('adminservices').createIndex({ base_service_id: 1, isActive: 1 })
    console.log('✓ AdminService indexes created')
    
    // AdditionalService indexes
    await mongoose.connection.db.collection('additionalservices').createIndex({ dealer_id: 1 })
    await mongoose.connection.db.collection('additionalservices').createIndex({ base_additional_service_id: 1 })
    await mongoose.connection.db.collection('additionalservices').createIndex({ isActive: 1 })
    await mongoose.connection.db.collection('additionalservices').createIndex({ dealer_id: 1, isActive: 1 })
    console.log('✓ AdditionalService indexes created')
    
    // BaseService indexes
    await mongoose.connection.db.collection('baseservices').createIndex({ name: 1 })
    await mongoose.connection.db.collection('baseservices').createIndex({ isActive: 1 })
    // Service Detail listings filter on isActive + categoryId together
    // (GET /api/v1/services?categoryId=), which the two single-field indexes
    // above can't serve as one.
    await mongoose.connection.db.collection('baseservices').createIndex({ isActive: 1, categoryId: 1 })

    // MR Bike Money ledger: idempotency prevents duplicate booking debits,
    // refunds and referral credits; the user/date index powers wallet history.
    await mongoose.connection.db.collection('mrbikemoneytransactions').createIndex(
      { idempotencyKey: 1 },
      { unique: true }
    )
    await mongoose.connection.db.collection('mrbikemoneytransactions').createIndex({ userId: 1, createdAt: -1 })
    console.log('✓ BaseService indexes created')

    // ServiceDetail indexes — 1:1 with BaseService, so the lookup key is
    // unique. GET /api/v1/services/:id does exactly one findOne on it.
    await mongoose.connection.db.collection('servicedetails').createIndex({ baseServiceId: 1 }, { unique: true })
    await mongoose.connection.db.collection('servicedetails').createIndex({ isPublished: 1 })
    console.log('✓ ServiceDetail indexes created')
    
    // UserBike — discovery resolves a rider's WHOLE garage on every home load.
    // The unique { user_id, plate_number } index the model declares already
    // serves this as a prefix; created here too so a fresh environment that
    // has not yet built the model index is still covered.
    await mongoose.connection.db.collection('userbikes').createIndex({ user_id: 1 })
    console.log('✓ UserBike indexes created')

    // Vendor/Dealer indexes
    await mongoose.connection.db.collection('vendors').createIndex({ shopName: 1 })
    await mongoose.connection.db.collection('vendors').createIndex({ email: 1 })
    // Nearby-garage lookups (dealerWithInRange, resolveDealerScope) pre-filter
    // on online + a lat/lng bounding box before the exact per-dealer
    // service-radius check runs. That box is sized off the widest radius a
    // dealer may configure, so it is deliberately generous — this index keeps
    // it from turning into a collection scan.
    await mongoose.connection.db.collection('vendors').createIndex({ online: 1, latitude: 1, longitude: 1 })
    console.log('✓ Vendor indexes created')


    await mongoose.connection.db.collection('payments').createIndex(
      { booking_id: 1 },
      {
        unique: true,
        partialFilterExpression: { booking_id: { $type: 'objectId' }, order_status: 'SUCCESS' },
        name: 'one_successful_payment_per_booking',
      },
    )
    await mongoose.connection.db.collection('payments').createIndex(
      { booking_id: 1 },
      {
        unique: true,
        partialFilterExpression: { booking_id: { $type: 'objectId' }, order_status: 'PENDING' },
        name: 'one_pending_payment_per_booking',
      },
    )
    await mongoose.connection.db.collection('wallets').createIndex(
      { booking_id: 1, transaction_type: 1 },
      {
        unique: true,
        partialFilterExpression: {
          booking_id: { $type: 'objectId' },
          transaction_type: { $in: ['settlement_online', 'settlement_cash'] },
        },
        name: 'one_wallet_settlement_per_booking_method',
      },
    )
    await mongoose.connection.db.collection('paymentreconciliationtasks').createIndex(
      { dedupeKey: 1 },
      { unique: true, name: 'payment_reconciliation_dedupe_unique' },
    )
    console.log('✓ Payment lifecycle integrity indexes created')
    
    console.log('🚀 All performance indexes created successfully!')
    
  } catch (error) {
    console.error('Error creating indexes:', error)
  } finally {
    await mongoose.connection.close()
  }
}

// Run the script
if (require.main === module) {
  createIndexes()
}

module.exports = createIndexes
