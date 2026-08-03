const express = require("express");
const router = express.Router();
const { Op } = require("sequelize");
const { requireAdmin } = require("./user");
const { User, SystemSetting, DriverDebtLedger } = require("../models");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");

// helper to get setting value
const getSetting = async (key) => {
  const s = await SystemSetting.findOne({ where: { key } });
  return s ? s.value : null;
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

  const limitVal = driver.driverDebtLimitOverride != null
    ? parseFloat(driver.driverDebtLimitOverride)
    : parseFloat((await getSettingValue("DRIVER_DEBT_LIMIT")) || 0);
  if (driver.isDebtBlocked && next < limitVal) {
    driver.isDebtBlocked = false;
    driver.blockReason = null;
  }

  await driver.save({ transaction });
  return driver;
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

// GET settings
router.get("/admin/debt/settings", async (req, res) => {
  try {
    const limit = await getSetting("DRIVER_DEBT_LIMIT");
    const type = await getSetting("DRIVER_COMMISSION_TYPE");
    const value = await getSetting("DRIVER_COMMISSION_VALUE");
    res.json({ limit: limit != null ? parseFloat(limit) : null, commissionType: type || null, commissionValue: value != null ? parseFloat(value) : null });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// PUT settings
router.put("/admin/debt/settings", requireAdmin, async (req, res) => {
  try {
    const { DRIVER_DEBT_LIMIT, DRIVER_COMMISSION_TYPE, DRIVER_COMMISSION_VALUE } = req.body;
    if (DRIVER_DEBT_LIMIT != null) {
      await SystemSetting.upsert({ key: "DRIVER_DEBT_LIMIT", value: String(DRIVER_DEBT_LIMIT) });
    }
    if (DRIVER_COMMISSION_TYPE != null) {
      await SystemSetting.upsert({ key: "DRIVER_COMMISSION_TYPE", value: String(DRIVER_COMMISSION_TYPE) });
    }
    if (DRIVER_COMMISSION_VALUE != null) {
      await SystemSetting.upsert({ key: "DRIVER_COMMISSION_VALUE", value: String(DRIVER_COMMISSION_VALUE) });
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
    const { count, rows } = await User.findAndCountAll({ where, attributes: ["id", "name", "phone", "driverDebt", "isDebtBlocked", "blockReason", "status"], limit, offset, order: [["driverDebt", "DESC"]] });
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
    const driver = await User.findByPk(driverId, { attributes: ["id", "name", "phone", "driverDebt", "isDebtBlocked", "blockReason"] });
    if (!driver) return res.status(404).json({ error: "not_found" });
    const { count, rows } = await DriverDebtLedger.findAndCountAll({ where: { driver_id: driverId }, limit, offset, order: [["createdAt", "DESC"]] });
    res.json({ driver, total: count, page, totalPages: Math.ceil(count / limit), ledger: rows });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
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
