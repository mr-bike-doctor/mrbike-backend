const Booking = require("../models/Booking");
const Bill = require("../models/billSchema");
const Dealer = require("../models/dealerModel");
const InvoiceCounter = require("../models/invoiceCounterModel");
const { PRICING_WRITE_BYPASS_FLAG, round2, resolvePriceForCC, resolveBikeCC } = require("./pricingEngine");
const {
    MR_BIKE_SUPPORT_PHONE,
    MR_BIKE_SUPPORT_EMAIL,
    DEFAULT_PLATFORM_FEE_LABEL,
    getSupportContact,
} = require("./appSettingsService");

// Sequential, atomic, per-year invoice numbers (e.g. INV-2026-000001).
// findOneAndUpdate($inc, upsert) is a single atomic Mongo op, so concurrent
// invoice creations (payment webhook + cash-confirm racing) can never
// collide or skip a number. Only ever called for a brand-new invoice —
// existing bills keep whatever bill_number they were created with.
async function generateInvoiceNumber() {
    const year = new Date().getFullYear();
    const key = `invoice_${year}`;
    const counter = await InvoiceCounter.findOneAndUpdate(
        { _id: key },
        { $inc: { seq: 1 } },
        { upsert: true, new: true }
    );
    return `INV-${year}-${String(counter.seq).padStart(6, "0")}`;
}

function resolveDealerDetails(dealer) {
    if (!dealer) {
        return { name: null, address: null, phone: null, gst_number: null, logo_url: null };
    }
    const address =
        dealer.fullAddress ||
        [dealer.presentAddress?.address, dealer.presentAddress?.city, dealer.presentAddress?.state]
            .filter(Boolean)
            .join(", ") ||
        [dealer.permanentAddress?.address, dealer.permanentAddress?.city, dealer.permanentAddress?.state]
            .filter(Boolean)
            .join(", ") ||
        null;

    return {
        name: dealer.shopName || null,
        address: address || null,
        phone: dealer.shopContact || dealer.phone || null,
        gst_number: dealer.gstNumber || null,
        logo_url: dealer.shopImages?.[0] || null,
    };
}

function loadBookingForInvoice(bookingId) {
    return Booking.findById(bookingId)
        .populate("user_id", "first_name last_name email phone")
        .populate({
            path: "userBike_id",
            select: "model plate_number registration_number vin bike_cc variant_id",
            populate: {
                path: "variant_id",
                model: "BikeVariant",
                select: "variant_name engine_cc model_id",
                populate: {
                    path: "model_id",
                    model: "BikeModel",
                    select: "model_name company_id",
                    populate: { path: "company_id", model: "BikeCompany", select: "name" },
                },
            },
        })
        .populate(
            "dealer_id",
            "shopName fullAddress presentAddress permanentAddress shopContact phone gstNumber shopImages tax commission pickupCharges dropCharges providesPickup providesDrop"
        )
        .populate({
            path: "services",
            model: "AdminService",
            select: "bikes",
            populate: { path: "base_service_id", select: "name" },
        })
        .populate({
            path: "additionalServices",
            select: "bikes",
            populate: { path: "base_additional_service_id", select: "name" },
        });
}

// One row per service on the booking, priced the way the booking itself was.
//
// The booking's own `serviceLines` (written with the pricing snapshot) is
// the record of what each service was charged at, so it wins whenever it is
// there. Bookings priced before it existed are re-priced with the pricing
// engine's own resolver and bike context — the exact rule `serviceAmount`
// was computed with. The old code here matched the raw `bike_cc` only, with
// no variant/model context, so a service the snapshot priced from a
// variant-specific row (or a decimal engine_cc) came out at a different
// price, or at ₹0, on the invoice.
function buildServiceLineItems(booking) {
    const userBike = booking.userBike_id;
    const variant = userBike?.variant_id;
    const bikeCC = resolveBikeCC(userBike);
    const bikeContext = {
        variantId: variant?._id || variant || null,
        modelId: variant?.model_id?._id || variant?.model_id || null,
    };

    // Snapshot prices keyed by kind+id. A list, not a single value, so the
    // same service on a booking twice consumes one stored line each.
    const stored = new Map();
    for (const line of booking.serviceLines || []) {
        const key = `${line.kind}:${String(line.ref)}`;
        if (!stored.has(key)) stored.set(key, []);
        stored.get(key).push(Number(line.price) || 0);
    }
    const priceOf = (kind, doc) => {
        const queue = stored.get(`${kind}:${String(doc?._id)}`);
        if (queue && queue.length) return round2(queue.shift());
        return round2(resolvePriceForCC(doc, bikeCC, bikeContext));
    };

    const lines = [];
    (booking.services || []).forEach((svc) => {
        const price = priceOf("service", svc);
        lines.push({ name: svc?.base_service_id?.name || "Service", price, quantity: 1, total: price });
    });
    (booking.additionalServices || []).forEach((svc) => {
        const price = priceOf("additional", svc);
        const name = svc?.base_additional_service_id?.name || "Additional Service";
        lines.push({ name: `Additional: ${name}`, price, quantity: 1, total: price });
    });

    if (lines.length === 0 && booking.serviceSummary && booking.serviceSummary.length > 0) {
        booking.serviceSummary.forEach((service) => {
            if (service.serviceName) {
                const price = Number(service.price) || 0;
                lines.push({ name: service.serviceName, price, quantity: 1, total: price });
            }
        });
    }

    return lines;
}

// Core invoice creation — this is the exact logic that used to live in
// controller/payment.js#generateBill, kept byte-for-byte so every existing
// trigger (PayU QR, cash-received/cash-confirm) keeps
// working unchanged. This function does NOT gate on booking eligibility —
// callers are trusted to invoke it only once payment is actually complete.
// The one exception (booking-completed fallback) does its own gating before
// calling this; see controller/booking.js.
async function getOrCreateInvoice(bookingId, paymentMeta = {}) {
    const existingBill = await Bill.findOne({ booking_id: bookingId });
    if (existingBill) {
        console.log(`📄 Invoice already exists for booking: ${bookingId}`);
        return existingBill;
    }

    const booking = await loadBookingForInvoice(bookingId);

    if (!booking) {
        throw new Error("Booking not found for invoice generation");
    }

    const services = buildServiceLineItems(booking);
    let subtotal = round2(services.reduce((sum, line) => sum + line.total, 0));

    // Pricing is the frozen snapshot taken by pricingEngine at booking
    // creation — never recomputed from the dealer's current settings.
    // Detection is `pricingVersion` presence only (see controller/payment.js
    // history) so a legitimately-zero tax/charge never falls through to the
    // legacy recompute branch below.
    const hasPricingSnapshot = Boolean(booking.pricingVersion);

    let pickupCharge, dropCharge, taxRate, taxAmount, totalAmount, commissionRate, commissionAmount, dealerEarnings;
    // GST MR Bike charges the dealer on its commission. Like the platform fee
    // below, it only exists on bookings that carry a pricing snapshot.
    let commissionTaxRate = 0;
    let commissionTaxAmount = 0;
    // Towing only ever exists on a booking with a pricing snapshot — bookings
    // that predate the snapshot also predate towing entirely, so the legacy
    // branch below leaves this at 0.
    let towingCharge = 0;
    // Only ever non-zero when hasPricingSnapshot — bookings without a
    // pricing snapshot predate the promo-code feature entirely.
    let discountAmount = 0;
    // Likewise: a booking without a pricing snapshot predates the platform
    // fee, so the legacy branch below leaves both of these alone.
    let platformFee = 0;
    let platformFeeLabel = null;

    if (hasPricingSnapshot) {
        pickupCharge = Number(booking.pickupCharges);
        dropCharge = Number(booking.dropCharges);
        towingCharge = Number(booking.towingCharge) || 0;
        subtotal = Number(booking.subtotal);
        taxRate = Number(booking.taxRate);
        taxAmount = Number(booking.taxAmount);
        discountAmount = Number(booking.discountAmount) || 0;
        platformFee = Number(booking.platformFee) || 0;
        platformFeeLabel = platformFee > 0
            ? booking.platformFeeLabel || DEFAULT_PLATFORM_FEE_LABEL
            : null;
        // total_amount / "Total Paid" is what the customer actually paid —
        // customerTotal minus whatever discount (promo) was applied, i.e.
        // the same amountDue virtual payment.js charges against. The platform
        // fee is already inside customerTotal, so it needs no adding here.
        totalAmount = round2(Number(booking.customerTotal) - discountAmount);
        commissionRate = Number(booking.commissionRate);
        commissionAmount = Number(booking.commissionAmount);
        commissionTaxRate = Number(booking.commissionTaxRate) || 0;
        commissionTaxAmount = Number(booking.commissionTaxAmount) || 0;
        dealerEarnings = Number(booking.dealerEarnings);
    } else {
        const dealer = booking.dealer_id;

        const hasPickupDrop = Boolean(booking.pickupAndDropId);
        pickupCharge = hasPickupDrop && dealer?.providesPickup ? parseFloat(dealer.pickupCharges) || 0 : 0;
        dropCharge = hasPickupDrop && dealer?.providesDrop ? parseFloat(dealer.dropCharges) || 0 : 0;

        subtotal += pickupCharge + dropCharge;

        taxRate = parseFloat(dealer?.tax) || 0;
        taxAmount = (subtotal * taxRate) / 100;
        totalAmount = subtotal + taxAmount;

        commissionRate = parseFloat(dealer?.commission) || 0;
        commissionAmount = parseFloat(((subtotal * commissionRate) / 100).toFixed(2));
        dealerEarnings = parseFloat((subtotal - commissionAmount).toFixed(2));
    }

    if (pickupCharge > 0) {
        services.push({ name: "Pickup Charges", price: pickupCharge, quantity: 1, total: pickupCharge });
    }
    if (dropCharge > 0) {
        services.push({ name: "Drop Charges", price: dropCharge, quantity: 1, total: dropCharge });
    }
    if (towingCharge > 0) {
        services.push({ name: "Towing Charges", price: towingCharge, quantity: 1, total: towingCharge });
    }

    const billNumber = await generateInvoiceNumber();

    const variant = booking.userBike_id?.variant_id;
    const model = variant?.model_id;
    const company = model?.company_id;

    const bill = new Bill({
        booking_id: booking._id,
        booking_number: booking.bookingId || null,
        payment_id: paymentMeta.payment_id || null,
        bill_number: billNumber,
        // A bill backfilled for an older paid booking is dated when that
        // booking was paid/delivered, not the day someone first opened it.
        bill_date: paymentMeta.bill_date || new Date(),
        customer_details: {
            name: `${booking.user_id.first_name} ${booking.user_id.last_name}`,
            email: booking.user_id.email,
            phone: booking.user_id.phone,
        },
        dealer_details: resolveDealerDetails(booking.dealer_id),
        support_details: await getSupportContact(),
        bike_details: {
            model: booking.userBike_id?.model || "N/A",
            // UserBike stores the plate as `plate_number`; `registration_number`
            // is only kept as a fallback for any legacy document that carried it.
            registration:
                booking.userBike_id?.plate_number || booking.userBike_id?.registration_number || "N/A",
            vin: booking.userBike_id?.vin || "N/A",
            company: company?.name || null,
            engine_cc: variant?.engine_cc ?? bikeCC ?? null,
        },
        services: services,
        subtotal: subtotal,
        pickup_charges: pickupCharge,
        drop_charges: dropCharge,
        towing_charge: towingCharge,
        tax_amount: taxAmount,
        tax_rate: taxRate,
        platform_fee: platformFee,
        platform_fee_label: platformFeeLabel,
        discount_amount: discountAmount,
        promo_code: booking.promoCode || null,
        promo_name: booking.promoName || null,
        total_amount: totalAmount,
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        commission_tax_rate: commissionTaxRate,
        commission_tax_amount: commissionTaxAmount,
        dealer_earnings: dealerEarnings,
        payment_details: {
            payment_method: paymentMeta.payment_method || "online",
            transaction_id: paymentMeta.transaction_id,
            payment_date: paymentMeta.bill_date || new Date(),
        },
        status: "generated",
    });

    try {
        await bill.save();
    } catch (error) {
        if (error?.code === 11000) {
            const concurrentBill = await Bill.findOne({ booking_id: bookingId });
            if (concurrentBill) return concurrentBill;
        }
        throw error;
    }
    console.log(`✅ Invoice generated: ${billNumber} for booking: ${booking._id}`);

    // Promo usage is NOT touched here. Per the final business rule, a promo
    // is consumed exactly once — when the dealer confirms the booking (see
    // controller/booking.js#updateBookingStatus) — and payment/invoice
    // generation are fully independent of that. This function only reads
    // booking.promoCode/promoName/discountAmount above to DISPLAY the
    // already-locked snapshot; it must never create a PromoCodeUsage or
    // increment PromoCode.usedCount.

    if (hasPricingSnapshot) {
        await Booking.findByIdAndUpdate(booking._id, { $set: { billGenerated: true } });
    } else {
        await Booking.findByIdAndUpdate(
            booking._id,
            {
                $set: {
                    billGenerated: true,
                    tax: taxAmount,
                    totalBill: subtotal,
                    pickupCharges: pickupCharge,
                    dropCharges: dropCharge,
                },
            },
            { [PRICING_WRITE_BYPASS_FLAG]: true }
        );
    }

    return bill;
}

// The rows getOrCreateInvoice appends after the services for the transport
// charges. They are carried over untouched when the service rows are rebuilt.
const TRANSPORT_ROW_NAMES = new Set(["Pickup Charges", "Drop Charges", "Towing Charges"]);

// Bills issued before buildServiceLineItems priced their service rows with a
// CC-only lookup, so a service could print at the wrong amount — or ₹0 — even
// though the bill's totals (taken from the booking snapshot) were right.
// Rebuild those rows from the booking the first time the invoice is opened.
//
// Only the rows are ever rewritten, never a total, and only when the rebuilt
// rows add up to exactly the service amount this bill already charged. A
// booking whose services changed after the bill was issued fails that check
// and keeps the bill it was paid against.
async function refreshBillServiceLines(bill) {
    if (!bill) return bill;

    const booking = await loadBookingForInvoice(bill.booking_id);
    if (!booking || !booking.pricingVersion) return bill;

    const serviceRows = buildServiceLineItems(booking);
    if (serviceRows.length === 0) return bill;

    const billedServiceAmount = round2(
        (Number(bill.subtotal) || 0) -
            (Number(bill.pickup_charges) || 0) -
            (Number(bill.drop_charges) || 0) -
            (Number(bill.towing_charge) || 0)
    );
    const rebuiltAmount = round2(serviceRows.reduce((sum, line) => sum + line.total, 0));
    if (rebuiltAmount !== billedServiceAmount) return bill;

    const transportRows = (bill.services || [])
        .filter((row) => TRANSPORT_ROW_NAMES.has(row.name))
        .map((row) => ({ name: row.name, price: row.price, quantity: row.quantity, total: row.total }));
    const next = [...serviceRows, ...transportRows];

    const current = (bill.services || []).map((row) => `${row.name}|${round2(row.total)}`);
    const rebuilt = next.map((row) => `${row.name}|${round2(row.total)}`);
    if (current.length === rebuilt.length && current.every((row, i) => row === rebuilt[i])) {
        return bill;
    }

    await Bill.updateOne({ _id: bill._id }, { $set: { services: next } });
    bill.services = next;
    return bill;
}

// A customer's phone number is theirs, not the garage's. The dealer gets the
// booking's own contact channels (pickup OTP, in-app chat, the platform's
// support line) and never the raw digits off the invoice, so the number is
// masked down to its last four before it reaches them — enough to match a
// number they already have on a job card, useless for anything else.
//
// Nothing here is a substitute for the server-side rule that the dealer's own
// copy is the only one they can fetch (requireBookingParticipant); it is the
// second layer, so a leak can't happen through the invoice shape alone.
function maskPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return null;
    if (digits.length <= 4) return "X".repeat(digits.length);
    return `${"X".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

const PLACEHOLDER_REGISTRATIONS = new Set(["", "-", "N/A", "NA", "NONE", "NULL", "UNDEFINED"]);

function isMissingRegistration(value) {
    return !value || PLACEHOLDER_REGISTRATIONS.has(String(value).trim().toUpperCase());
}

// Every bill created before the plate_number fix above stored "N/A", because
// invoice generation read `registration_number` — a field UserBike never had.
// Repair such a bill in place the first time its invoice is opened, so the
// already-issued invoices show the real plate instead of N/A forever.
async function backfillBikeRegistration(bill) {
    if (!bill || !isMissingRegistration(bill.bike_details?.registration)) return bill;

    const booking = await Booking.findById(bill.booking_id)
        .select("userBike_id")
        .populate("userBike_id", "plate_number registration_number")
        .lean();

    const plate = booking?.userBike_id?.plate_number || booking?.userBike_id?.registration_number;
    if (isMissingRegistration(plate)) return bill;

    await Bill.updateOne({ _id: bill._id }, { $set: { "bike_details.registration": plate } });
    if (bill.bike_details) bill.bike_details.registration = plate;
    return bill;
}

// Pure mapping, no DB access — the single shape all three frontends
// (User App, Dealer App, Admin Panel) render identically, except that the
// dealer's net payout is withheld from the customer (see `settlement` below).
function buildInvoiceResponse(bill, { role } = {}) {
    return {
        invoiceNumber: bill.bill_number,
        bookingId: bill.booking_id,
        bookingNumber: bill.booking_number || null,
        invoiceDate: bill.bill_date,
        paymentMethod: bill.payment_details?.payment_method || null,
        paymentStatus: bill.status,
        dealer: {
            name: bill.dealer_details?.name || null,
            address: bill.dealer_details?.address || null,
            gstNumber: bill.dealer_details?.gst_number || null,
            logoUrl: bill.dealer_details?.logo_url || null,
        },
        // The only phone number an invoice ever carries. The dealer's own
        // number is withheld from this payload entirely (it stays on the
        // stored bill for internal lookups) so no template can print it —
        // customers with an invoice question must reach MR Bike, not the
        // garage. Bills issued before support_details existed fall back to
        // the number this build ships with.
        support: {
            phone: bill.support_details?.phone || MR_BIKE_SUPPORT_PHONE,
            email: bill.support_details?.email || MR_BIKE_SUPPORT_EMAIL,
        },
        customer: {
            name: bill.customer_details?.name || null,
            // Full digits only for the customer reading their own invoice.
            // The dealer sees a masked number; the admin panel keeps the real
            // one because support has to be able to call the customer back.
            // The customer's email is on no invoice at all, for any role.
            mobile:
                role === "dealer"
                    ? maskPhone(bill.customer_details?.phone)
                    : bill.customer_details?.phone || null,
        },
        bike: {
            company: bill.bike_details?.company || null,
            model: bill.bike_details?.model || null,
            registrationNumber: isMissingRegistration(bill.bike_details?.registration)
                ? null
                : bill.bike_details.registration,
            engineCc: bill.bike_details?.engine_cc ?? null,
        },
        services: (bill.services || []).map((s) => ({
            name: s.name,
            quantity: s.quantity,
            price: s.price,
            total: s.total,
        })),
        charges: {
            pickupCharge: bill.pickup_charges || 0,
            dropCharge: bill.drop_charges || 0,
            // 0 for a rideable bike and for every bill issued before towing
            // existed, so the three invoice templates can render it with the
            // same `> 0` guard they already use for pickup/drop.
            towingCharge: bill.towing_charge || 0,
        },
        subtotal: bill.subtotal,
        tax: { rate: bill.tax_rate, amount: bill.tax_amount },
        // MR Bike's convenience fee. Already part of `totalPaid`, so every
        // template must render it for the invoice to add up. `amount` is 0
        // whenever the fee didn't apply, which is the guard templates use.
        platformFee: {
            amount: bill.platform_fee || 0,
            label: bill.platform_fee_label || DEFAULT_PLATFORM_FEE_LABEL,
        },
        discount: bill.promo_code
            ? { code: bill.promo_code, name: bill.promo_name || null, amount: bill.discount_amount || 0 }
            : null,
        totalPaid: bill.total_amount,
        // Commission — MR Bike's cut of the garage's own amount, and a
        // different thing entirely from the customer-facing `platformFee`
        // above. `dealerPayout` is settlement data between MR Bike and the
        // dealer, so it is withheld from the User App entirely rather than
        // merely hidden client-side; the Dealer App and Admin Panel still
        // receive it.
        settlement: {
            commissionRate: bill.commission_rate,
            commissionAmount: bill.commission_amount,
            // GST on that commission, and the two added together — what is
            // actually recovered from the dealer. 0 on bills issued before
            // the tax existed, which is the guard the templates render behind.
            commissionTaxRate: bill.commission_tax_rate || 0,
            commissionTaxAmount: bill.commission_tax_amount || 0,
            commissionTotal: round2(
                (bill.commission_amount || 0) + (bill.commission_tax_amount || 0)
            ),
            ...(role === "customer" ? {} : { dealerPayout: bill.dealer_earnings }),
        },
    };
}

module.exports = {
    generateInvoiceNumber,
    getOrCreateInvoice,
    backfillBikeRegistration,
    refreshBillServiceLines,
    buildInvoiceResponse,
};
