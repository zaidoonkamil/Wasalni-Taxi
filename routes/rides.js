const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/auth");
const { RideRequest, User, DriverRating } = require("../models");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");
const { Op } = require("sequelize");
const { calculateFare, normalizeServiceType } = require("../services/areaPricing");

function roundUpTo250(amount) {
  return Math.ceil(amount / 250) * 250;
}

const driverCanReceiveService = (driverCategory, serviceType) => {
  const category = driverCategory === "super" ? "super" : "ordinary";
  return serviceType === "ordinary" || category === "super";
};

const previousGoodDriverMessage = {
  title: "زبون يعرفك يطلب رحلة",
  message: "أحد الزبائن الذين أوصلتهم سابقاً وقيّم رحلتك بشكل جيد يطلب تكسي الآن بالقرب منك.",
};

const getPreviousGoodDriverRatings = async (riderId, driverIds) => {
  if (!riderId || !driverIds.length) return new Map();

  const rows = await DriverRating.findAll({
    where: {
      rider_id: riderId,
      driver_id: { [Op.in]: driverIds },
      rating: { [Op.gte]: 3 },
      skipped: false,
    },
    attributes: ["driver_id", "rating"],
    raw: true,
  });

  const byDriver = new Map();
  for (const row of rows) {
    const driverId = String(row.driver_id);
    const rating = Number(row.rating || 0);
    const current = byDriver.get(driverId) || 0;
    if (rating > current) byDriver.set(driverId, rating);
  }
  return byDriver;
};

router.post("/ride-requests/estimate", authenticateToken, async (req, res) => {
  try {
    const { pickup, dropoff, distanceKm, durationMin } = req.body;
    const serviceType = normalizeServiceType(req.body.serviceType);
    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "pickup and dropoff required" });
    }

    const result = await calculateFare({
      pickup,
      dropoff,
      distanceKm,
      durationMin,
      serviceType,
    });

    res.json({
      success: true,
      serviceType,
      pricingAreaType: result.areaType,
      estimatedFare: result.estimatedFare,
      pricing: result.pricing,
    });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// إنشاء طلب رحلة جديد (REST)
router.post("/ride-requests", authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const { pickup, dropoff } = req.body;
    const serviceType = normalizeServiceType(req.body.serviceType);

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "pickup and dropoff required" });
    }

    const active = await RideRequest.findOne({
      where: {
        rider_id: user.id,
        status: { [Op.in]: ["pending", "accepted", "arrived", "started"] },
      },
      order: [["createdAt", "DESC"]],
    });

    if (active) {
      return res.json({ success: true, request: active, activeAlreadyExists: true });
    }

    // parse inputs
    const bodyDistance = req.body.distanceKm;
    const bodyDuration = req.body.durationMin;

    let dKm =
      bodyDistance != null
        ? parseFloat(bodyDistance)
        : (pickup.distanceKm != null ? parseFloat(pickup.distanceKm) : null);

    let dur =
      bodyDuration != null
        ? parseFloat(bodyDuration)
        : (pickup.durationMin != null ? parseFloat(pickup.durationMin) : null);

    if (!Number.isFinite(dKm)) dKm = null;
    if (!Number.isFinite(dur)) dur = null;

    let estimatedFare = null;
    let pricingAreaType = "mixed";

    console.log("[CREATE VIA REST] rider=", req.user?.id);
    console.log("[POST /ride-requests] distanceKm(body):", req.body.distanceKm);
    console.log("[POST /ride-requests] pickup.distanceKm:", pickup?.distanceKm);
    console.log("[POST /ride-requests] durationMin(body):", req.body.durationMin);
    console.log("[POST /ride-requests] pickup.durationMin:", pickup?.durationMin);
    console.log("[POST /ride-requests] parsed dKm:", dKm, "parsed dur:", dur);

    try {
      const fare = await calculateFare({
        pickup,
        dropoff,
        distanceKm: dKm,
        durationMin: dur,
        serviceType,
      });
      estimatedFare = fare.estimatedFare;
      pricingAreaType = fare.areaType;

      console.log("[POST /ride-requests] pricing:", {
        serviceType,
        pricingAreaType,
        baseFare: fare.pricing?.baseFare,
        pricePerKm: fare.pricing?.pricePerKm,
        pricePerMinute: fare.pricing?.pricePerMinute,
        minimumFare: fare.pricing?.minimumFare,
      });
    } catch (e) {
      console.error("[POST /ride-requests] pricing calc error:", e.message);
      // estimatedFare remains null
    }

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
      estimatedFare,
      serviceType,
      pricingAreaType,
      status: "pending",
    });

    // find nearby drivers
    const redisClient = await redisService.init();
    const radiusMeters = parseInt(req.query.radius, 10) || 5000;

    const raw = await redisClient
      .sendCommand([
        "GEORADIUS",
        "drivers:geo",
        String(pickup.lng),
        String(pickup.lat),
        String(radiusMeters),
        "m",
        "COUNT",
        "30",
        "ASC",
      ])
      .catch(() => []);

    const driverIds = (raw || []).map(String).slice(0, 30);
    const driverRows = await User.findAll({
      where: { id: { [Op.in]: driverIds }, role: "driver", status: "active" },
      attributes: ["id", "vehicleCategory"],
    });
    const driverCategoryById = new Map(driverRows.map((driver) => [String(driver.id), driver.vehicleCategory || "ordinary"]));
    const previousGoodRatingsByDriver = await getPreviousGoodDriverRatings(user.id, driverIds);

    for (const did of driverIds) {
      if (!driverCanReceiveService(driverCategoryById.get(String(did)), serviceType)) continue;

      const isOnline = await redisClient.sIsMember("drivers:online", String(did));
      if (!isOnline) continue;

      const busyRideId = await redisClient.get(`driver:busy:${did}`);
      if (busyRideId) continue;

      const previousRating = previousGoodRatingsByDriver.get(String(did));
      const priorityMatch = previousRating != null;
      const payload = priorityMatch
        ? {
            request: newReq,
            priorityMatch: {
              type: "previous_good_rating",
              rating: previousRating,
              title: previousGoodDriverMessage.title,
              message: previousGoodDriverMessage.message,
            },
          }
        : { request: newReq };

      await socketService
        .notifyDriverSocket(did, "request:new", payload)
        .catch(() => {});

      if (priorityMatch) {
        notifications
          .sendNotificationToUser(did, previousGoodDriverMessage.message, previousGoodDriverMessage.title)
          .catch((e) => console.error("previous good driver push error:", e.message));
      }
    }

    return res.json({ success: true, request: newReq });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /ride-requests/active
router.get("/ride-requests/active", authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    const activeStatuses = ["pending", "accepted", "arrived", "started"];

    const where =
      user.role === "driver"
        ? { driver_id: user.id, status: { [Op.in]: activeStatuses } }
        : { rider_id: user.id, status: { [Op.in]: activeStatuses } };

    const request = await RideRequest.findOne({
      where,
      order: [["updatedAt", "DESC"]],
    });

    return res.json({ hasActive: !!request, request });
  } catch (e) {
    return res.status(500).json({ error: e.message });
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
    if (ride.driver_id) {
      await socketService.notifyDriverSocket(
        ride.driver_id,
        "trip:status_changed",
        { requestId: ride.id, status: ride.status }
      );

      const redisClient = await redisService.init();
      await redisClient.del(`driver:busy:${ride.driver_id}`);
    }
    if (ride.driver_id) {
      await socketService.notifyDriverSocket(ride.driver_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
    const redisClient = await redisService.init();
    await redisClient.del(`driver:busy:${ride.driver_id}`);
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
