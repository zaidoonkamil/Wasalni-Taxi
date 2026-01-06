const jwt = require("jsonwebtoken");
const redisService = require("./redis");
const { User, RideRequest, PricingSetting, SystemSetting, DriverDebtLedger } = require("../models");
const sequelize = require("../config/db");
const notifications = require("./notifications") || require("../services/notifications");
const { Op } = require("sequelize");

let ioInstance = null;

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
      await redisClient.set(socketKey, socket.id, { EX: 120 });

      if (isDriver) {
        await redisClient.set(`driver:state:${user.id}`, "online", { EX: 90 });
        // maintain lightweight set of online drivers (IDs only)
        try { await redisClient.sAdd("drivers:online", String(user.id)); } catch (e) {}
      }

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

      // اتصال السائق
      socket.on("driver:online", async () => {
        await redisClient.set(`driver:state:${user.id}`, "online", { EX: 90 });
        try { await redisClient.sAdd("drivers:online", String(user.id)); } catch (e) {}
      });

      socket.on("driver:offline", async () => {
        await redisClient.del(`driver:state:${user.id}`);
        try { await redisClient.sRem("drivers:online", String(user.id)); } catch (e) {}
      });

      // تحديث موقع السائق
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

          console.log("📍 driver:location recv", user.id, lat, lng);

          const locObj = { lat, lng, heading: heading || null, ts: Date.now() };
          await redisService.setJSON(`driver:loc:${user.id}`, locObj, 90);

          await redisClient.sendCommand([
            "GEOADD",
            "drivers:geo",
            String(lng),
            String(lat),
            String(user.id),
          ]);

          return ack && ack({ ok: true });
        } catch (e) {
          console.error("driver:location error", e.message);
          return ack && ack({ ok: false, reason: e.message });
        }
      });


      // قبول طلب الرحلة من قبل السائق
      socket.on("driver:accept_request", async ({ requestId }) => {
        try {
          // Check debt/block status from DB before proceeding
          const driver = await User.findByPk(user.id);
          if (driver && (driver.isDebtBlocked || driver.status === "blocked" || driver.blockReason === "debt")) {
            socket.emit("request:accept_failed", { reason: "debt_blocked" });
            return;
          }

          const lockKey = `order:lock:${requestId}`;
          const locked = await redisService.setLock(lockKey, String(user.id), 12);
          if (!locked) {
            socket.emit("request:accept_failed", { reason: "already_taken" });
            return;
          }

          // DB transaction
          const t = await sequelize.transaction();
          try {
            const req = await RideRequest.findByPk(requestId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!req) {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { reason: "not_found" });
              return;
            }
            if (req.status !== "pending") {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { reason: "not_pending" });
              return;
            }

            req.status = "accepted";
            req.driver_id = user.id;
            await req.save({ transaction: t });
            await t.commit();

            // notify rider
            const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
            const payload = { requestId: req.id, driverId: user.id };
            if (riderSocketId && ioInstance) {
              ioInstance.to(riderSocketId).emit("request:accepted", payload);
            } else {
              // offline -> send push
              try { await notifications.sendNotificationToUser(req.rider_id, 'تم قبول طلبك', 'سائق في الطريق'); } catch (e) {}
            }

            // notify other drivers to close (best-effort)
            // remove lock keeps others from accepting

            socket.emit("request:accepted", payload);
          } catch (e) {
            await t.rollback();
            await redisService.releaseLock(lockKey, String(user.id));
            socket.emit("request:accept_failed", { reason: "error", details: e.message });
          }
        } catch (e) {
          console.error("accept error", e.message);
        }
      });

      // وصول السائق
      socket.on("driver:arrived", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          req.status = "arrived";
          await req.save();
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          const payload = { requestId: req.id, status: req.status };
          if (riderSocketId && ioInstance) ioInstance.to(riderSocketId).emit("trip:status_changed", payload);
        } catch (e) { console.error(e.message); }
      });

      // بدء الرحلة
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

      // إنهاء الرحلة
      socket.on("driver:end_trip", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;

          // mark completed
          req.status = "completed";
          await req.save();

          // notify rider
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          const payload = { requestId: req.id, status: req.status };
          if (riderSocketId && ioInstance) ioInstance.to(riderSocketId).emit("trip:status_changed", payload);

          // --- Debt / commission handling (MySQL only) ---
          try {
            // load latest settings
            const commissionTypeSetting = await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_TYPE" } });
            const commissionValueSetting = await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_VALUE" } });
            const debtLimitSetting = await SystemSetting.findOne({ where: { key: "DRIVER_DEBT_LIMIT" } });

            const commissionType = commissionTypeSetting ? (commissionTypeSetting.value || "fixed") : "fixed";
            const commissionValue = commissionValueSetting ? parseFloat(commissionValueSetting.value) : 0;
            const systemLimit = debtLimitSetting ? parseFloat(debtLimitSetting.value) : null;

            // calculate commission amount
            let commissionAmount = 0;
            if (commissionType === "percent") {
              const fare = req.estimatedFare ? parseFloat(req.estimatedFare) : 0;
              commissionAmount = (fare * (commissionValue || 0)) / 100;
            } else {
              commissionAmount = commissionValue || 0;
            }

            // Only charge if amount > 0
            if (commissionAmount > 0) {
              const t = await sequelize.transaction();
              try {
                const driver = await User.findByPk(req.driver_id, { transaction: t, lock: t.LOCK.UPDATE });
                if (driver) {
                  const prevDebt = parseFloat(driver.driverDebt || 0);
                  const newDebt = prevDebt + commissionAmount;
                  driver.driverDebt = newDebt;

                  // determine limit: override or system
                  const limit = driver.driverDebtLimitOverride != null ? parseFloat(driver.driverDebtLimitOverride) : (systemLimit != null ? systemLimit : null);

                  // add ledger
                  await DriverDebtLedger.create({ driver_id: driver.id, ride_request_id: req.id, type: "charge", amount: commissionAmount, note: "commission on completed ride" }, { transaction: t });

                  // block if reached limit
                  if (limit != null && newDebt >= limit) {
                    driver.isDebtBlocked = true;
                    driver.blockReason = "debt";
                    // remove from redis online/geo to avoid matching
                    try {
                      await redisClient.del(`driver:state:${driver.id}`);
                      await redisClient.sRem("drivers:online", String(driver.id));
                      await redisClient.sendCommand(["ZREM", "drivers:geo", String(driver.id)]);
                      await redisClient.del(`driver:loc:${driver.id}`);
                    } catch (e) {}
                    // notify driver via socket or push
                    try {
                      const sid = await redisClient.get(`socket:driver:${driver.id}`);
                      const payload2 = { debt: newDebt, limit };
                      if (sid && ioInstance) ioInstance.to(sid).emit("driver:debt_blocked", payload2);
                      else await notifications.sendNotificationToUser(driver.id, `تم حظرك بسبب تجاوز حد الدين ${limit}`);
                    } catch (e) {}
                  }

                  await driver.save({ transaction: t });
                }
                await t.commit();
              } catch (err) {
                await t.rollback();
                console.error("commission transaction error", err.message);
              }
            }
          } catch (e) {
            console.error("debt handling error", e.message);
          }

        } catch (e) { console.error(e.message); }
      });

      //  إنشاء طلب الرحلة من قبل الراكب
      socket.on("rider:create_request", async (data, ack) => {
        const t = await sequelize.transaction();
        try {
          const { pickup, dropoff, distanceKm, durationMin } = data;
          if (!pickup || !dropoff) {
            await t.rollback();
            return ack && ack({ error: "invalid_payload" });
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
            return ack && ack({
              error: "active_ride_exists",
              message: "عندك رحلة/طلب فعال مسبقاً",
              activeRequestId: active.id,
              status: active.status,
            });
          }

          let estimatedFare = null;

          const dKmRaw = distanceKm != null ? parseFloat(distanceKm) : null;
          const durRaw = durationMin != null ? parseFloat(durationMin) : null;

          const dKm = Number.isFinite(dKmRaw) ? dKmRaw : null;
          const dur = Number.isFinite(durRaw) ? durRaw : null;

          const DEFAULT_PRICING = {
            baseFare: 2000,        // أجرة فتح العداد
            pricePerKm: 500,       // دينار لكل كم
            pricePerMinute: 0,     // دينار لكل دقيقة
            minimumFare: 3000,     // أقل أجرة ممكنة
          };

          try {
            const pricing = await PricingSetting.findOne({
              order: [["createdAt", "DESC"]],
              transaction: t,
            });

            const base = pricing?.baseFare != null && Number.isFinite(parseFloat(pricing.baseFare))
              ? parseFloat(pricing.baseFare)
              : DEFAULT_PRICING.baseFare;

            const perKm = pricing?.pricePerKm != null && Number.isFinite(parseFloat(pricing.pricePerKm))
              ? parseFloat(pricing.pricePerKm)
              : DEFAULT_PRICING.pricePerKm;

            const perMin = pricing?.pricePerMinute != null && Number.isFinite(parseFloat(pricing.pricePerMinute))
              ? parseFloat(pricing.pricePerMinute)
              : DEFAULT_PRICING.pricePerMinute;

            const minimum = pricing?.minimumFare != null && Number.isFinite(parseFloat(pricing.minimumFare))
              ? parseFloat(pricing.minimumFare)
              : DEFAULT_PRICING.minimumFare;

            if (dKm != null) {
              let fare = base + dKm * perKm + (dur != null ? dur * perMin : 0);
              fare = Math.max(minimum, fare);

              estimatedFare = String(Math.round(fare));
            }
          } catch (e) {
            console.error("pricing calc error:", e.message);

            // fallback افتراضي حتى لو صار error
            if (dKm != null) {
              let fare =
                DEFAULT_PRICING.baseFare +
                dKm * DEFAULT_PRICING.pricePerKm +
                (dur != null ? dur * DEFAULT_PRICING.pricePerMinute : 0);

              fare = Math.max(DEFAULT_PRICING.minimumFare, fare);
              estimatedFare = fare.toFixed(2);
            }
          }

          // ✅ 3) إنشاء الطلب
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
            estimatedFare: estimatedFare, // ✅ ما راح تبقى null إذا dKm موجود
            status: "pending",
          }, { transaction: t });

          await t.commit();

          // ✅ 4) بعد commit سوّي matching للسائقين
          const nearby = await redisClient
            .sendCommand(["GEORADIUS", "drivers:geo", String(pickup.lng), String(pickup.lat), "5000", "m", "COUNT", "30", "ASC"])
            .catch(() => []);

          const driverIds = (nearby || []).map(String).slice(0, 30);

          for (const did of driverIds) {
            const driverSocketId = await redisClient.get(`socket:driver:${did}`);
            if (driverSocketId && ioInstance) {
              ioInstance.to(driverSocketId).emit("request:new", { request: newReq });
            }
          }

          return ack && ack({ success: true, request: newReq });

        } catch (e) {
          try { await t.rollback(); } catch (_) {}
          console.error("rider:create_request", e.message);
          return ack && ack({ error: e.message });
        }
      });

      // إلغاء طلب الرحلة من قبل الراكب
      socket.on("rider:cancel_request", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          req.status = "cancelled";
          await req.save();
          if (req.driver_id) {
            const driverSocketId = await redisClient.get(`socket:driver:${req.driver_id}`);
            if (driverSocketId && ioInstance) ioInstance.to(driverSocketId).emit("trip:status_changed", { requestId: req.id, status: req.status });
          }
        } catch (e) { console.error(e.message); }
      });

    } catch (e) {
      console.error("socket connection error", e.message);
    }
  });
};

// اخبار السائق عبر السوكت
const notifyDriverSocket = async (driverId, event, payload) => {
  if (!ioInstance) return false;
  const redisClient = redisService.client();
  const sid = await redisClient.get(`socket:driver:${driverId}`);
  if (sid) ioInstance.to(sid).emit(event, payload);
  return !!sid;
};

// اخبار الراكب عبر السوكت
const notifyRiderSocket = async (riderId, event, payload) => {
  if (!ioInstance) return false;
  const redisClient = redisService.client();
  const sid = await redisClient.get(`socket:rider:${riderId}`);
  if (sid) ioInstance.to(sid).emit(event, payload);
  return !!sid;
};

module.exports = { init, notifyDriverSocket, notifyRiderSocket };
