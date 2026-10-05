const mongoose = require("mongoose")
const Ticket = require("../models/ticket_model")
const Admin = require("../models/admin_model")
const Customer = require("../models/customer_model")
const Vendor = require("../models/dealerModel")

const parseTicketNo = (s) => {
  const str = String(s || "").trim()
  // Match TCK-XXXXX (legacy), MRBDXXXXXXXXXX (vendor), or MRBDCXXXXXXXXXX (user)
  const m = /^(?:TCK-|MRBD|MRBDC)(\d+)$/.exec(str)
  return m ? Number.parseInt(m[1], 10) : null
}

// All active admins get notified (shared support queue) when a dealer/user
// sends a message; each admin's own unread counter is reset only once they
// personally open the ticket.
const getActiveAdminIds = async () => {
  const admins = await Admin.find({ status: "active" }).select("_id").lean()
  return admins.map((a) => a._id)
}

// Tickets only store user_id + user_type, so the admin console had no way to
// tell who raised a ticket. Resolves each ticket's raiser from the matching
// collection (customers for "user", Vendor for "dealer") and attaches a small
// `raisedBy` summary. Admin-only — never sent back to customers/dealers.
const isDealerType = (t) => t === "dealer" || Number(t) === 2

const attachRaisedBy = async (tickets) => {
  const customerIds = []
  const dealerIds = []
  tickets.forEach((t) => {
    if (!t?.user_id) return
    ;(isDealerType(t.user_type) ? dealerIds : customerIds).push(t.user_id)
  })

  const [customers, dealers] = await Promise.all([
    customerIds.length
      ? Customer.find({ _id: { $in: customerIds } }).select("id first_name last_name phone email city").lean()
      : [],
    dealerIds.length
      ? Vendor.find({ _id: { $in: dealerIds } })
          .select("id shopName ownerName phone shopContact email shopEmail city")
          .lean()
      : [],
  ])

  const customerMap = new Map(customers.map((c) => [String(c._id), c]))
  const dealerMap = new Map(dealers.map((d) => [String(d._id), d]))

  return tickets.map((t) => {
    const key = String(t.user_id)
    let raisedBy = null
    if (isDealerType(t.user_type)) {
      const d = dealerMap.get(key)
      if (d) {
        raisedBy = {
          _id: d._id,
          type: "dealer",
          displayId: d.id ?? null,
          name: d.shopName || d.ownerName || "",
          ownerName: d.ownerName || "",
          phone: d.phone || d.shopContact || "",
          email: d.email || d.shopEmail || "",
          city: d.city || "",
        }
      }
    } else {
      const c = customerMap.get(key)
      if (c) {
        raisedBy = {
          _id: c._id,
          type: "user",
          displayId: c.id ?? null,
          name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim(),
          phone: c.phone || "",
          email: c.email || "",
          city: c.city || "",
        }
      }
    }
    return { ...t, raisedBy }
  })
}

// req.auth.role comes from authenticateActor ("customer"/"dealer"), while
// Ticket.user_type/sender_type use "user"/"dealer" (see models/ticket_model.js
// ROLES) — map between the two instead of hardcoding "user" for everyone.
const ROLE_TO_TICKET_TYPE = { customer: "user", dealer: "dealer" }

const createTicket = async (req, res) => {
  try {
    const user_id = req.user_id
    const { subject, message } = req.body
    const user_type = ROLE_TO_TICKET_TYPE[req.auth?.role] || "user"

    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required" })
    }
    if (!mongoose.Types.ObjectId.isValid(user_id)) {
      return res.status(400).json({ success: false, message: "Invalid user_id" })
    }
    if (!subject || !message) {
      return res.status(400).json({ success: false, message: "Subject and message are required" })
    }

    // Only dealer/user allowed
    const allowed = ["dealer", "user"]
    if (!allowed.includes(user_type)) {
      return res.status(400).json({
        success: false,
        message: 'user_type must be "dealer" or "user"',
      })
    }

    const msgSenderId = user_id
    if (!mongoose.Types.ObjectId.isValid(msgSenderId)) {
      return res.status(400).json({ success: false, message: "Invalid sender_id" })
    }

    // sender_type falls back to user_type if not valid
    const msgSenderType = user_type

    const created = await Ticket.create({
      user_id,
      user_type,
      subject,
      messages: [
        {
          sender_id: msgSenderId,
          sender_type: msgSenderType,
          message,
        },
      ],
    })

    // New ticket always starts with a dealer/user message, so every active
    // admin should see it as unread until they personally open it.
    const adminIds = await getActiveAdminIds()
    if (adminIds.length) {
      created.incrementUnreadForAdmins(adminIds)
      await created.save()

      const io = req.app.get("io")
      if (io) {
        adminIds.forEach((id) =>
          io.to(`admin:${id}`).emit("support:unread:changed", { ticketId: String(created._id) }),
        )
      }
    }

    return res.status(201).json({
      success: true,
      message: "Ticket created successfully",
      data: created,
    })
  } catch (error) {
    console.error("Ticket Creation Error:", error)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

// Role helpers: accept numeric or string; normalize to string
const ROLE_NUM2STR = { 1: "admin", 2: "dealer", 4: "user" }
const ROLE_STR = ["admin", "dealer", "user"]

const normalizeRole = (val) => {
  if (val == null) return null
  const n = Number(val)
  if ([1, 2, 4].includes(n)) return ROLE_NUM2STR[n]
  const s = String(val).toLowerCase().trim()
  if (ROLE_STR.includes(s)) return s
  return null
}

const replyToTicket = async (req, res) => {
  try {
    const { ticket_id } = req.params
    const { message } = req.body
    const sender_id = req.auth.id
    const sender_type = req.auth.role === "customer" ? "user" : req.auth.role

    if (!ticket_id || !message || !sender_id || !sender_type) {
      return res
        .status(400)
        .json({ success: false, message: "ticket_id, message, sender_id, sender_type are required" })
    }

    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" })
    if (ticket.status === "Closed") return res.status(400).json({ success: false, message: "Ticket is closed" })

    // push message
    ticket.messages.push({
      sender_id,
      sender_type, // "admin" | "dealer" | "user"  (or numbers if that's what you store)
      message,
      timestamp: new Date(),
    })
    // optional: update convenience fields
    ticket.lastMessageAt = new Date()
    ticket.lastMessageText = message

    // Admin's own reply implies they've seen the thread; a dealer/user reply
    // bumps every active admin's unread counter for this ticket.
    let notifyAdminIds = []
    if (sender_type === "admin") {
      ticket.resetUnreadForAdmin(sender_id)
    } else {
      notifyAdminIds = await getActiveAdminIds()
      ticket.incrementUnreadForAdmins(notifyAdminIds)
    }

    await ticket.save()

    // repop / lean if you want to send a clean object
    const updated = await Ticket.findById(ticket_id).lean({ virtuals: true })

    // 🔊 emit to everyone viewing this ticket
    const io = req.app.get("io")
    if (io) {
      io.to(String(ticket_id)).emit("ticket:message:new", {
        ticketId: String(ticket_id),
        ticket: updated, // or just send the new message to minimize payload
        // message: updated.messages[updated.messages.length - 1],
      })

      if (sender_type === "admin") {
        io.to(`admin:${sender_id}`).emit("support:unread:changed", { ticketId: String(ticket_id) })
      } else {
        notifyAdminIds.forEach((id) =>
          io.to(`admin:${id}`).emit("support:unread:changed", { ticketId: String(ticket_id) }),
        )
      }
    }

    return res.status(200).json({ success: true, message: "Reply added", data: updated })
  } catch (err) {
    console.error("Ticket Reply Error:", err)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

const getMyTickets = async (req, res) => {
  try {
    const user_id = req.auth?.role === "admin" ? req.params.user_id : req.user_id

    if (!user_id) {
      return res.status(400).json({ success: false, message: "User ID is required" })
    }

    if (!mongoose.Types.ObjectId.isValid(user_id)) {
      return res.status(400).json({ success: false, message: "Invalid user_id" })
    }

    const tickets = await Ticket.find({ user_id: new mongoose.Types.ObjectId(user_id) })
      .sort({ created_at: -1 })
      .lean()

    return res.status(200).json({
      success: true,
      message: "Tickets retrieved successfully",
      data: tickets,
    })
  } catch (error) {
    console.error("Fetch Tickets Error:", error)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

const getAllUserAndDealerTickets = async (req, res) => {
  try {
    // ---- optional query params ----
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20))
    const q = (req.query.q || "").trim() // search term (subject / lastMessageText)
    const status = (req.query.status || "").trim() // "Open" | "In Progress" | "Closed"
    const sortBy = req.query.sortBy || "lastMessageAt" // "lastMessageAt" | "created_at"
    const sortDir = (req.query.sortDir || "desc").toLowerCase() === "asc" ? 1 : -1

    // ---- base filter: dealer + user (string) OR legacy numeric 2/4 ----
    const typeFilter = {
      $or: [
        { user_type: { $in: ["dealer", "user"] } },
        { user_type: { $in: [2, 4] } }, // compatibility if some docs are still numeric
      ],
    }

    const filter = { ...typeFilter }

    if (status) {
      filter.status = status // relies on enum: "Open" | "In Progress" | "Closed"
    }

    // Text search: uses text index if available, else regex on subject/lastMessageText
    let useProjectScore = false
    let sort = {}
    if (q) {
      // If you created a text index on subject + lastMessageText:
      // TicketSchema.index({ subject: "text", lastMessageText: "text" })
      filter.$text = { $search: q }
      useProjectScore = true
      sort = { score: { $meta: "textScore" }, [sortBy]: sortDir, _id: -1 }
    } else {
      sort = { [sortBy]: sortDir, _id: -1 }
    }

    const skip = (page - 1) * limit

    // Query
    const query = Ticket.find(filter).sort(sort).skip(skip).limit(limit).lean()

    if (useProjectScore) {
      query.select({ score: { $meta: "textScore" } })
    } else {
      // pick a lightweight projection; add/remove fields as needed
      query.select({
        subject: 1,
        status: 1,
        user_id: 1,
        user_type: 1,
        lastMessageAt: 1,
        lastMessageText: 1,
        created_at: 1,
        ticketNo: 1,
        ticketId: 1, // virtual if enabled
        unreadFor: 1, // reduced to a per-viewer boolean below, never sent raw
      })
    }

    const [tickets, total] = await Promise.all([query.exec(), Ticket.countDocuments(filter)])

    // Collapse the raw unreadFor map down to a single boolean scoped to the
    // requesting admin — the client only needs to know "unread for me".
    const adminId = req.admin_id ? String(req.admin_id) : null
    const rows = await attachRaisedBy(
      tickets.map(({ unreadFor, ...t }) => ({
        ...t,
        unread: Boolean(adminId && unreadFor && unreadFor[adminId] > 0),
      })),
    )

    return res.status(200).json({
      success: true,
      message: "User and dealer tickets retrieved successfully",
      data: rows,
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
        sortBy,
        sortDir: sortDir === 1 ? "asc" : "desc",
        q: q || undefined,
        status: status || undefined,
      },
    })
  } catch (error) {
    console.error("Fetch User & Dealer Tickets Error:", error)
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    })
  }
}

const getTicketById = async (req, res) => {
  try {
    const { ticket_id } = req.params
    // Optional query flags
    const markSeen = String(req.query.markSeen || "false").toLowerCase() === "true"
    const includeMessages = String(req.query.includeMessages || "true").toLowerCase() === "true"

    if (!ticket_id) {
      return res.status(400).json({ success: false, message: "ticket_id is required" })
    }

    // Resolve by _id or ticketId (TCK-xxxxx)
    let findFilter = null
    if (mongoose.Types.ObjectId.isValid(ticket_id)) {
      findFilter = { _id: ticket_id }
    } else {
      const ticketNo = parseTicketNo(ticket_id)
      if (!ticketNo) {
        return res.status(400).json({
          success: false,
          message: "ticket_id must be a valid ObjectId or like TCK-00001",
        })
      }
      findFilter = { ticketNo }
    }

    // identify viewer (assumes you set req.user in auth middleware)
    // expected shape: { _id: ObjectId, role: "admin" | "dealer" | "user" }
    const viewer = req.user || {}
    const viewerId = viewer._id ? String(viewer._id) : null
    const isAdmin = viewer.role === "admin"

    // Fetch ticket
    const ticket = await Ticket.findOne(findFilter)
      .select({
        subject: 1,
        status: 1,
        user_id: 1,
        user_type: 1,
        messages: includeMessages ? 1 : 0,
        lastMessageAt: 1,
        lastMessageText: 1,
        unreadFor: 1,
        created_at: 1,
        ticketNo: 1,
      })
      .populate({
        path: "messages.sender_id",
        select: "name email", // keep it light
      })
      .lean()

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found" })
    }

    // ACL: non-admins can only read their own ticket
    if (!isAdmin && viewerId && String(ticket.user_id) !== viewerId) {
      return res.status(403).json({ success: false, message: "Forbidden" })
    }

    // Hide internal messages for non-admins
    if (!isAdmin && includeMessages && Array.isArray(ticket.messages)) {
      ticket.messages = ticket.messages.filter((m) => !m.internal)
    }

    // Optionally mark seen for viewer (non-admin/admin both allowed)
    if (markSeen && viewerId) {
      // Build updates: add viewerId to seenBy for each visible message, and reset unreadFor[viewerId]
      // Only mark non-internal or admin messages.
      const updateOps = []

      // Reset unreadFor viewer
      updateOps.push({
        updateOne: {
          filter: { _id: ticket._id },
          update: { $set: { [`unreadFor.${viewerId}`]: 0 } },
        },
      })

      // Add to seenBy per message (only when messages included)
      if (includeMessages && Array.isArray(ticket.messages) && ticket.messages.length) {
        // collect message _ids to update where viewer not already present
        const messageIdsToUpdate = ticket.messages
          .filter((m) => !m.internal || isAdmin)
          .filter((m) => !(m.seenBy || []).some((x) => String(x) === viewerId))
          .map((m) => m._id)

        if (messageIdsToUpdate.length) {
          updateOps.push({
            updateOne: {
              filter: { _id: ticket._id },
              update: {
                $addToSet: {
                  "messages.$[msg].seenBy": new mongoose.Types.ObjectId(viewerId),
                },
              },
              arrayFilters: [{ "msg._id": { $in: messageIdsToUpdate } }],
            },
          })
        }
      }

      if (updateOps.length) {
        await Ticket.bulkWrite(updateOps)
        // reflect locally
        if (ticket.unreadFor) ticket.unreadFor[viewerId] = 0
        if (includeMessages && Array.isArray(ticket.messages)) {
          ticket.messages = ticket.messages.map((m) => {
            if ((!m.internal || isAdmin) && updateOps.length) {
              const shouldAdd = m._id && (m.seenBy || []).every((x) => String(x) !== viewerId)
              if (shouldAdd) {
                return {
                  ...m,
                  seenBy: [...(m.seenBy || []), viewer._id],
                }
              }
            }
            return m
          })
        }
      }
    }

    const date = new Date(ticket.created_at)
    const day = String(date.getDate()).padStart(2, "0")
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const year = String(date.getFullYear()).slice(-2)
    const hours = String(date.getHours()).padStart(2, "0")
    const minutes = String(date.getMinutes()).padStart(2, "0")
    const timeStr = `${day}${month}${year}${hours}${minutes}`
    const prefix = ticket.user_type === "dealer" ? "MRBD" : "MRBDC"

    const payload = req.auth?.role === "admin" ? (await attachRaisedBy([ticket]))[0] : ticket

    return res.status(200).json({
      success: true,
      message: "Ticket retrieved successfully",
      data: {
        ...payload,
        ticketId: `${prefix}${timeStr}`,
      },
    })
  } catch (error) {
    console.error("Fetch Single Ticket Error:", error)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

const updateTicketStatus = async (req, res) => {
  try {
    const { ticket_id } = req.params
    const { status } = req.body

    const allowed = ["Open", "In Progress", "Closed"]
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed: ${allowed.join(", ")}`,
      })
    }

    // Support either ObjectId or TCK-xxxxx
    let filter
    if (mongoose.Types.ObjectId.isValid(ticket_id)) {
      filter = { _id: ticket_id }
    } else {
      const ticketNo = parseTicketNo(ticket_id)
      if (!ticketNo) {
        return res.status(400).json({
          success: false,
          message: "ticket_id must be a valid ObjectId or like TCK-00001",
        })
      }
      filter = { ticketNo }
    }

    // Fetch existing (lean for speed)
    const existing = await Ticket.findOne(filter).select({ status: 1, ticketNo: 1 }).lean()

    if (!existing) {
      return res.status(404).json({ success: false, message: "Ticket not found" })
    }

    // Prevent changes when already Closed
    if (existing.status === "Closed") {
      return res.status(400).json({
        success: false,
        message: "Ticket is already Closed and cannot be updated",
      })
    }

    // No-op guard
    if (existing.status === status) {
      return res.status(409).json({
        success: false,
        message: `Ticket is already in status "${status}"`,
      })
    }

    // Apply update
    const updated = await Ticket.findOneAndUpdate(
      filter,
      { $set: { status } },
      { new: true }, // return the updated doc
    ).lean()

    const date = new Date(updated.created_at)
    const day = String(date.getDate()).padStart(2, "0")
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const year = String(date.getFullYear()).slice(-2)
    const hours = String(date.getHours()).padStart(2, "0")
    const minutes = String(date.getMinutes()).padStart(2, "0")
    const timeStr = `${day}${month}${year}${hours}${minutes}`
    const prefix = updated.user_type === "dealer" ? "MRBD" : "MRBDC"

    const response = {
      ...updated,
      ticketId: `${prefix}${timeStr}`,
    }

    return res.status(200).json({
      success: true,
      message: "Ticket status updated successfully",
      data: response,
    })
  } catch (err) {
    console.error("Update Ticket Status Error:", err)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

// Total number of tickets carrying an unread dealer/user message for the
// requesting admin — backs the sidebar "Support (n)" badge.
const getSupportUnreadCount = async (req, res) => {
  try {
    const adminId = String(req.admin_id)
    const unreadCount = await Ticket.countDocuments({ [`unreadFor.${adminId}`]: { $gt: 0 } })
    return res.status(200).json({ success: true, unreadCount })
  } catch (error) {
    console.error("Get Support Unread Count Error:", error)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

// Marks a ticket read for the requesting admin only (per-admin unread state);
// other admins who haven't opened it still see it as unread.
const markTicketRead = async (req, res) => {
  try {
    const { ticket_id } = req.params
    if (!mongoose.Types.ObjectId.isValid(ticket_id)) {
      return res.status(400).json({ success: false, message: "Invalid ticket_id" })
    }

    const ticket = await Ticket.findById(ticket_id)
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" })

    ticket.resetUnreadForAdmin(req.admin_id)
    await ticket.save()

    const adminId = String(req.admin_id)
    const unreadCount = await Ticket.countDocuments({ [`unreadFor.${adminId}`]: { $gt: 0 } })

    const io = req.app.get("io")
    if (io) io.to(`admin:${adminId}`).emit("support:unread:changed", { ticketId: String(ticket_id) })

    return res.status(200).json({ success: true, unreadCount })
  } catch (error) {
    console.error("Mark Ticket Read Error:", error)
    return res.status(500).json({ success: false, message: "Internal server error" })
  }
}

module.exports = {
  createTicket,
  replyToTicket,
  getMyTickets,
  getAllUserAndDealerTickets,
  updateTicketStatus,
  getTicketById,
  getSupportUnreadCount,
  markTicketRead,
}
