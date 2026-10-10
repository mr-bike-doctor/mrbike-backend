# Booking slot capacity rollout gate

Admin rescheduling stays disabled unless both `ENABLE_BOOKING_SLOT_RESERVATIONS=true` and `BOOKING_SLOT_RESERVATIONS_READY=true` are set. The backend also checks that the unique `BookingSlotReservation.bookingId` index exists before it advertises scheduling as enabled or accepts a reservation.

Do not set the readiness flag until the business owner has supplied authoritative, garage-specific capacity for each supported date/time slot and an isolated, reviewed reconciliation has created reservation rows for every active booking with a schedule. Each capacity row's `reservedCount` must match that reconciled reservation set. Existing booking schedules are intentionally not inferred into capacity or changed by application startup.

Capacity records are keyed by the deterministic `_id` returned by `services/bookingSlotReservations.capacityId(dealerId, scheduleDate, timeSlot)`. `scheduleDate` is `YYYY-MM-DD`; `timeSlot` must match the booking's supported slot label. The transactional reservation operation conditionally increments a slot only while `reservedCount < capacity`, releases the booking's previous reservation in the same transaction, and updates the booking and audit event in that transaction. If capacity, the previous reservation, the unique reservation index, or transaction support cannot be verified, the operation fails closed.

There is no default capacity and no automatic backfill. Keep both flags unset until capacity and reservation reconciliation are independently reviewed. Enabling the flags is an operational deployment decision and is not part of this code change.
