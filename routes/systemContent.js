const express = require("express");
const router = express.Router();
const { requireAdmin } = require("./user");
const { SystemSetting } = require("../models");

const TERMS_KEY = "TERMS_AND_CONDITIONS";
const DRIVER_TERMS_KEY = "DRIVER_TERMS_AND_CONDITIONS";
const APP_DESCRIPTION_KEY = "APP_DESCRIPTION";

const getSettingValue = async (key) => {
  const setting = await SystemSetting.findOne({ where: { key } });
  return setting ? setting.value : "";
};

router.get("/settings/terms", async (req, res) => {
  try {
    const content = await getSettingValue(TERMS_KEY);
    res.json({ content: content || "" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/settings/driver-terms", async (req, res) => {
  try {
    const content = await getSettingValue(DRIVER_TERMS_KEY);
    res.json({ content: content || "" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/settings/app-description", async (req, res) => {
  try {
    const content = await getSettingValue(APP_DESCRIPTION_KEY);
    res.json({ content: content || "" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/settings/terms", requireAdmin, async (req, res) => {
  try {
    const content = await getSettingValue(TERMS_KEY);
    res.json({ content: content || "" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/settings/driver-terms", requireAdmin, async (req, res) => {
  try {
    const content = await getSettingValue(DRIVER_TERMS_KEY);
    res.json({ content: content || "" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/settings/app-description", requireAdmin, async (req, res) => {
  try {
    const content = await getSettingValue(APP_DESCRIPTION_KEY);
    res.json({ content: content || "" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put("/admin/settings/terms", requireAdmin, async (req, res) => {
  try {
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "content required" });

    await SystemSetting.upsert({ key: TERMS_KEY, value: content });
    res.json({ success: true, content });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put("/admin/settings/driver-terms", requireAdmin, async (req, res) => {
  try {
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "content required" });

    await SystemSetting.upsert({ key: DRIVER_TERMS_KEY, value: content });
    res.json({ success: true, content });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put("/admin/settings/app-description", requireAdmin, async (req, res) => {
  try {
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ error: "content required" });

    await SystemSetting.upsert({ key: APP_DESCRIPTION_KEY, value: content });
    res.json({ success: true, content });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
