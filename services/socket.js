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
        
        // رفض الطلب من قبل السائق
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

      // اتصال السائق
      socket.on("driver:online", async () => {
        try {
          await redisClient.set(`driver:state:${user.id}`, "online", { EX: 3600 });
          await redisClient.sAdd("drivers:online", String(user.id));
          await redisClient.set(socketKey, socket.id, { EX: 3600 });
          console.log("🟢 driver online:", user.id);
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


          const locObj = { lat, lng, heading: heading || null, ts: Date.now() };
          await redisService.setJSON(`driver:loc:${user.id}`, locObj, 3600);

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
          const driver = await User.findByPk(user.id);
          if (driver && (driver.isDebtBlocked || driver.status === "blocked" || driver.blockReason === "debt")) {
            socket.emit("request:accept_failed", { reason: "debt_blocked" });
            return;
          }

          const lockKey = `order:lock:${requestId}`;
          const busy = await redisClient.get(`driver:busy:${user.id}`);
          if (busy) {
            socket.emit("request:accept_failed", { reason: "driver_busy", activeRequestId: busy });
            return;
          }
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

            await redisClient.set(`driver:busy:${user.id}`, String(req.id), { EX: 60 * 60 * 3 });
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
          const payload = { requestId: req.id, status: req.status };
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          if (riderSocketId && ioInstance) {
            ioInstance.to(riderSocketId).emit("trip:status_changed", payload);
          }
          try {
            await notifications.sendNotificationToUser(
              req.rider_id,
              "السائق وصل موقعك",
              "الكابتن وصل لموقعك، تقدر تطلع هسه"
            );
          } catch (e) {
            console.error("arrived push error:", e.message);
          }

        } catch (e) {
          console.error("driver:arrived error:", e.message);
        }
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
          await redisClient.del(`driver:busy:${req.driver_id}`);
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
            return ack && ack({ ok: false, error: "invalid_payload" });
          }

          console.log("🧾 rider:create_request from riderId=", user.id);
          console.log("🎯 pickup", pickup.lat, pickup.lng, "addr=", pickup.address);
          console.log("🏁 dropoff", dropoff.lat, dropoff.lng, "addr=", dropoff.address);
          console.log("📏 distanceKm=", distanceKm, "durationMin=", durationMin);

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
            console.log("⚠️ active ride exists id=", active.id, "status=", active.status);
            return ack && ack({
              ok: false,
              error: "active_ride_exists",
              message: "عندك رحلة/طلب فعال مسبقاً",
              activeRequestId: active.id,
              status: active.status,
            });
          }

          // 2) حساب التسعيرة
          let estimatedFare = null;

          const dKmRaw = distanceKm != null ? parseFloat(distanceKm) : null;
          const durRaw = durationMin != null ? parseFloat(durationMin) : null;

          const dKm = Number.isFinite(dKmRaw) ? dKmRaw : null;
          const dur = Number.isFinite(durRaw) ? durRaw : null;

          const DEFAULT_PRICING = {
            baseFare: 2000,
            pricePerKm: 500,
            pricePerMinute: 0,
            minimumFare: 3000,
          };

          try {
            const pricing = await PricingSetting.findOne({
              order: [["createdAt", "DESC"]],
              transaction: t,
            });

            const base =
              pricing?.baseFare != null && Number.isFinite(parseFloat(pricing.baseFare))
                ? parseFloat(pricing.baseFare)
                : DEFAULT_PRICING.baseFare;

            const perKm =
              pricing?.pricePerKm != null && Number.isFinite(parseFloat(pricing.pricePerKm))
                ? parseFloat(pricing.pricePerKm)
                : DEFAULT_PRICING.pricePerKm;

            const perMin =
              pricing?.pricePerMinute != null && Number.isFinite(parseFloat(pricing.pricePerMinute))
                ? parseFloat(pricing.pricePerMinute)
                : DEFAULT_PRICING.pricePerMinute;

            const minimum =
              pricing?.minimumFare != null && Number.isFinite(parseFloat(pricing.minimumFare))
                ? parseFloat(pricing.minimumFare)
                : DEFAULT_PRICING.minimumFare;

            if (dKm != null) {
              let fare = base + dKm * perKm + (dur != null ? dur * perMin : 0);
              fare = Math.max(minimum, fare);
              estimatedFare = String(Math.round(fare));
            }
          } catch (e) {
            console.error("pricing calc error:", e.message);
            if (dKm != null) {
              let fare =
                DEFAULT_PRICING.baseFare +
                dKm * DEFAULT_PRICING.pricePerKm +
                (dur != null ? dur * DEFAULT_PRICING.pricePerMinute : 0);

              fare = Math.max(DEFAULT_PRICING.minimumFare, fare);
              estimatedFare = String(Math.round(fare));
            }
          }

          // 3) إنشاء الطلب داخل transaction
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
              status: "pending",
            },
            { transaction: t }
          );

          await t.commit();
          console.log("✅ created request id=", newReq.id, "fare=", newReq.estimatedFare);
          // 4) matching بعد commit
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
              console.error("❌ GEORADIUS error", e.message);
              return [];
            });

          const driverIds = (nearby || []).map(String).slice(0, 30);

          let sentCount = 0;

          // ✅ new: key نخزّن بيه السواق اللي وصلهم الطلب
          const sentKey = `request:sent_to:${newReq.id}`;

          for (const did of driverIds) {
            const isOnline = await redisClient.sIsMember("drivers:online", String(did));
            if (!isOnline) continue;

            const busyRideId = await redisClient.get(`driver:busy:${did}`);
            if (busyRideId) continue;

            // 2) إذا رافض الطلب لا تبعث له
            const rejectedKey = `request:rejected:${newReq.id}`;
            const isRejected = await redisClient.sIsMember(rejectedKey, String(did));
            if (isRejected) continue;

            // 3) لازم عنده سوكت
            const driverSocketId = await redisClient.get(`socket:driver:${did}`);
            if (driverSocketId && ioInstance) {
              ioInstance.to(driverSocketId).emit("request:new", { request: newReq });
              sentCount++;

              // ✅ new: خزّن انه انبعت لهذا السائق
              await redisClient.sAdd(sentKey, String(did));
            }
          }

          // ✅ new: خلي الـ set ينتهي بعد ساعة
          await redisClient.expire(sentKey, 3600);

          console.log("📤 done matching. sentCount=", sentCount);

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
          console.error("❌ rider:create_request", e.message);
          return ack && ack({ ok: false, error: e.message });
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
            await redisClient.del(`driver:busy:${req.driver_id}`);
          }

          const sentKey = `request:sent_to:${req.id}`;
          const driverIds = await redisClient.sMembers(sentKey);

          for (const did of driverIds || []) {
            const sid = await redisClient.get(`socket:driver:${did}`);
            if (sid && ioInstance) {
              ioInstance.to(sid).emit("trip:status_changed", {
                requestId: req.id,
                status: req.status,
              });
            }
          }

          await redisClient.del(sentKey);
          await redisClient.del(`request:rejected:${req.id}`);

        } catch (e) {
          console.error(e.message);
        }
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
