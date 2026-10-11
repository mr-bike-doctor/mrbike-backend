# Roadside Assistance operation and release requirements

RSA requests are independent of normal `Booking` records and remain disabled by default.

Set `RSA_REQUESTS_ENABLED=true` only after the RSA catalog, active polygon coverage, approved dealer prices, dealer RSA permissions, capabilities, locations and positive capacities have been checked. Each dealer must also enable the separate RSA availability switch; regular dealer online status remains a separate requirement. This flag enables request creation and the expired-offer retry worker. Leave it unset or `false` to return an unavailable response and reject request creation.

Optional tuning:

- `RSA_OFFER_BATCH_SIZE`: dealers offered at once (default 3, bounded 1–5).
- `RSA_OFFER_TTL_MS`: offer lifetime (default 90000, bounded 15000–600000).

The Mongo deployment must support transactions (replica set or sharded cluster). Request creation serializes concurrent active requests per saved bike. Capacity is reserved on the first successful dealer acceptance and released on cancellation before work starts or terminal completion. Cancellation is rejected after repair/towing has started or cash has been collected. Nearby eligibility reports only server-verified partners; no fallback providers are fabricated.

RSA status and assignment updates use authenticated socket rooms. Realtime messages contain request IDs and status only; clients refetch authorized request details after an update. Customer breakdown coordinates are returned only to the owning customer, the dealer with a live offer/current assignment, and authorized Admin routes. GPS updates are accepted only from the current assigned dealer while traveling to the customer or to the approved towing destination. Customer tracking hides stale GPS and shows ETA only when a route response is available.

RSA does not accept or return issue photos and has no dependency on `AWS_S3_PRIVATE_BUCKET`. Legacy database photo values, if any, are not mapped, served, or migrated by the RSA model.

The customer Android map uses the Google Maps SDK configured through the Android `com.google.android.geo.API_KEY` manifest placeholder. The dealer app reads `GOOGLE_MAPS_API_KEY` from its build environment for the SDK and Google Routes API. Restrict each Android key to its app package and the Play App Signing SHA-1 used by the release build; restrict API access to the SDK APIs and Routes/Geocoding APIs actually used by that app. Keep release signing credentials and Maps keys in the build environment, not source control.

Routing currently uses the public `router.project-osrm.org` service for Customer routes and as the Dealer fallback when Google Routes is unavailable. This is real route data, but the public service has no service-level agreement or application-specific capacity guarantee. Production release requires an approved controlled routing provider and configured key/quotas/restrictions, or an explicitly accepted operational dependency on this public endpoint. No paid routing API is enabled by this module.

Roadside repair estimates are itemized, versioned, and require customer approval before repair starts. A revised estimate requires a new approval. Towing requires an Admin-authorized provider, customer approval of the towing estimate/destination, a customer-created handover code, a fresh dealer GPS fix near the approved destination, and explicit handover verification before payment/completion. GPS arrival alone does not complete a request. Cash confirmation must match the approved total and is idempotent; this flow does not invoke normal booking payment, wallet, settlement, or invoice logic.
