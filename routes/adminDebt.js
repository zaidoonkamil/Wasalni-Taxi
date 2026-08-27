const express = require("express");
const router = express.Router();
const { Op } = require("sequelize");
const { requireAdmin } = require("./user");
const { User, SystemSetting, DriverDebtLedger, DriverRewardLedger } = require("../models");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");
const { grantDriverReward } = require("../services/driverRewards");

// helper to get setting value
const getSetting = async (key) => {
  const s = await SystemSetting.findOne({ where: { key } });
  return s ? s.value : null;
};

const categoryPrefix = (category) => (category === "super" ? "SUPER_" : "");

const getDebtLimitForDriver = async (driver) => {
  if (driver.driverDebtLimitOverride != null) return parseFloat(driver.driverDebtLimitOverride);
  const prefix = categoryPrefix(driver.vehicleCategory);
  const value = await getSettingValue(`${prefix}DRIVER_DEBT_LIMIT`);
  if (value != null) return parseFloat(value);
  return parseFloat((await getSettingValue("DRIVER_DEBT_LIMIT")) || 0);
};

const applyDriverDebtPayment = async ({ driver, amount, note, adminId, transaction }) => {
  const prev = parseFloat(driver.driverDebt || 0);
  let next = prev - amount;
  if (next < 0) next = 0;
  driver.driverDebt = next;

  await DriverDebtLedger.create(
    {
      driver_id: driver.id,
      type: "payment",
      amount,
      note: note || "admin payment",
      admin_id: adminId,
    },
    { transaction }
  );

  const limitVal = await getDebtLimitForDriver(driver);
  if (driver.isDebtBlocked && next < limitVal) {
    driver.isDebtBlocked = false;
    driver.blockReason = null;
  }

  await driver.save({ transaction });
  return driver;
};

const parseMoneyAmount = (value) => {
  const normalized = String(value || 0).replace(/[,\u066C\s]/g, "");
  const amount = parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
};

const notifyDriverDebtUpdated = async (driver, amount) => {
  try {
    const sid = await redisService.client().get(`socket:driver:${driver.id}`);
    if (sid && socketService) {
      socketService.notifyDriverSocket(driver.id, "driver:debt_updated", { debt: driver.driverDebt });
    } else {
      await notifications.sendNotificationToUser(driver.id, `تم سداد جزء من مديونيتك: ${amount}`);
    }
  } catch (e) {}
};

const notifyDriverRewardGranted = async (driver, amount) => {
  const title = "مكافأة جديدة";
  const message = `تمت إضافة مكافأة إلى حسابك بقيمة ${amount} د.ع. سيتم خصم عمولات رحلاتك منها قبل احتساب أي دين.`;
  try {
    await socketService.notifyDriverSocket(driver.id, "driver:reward_updated", {
      rewardBalance: driver.driverRewardBalance,
      title,
      message,
    });
  } catch (e) {}

  try {
    await notifications.sendNotificationToUser(driver.id, message, title);
  } catch (e) {
    console.error(`❌ Error sending reward notification to driver ${driver.id}:`, e.message);
  }
};

// GET settings
router.get("/admin/debt/settings", async (req, res) => {
  try {
    const limit = await getSetting("DRIVER_DEBT_LIMIT");
    const type = await getSetting("DRIVER_COMMISSION_TYPE");
    const value = await getSetting("DRIVER_COMMISSION_VALUE");
    const superLimit = await getSetting("SUPER_DRIVER_DEBT_LIMIT");
    const superType = await getSetting("SUPER_DRIVER_COMMISSION_TYPE");
    const superValue = await getSetting("SUPER_DRIVER_COMMISSION_VALUE");
    const ordinarySettings = {
      limit: limit != null ? parseFloat(limit) : null,
      commissionType: type || null,
      commissionValue: value != null ? parseFloat(value) : null,
    };
    const superSettings = {
      limit: superLimit != null ? parseFloat(superLimit) : ordinarySettings.limit,
      commissionType: superType || ordinarySettings.commissionType,
      commissionValue: superValue != null ? parseFloat(superValue) : ordinarySettings.commissionValue,
    };
    res.json({
      ...ordinarySettings,
      settingsByType: {
        ordinary: ordinarySettings,
        super: superSettings,
      },
    });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// PUT settings
router.put("/admin/debt/settings", requireAdmin, async (req, res) => {
  try {
    const {
      DRIVER_DEBT_LIMIT,
      DRIVER_COMMISSION_TYPE,
      DRIVER_COMMISSION_VALUE,
      SUPER_DRIVER_DEBT_LIMIT,
      SUPER_DRIVER_COMMISSION_TYPE,
      SUPER_DRIVER_COMMISSION_VALUE,
    } = req.body;
    if (DRIVER_DEBT_LIMIT != null) {
      await SystemSetting.upsert({ key: "DRIVER_DEBT_LIMIT", value: String(DRIVER_DEBT_LIMIT) });
    }
    if (DRIVER_COMMISSION_TYPE != null) {
      await SystemSetting.upsert({ key: "DRIVER_COMMISSION_TYPE", value: String(DRIVER_COMMISSION_TYPE) });
    }
    if (DRIVER_COMMISSION_VALUE != null) {
      await SystemSetting.upsert({ key: "DRIVER_COMMISSION_VALUE", value: String(DRIVER_COMMISSION_VALUE) });
    }
    if (SUPER_DRIVER_DEBT_LIMIT != null) {
      await SystemSetting.upsert({ key: "SUPER_DRIVER_DEBT_LIMIT", value: String(SUPER_DRIVER_DEBT_LIMIT) });
    }
    if (SUPER_DRIVER_COMMISSION_TYPE != null) {
      await SystemSetting.upsert({ key: "SUPER_DRIVER_COMMISSION_TYPE", value: String(SUPER_DRIVER_COMMISSION_TYPE) });
    }
    if (SUPER_DRIVER_COMMISSION_VALUE != null) {
      await SystemSetting.upsert({ key: "SUPER_DRIVER_COMMISSION_VALUE", value: String(SUPER_DRIVER_COMMISSION_VALUE) });
    }
    res.json({ success: true });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// GET drivers debts list
router.get("/admin/drivers/debts", requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const minDebt = req.query.minDebt != null ? parseFloat(req.query.minDebt) : null;
    const where = { role: "driver" };
    if (minDebt != null) where.driverDebt = { [Op.gte]: minDebt };
    const offset = (page - 1) * limit;
    const { count, rows } = await User.findAndCountAll({ where, attributes: ["id", "name", "phone", "driverDebt", "driverRewardBalance", "isDebtBlocked", "blockReason", "status"], limit, offset, order: [["driverDebt", "DESC"]] });
    res.json({ total: count, page, totalPages: Math.ceil(count / limit), drivers: rows });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// GET driver debt detail with ledger
router.get("/admin/drivers/:id/debt", requireAdmin, async (req, res) => {
  try {
    const driverId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;
    const driver = await User.findByPk(driverId, { attributes: ["id", "name", "phone", "driverDebt", "driverRewardBalance", "isDebtBlocked", "blockReason"] });
    if (!driver) return res.status(404).json({ error: "not_found" });
    const { count, rows } = await DriverDebtLedger.findAndCountAll({ where: { driver_id: driverId }, limit, offset, order: [["createdAt", "DESC"]] });
    const rewardLedger = await DriverRewardLedger.findAll({ where: { driver_id: driverId }, limit, offset, order: [["createdAt", "DESC"]] });
    res.json({ driver, total: count, page, totalPages: Math.ceil(count / limit), ledger: rows, rewardLedger });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

router.post("/admin/drivers/:id/rewards/grant", requireAdmin, async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const driverId = req.params.id;
    const { amount, note } = req.body;
    const parsed = parseMoneyAmount(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "Invalid amount" });
    }

    const driver = await User.findByPk(driverId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!driver || driver.role !== "driver") {
      await t.rollback();
      return res.status(404).json({ error: "driver_not_found" });
    }

    const rewardResult = await grantDriverReward({
      driver,
      amount: parsed,
      note: note || "admin reward",
      adminId: req.user.id,
      transaction: t,
    });

    await t.commit();
    await notifyDriverRewardGranted(driver, parsed);

    res.json({
      success: true,
      driver,
      reward: {
        granted: rewardResult.granted,
        previousBalance: rewardResult.previousBalance,
        balance: rewardResult.nextBalance,
      },
    });
  } catch (e) {
    await t.rollback();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post("/admin/drivers/rewards/grant-bulk", requireAdmin, async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const { amount, note, driverIds, allDrivers } = req.body;
    const parsed = parseMoneyAmount(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "Invalid amount" });
    }

    const where = { role: "driver" };
    if (!allDrivers) {
      const ids = Array.isArray(driverIds)
        ? driverIds.map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id))
        : [];
      if (ids.length === 0) {
        await t.rollback();
        return res.status(400).json({ error: "driverIds required" });
      }
      where.id = { [Op.in]: ids };
    }

    const drivers = await User.findAll({ where, transaction: t, lock: t.LOCK.UPDATE });
    const rewards = [];
    for (const driver of drivers) {
      const rewardResult = await grantDriverReward({
        driver,
        amount: parsed,
        note: note || (allDrivers ? "admin reward for all drivers" : "admin reward for selected drivers"),
        adminId: req.user.id,
        transaction: t,
      });
      rewards.push({
        driverId: driver.id,
        granted: rewardResult.granted,
        previousBalance: rewardResult.previousBalance,
        balance: rewardResult.nextBalance,
      });
    }

    await t.commit();
    for (const driver of drivers) {
      await notifyDriverRewardGranted(driver, parsed);
    }

    res.json({ success: true, affected: drivers.length, drivers, rewards });
  } catch (e) {
    await t.rollback();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST pay debt
router.post("/admin/drivers/:id/debt/pay", requireAdmin, async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const driverId = req.params.id;
    const { amount, note } = req.body;
    const parsed = parseFloat(amount || 0);
    if (isNaN(parsed) || parsed <= 0) { await t.rollback(); return res.status(400).json({ error: "Invalid amount" }); }

    const driver = await User.findByPk(driverId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!driver) { await t.rollback(); return res.status(404).json({ error: "not_found" }); }

    await applyDriverDebtPayment({
      driver,
      amount: parsed,
      note,
      adminId: req.user.id,
      transaction: t,
    });

    if (!driver.isDebtBlocked) {
      try { await redisService.client().sRem("drivers:debt_blocked", String(driver.id)); } catch (e) {}
    }

    await t.commit();

    await notifyDriverDebtUpdated(driver, parsed);

    res.json({ success: true, driver });
  } catch (e) { await t.rollback(); console.error(e.message); res.status(500).json({ error: e.message }); }
});

// POST pay debt for selected drivers or all drivers
router.post("/admin/drivers/debt/pay-bulk", requireAdmin, async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const { amount, note, driverIds, allDrivers } = req.body;
    const parsed = parseFloat(amount || 0);
    if (isNaN(parsed) || parsed <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "Invalid amount" });
    }

    let where = { role: "driver" };
    if (!allDrivers) {
      const ids = Array.isArray(driverIds)
        ? driverIds.map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id))
        : [];
      if (ids.length === 0) {
        await t.rollback();
        return res.status(400).json({ error: "driverIds required" });
      }
      where.id = { [Op.in]: ids };
    }

    const drivers = await User.findAll({
      where,
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    for (const driver of drivers) {
      await applyDriverDebtPayment({
        driver,
        amount: parsed,
        note: note || (allDrivers ? "admin payment for all drivers" : "admin payment for selected drivers"),
        adminId: req.user.id,
        transaction: t,
      });
    }

    await t.commit();

    for (const driver of drivers) {
      if (!driver.isDebtBlocked) {
        try { await redisService.client().sRem("drivers:debt_blocked", String(driver.id)); } catch (e) {}
      }
      await notifyDriverDebtUpdated(driver, parsed);
    }

    res.json({ success: true, affected: drivers.length, drivers });
  } catch (e) {
    await t.rollback();
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

const getSettingValue = async (key) => {
  const s = await SystemSetting.findOne({ where: { key } });
  return s ? s.value : null;
};

module.exports = router;
