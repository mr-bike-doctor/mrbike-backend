const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Bill = require("../models/billSchema");
const {
    getOrCreateInvoice,
    backfillBikeRegistration,
    refreshBillServiceLines,
    buildInvoiceResponse,
} = require("../services/invoiceService");

const BILL_STATUS_VALUES = ["paid", "pending", "cancelled"];

const SORT_OPTIONS = {
    newest: { bill_date: -1 },
    oldest: { bill_date: 1 },
    amount_high: { total_amount: -1 },
    amount_low: { total_amount: 1 },
};

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolves the {$gte, $lte} range for the list's Date filter. "custom" reads
// startDate/endDate from the query; every other option is computed from the
// server's current time. Returns null when no date filter should be applied.
function buildDateRange(dateFilter, startDate, endDate) {
    const now = new Date();

    if (dateFilter === "custom") {
        const range = {};
        if (startDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            range.$gte = start;
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            range.$lte = end;
        }
        return Object.keys(range).length ? range : null;
    }

    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);

    switch (dateFilter) {
        case "today":
            start.setHours(0, 0, 0, 0);
            break;
        case "last7":
            start.setDate(start.getDate() - 6);
            start.setHours(0, 0, 0, 0);
            break;
        case "last30":
            start.setDate(start.getDate() - 29);
            start.setHours(0, 0, 0, 0);
            break;
        case "thisMonth":
            start.setDate(1);
            start.setHours(0, 0, 0, 0);
            break;
        default:
            return null;
    }

    return { $gte: start, $lte: end };
}

// GET /bikedoctor/invoice/booking/:bookingId
// Single endpoint consumed identically by the User App, Dealer App and
// Admin Panel. Always returns the one existing invoice for a booking if
// present. Only ever creates a new one when the booking's payment is
// actually complete (billStatus === "paid") — never for an unpaid booking,
// regardless of its status (e.g. "completed" while still unpaid).
const getInvoice = async (req, res) => {
    try {
        const { bookingId } = req.params;

        let bill = await Bill.findOne({ booking_id: bookingId });

        if (!bill) {
            const booking = await Booking.findById(bookingId).select("billStatus payment_method");
            if (!booking) {
                return res.status(404).json({ success: false, message: "Booking not found" });
            }

            if (booking.billStatus !== "paid") {
                return res.status(404).json({ success: false, message: "Invoice not available yet" });
            }

            bill = await getOrCreateInvoice(bookingId, {
                payment_method: booking.payment_method || "N/A",
            });
        } else {
            // Older bills stored the bike registration as "N/A"; repair them
            // from the booking's bike the first time they are opened.
            await backfillBikeRegistration(bill);
            // …and priced their service rows with a CC-only lookup, so an
            // additional service could print at ₹0. Never fatal: the stored
            // bill is still a valid invoice if the repair can't run.
            try {
                await refreshBillServiceLines(bill);
            } catch (repairError) {
                console.error("Invoice service-row repair failed:", repairError.message);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Invoice fetched successfully",
            data: buildInvoiceResponse(bill, { role: req.auth?.role }),
        });
    } catch (error) {
        console.error("Get Invoice Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch invoice",
            error: error.message,
        });
    }
};

// How many missing invoices one list request will create. Keeps the first
// load after deploy bounded for a dealer with a long paid history; the rest
// are picked up on the following loads.
const BACKFILL_BATCH_SIZE = 25;

// A Bill is normally written when payment completes, but bookings paid before
// that trigger existed — or whose bill generation failed — never got one,
// and the list below reads Bills only, so those bookings were simply missing
// from the dealer's Invoices screen. Create their bills here, under the same
// gate getInvoice uses (billStatus "paid"), dated when the booking was paid.
async function backfillMissingDealerInvoices(dealerId) {
    const paidBookings = await Booking.find({ dealer_id: dealerId, billStatus: "paid" })
        .select("_id payment_method delivered_at updatedAt")
        .sort({ updatedAt: -1 })
        .lean();
    if (paidBookings.length === 0) return;

    const billed = await Bill.find({ booking_id: { $in: paidBookings.map((b) => b._id) } })
        .select("booking_id")
        .lean();
    const billedIds = new Set(billed.map((b) => String(b.booking_id)));
    const missing = paidBookings.filter((b) => !billedIds.has(String(b._id))).slice(0, BACKFILL_BATCH_SIZE);

    for (const booking of missing) {
        try {
            await getOrCreateInvoice(booking._id, {
                payment_method: booking.payment_method || "N/A",
                bill_date: booking.delivered_at || booking.updatedAt || null,
            });
        } catch (error) {
            console.error(`Invoice backfill failed for booking ${booking._id}:`, error.message);
        }
    }
}

// GET /bikedoctor/invoice/dealer/:dealerId
// Lightweight, paginated invoice history for the Dealer App's Invoices list
// screen. Bill already denormalizes customer/bike/amount at invoice-creation
// time, so a single $lookup onto Booking (for dealer scoping + billStatus)
// is enough — no per-row population of user/bike/dealer documents. Never
// returns the pricing breakdown (subtotal/tax/commission/dealerEarnings);
// that only comes from GET /invoice/booking/:bookingId when an invoice is
// opened.
const getDealerInvoices = async (req, res) => {
    try {
        const { dealerId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(dealerId)) {
            return res.status(400).json({ success: false, message: "Invalid dealer id" });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);

        // Only on the first page, so scrolling never re-runs it.
        if (page === 1) {
            try {
                await backfillMissingDealerInvoices(new mongoose.Types.ObjectId(dealerId));
            } catch (backfillError) {
                console.error("Dealer invoice backfill failed:", backfillError.message);
            }
        }
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip = (page - 1) * limit;

        const { search, status, dateFilter, startDate, endDate, sortBy } = req.query;

        const match = { "booking.dealer_id": new mongoose.Types.ObjectId(dealerId) };

        if (status && status !== "all" && BILL_STATUS_VALUES.includes(status)) {
            match["booking.billStatus"] = status;
        }

        const dateRange = buildDateRange(dateFilter, startDate, endDate);
        if (dateRange) {
            match.bill_date = dateRange;
        }

        if (search && String(search).trim()) {
            const regex = new RegExp(escapeRegex(String(search).trim()), "i");
            match.$or = [
                { bill_number: regex },
                { booking_number: regex },
                { "customer_details.name": regex },
                { "bike_details.registration": regex },
            ];
        }

        const sort = SORT_OPTIONS[sortBy] || SORT_OPTIONS.newest;

        const pipeline = [
            {
                $lookup: {
                    from: "bookings",
                    localField: "booking_id",
                    foreignField: "_id",
                    as: "booking",
                },
            },
            { $unwind: "$booking" },
            { $match: match },
            {
                $facet: {
                    data: [
                        { $sort: sort },
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $project: {
                                _id: 0,
                                invoiceNumber: "$bill_number",
                                bookingId: "$booking._id",
                                bookingNumber: "$booking_number",
                                customerName: "$customer_details.name",
                                bikeNumber: "$bike_details.registration",
                                invoiceDate: "$bill_date",
                                paymentStatus: "$booking.billStatus",
                                totalPaid: "$total_amount",
                            },
                        },
                    ],
                    totalCount: [{ $count: "count" }],
                },
            },
        ];

        const [result] = await Bill.aggregate(pipeline);
        const invoices = result?.data || [];
        const totalInvoices = result?.totalCount?.[0]?.count || 0;
        const totalPages = Math.max(1, Math.ceil(totalInvoices / limit));

        return res.status(200).json({
            success: true,
            message: "Invoices fetched successfully",
            data: {
                invoices,
                pagination: {
                    currentPage: page,
                    pageSize: limit,
                    totalInvoices,
                    totalPages,
                    hasMore: page < totalPages,
                },
            },
        });
    } catch (error) {
        console.error("Get Dealer Invoices Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch invoices",
            error: error.message,
        });
    }
};

module.exports = { getInvoice, getDealerInvoices };
