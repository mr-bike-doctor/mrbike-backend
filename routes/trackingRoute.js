var express = require('express');
var multer = require('multer');
var fs = require('fs-extra');
const router = express.Router();
const { requireAdmin } = require("../middlewares/requireAdmin");
const { requireBookingParticipant } = require("../middlewares/bookingAuth");
const { requireAdminBookingPermission } = require("../middlewares/adminBookingPermissions");
const {gettracking, updatetracking,getAlltracking} = require("../controller/trackings")

const storage = multer.diskStorage({
    destination: (req, file, callback) => {
        var path = `./upload/tracking`;
        fs.mkdirsSync(path);
        callback(null, path);
    },
    filename(req, file, callback) {
        callback(null, Date.now() + '_' + file.originalname);
    },
});
const upload = multer({ storage });

/* POST users listing. */getAlltracking
router.get('/alltrackbooking',requireAdmin,requireAdminBookingPermission("booking.live_gps"),getAlltracking)
router.get('/trackbooking/:id',requireBookingParticipant((req) => req.params.id),requireAdminBookingPermission("booking.live_gps"),gettracking)
router.put('/updatetracking/:id',requireBookingParticipant((req) => req.params.id),requireAdminBookingPermission("booking.live_gps"),updatetracking)


module.exports = router;
