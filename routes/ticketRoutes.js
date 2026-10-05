const express = require("express");
const router = express.Router();
const {
    createTicket,
    replyToTicket,
    getMyTickets,
    getAllUserAndDealerTickets,
    updateTicketStatus,
    getTicketById,
    getSupportUnreadCount,
    markTicketRead
} = require("../controller/ticketController");
const { requireAdmin } = require("../middlewares/requireAdmin");
const { requireOwnTicketList, requireTicketParticipant } = require("../middlewares/ticketAuth");

// requireOwnTicketList checks req.params.user_id against the authenticated
// actor (customer or dealer) and sets req.auth/req.user_id — the same
// ownership check a ticket-create needs, so it's reused here as well.
router.post("/create/:user_id", requireOwnTicketList, createTicket);
router.post("/reply/:ticket_id", requireTicketParticipant("ticket_id"), replyToTicket);
router.get("/my-tickets/:user_id", requireOwnTicketList, getMyTickets);
router.get("/user-dealer", requireAdmin, getAllUserAndDealerTickets);
router.post("/status/:ticket_id", requireTicketParticipant("ticket_id"), updateTicketStatus);
// Older dealer/user app builds send PUT here.
router.put("/status/:ticket_id", requireTicketParticipant("ticket_id"), updateTicketStatus);
router.get("/tickets/:ticket_id", requireTicketParticipant("ticket_id"), getTicketById);
router.get("/unread-count", requireAdmin, getSupportUnreadCount);
router.post("/mark-read/:ticket_id", requireAdmin, markTicketRead);

module.exports = router;
