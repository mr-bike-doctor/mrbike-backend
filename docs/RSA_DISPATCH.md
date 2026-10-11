# RSA request dispatch

RSA requests are independent of normal `Booking` records and remain disabled by default.

Set `RSA_REQUESTS_ENABLED=true` only after the RSA catalog, active polygon coverage, approved dealer prices, dealer RSA permissions, capabilities, locations and positive capacities have been checked. This flag enables request creation and the expired-offer retry worker. Leave it unset or `false` to return an unavailable response and reject request creation.

Optional tuning:

- `RSA_OFFER_BATCH_SIZE`: dealers offered at once (default 3, bounded 1–5).
- `RSA_OFFER_TTL_MS`: offer lifetime (default 90000, bounded 15000–600000).

The Mongo deployment must support transactions (replica set or sharded cluster). Capacity is reserved on the first successful dealer acceptance and released on customer/dealer cancellation or completion. Nearby eligibility reports only server-verified partners; no fallback providers are fabricated.

RSA status and assignment updates are available through authenticated sockets. Customer GPS is returned only through owner-authenticated request details and to a dealer with a live offer or current assignment. Realtime rooms contain request IDs and status only; clients refetch details after an update.

The current foundation does not implement dealer GPS streaming, route/ETA calculation, photo upload, or payment collection. Dealer inspection estimates can be sent and approved/declined, but this does not charge the customer.
