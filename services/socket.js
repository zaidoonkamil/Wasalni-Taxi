const jwt = require("jsonwebtoken");
const redisService = require("./redis");
const { User, RideRequest, SystemSetting, DriverDebtLedger, DriverRating } = require("../models");
const sequelize = require("../config/db");
const notifications = require("./notifications") || require("../services/notifications");
const { Op } = require("sequelize");
const { calculateFare, normalizeServiceType } = require("./areaPricing");
const { applyCommissionWithReward } = require("./driverRewards");

let ioInstance = null;


function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const driverCanReceiveService = (driverCategory, serviceType) => {
  return true;
};

const previousGoodDriverMessage = {
  title: "Ø²Ø¨ÙˆÙ† ÙŠØ¹Ø±ÙÙƒ ÙŠØ·Ù„Ø¨ Ø±Ø­Ù„Ø©",
  message: "Ø£Ø­Ø¯ Ø§Ù„Ø²Ø¨Ø§Ø¦Ù† Ø§Ù„Ø°ÙŠÙ† Ø£ÙˆØµÙ„ØªÙ‡Ù… Ø³Ø§Ø¨Ù‚Ø§Ù‹ ÙˆÙ‚ÙŠÙ‘Ù… Ø±Ø­Ù„ØªÙƒ Ø¨Ø´ÙƒÙ„ Ø¬ÙŠØ¯ ÙŠØ·Ù„Ø¨ ØªÙƒØ³ÙŠ Ø§Ù„Ø¢Ù† Ø¨Ø§Ù„Ù‚Ø±Ø¨ Ù…Ù†Ùƒ.",
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

const init = async (io) => {
  ioInstance = io;

  const redisClient = await redisService.init();

  io.on("connection", async (socket) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        socket.disconnect(true);
        return;
      }

      let user;
      try {
        user = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        socket.disconnect(true);
        return;
      }

      socket.user = user;

      const isDriver = user.role === "driver";
      const socketKey = isDriver ? `socket:driver:${user.id}` : `socket:rider:${user.id}`;
      await redisClient.set(socketKey, socket.id, { EX: 3600  });
        const refreshSocketKey = async () => {
          try {
            await redisClient.set(socketKey, socket.id, { EX: 3600 });
          } catch (e) {
            console.error("refreshSocketKey error", e.message);
          }
        };
        
        socket.onAny(async () => {
          await refreshSocketKey();
        });
        
        // Ø±ÙØ¶ Ø§Ù„Ø·Ù„Ø¨ Ù…Ù† Ù‚Ø¨Ù„ Ø§Ù„Ø³Ø§Ø¦Ù‚
      socket.on("driver:reject_request", async ({ requestId }) => {
        try {
          if (!requestId) return;

          const key = `request:rejected:${requestId}`;
          await redisClient.sAdd(key, String(user.id));
          await redisClient.expire(key, 3600);

          socket.emit("request:rejected_ack", { ok: true, requestId });
        } catch (e) {
          console.error("driver:reject_request error", e.message);
          socket.emit("request:rejected_ack", { ok: false, error: e.message });
        }
      });

      socket.on("disconnect", async () => {
          try {
            await redisClient.del(socketKey);
            if (isDriver) {
              await redisClient.del(`driver:state:${user.id}`);
              try { await redisClient.sRem("drivers:online", String(user.id)); } catch (e) {}
              await redisClient.sendCommand(["ZREM", "drivers:geo", String(user.id)]);
              await redisClient.del(`driver:loc:${user.id}`);
            }
          } catch (e) {
            console.error("socket disconnect cleanup", e.message);
          }
      });

      // Ø§ØªØµØ§Ù„ Ø§Ù„Ø³Ø§Ø¦Ù‚
      socket.on("driver:online", async () => {
        try {
          const isDebtBlocked = await redisClient.sIsMember("drivers:debt_blocked", String(user.id));
          if (isDebtBlocked) {
            socket.emit("driver:debt_blocked", { ok: false, reason: "debt_blocked" });
            return;
          }
          await redisClient.set(`driver:state:${user.id}`, "online", { EX: 3600 });
          await redisClient.sAdd("drivers:online", String(user.id));
          await redisClient.set(socketKey, socket.id, { EX: 3600 });
          console.log("ðŸŸ¢ driver online:", user.id);
        } catch (e) {
          console.error("driver:online error", e.message);
        }
      });

      socket.on("driver:offline", async () => {
        await redisClient.del(`driver:state:${user.id}`);
        try { await redisClient.sRem("drivers:online", String(user.id)); } catch (e) {}
        try { await redisClient.sendCommand(["ZREM", "drivers:geo", String(user.id)]); } catch (e) {}
        try { await redisClient.del(`driver:loc:${user.id}`); } catch (e) {}
      });

      // ØªØ­Ø¯ÙŠØ« Ù…ÙˆÙ‚Ø¹ Ø§Ù„Ø³Ø§Ø¦Ù‚
      socket.on("driver:location", async (data, ack) => {
        try {
          const now = Date.now();
          const last = socket.data?.lastLocTs || 0;

          if (now - last < 1000) {
            return ack && ack({ ok: true, throttled: true });
          }

          socket.data = socket.data || {};
          socket.data.lastLocTs = now;

          const { lat, lng, heading } = data;

          if (lat == null || lng == null) {
            return ack && ack({ ok: false, reason: "missing_lat_lng" });
          }

          const locObj = { lat, lng, heading: heading || null, ts: Date.now() };
          await redisService.setJSON(`driver:loc:${user.id}`, locObj, 3600);

          await redisClient.sendCommand([
            "GEOADD",
            "drivers:geo",
            String(lng),
            String(lat),
            String(user.id),
          ]);

          try {
            const reqId = await redisClient.get(`driver:busy:${user.id}`);
            if (reqId) {
              const req = await RideRequest.findByPk(reqId);
              if (req) {
                const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
                if (riderSocketId && ioInstance) {
                  ioInstance.to(riderSocketId).emit("trip:driver_location", {
                    requestId: req.id,
                    driverId: user.id,
                    lat,
                    lng,
                    heading: heading || null,
                  });
                }
              }
            }
          } catch (e) {
            console.error("emit trip:driver_location error", e.message);
          }

          return ack && ack({ ok: true });
        } catch (e) {
          console.error("driver:location error", e.message);
          return ack && ack({ ok: false, reason: e.message });
        }
      });


      // Ù‚Ø¨ÙˆÙ„ Ø·Ù„Ø¨ Ø§Ù„Ø±Ø­Ù„Ø© Ù…Ù† Ù‚Ø¨Ù„ Ø§Ù„Ø³Ø§Ø¦Ù‚
      socket.on("driver:accept_request", async ({ requestId }) => {
        try {
          const driver = await User.findByPk(user.id);
          if (driver && (driver.isDebtBlocked || driver.status === "blocked" || driver.blockReason === "debt")) {
            socket.emit("request:accept_failed", { requestId, reason: "debt_blocked" });
            return;
          }

          const lockKey = `order:lock:${requestId}`;
          const busy = await redisClient.get(`driver:busy:${user.id}`);
          if (busy) {
            socket.emit("request:accept_failed", { requestId, reason: "driver_busy", activeRequestId: busy });
            return;
          }
          const locked = await redisService.setLock(lockKey, String(user.id), 12);
          if (!locked) {
            socket.emit("request:accept_failed", { requestId, reason: "already_taken" });
            return;
          }

          // DB transaction
          const t = await sequelize.transaction();
          try {
            const req = await RideRequest.findByPk(requestId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!req) {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { requestId, reason: "not_found" });
              return;
            }
            if (req.status !== "pending") {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { requestId, reason: "not_pending" });
              return;
            }
            if (!driverCanReceiveService(driver?.vehicleCategory, req.serviceType || "ordinary")) {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { requestId, reason: "service_type_not_allowed" });
              return;
            }

            req.status = "accepted";
            req.driver_id = user.id;
            await req.save({ transaction: t });
            await t.commit();

            await redisClient.set(`driver:busy:${user.id}`, String(req.id), { EX: 60 * 60 * 3 });
            // notify rider
            const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
            const payload = { requestId: req.id, driverId: user.id };
            if (riderSocketId && ioInstance) {
              ioInstance.to(riderSocketId).emit("request:accepted", payload);
            } else {
              // offline -> send push
              try { await notifications.sendNotificationToUser(req.rider_id, 'ØªÙ… Ù‚Ø¨ÙˆÙ„ Ø·Ù„Ø¨Ùƒ', 'Ø³Ø§Ø¦Ù‚ ÙÙŠ Ø§Ù„Ø·Ø±ÙŠÙ‚'); } catch (e) {}
            }

            const sentKey = `request:sent_to:${req.id}`;
            try {
              const sentDriverIds = await redisClient.sMembers(sentKey);
              for (const did of sentDriverIds) {
                if (String(did) === String(user.id)) continue;
                const sid = await redisClient.get(`socket:driver:${did}`);
                if (sid && ioInstance) {
                  ioInstance.to(sid).emit("request:taken", {
                    requestId: req.id,
                    driverId: user.id,
                    status: "accepted",
                  });
                }
              }
              await redisClient.del(sentKey);
              await redisClient.del(`request:rejected:${req.id}`);
            } catch (notifyErr) {
              console.error("notify request:taken error", notifyErr.message);
            }

            socket.emit("request:accepted", payload);
          } catch (e) {
            await t.rollback();
            await redisService.releaseLock(lockKey, String(user.id));
            socket.emit("request:accept_failed", { requestId, reason: "error", details: e.message });
          }
        } catch (e) {
          console.error("accept error", e.message);
        }
      });

      // ÙˆØµÙˆÙ„ Ø§Ù„Ø³Ø§Ø¦Ù‚
      socket.on("driver:arrived", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          req.status = "arrived";
          await req.save();
          const payload = { requestId: req.id, status: req.status };
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          if (riderSocketId && ioInstance) {
            ioInstance.to(riderSocketId).emit("trip:status_changed", payload);
          }
          try {
            await notifications.sendNotificationToUser(
              req.rider_id,
              "Ø§Ù„Ø³Ø§Ø¦Ù‚ ÙˆØµÙ„ Ù…ÙˆÙ‚Ø¹Ùƒ",
              "Ø§Ù„ÙƒØ§Ø¨ØªÙ† ÙˆØµÙ„ Ù„Ù…ÙˆÙ‚Ø¹ÙƒØŒ ØªÙ‚Ø¯Ø± ØªØ·Ù„Ø¹ Ù‡Ø³Ù‡"
            );
          } catch (e) {
            console.error("arrived push error:", e.message);
          }

        } catch (e) {
          console.error("driver:arrived error:", e.message);
        }
      });


      // Ø¨Ø¯Ø¡ Ø§Ù„Ø±Ø­Ù„Ø©
      socket.on("driver:start_trip", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          req.status = "started";
          await req.save();
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          const payload = { requestId: req.id, status: req.status };
          if (riderSocketId && ioInstance) ioInstance.to(riderSocketId).emit("trip:status_changed", payload);
        } catch (e) { console.error(e.message); }
      });

      // Ø¥Ù†Ù‡Ø§Ø¡ Ø§Ù„Ø±Ø­Ù„Ø©
      socket.on("driver:end_trip", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;

          // mark completed
          req.status = "completed";
          await req.save();
          await redisClient.del(`driver:busy:${req.driver_id}`);
          // notify rider
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          const payload = { requestId: req.id, status: req.status };
          if (riderSocketId && ioInstance) ioInstance.to(riderSocketId).emit("trip:status_changed", payload);

          // --- Debt / commission handling (MySQL only) ---
          try {
            const t = await sequelize.transaction();
            try {
              const driver = await User.findByPk(req.driver_id, { transaction: t, lock: t.LOCK.UPDATE });
              if (driver) {
                const prefix = driver.vehicleCategory === "super" ? "SUPER_" : "";
                const commissionTypeSetting =
                  await SystemSetting.findOne({ where: { key: `${prefix}DRIVER_COMMISSION_TYPE` }, transaction: t }) ||
                  await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_TYPE" }, transaction: t });
                const commissionValueSetting =
                  await SystemSetting.findOne({ where: { key: `${prefix}DRIVER_COMMISSION_VALUE` }, transaction: t }) ||
                  await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_VALUE" }, transaction: t });
                const debtLimitSetting =
                  await SystemSetting.findOne({ where: { key: `${prefix}DRIVER_DEBT_LIMIT` }, transaction: t }) ||
                  await SystemSetting.findOne({ where: { key: "DRIVER_DEBT_LIMIT" }, transaction: t });

                const commissionType = commissionTypeSetting ? (commissionTypeSetting.value || "fixed") : "fixed";
                const commissionValue = commissionValueSetting ? parseFloat(commissionValueSetting.value) : 0;
                const systemLimit = debtLimitSetting ? parseFloat(debtLimitSetting.value) : null;

                let commissionAmount = 0;
                if (commissionType === "percent") {
                  const fare = req.estimatedFare ? parseFloat(req.estimatedFare) : 0;
                  commissionAmount = (fare * (commissionValue || 0)) / 100;
                } else {
                  commissionAmount = commissionValue || 0;
                }

                if (commissionAmount > 0) {
                  const limit = driver.driverDebtLimitOverride != null ? parseFloat(driver.driverDebtLimitOverride) : (systemLimit != null ? systemLimit : null);
                  const rewardResult = await applyCommissionWithReward({
                    driver,
                    rideRequestId: req.id,
                    commissionAmount,
                    debtLimit: limit,
                    transaction: t,
                  });

                  try {
                    const sid = await redisClient.get(`socket:driver:${driver.id}`);
                    const payload2 = {
                      debt: rewardResult.debt,
                      rewardBalance: rewardResult.rewardBalance,
                      usedReward: rewardResult.usedReward,
                      addedDebt: rewardResult.addedDebt,
                      limit,
                    };
                    if (driver.isDebtBlocked) {
                      if (sid && ioInstance) ioInstance.to(sid).emit("driver:debt_blocked", payload2);
                      else await notifications.sendNotificationToUser(driver.id, `تم حظرك بسبب تجاوز حد الدين ${limit}`);
                    } else if (sid && ioInstance) {
                      ioInstance.to(sid).emit("driver:debt_updated", payload2);
                    }
                  } catch (e) {}
                }
              }
              await t.commit();
            } catch (err) {
              await t.rollback();
              console.error("commission transaction error", err.message);
            }
          } catch (e) {
            console.error("debt handling error", e.message);
          }

        } catch (e) { console.error(e.message); }
      });

      //  Ø¥Ù†Ø´Ø§Ø¡ Ø·Ù„Ø¨ Ø§Ù„Ø±Ø­Ù„Ø© Ù…Ù† Ù‚Ø¨Ù„ Ø§Ù„Ø±Ø§ÙƒØ¨
      socket.on("rider:create_request", async (data, ack) => {
        const t = await sequelize.transaction();
        try {
          const { pickup, dropoff, distanceKm, durationMin } = data;
          const serviceType = normalizeServiceType(data?.serviceType);

          if (!pickup || !dropoff) {
            await t.rollback();
            return ack && ack({ ok: false, error: "invalid_payload" });
          }

          const active = await RideRequest.findOne({
            where: {
              rider_id: user.id,
              status: { [Op.in]: ["pending", "accepted", "arrived", "started"] },
            },
            order: [["createdAt", "DESC"]],
            transaction: t,
            lock: t.LOCK.UPDATE,
          });

          if (active) {
            await t.rollback();
            console.log("âš ï¸ active ride exists id=", active.id, "status=", active.status);
            return ack && ack({
              ok: false,
              error: "active_ride_exists",
              message: "Ø¹Ù†Ø¯Ùƒ Ø±Ø­Ù„Ø©/Ø·Ù„Ø¨ ÙØ¹Ø§Ù„ Ù…Ø³Ø¨Ù‚Ø§Ù‹",
              activeRequestId: active.id,
              status: active.status,
            });
          }

          let estimatedFare = null;
          let pricingAreaType = "mixed";
          let pricingZoneId = null;

          const serverKm =
            pickup?.lat != null && pickup?.lng != null && dropoff?.lat != null && dropoff?.lng != null
              ? haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng)
              : null;

          const dKm = serverKm != null ? Number(serverKm.toFixed(3)) : null;
          const dur = durationMin != null ? parseFloat(durationMin) : null;


          try {
            const fare = await calculateFare({
              pickup,
              dropoff,
              distanceKm: dKm,
              durationMin: dur,
              serviceType,
              transaction: t,
            });
            estimatedFare = fare.estimatedFare;
            pricingAreaType = fare.areaType;
            pricingZoneId = fare.pricingZone?.id || null;
          } catch (e) {
            console.error("pricing calc error:", e.message);
          }

          const newReq = await RideRequest.create(
            {
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
              pricingZoneId,
              status: "pending",
            },
            { transaction: t }
          );

          await t.commit();

          const radiusM = 5000;
          const nearby = await redisClient
            .sendCommand([
              "GEORADIUS",
              "drivers:geo",
              String(pickup.lng),
              String(pickup.lat),
              String(radiusM),
              "m",
              "COUNT",
              "30",
              "ASC",
            ])
            .catch((e) => {
              console.error("âŒ GEORADIUS error", e.message);
              return [];
            });

          const driverIds = (nearby || []).map(String).slice(0, 30);
          const driverRows = await User.findAll({
            where: { id: { [Op.in]: driverIds }, role: "driver", status: "active" },
            attributes: ["id", "vehicleCategory"],
          });
          const driverCategoryById = new Map(driverRows.map((driver) => [String(driver.id), driver.vehicleCategory || "ordinary"]));
          const previousGoodRatingsByDriver = await getPreviousGoodDriverRatings(user.id, driverIds);

          let sentCount = 0;
          const sentKey = `request:sent_to:${newReq.id}`;

          for (const did of driverIds) {
            if (!driverCanReceiveService(driverCategoryById.get(String(did)), serviceType)) continue;

            const isOnline = await redisClient.sIsMember("drivers:online", String(did));
            if (!isOnline) continue;

            const busyRideId = await redisClient.get(`driver:busy:${did}`);
            if (busyRideId) continue;

            const rejectedKey = `request:rejected:${newReq.id}`;
            const isRejected = await redisClient.sIsMember(rejectedKey, String(did));
            if (isRejected) continue;

            const isDebtBlocked = await redisClient.sIsMember("drivers:debt_blocked", String(did));
            if (isDebtBlocked) continue;

            const driverSocketId = await redisClient.get(`socket:driver:${did}`);
            if (driverSocketId && ioInstance) {
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

              ioInstance.to(driverSocketId).emit("request:new", payload);
              sentCount++;
              await redisClient.sAdd(sentKey, String(did));

              if (priorityMatch) {
                notifications
                  .sendNotificationToUser(
                    did,
                    previousGoodDriverMessage.message,
                    previousGoodDriverMessage.title
                  )
                  .catch((e) => console.error("previous good driver push error:", e.message));
              }
            }
          }

          await redisClient.expire(sentKey, 3600);

          console.log("ðŸ“¤ done matching. sentCount=", sentCount);

          return ack && ack({
            ok: true,
            success: true,
            request: newReq,
            debug: { radiusM, driverIds, sentCount },
          });
        } catch (e) {
          try {
            await t.rollback();
          } catch (_) {}
          console.error("âŒ rider:create_request", e.message);
          return ack && ack({ ok: false, error: e.message });
        }
      });


      // Ø¥Ù„ØºØ§Ø¡ Ø·Ù„Ø¨ Ø§Ù„Ø±Ø­Ù„Ø© Ù…Ù† Ù‚Ø¨Ù„ Ø§Ù„Ø±Ø§ÙƒØ¨
      socket.on("rider:cancel_request", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;

          if (["completed", "cancelled"].includes(req.status)) return;

          req.status = "cancelled";
          await req.save();

          if (req.driver_id) {
            await redisClient.del(`driver:busy:${req.driver_id}`);

            const driverSid = await redisClient.get(`socket:driver:${req.driver_id}`);
            if (driverSid && ioInstance) {
              ioInstance.to(driverSid).emit("trip:status_changed", {
                requestId: req.id,
                status: "cancelled",
              });
            }
          }

          const sentKey = `request:sent_to:${req.id}`;
          const driverIds = await redisClient.sMembers(sentKey);

          for (const did of driverIds || []) {
            const sid = await redisClient.get(`socket:driver:${did}`);
            if (sid && ioInstance) {
              ioInstance.to(sid).emit("trip:status_changed", {
                requestId: req.id,
                status: "cancelled",
              });
            }
          }

          await redisClient.del(sentKey);
          await redisClient.del(`request:rejected:${req.id}`);

        } catch (e) {
          console.error("rider:cancel_request error", e.message);
        }
      });

    } catch (e) {
      console.error("socket connection error", e.message);
    }
  });
};

// Ø§Ø®Ø¨Ø§Ø± Ø§Ù„Ø³Ø§Ø¦Ù‚ Ø¹Ø¨Ø± Ø§Ù„Ø³ÙˆÙƒØª
const notifyDriverSocket = async (driverId, event, payload) => {
  if (!ioInstance) return false;
  const redisClient = redisService.client();
  const sid = await redisClient.get(`socket:driver:${driverId}`);
  if (sid) ioInstance.to(sid).emit(event, payload);
  return !!sid;
};

// Ø§Ø®Ø¨Ø§Ø± Ø§Ù„Ø±Ø§ÙƒØ¨ Ø¹Ø¨Ø± Ø§Ù„Ø³ÙˆÙƒØª
const notifyRiderSocket = async (riderId, event, payload) => {
  if (!ioInstance) return false;
  const redisClient = redisService.client();
  const sid = await redisClient.get(`socket:rider:${riderId}`);
  if (sid) ioInstance.to(sid).emit(event, payload);
  return !!sid;
};

module.exports = { init, notifyDriverSocket, notifyRiderSocket };
