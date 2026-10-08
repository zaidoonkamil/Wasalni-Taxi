const jwt = require("jsonwebtoken");
const redisService = require("./redis");
const { User, RideRequest, SystemSetting, DriverDebtLedger, DriverRating } = require("../models");
const sequelize = require("../config/db");
const notifications = require("./notifications") || require("../services/notifications");
const { Op } = require("sequelize");
const { calculateFare, normalizeServiceType } = require("./areaPricing");
const { resolveRouteMetrics } = require("./routeMetrics");
const { applyCommissionWithReward } = require("./driverRewards");
const {
  clearPendingRequestForDrivers,
  cleanDriverRealtimeState,
  isDriverOnlineFresh,
  markDriverOnline,
  pendingDriverRequestsKey,
  rememberPendingRequestForDriver,
  syncDriverAvailability,
} = require("./driverAvailability");

let ioInstance = null;

// آخر موقع معروف للكابتن ({ lat, lng, heading, speed, ts }) أو null. ما يرمي خطأ أبداً.
const getDriverLocation = async (driverId) => {
  try {
    const loc = await redisService.getJSON(`driver:loc:${driverId}`);
    if (!loc || loc.lat == null || loc.lng == null) return null;
    return {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      heading: loc.heading ?? null,
      speed: loc.speed ?? null,
      ts: loc.ts ?? null,
    };
  } catch (e) {
    return null;
  }
};

const isRoomOnline = (room) => {
  if (!ioInstance) return false;
  const members = ioInstance.sockets.adapter.rooms.get(room);
  return !!members && members.size > 0;
};

const ACTIVE_TRIP_STATUSES = ["accepted", "arrived", "started"];

// مفتاح socket:<role>:<id> بعده ينستخدم بأماكن قديمة، فنخليه طويل (ينحذف بالـ disconnect)
const SOCKET_KEY_TTL = 60 * 60 * 24;

// الإرسال عن طريق rooms بدل socket id المخزن بـ Redis (اللي جان ينتهي وما يتحدث)
const emitToRider = (riderId, event, payload) => {
  const room = `rider:${riderId}`;
  if (!isRoomOnline(room)) return false;
  ioInstance.to(room).emit(event, payload);
  return true;
};

const emitToDriver = (driverId, event, payload) => {
  const room = `driver:${driverId}`;
  if (!isRoomOnline(room)) return false;
  ioInstance.to(room).emit(event, payload);
  return true;
};

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
  title: "زبون سابق يطلب رحلة",
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

const deliverPendingRequestsToDriver = async (driverId, redisClient) => {
  if (!ioInstance) return;

  if (!isRoomOnline(`driver:${driverId}`)) return;

  const requestIds = await redisClient
    .sMembers(pendingDriverRequestsKey(driverId))
    .catch(() => []);
  if (!requestIds || !requestIds.length) return;

  const busyRideId = await redisClient.get(`driver:busy:${driverId}`);
  if (busyRideId) return;

  for (const requestId of requestIds) {
    const req = await RideRequest.findByPk(requestId).catch(() => null);
    if (!req || req.status !== "pending") {
      await redisClient.sRem(pendingDriverRequestsKey(driverId), String(requestId)).catch(() => {});
      continue;
    }

    const stillSent = await redisClient
      .sIsMember(`request:sent_to:${requestId}`, String(driverId))
      .catch(() => false);
    const isRejected = await redisClient
      .sIsMember(`request:rejected:${requestId}`, String(driverId))
      .catch(() => false);
    if (!stillSent || isRejected) {
      await redisClient.sRem(pendingDriverRequestsKey(driverId), String(requestId)).catch(() => {});
      continue;
    }

    emitToDriver(driverId, "request:new", { request: req });
  }
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
      // room ثابت للمستخدم: كل الأحداث توصله عن طريقه، حتى لو عنده أكثر من اتصال
      socket.join(isDriver ? `driver:${user.id}` : `rider:${user.id}`);

      // ملاحظة مهمة: كل الـ handlers لازم تتسجل قبل أي await. أي رسالة يدزها
      // التطبيق أول ما يتصل (موقع، طلب حالة) جانت تضيع لأن محد يستقبلها بعد.
      // التهيئة اللي تحتاج Redis/داتابيس صارت بآخر هذا الـ handler.
        const refreshSocketKey = async () => {
          try {
            await redisClient.set(socketKey, socket.id, { EX: SOCKET_KEY_TTL });
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
          await redisClient.sRem(pendingDriverRequestsKey(user.id), String(requestId));

          socket.emit("request:rejected_ack", { ok: true, requestId });
        } catch (e) {
          console.error("driver:reject_request error", e.message);
          socket.emit("request:rejected_ack", { ok: false, error: e.message });
        }
      });

      socket.on("disconnect", async () => {
          try {
            const currentSocketId = await redisClient.get(socketKey);
            if (currentSocketId === socket.id) {
              await redisClient.del(socketKey);
            }
          } catch (e) {
            console.error("socket disconnect cleanup", e.message);
          }
      });

      // اتصال السائق
      socket.on("driver:get_online_state", async (_, ack) => {
        try {
          const online = await isDriverOnlineFresh(user.id, redisClient);
          return ack && ack({ ok: true, online });
        } catch (e) {
          console.error("driver:get_online_state error", e.message);
          return ack && ack({ ok: false, error: "state_unavailable" });
        }
      });

      socket.on("driver:online", async (_, ack) => {
        try {
          const driver = await User.findByPk(user.id, {
            attributes: [
              "id",
              "role",
              "status",
              "vehicleCategory",
              "driverDebt",
              "driverDebtLimitOverride",
              "isDebtBlocked",
              "blockReason",
            ],
          });
          const availability = await syncDriverAvailability(driver, { redisClient });
          if (!availability.canReceive && availability.reason === "not_active") {
            socket.emit("driver:not_active", {
              ok: false,
              status: availability.status || "not_found",
              message: availability.message,
            });
            ack && ack({ ok: false, online: false, reason: "not_active", message: availability.message });
            return;
          }

          if (!availability.canReceive && availability.reason === "debt_blocked") {
            socket.emit("driver:debt_blocked", {
              ok: false,
              reason: "debt_blocked",
              message: availability.message,
              debt: availability.debt,
              debtLimit: availability.debtLimit,
            });
            ack && ack({ ok: false, online: false, reason: "debt_blocked", message: availability.message });
            return;
          }

          await markDriverOnline(user.id, redisClient);
          await redisClient.set(socketKey, socket.id, { EX: 3600 });
          await deliverPendingRequestsToDriver(user.id, redisClient);
          console.log("driver online:", user.id);
          ack && ack({ ok: true, online: true });
        } catch (e) {
          console.error("driver:online error", e.message);
          ack && ack({ ok: false, online: false, error: "state_unavailable" });
        }
      });

      socket.on("driver:restore_online_state", async () => {
        try {
          const restored = await isDriverOnlineFresh(user.id, redisClient);
          if (!restored) return socket.emit("driver:online_restored", { ok: false });

          await markDriverOnline(user.id, redisClient);
          await redisClient.set(socketKey, socket.id, { EX: 3600 });
          socket.emit("driver:online_restored", {
            ok: true,
            ttlSeconds: 30 * 60,
          });
          await deliverPendingRequestsToDriver(user.id, redisClient);
        } catch (e) {
          console.error("driver:restore_online_state error", e.message);
        }
      });

      socket.on("driver:offline", async (data = {}, ack) => {
        try {
          if (data?.manual !== true && data?.reason !== "manual") {
            const response = {
              ok: false,
              ignored: true,
              reason: "manual_required",
            };
            socket.emit("driver:offline_ack", response);
            return ack && ack(response);
          }

          await cleanDriverRealtimeState(user.id, redisClient);
          const response = { ok: true, online: false };
          socket.emit("driver:offline_ack", response);
          ack && ack(response);
        } catch (e) {
          ack && ack({ ok: false, error: "state_unavailable" });
        }
      });

      // تحديث موقع السائق
      socket.on("driver:location", async (data, ack) => {
        try {
          const now = Date.now();
          const last = socket.data?.lastLocTs || 0;

          // حماية من الإغراق بس؛ التطبيق يدز كل ~1.1 ثانية
          if (now - last < 500) {
            return ack && ack({ ok: true, throttled: true });
          }

          socket.data = socket.data || {};
          socket.data.lastLocTs = now;

          const { lat, lng, heading, speed } = data;

          if (lat == null || lng == null) {
            return ack && ack({ ok: false, reason: "missing_lat_lng" });
          }

          const busyReqId = await redisClient.get(`driver:busy:${user.id}`);
          const online = await isDriverOnlineFresh(user.id, redisClient);

          // السائق اللي عنده رحلة فعالة لازم موقعه يوصل للزبون حتى لو
          // طفى استقبال الطلبات، فما نرفضه إلا إذا لا متصل ولا عنده رحلة
          if (!online && !busyReqId) {
            return ack && ack({ ok: false, reason: "driver_not_online" });
          }

          const locObj = {
            lat,
            lng,
            heading: heading ?? null,
            speed: speed ?? null,
            ts: Date.now(),
          };
          await redisService.setJSON(`driver:loc:${user.id}`, locObj, 3600);

          if (online) {
            await markDriverOnline(user.id, redisClient);
            await redisClient.sendCommand([
              "GEOADD",
              "drivers:geo",
              String(lng),
              String(lat),
              String(user.id),
            ]);
          }

          try {
            if (busyReqId && ioInstance) {
              // نخزن rider_id على الاتصال بدل ما نقرأ الطلب من الداتابيس كل ثانية
              if (socket.data.tripReqId !== busyReqId) {
                const req = await RideRequest.findByPk(busyReqId, { attributes: ["id", "rider_id"] });
                socket.data.tripReqId = busyReqId;
                socket.data.tripRiderId = req ? req.rider_id : null;
              }
              if (socket.data.tripRiderId) {
                ioInstance.to(`rider:${socket.data.tripRiderId}`).emit("trip:driver_location", {
                  requestId: busyReqId,
                  driverId: user.id,
                  lat,
                  lng,
                  heading: heading ?? null,
                  speed: speed ?? null,
                });
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


      // الزبون يطلب آخر موقع للكابتن مالته (أول ما ينقبل الطلب، أو يرجع
      // للتطبيق، أو إذا تأخرت التحديثات). هذا يخلي الخريطة تصلّح نفسها.
      socket.on("rider:get_driver_location", async (data, ack) => {
        try {
          if (isDriver) return ack && ack({ ok: false, reason: "not_rider" });
          const where = { rider_id: user.id, status: { [Op.in]: ACTIVE_TRIP_STATUSES } };
          if (data && data.requestId) where.id = data.requestId;
          const req = await RideRequest.findOne({
            where,
            order: [["id", "DESC"]],
            attributes: ["id", "driver_id", "status"],
          });
          if (!req || !req.driver_id) return ack && ack({ ok: true, found: false });

          const loc = await getDriverLocation(req.driver_id);
          return ack && ack({
            ok: true,
            found: !!loc,
            requestId: req.id,
            driverId: req.driver_id,
            status: req.status,
            ...(loc || {}),
          });
        } catch (e) {
          return ack && ack({ ok: false, reason: e.message });
        }
      });

      // قبول طلب الرحلة من قبل السائق
      socket.on("driver:accept_request", async ({ requestId }) => {
        try {
          const driver = await User.findByPk(user.id);
          const availability = await syncDriverAvailability(driver, { redisClient });
          if (!availability.canReceive) {
            socket.emit("request:accept_failed", {
              requestId,
              reason: availability.reason,
              message: availability.message,
            });
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
          let req;
          const t = await sequelize.transaction();
          try {
            req = await RideRequest.findByPk(requestId, { transaction: t, lock: t.LOCK.UPDATE });
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
          } catch (e) {
            try { await t.rollback(); } catch (_) {}
            await redisService.releaseLock(lockKey, String(user.id));
            socket.emit("request:accept_failed", { requestId, reason: "error", details: e.message });
            return;
          }

          // ===== من هنا القبول ثابت بالداتابيس =====
          // أي خطأ بعده لازم ما يوصل للكابتن كـ "فشل"، وإلا يسكّر الرحلة عنده
          // ويوكف إرسال موقعه بينما الزبون ينتظره
          try {
            // busy قبل كلشي: هو اللي يخلي موقع الكابتن ينرسل للزبون
            await redisClient.set(`driver:busy:${user.id}`, String(req.id), { EX: 60 * 60 * 3 });
          } catch (e) {
            console.error("accept: set busy error", e.message);
          }

          const driverLocation = await getDriverLocation(user.id);
          const payload = { requestId: req.id, driverId: user.id, driverLocation };

          // الكابتن أولاً حتى يبدي يرسل موقعه فوراً
          socket.emit("request:accepted", payload);

          try {
            const riderRoom = `rider:${req.rider_id}`;
            if (isRoomOnline(riderRoom)) {
              ioInstance.to(riderRoom).emit("request:accepted", payload);
              if (driverLocation) {
                ioInstance.to(riderRoom).emit("trip:driver_location", {
                  requestId: req.id,
                  driverId: user.id,
                  ...driverLocation,
                });
              }
            } else {
              await notifications.sendNotificationToUser(req.rider_id, "تم قبول طلبك", "السائق في الطريق");
            }
          } catch (e) {
            console.error("accept: notify rider error", e.message);
          }

          try {
            const sentDriverIds = await clearPendingRequestForDrivers(req.id, redisClient);
            for (const did of sentDriverIds) {
              if (String(did) === String(user.id)) continue;
              ioInstance.to(`driver:${did}`).emit("request:taken", {
                requestId: req.id,
                driverId: user.id,
                status: "accepted",
              });
            }
          } catch (notifyErr) {
            console.error("notify request:taken error", notifyErr.message);
          }
        } catch (e) {
          console.error("accept error", e.message);
          // لازم نرد على الكابتن دائماً، وإلا يبقى ينتظر بدون ما يعرف النتيجة
          socket.emit("request:accept_failed", { requestId, reason: "error", details: e.message });
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
          emitToRider(req.rider_id, "trip:status_changed", payload);
          try {
            // التطبيق يخفي هذا الإشعار إذا جان مفتوح لأنه يشغل نغمة الوصول بنفسه
            await notifications.sendNotificationToUser(
              req.rider_id,
              "الكابتن وصل لموقعك، تقدر تطلع هسه",
              "وصلني - السائق وصل موقعك",
              { data: { type: "driver_arrived", requestId: String(req.id) }, priority: 10 }
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
          const payload = { requestId: req.id, status: req.status };
          emitToRider(req.rider_id, "trip:status_changed", payload);
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
          const payload = { requestId: req.id, status: req.status };
          if (req.driver_id) {
            await redisClient.del(`driver:busy:${req.driver_id}`);
          }
          await clearPendingRequestForDrivers(req.id, redisClient);

          emitToRider(req.rider_id, "trip:status_changed", payload);
          if (req.driver_id) emitToDriver(req.driver_id, "trip:status_changed", payload);

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
                    const sid = isRoomOnline(`driver:${driver.id}`) ? `driver:${driver.id}` : null;
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

      // إنشاء طلب الرحلة من قبل الراكب
      socket.on("rider:create_request", async (data, ack) => {
        const t = await sequelize.transaction();
        try {
          const { pickup, dropoff } = data;
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
            console.log("active ride exists id=", active.id, "status=", active.status);
            return ack && ack({
              ok: false,
              error: "active_ride_exists",
              message: "عندك رحلة/طلب فعال مسبقاً",
              activeRequestId: active.id,
              status: active.status,
            });
          }

          let estimatedFare = null;
          let pricingAreaType = "mixed";
          let pricingZoneId = null;
          let pricingRouteId = null;

          const routeMetrics = await resolveRouteMetrics(pickup, dropoff);
          const dKm = routeMetrics.distanceKm;
          const dur = routeMetrics.durationMin;


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
            pricingRouteId = fare.pricingRoute?.id || null;
            console.log("[socket rider:create_request] pricing:", {
              serviceType,
              pricingZoneId,
              pricingRouteId,
              pricingSource: fare.pricingSource,
              distanceKm: dKm,
              distanceSource: routeMetrics.source,
              routePricePerKm: fare.pricingRoute?.pricePerKm,
              zonePricePerKm: fare.pricingZone?.pricePerKm,
              pickupZone: fare.pickupZone,
              dropoffZone: fare.dropoffZone,
              matchedPickupZones: fare.matchedPickupZones,
              matchedDropoffZones: fare.matchedDropoffZones,
            });
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
              pricingRouteId,
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
              console.error("GEORADIUS error", e.message);
              return [];
            });

          const driverIds = (nearby || []).map(String).slice(0, 30);
          const driverRows = await User.findAll({
            where: { id: { [Op.in]: driverIds }, role: "driver", status: "active" },
            attributes: ["id", "vehicleCategory", "isDebtBlocked", "blockReason"],
          });
          const driverById = new Map(driverRows.map((driver) => [String(driver.id), driver]));
          const previousGoodRatingsByDriver = await getPreviousGoodDriverRatings(user.id, driverIds);

          let sentCount = 0;
          const sentKey = `request:sent_to:${newReq.id}`;

          for (const did of driverIds) {
            const driver = driverById.get(String(did));
            if (!driver) continue;
            if (driver.isDebtBlocked || driver.blockReason === "debt") continue;
            if (!driverCanReceiveService(driver.vehicleCategory || "ordinary", serviceType)) continue;

            const isOnline = await isDriverOnlineFresh(did, redisClient);
            if (!isOnline) continue;

            const busyRideId = await redisClient.get(`driver:busy:${did}`);
            if (busyRideId) continue;

            const rejectedKey = `request:rejected:${newReq.id}`;
            const isRejected = await redisClient.sIsMember(rejectedKey, String(did));
            if (isRejected) continue;

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

            emitToDriver(did, "request:new", payload);

            // نرسل إشعار دائماً، والتطبيق يخفيه إذا جان مفتوح (حتى ما تتداخل النغمتين)
            notifications
              .sendRideRequestNotification(did, newReq.id, priorityMatch ? previousGoodDriverMessage : null)
              .catch((e) => console.error("driver request push error:", e.message));

            sentCount++;
            await redisClient.sAdd(sentKey, String(did));
            await rememberPendingRequestForDriver(did, newReq.id, redisClient);
          }

          await redisClient.expire(sentKey, 3600);

          console.log("done matching. sentCount=", sentCount);

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
          console.error("rider:create_request", e.message);
          return ack && ack({ ok: false, error: e.message });
        }
      });


      // إلغاء طلب الرحلة من قبل الراكب
      socket.on("rider:cancel_request", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;

          if (["completed", "cancelled"].includes(req.status)) return;

          req.status = "cancelled";
          await req.save();

          if (req.driver_id) {
            await redisClient.del(`driver:busy:${req.driver_id}`);

            emitToDriver(req.driver_id, "trip:status_changed", {
              requestId: req.id,
              status: "cancelled",
            });
          }

          const driverIds = await clearPendingRequestForDrivers(req.id, redisClient);

          for (const did of driverIds || []) {
            emitToDriver(did, "trip:status_changed", {
              requestId: req.id,
              status: "cancelled",
            });
          }

        } catch (e) {
          console.error("rider:cancel_request error", e.message);
        }
      });

      // ===== التهيئة (بعد تسجيل كل الـ handlers) =====
      await redisClient.set(socketKey, socket.id, { EX: SOCKET_KEY_TTL });
      if (isDriver) {
        try {
          const restored = await isDriverOnlineFresh(user.id, redisClient);
          if (restored) {
            await markDriverOnline(user.id, redisClient);
            socket.emit("driver:online_restored", {
              ok: true,
              ttlSeconds: 30 * 60,
            });
            await deliverPendingRequestsToDriver(user.id, redisClient);
          }
        } catch (e) {
          console.error("driver online restore error", e.message);
        }
      }
    } catch (e) {
      console.error("socket connection error", e.message);
    }
  });
};

// إخبار السائق عبر السوكت (يرجع true إذا جان متصل)
const notifyDriverSocket = async (driverId, event, payload) => emitToDriver(driverId, event, payload);

// إخبار الراكب عبر السوكت (يرجع true إذا جان متصل)
const notifyRiderSocket = async (riderId, event, payload) => emitToRider(riderId, event, payload);

module.exports = { init, notifyDriverSocket, notifyRiderSocket };
