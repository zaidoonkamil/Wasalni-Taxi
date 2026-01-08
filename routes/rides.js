const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/auth");
const { RideRequest, PricingSetting } = require("../models");
const redisService = require("../services/redis");
const socketService = require("../services/socket");

// إنشاء طلب رحلة جديد (REST)
router.post("/ride-requests", authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ error: "pickup and dropoff required" });

    // compute fare if distance provided
    let dKm = req.body.distanceKm != null ? parseFloat(req.body.distanceKm) : (pickup.distanceKm || null);
    let dur = req.body.durationMin != null ? parseFloat(req.body.durationMin) : (pickup.durationMin || null);
    let estimatedFare = null;
    try {
      const pricing = await PricingSetting.findOne({ order: [["createdAt", "DESC"]] });
      if (pricing && dKm != null) {
        const base = parseFloat(pricing.baseFare || 0);
        const perKm = parseFloat(pricing.pricePerKm || 0);
        const perMin = pricing.pricePerMinute ? parseFloat(pricing.pricePerMinute) : 0;
        const minimum = pricing.minimumFare != null ? parseFloat(pricing.minimumFare) : null;
        let fare = base + dKm * perKm + (dur != null ? dur * perMin : 0);
        if (minimum != null) fare = Math.max(minimum, fare);
        estimatedFare = fare.toFixed(2);
      }
    } catch (e) { }

    const newReq = await RideRequest.create({
      rider_id: user.id,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupAddress: pickup.address || null,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
      dropoffAddress: dropoff.address || null,
      distanceKm: dKm,
      durationMin: dur,
      estimatedFare: estimatedFare,
      status: "pending",
    });

    // اعثر على السائقين القريبين عبر تقنية Redis الجغرافية
    const redisClient = await redisService.init();
    const radiusMeters = parseInt(req.query.radius) || 5000;
    const raw = await redisClient.sendCommand(["GEORADIUS", "drivers:geo", String(pickup.lng), String(pickup.lat), String(radiusMeters), "m", "COUNT", "30", "ASC"]).catch(() => []);
    const driverIds = (raw || []).map(String).slice(0, 30);

    // إخطار السائقين عبر المقابس
    for (const did of driverIds) {
      await socketService.notifyDriverSocket(did, "request:new", { request: newReq }).catch(() => {});
    }

    res.json({ success: true, request: newReq });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /ride-requests/active
router.get("/ride-requests/active", authenticateToken, async (req, res) => {
  try {
    const active = await RideRequest.findOne({
      where: {
        rider_id: req.user.id,
        status: ["pending", "accepted", "arrived", "started"],
      },
      order: [["createdAt", "DESC"]],
    });

    if (!active) {
      return res.json({ hasActive: false });
    }

    return res.json({
      hasActive: true,
      request: active,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// الحصول على تفاصيل طلب رحلة
router.get("/ride-requests/:id", authenticateToken, async (req, res) => {
  try {
    const reqId = req.params.id;
    const ride = await RideRequest.findByPk(reqId);
    if (!ride) return res.status(404).json({ error: "not_found" });
    res.json({ ride });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// إلغاء طلب رحلة
router.post("/ride-requests/:id/cancel", authenticateToken, async (req, res) => {
  try {
    const reqId = req.params.id;
    const ride = await RideRequest.findByPk(reqId);
    if (!ride) return res.status(404).json({ error: "not_found" });
    if (ride.status === "completed" || ride.status === "cancelled") return res.status(400).json({ error: "cannot_cancel" });
    ride.status = "cancelled";
    await ride.save();
    // notify assigned driver
    if (ride.driver_id) {
      await socketService.notifyDriverSocket(ride.driver_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
    }
    res.json({ success: true, ride });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// الحصول على السائقين القريبين
router.get("/drivers/nearby", authenticateToken, async (req, res) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
    const redisClient = await redisService.init();
    const raw = await redisClient.sendCommand(["GEORADIUS", "drivers:geo", String(lng), String(lat), String(radius), "m", "COUNT", "30", "ASC"]).catch(() => []);
    const driverIds = (raw || []).map(String).slice(0, 30);
    const list = [];
    for (const did of driverIds) {
      const loc = await redisService.getJSON(`driver:loc:${did}`);
      list.push({ driverId: did, loc });
    }
    res.json({ drivers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ride-requests/user/:userId
router.get("/ride-requests/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, page = 1, limit = 20,} = req.query;

    const where = { rider_id: userId };
    if (status) where.status = status;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows, count } = await RideRequest.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    return res.json({
      success: true,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      rides: rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /ride-requests/driver/:driverId
router.get("/ride-requests/driver/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    const {
      status,
      page = 1,
      limit = 20,
    } = req.query;

    const where = { driver_id: driverId };
    if (status) where.status = status;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows, count } = await RideRequest.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    return res.json({
      success: true,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      rides: rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;