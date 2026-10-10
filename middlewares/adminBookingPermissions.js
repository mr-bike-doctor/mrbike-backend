const ROLE_PERMISSIONS = Object.freeze({
  Admin: Object.freeze([
    "booking.view", "booking.service_modify", "booking.location_correct",
    "booking.reassign", "booking.cancel", "booking.charge_review",
    "booking.complaint_manage", "booking.live_gps", "booking.audit_read",
  ]),
  Subadmin: Object.freeze(["booking.view", "booking.complaint_manage"]),
  Manager: Object.freeze([
    "booking.view", "booking.service_modify", "booking.location_correct",
    "booking.reassign", "booking.cancel", "booking.charge_review",
    "booking.complaint_manage", "booking.live_gps", "booking.audit_read",
  ]),
  Executive: Object.freeze([
    "booking.view", "booking.complaint_manage", "booking.live_gps",
  ]),
  Telecaller: Object.freeze(["booking.view", "booking.complaint_manage"]),
});

function hasAdminBookingPermission(role, permission) {
  if (typeof role !== "string" || typeof permission !== "string") return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) === true;
}

function requireAdminBookingPermission(permission) {
  return function (req, res, next) {
    // Non-admin booking participants continue through their existing route-level
    // actor checks; this middleware adds role-based restrictions to admin calls.
    if (req.auth?.role && req.auth.role !== "admin") return next();
    const adminRole = req.auth?.adminRole || req.admin_role;
    if (
      (req.auth?.role !== "admin" && !req.admin_role) ||
      !hasAdminBookingPermission(adminRole, permission)
    ) {
      return res.status(403).json({ success: false, message: "Booking permission denied" });
    }
    return next();
  };
}

module.exports = { ROLE_PERMISSIONS, hasAdminBookingPermission, requireAdminBookingPermission };
