const express = require("express");
const { Op, fn, col } = require("sequelize");
const { authenticateToken } = require("../middlewares/auth");
const { DriverRating, RideRequest, User } = require("../models");

const router = express.Router();

const normalizeRating = (value) => {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  return rating;
};

const normalizeTags = (value) => {
  const allowed = new Set([
    "good_driving",
    "clean_car",
    "polite_driver",
    "on_time",
    "safe_trip",
    "knows_routes",
  ]);

  const tags = Array.isArray(value) ? value : [];
  return tags
    .map((tag) => String(tag || "").trim())
    .filter((tag) => allowed.has(tag))
    .slice(0, 6);
};

const ratingSummaryForDriver = async (driverId) => {
  const rows = await DriverRating.findAll({
    where: { driver_id: driverId, skipped: false },
    attributes: [
      [fn("COUNT", col("id")), "count"],
      [fn("AVG", col("rating")), "average"],
    ],
    raw: true,
  });

  const row = rows[0] || {};
  const count = Number(row.count || 0);
  const average = count > 0 ? Number(Number(row.average || 0).toFixed(2)) : 0;

  return { average, count };
};

const serializePendingRide = (ride) => {
  if (!ride) return null;
  const data = ride.toJSON ? ride.toJSON() : ride;
  return {
    id: data.id,
    driver_id: data.driver_id,
    driverId: data.driver_id,
    driver: data.driver
      ? {
          id: data.driver.id,
          name: data.driver.name,
          phone: data.driver.phone,
          driverImage: data.driver.driverImage,
          vehicleType: data.driver.vehicleType,
          vehicleColor: data.driver.vehicleColor,
          vehicleNumber: data.driver.vehicleNumber,
        }
      : null,
    pickupAddress: data.pickupAddress,
    dropoffAddress: data.dropoffAddress,
    completedAt: data.updatedAt,
  };
};

router.get("/drivers/:id/rating-summary", async (req, res) => {
  try {
    const driver = await User.findByPk(req.params.id, {
      attributes: ["id", "role"],
    });
    if (!driver || driver.role !== "driver") {
      return res.status(404).json({ error: "السائق غير موجود" });
    }

    return res.json(await ratingSummaryForDriver(driver.id));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get("/ratings/pending-driver-rating", authenticateToken, async (req, res) => {
  try {
    const ride = await RideRequest.findOne({
      where: {
        rider_id: req.user.id,
        driver_id: { [Op.ne]: null },
        status: "completed",
      },
      include: [
        {
          model: DriverRating,
          as: "driverRating",
          required: false,
          attributes: ["id"],
        },
        {
          model: User,
          as: "driver",
          attributes: [
            "id",
            "name",
            "phone",
            "driverImage",
            "vehicleType",
            "vehicleColor",
            "vehicleNumber",
          ],
        },
      ],
      order: [["updatedAt", "DESC"]],
    });

    if (!ride || ride.driverRating) {
      return res.json({ hasPending: false, ride: null });
    }

    return res.json({ hasPending: true, ride: serializePendingRide(ride) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/ride-requests/:id/driver-rating", authenticateToken, async (req, res) => {
  try {
    const ride = await RideRequest.findByPk(req.params.id);
    if (!ride) return res.status(404).json({ error: "الرحلة غير موجودة" });
    if (ride.rider_id !== req.user.id) {
      return res.status(403).json({ error: "غير مسموح" });
    }
    if (ride.status !== "completed" || !ride.driver_id) {
      return res.status(400).json({ error: "يمكن تقييم الرحلات المكتملة فقط" });
    }

    const exists = await DriverRating.findOne({
      where: { ride_request_id: ride.id },
    });
    if (exists) {
      return res.status(400).json({ error: "تم التعامل مع تقييم هذه الرحلة مسبقاً" });
    }

    const skipped = req.body.skipped === true || req.body.skipped === "true";
    const rating = skipped ? null : normalizeRating(req.body.rating);
    if (!skipped && rating == null) {
      return res.status(400).json({ error: "التقييم يجب أن يكون من 1 إلى 5" });
    }

    const created = await DriverRating.create({
      ride_request_id: ride.id,
      rider_id: req.user.id,
      driver_id: ride.driver_id,
      rating: skipped ? 1 : rating,
      tags: skipped ? [] : normalizeTags(req.body.tags),
      comment: skipped ? null : String(req.body.comment || "").trim() || null,
      skipped,
    });

    return res.status(201).json({
      success: true,
      rating: created,
      summary: await ratingSummaryForDriver(ride.driver_id),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = { router, ratingSummaryForDriver };
