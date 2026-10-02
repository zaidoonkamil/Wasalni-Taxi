const { SystemSetting, User } = require("../models");
const redisService = require("./redis");

const parseAmount = (value) => {
  const amount = parseFloat(String(value || 0).replace(/[,\u066C\s]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
};

const DRIVER_ONLINE_TTL_SECONDS = 30 * 60;
const driverOnlineKey = (driverId) => `driver:online:${driverId}`;
const pendingDriverRequestsKey = (driverId) => `driver:pending_requests:${driverId}`;

const categoryPrefix = (category) => (category === "super" ? "SUPER_" : "");

const getDriverDebtLimit = async (driver, transaction) => {
  if (driver.driverDebtLimitOverride != null) {
    const override = parseAmount(driver.driverDebtLimitOverride);
    return Number.isFinite(override) ? override : null;
  }

  const prefix = categoryPrefix(driver.vehicleCategory);
  const setting =
    (await SystemSetting.findOne({
      where: { key: `${prefix}DRIVER_DEBT_LIMIT` },
      transaction,
    })) ||
    (await SystemSetting.findOne({
      where: { key: "DRIVER_DEBT_LIMIT" },
      transaction,
    }));

  if (!setting) return null;
  const value = parseAmount(setting.value);
  return Number.isFinite(value) ? value : null;
};

const cleanDriverRealtimeState = async (driverId, redisClient) => {
  const redis = redisClient || (await redisService.init());
  const pendingKey = pendingDriverRequestsKey(driverId);
  const pendingRequestIds = await redis.sMembers(pendingKey).catch(() => []);
  for (const requestId of pendingRequestIds || []) {
    await redis.sRem(`request:sent_to:${requestId}`, String(driverId)).catch(() => {});
  }
  await redis.del(pendingKey);
  await redis.del(`driver:state:${driverId}`);
  await redis.del(driverOnlineKey(driverId));
  await redis.sRem("drivers:online", String(driverId));
  await redis.sendCommand(["ZREM", "drivers:geo", String(driverId)]).catch(() => {});
  await redis.del(`driver:loc:${driverId}`);
};

const syncDriverAvailability = async (driver, options = {}) => {
  const redis = options.redisClient || (await redisService.init());
  const save = options.save !== false;

  if (!driver || driver.role !== "driver") {
    return {
      canReceive: false,
      reason: "not_driver",
      message: "هذا الحساب ليس كابتن",
    };
  }

  let changed = false;
  const debtLimit = await getDriverDebtLimit(driver, options.transaction);
  const debt = parseAmount(driver.driverDebt);
  const limitReached = debtLimit != null && debt >= debtLimit;

  if (limitReached && !driver.isDebtBlocked) {
    driver.isDebtBlocked = true;
    driver.blockReason = "debt";
    changed = true;
  }

  if (!limitReached && driver.isDebtBlocked && driver.blockReason === "debt") {
    driver.isDebtBlocked = false;
    driver.blockReason = null;
    changed = true;
  }

  if (!driver.isDebtBlocked && driver.blockReason === "debt" && !limitReached) {
    driver.blockReason = null;
    changed = true;
  }

  if (changed && save && typeof driver.save === "function") {
    await driver.save({ transaction: options.transaction });
  }

  const status = driver.status || "pending";
  const debtBlocked = !!driver.isDebtBlocked || driver.blockReason === "debt";

  if (status !== "active") {
    await cleanDriverRealtimeState(driver.id, redis);
    if (!debtBlocked) await redis.sRem("drivers:debt_blocked", String(driver.id));
    return {
      canReceive: false,
      reason: "not_active",
      status,
      message: "حساب الكابتن غير مفعل",
      debt,
      debtLimit,
    };
  }

  if (debtBlocked) {
    await redis.sAdd("drivers:debt_blocked", String(driver.id));
    await cleanDriverRealtimeState(driver.id, redis);
    return {
      canReceive: false,
      reason: "debt_blocked",
      status,
      message: "حسابك موقوف بسبب المديونية",
      debt,
      debtLimit,
    };
  }

  await redis.sRem("drivers:debt_blocked", String(driver.id));
  return {
    canReceive: true,
    reason: "ok",
    status,
    debt,
    debtLimit,
  };
};

const markDriverOnline = async (driverId, redisClient) => {
  const redis = redisClient || (await redisService.init());
  await redis.set(driverOnlineKey(driverId), "1", { EX: DRIVER_ONLINE_TTL_SECONDS });
  await redis.set(`driver:state:${driverId}`, "online", { EX: DRIVER_ONLINE_TTL_SECONDS });
  await redis.sAdd("drivers:online", String(driverId));
};

const isDriverOnlineFresh = async (driverId, redisClient) => {
  const redis = redisClient || (await redisService.init());
  const isListed = await redis.sIsMember("drivers:online", String(driverId));
  if (!isListed) return false;

  const heartbeat = await redis.get(driverOnlineKey(driverId));
  if (!heartbeat) {
    await cleanDriverRealtimeState(driverId, redis);
    return false;
  }

  return true;
};

const rememberPendingRequestForDriver = async (driverId, requestId, redisClient) => {
  const redis = redisClient || (await redisService.init());
  const key = pendingDriverRequestsKey(driverId);
  await redis.sAdd(key, String(requestId));
  await redis.expire(key, DRIVER_ONLINE_TTL_SECONDS);
};

const clearPendingRequestForDrivers = async (requestId, redisClient) => {
  const redis = redisClient || (await redisService.init());
  const sentKey = `request:sent_to:${requestId}`;
  const driverIds = await redis.sMembers(sentKey).catch(() => []);

  for (const driverId of driverIds || []) {
    await redis.sRem(pendingDriverRequestsKey(driverId), String(requestId)).catch(() => {});
  }

  await redis.del(sentKey);
  await redis.del(`request:rejected:${requestId}`);
  return driverIds || [];
};

module.exports = {
  parseAmount,
  DRIVER_ONLINE_TTL_SECONDS,
  pendingDriverRequestsKey,
  getDriverDebtLimit,
  cleanDriverRealtimeState,
  markDriverOnline,
  isDriverOnlineFresh,
  rememberPendingRequestForDriver,
  clearPendingRequestForDrivers,
  syncDriverAvailability,
  reconcileAllDriverAvailability: async () => {
    const redis = await redisService.init();
    await redis.del("drivers:online");
    await redis.del("drivers:geo");
    await redis.del("drivers:debt_blocked");

    const drivers = await User.findAll({
      where: { role: "driver" },
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

    let onlineCleaned = 0;
    let debtBlockedSynced = 0;

    for (const driver of drivers) {
      const beforeBlocked = !!driver.isDebtBlocked || driver.blockReason === "debt";
      await cleanDriverRealtimeState(driver.id, redis);
      const result = await syncDriverAvailability(driver, { redisClient: redis });
      if (!result.canReceive) onlineCleaned++;
      if (beforeBlocked || result.reason === "debt_blocked") debtBlockedSynced++;
    }

    return {
      drivers: drivers.length,
      onlineCleaned,
      debtBlockedSynced,
    };
  },
};
