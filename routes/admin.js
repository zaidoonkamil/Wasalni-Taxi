const express = require("express");
const router = express.Router();
const { requireAdmin } = require("./user");
const { PricingSetting, RideRequest, User, AreaPricingZone } = require("../models");
const { Op } = require("sequelize");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");
const { AREA_TYPES, SERVICE_TYPES, normalizeAreaType, normalizeServiceType } = require("../services/areaPricing");

const driverCanReceiveService = (driverCategory, serviceType) => {
  return true;
};

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// Get current pricing (latest)
router.get("/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const latest = await PricingSetting.findOne({ order: [["createdAt", "DESC"]] });
    const findLatest = (serviceType, areaType = "mixed") =>
      PricingSetting.findOne({
        where: { serviceType, areaType },
        order: [["createdAt", "DESC"]],
      });

    const matrix = {};
    for (const serviceType of SERVICE_TYPES) {
      matrix[serviceType] = {};
      for (const areaType of AREA_TYPES) {
        matrix[serviceType][areaType] = await findLatest(serviceType, areaType);
      }
    }

    const ordinary = matrix.ordinary.mixed || await findLatest("ordinary");
    const superPricing = matrix.super.mixed || await findLatest("super");

    res.json({
      pricing: ordinary || latest || null,
      pricingByType: {
        ordinary: ordinary || latest || null,
        super: superPricing || ordinary || latest || null,
      },
      pricingByArea: {
        ordinary: {
          rich: matrix.ordinary.rich || matrix.ordinary.mixed || latest || null,
          poor: matrix.ordinary.poor || matrix.ordinary.mixed || latest || null,
          mixed: matrix.ordinary.mixed || latest || null,
        },
        super: {
          rich: matrix.super.rich || matrix.super.mixed || matrix.ordinary.rich || matrix.ordinary.mixed || latest || null,
          poor: matrix.super.poor || matrix.super.mixed || matrix.ordinary.poor || matrix.ordinary.mixed || latest || null,
          mixed: matrix.super.mixed || matrix.ordinary.mixed || latest || null,
        },
      },
    });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Update pricing (create new record)
router.put("/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const { baseFare, pricePerKm, pricePerMinute, minimumFare, surgeEnabled, surgeMultiplier } = req.body;
    const serviceType = normalizeServiceType(req.body.serviceType);
    const areaType = normalizeAreaType(req.body.areaType);
    if (baseFare == null || pricePerKm == null) return res.status(400).json({ error: "baseFare and pricePerKm are required" });

    const newRec = await PricingSetting.create({
      serviceType,
      areaType,
      baseFare,
      pricePerKm,
      pricePerMinute: pricePerMinute != null ? pricePerMinute : null,
      minimumFare: minimumFare != null ? minimumFare : null,
      surgeEnabled: !!surgeEnabled,
      surgeMultiplier: surgeMultiplier != null ? surgeMultiplier : 1,
      updatedByAdminId: req.user.id,
    });

    res.json({ success: true, pricing: newRec });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

router.get("/admin/area-zones", requireAdmin, async (req, res) => {
  try {
    const zones = await AreaPricingZone.findAll({ order: [["createdAt", "DESC"]] });
    res.json({ zones });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post("/admin/area-zones", requireAdmin, async (req, res) => {
  try {
    const lat = Number(req.body.centerLat);
    const lng = Number(req.body.centerLng);
    const radius = parseInt(req.body.radiusMeters, 10);
    const ordinaryPricePerKm = parsePositiveNumber(req.body.ordinaryPricePerKm);
    const superPricePerKm = parsePositiveNumber(req.body.superPricePerKm);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "centerLat and centerLng are required" });
    }
    if (!Number.isFinite(radius) || radius < 100) {
      return res.status(400).json({ error: "radiusMeters must be 100 or more" });
    }
    if (ordinaryPricePerKm == null || superPricePerKm == null) {
      return res.status(400).json({ error: "ordinaryPricePerKm and superPricePerKm are required" });
    }

    const zone = await AreaPricingZone.create({
      name: req.body.name || null,
      type: "rich",
      centerLat: lat,
      centerLng: lng,
      radiusMeters: radius,
      ordinaryPricePerKm,
      superPricePerKm,
      active: req.body.active == null ? true : !!req.body.active,
    });
    res.json({ success: true, zone });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put("/admin/area-zones/:id", requireAdmin, async (req, res) => {
  try {
    const zone = await AreaPricingZone.findByPk(req.params.id);
    if (!zone) return res.status(404).json({ error: "not_found" });

    if (req.body.name !== undefined) zone.name = req.body.name || null;
    if (req.body.centerLat !== undefined) zone.centerLat = Number(req.body.centerLat);
    if (req.body.centerLng !== undefined) zone.centerLng = Number(req.body.centerLng);
    if (req.body.radiusMeters !== undefined) zone.radiusMeters = parseInt(req.body.radiusMeters, 10);
    if (req.body.ordinaryPricePerKm !== undefined) {
      const value = parsePositiveNumber(req.body.ordinaryPricePerKm);
      if (value == null) return res.status(400).json({ error: "ordinaryPricePerKm must be greater than zero" });
      zone.ordinaryPricePerKm = value;
    }
    if (req.body.superPricePerKm !== undefined) {
      const value = parsePositiveNumber(req.body.superPricePerKm);
      if (value == null) return res.status(400).json({ error: "superPricePerKm must be greater than zero" });
      zone.superPricePerKm = value;
    }
    if (req.body.active !== undefined) zone.active = !!req.body.active;

    if (!Number.isFinite(Number(zone.centerLat)) || !Number.isFinite(Number(zone.centerLng))) {
      return res.status(400).json({ error: "invalid center" });
    }
    if (!Number.isFinite(Number(zone.radiusMeters)) || Number(zone.radiusMeters) < 100) {
      return res.status(400).json({ error: "radiusMeters must be 100 or more" });
    }

    await zone.save();
    res.json({ success: true, zone });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/admin/area-zones/:id", requireAdmin, async (req, res) => {
  try {
    const zone = await AreaPricingZone.findByPk(req.params.id);
    if (!zone) return res.status(404).json({ error: "not_found" });
    await zone.destroy();
    res.json({ success: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: list ride requests with filters
router.get("/admin/ride-requests", requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 30, from, to, rider_id, driver_id } = req.query;
    const where = {};
    if (status) where.status = status;
    if (rider_id) where.rider_id = rider_id;
    if (driver_id) where.driver_id = driver_id;
    if (from || to) where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(from);
    if (to) where.createdAt[Op.lte] = new Date(to);

    const offset = (page - 1) * limit;
    const { count, rows } = await RideRequest.findAndCountAll({ where, limit: parseInt(limit), offset, order: [["createdAt", "DESC"]] });
    res.json({ total: count, page: parseInt(page), totalPages: Math.ceil(count / limit), rides: rows });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: get ride details
router.get("/admin/ride-requests/:id", requireAdmin, async (req, res) => {
  try {
    const ride = await RideRequest.findByPk(req.params.id, { include: [
      { model: User, as: "rider", attributes: { exclude: ["password"] } },
      { model: User, as: "driver", attributes: { exclude: ["password"] } }
    ] });
    if (!ride) return res.status(404).json({ error: "not_found" });
    res.json({ ride });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: change status with validations
router.patch("/admin/ride-requests/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });
    const ride = await RideRequest.findByPk(req.params.id);
    if (!ride) return res.status(404).json({ error: "not_found" });
    if (["completed", "cancelled"].includes(ride.status)) return res.status(400).json({ error: "cannot_change_final_status" });
    if (ride.status === "completed" && status === "pending") return res.status(400).json({ error: "invalid_transition" });

    ride.status = status;
    await ride.save();

    // notify
    try {
      if (ride.rider_id) {
        const ok = await socketService.notifyRiderSocket(ride.rider_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
        if (!ok) await notifications.sendNotificationToUser(ride.rider_id, `حالة الرحلة تغيرت إلى ${ride.status}`);
      }
      if (ride.driver_id) {
        const ok2 = await socketService.notifyDriverSocket(ride.driver_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
        if (!ok2) await notifications.sendNotificationToUser(ride.driver_id, `حالة الرحلة تغيرت إلى ${ride.status}`);
      }
    } catch (e) {}

    res.json({ success: true, ride });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: assign driver to pending ride
router.post("/admin/ride-requests/:id/assign-driver", requireAdmin, async (req, res) => {
  const t = await RideRequest.sequelize.transaction();
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: "driverId required" });
    const ride = await RideRequest.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!ride) { await t.rollback(); return res.status(404).json({ error: "not_found" }); }
    if (ride.status !== "pending") { await t.rollback(); return res.status(400).json({ error: "ride_not_pending" }); }
    const driver = await User.findByPk(driverId, { transaction: t });
    if (!driver || driver.role !== "driver") { await t.rollback(); return res.status(404).json({ error: "driver_not_found" }); }
    if (!driverCanReceiveService(driver.vehicleCategory, ride.serviceType || "ordinary")) {
      await t.rollback();
      return res.status(400).json({ error: "driver_service_type_not_allowed" });
    }

    ride.driver_id = driverId;
    ride.status = "accepted";
    await ride.save({ transaction: t });
    await t.commit();

    // notify rider and driver
    try {
      const riderNotified = await socketService.notifyRiderSocket(ride.rider_id, "request:accepted", { requestId: ride.id, driverId });
      if (!riderNotified) await notifications.sendNotificationToUser(ride.rider_id, "تم تعيين سائق لطلبك");

      const driverNotified = await socketService.notifyDriverSocket(driverId, "request:assigned", { request: ride });
      if (!driverNotified) await notifications.sendNotificationToUser(driverId, "تم تعيين طلب لك");
    } catch (e) { console.error(e.message); }

    res.json({ success: true, ride });
  } catch (e) { await t.rollback(); console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: online drivers (lightweight)
router.get("/admin/drivers/online", requireAdmin, async (req, res) => {
  try {
    const redis = await redisService.init();
    const ids = await redis.sMembers("drivers:online").catch(() => []);
    const list = [];
    for (const id of ids) {
      const loc = await redis.get(`driver:loc:${id}`).catch(() => null);
      const last = loc ? JSON.parse(loc) : null;
      const user = await User.findByPk(id, { attributes: { exclude: ["password"] } }).catch(() => null);
      list.push({ driverId: id, user, loc: last });
    }
    res.json({ drivers: list });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: simple stats
router.get("/admin/stats/summary", requireAdmin, async (req, res) => {
  try {
    const usersCount = await User.count({ where: { role: { [Op.not]: "admin" } } });
    const driversCount = await User.count({ where: { role: "driver" } });
    const today = new Date();
    today.setHours(0,0,0,0);
    const ridesToday = await RideRequest.count({ where: { createdAt: { [Op.gte]: today } } });
    const pending = await RideRequest.count({ where: { status: "pending" } });
    const completed = await RideRequest.count({ where: { status: "completed" } });
    res.json({ users: usersCount, drivers: driversCount, ridesToday, pending, completed });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
