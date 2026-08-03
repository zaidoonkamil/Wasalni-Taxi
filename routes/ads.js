const express = require("express");
const { Advertisement } = require("../models");
const { requireAdmin } = require("./user");
const uploadImage = require("../middlewares/uploads");

const router = express.Router();

const toBool = (value, fallback = true) => {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = String(value).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
};

const adPayload = (ad, req) => {
  const json = ad.toJSON ? ad.toJSON() : ad;
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const baseUrl = process.env.PUBLIC_BASE_URL || `${proto}://${req.get("host")}`;
  return {
    ...json,
    imageUrl: json.image ? `${baseUrl}/uploads/${json.image}` : null,
  };
};

router.get("/ads", async (req, res) => {
  try {
    const ads = await Advertisement.findAll({
      where: { isActive: true },
      order: [
        ["sortOrder", "ASC"],
        ["createdAt", "DESC"],
      ],
    });

    res.json({ ads: ads.map((ad) => adPayload(ad, req)) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/ads", requireAdmin, async (req, res) => {
  try {
    const ads = await Advertisement.findAll({
      order: [
        ["sortOrder", "ASC"],
        ["createdAt", "DESC"],
      ],
    });

    res.json({ ads: ads.map((ad) => adPayload(ad, req)) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post("/admin/ads", requireAdmin, uploadImage.single("image"), async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const sortOrder = parseInt(req.body.sortOrder || "0", 10);
    const isActive = toBool(req.body.isActive, true);
    const image = req.file?.filename;

    if (!image) return res.status(400).json({ error: "image required" });

    const ad = await Advertisement.create({
      title,
      description,
      image,
      isActive,
      sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0,
      updatedByAdminId: req.user?.id || null,
    });

    res.status(201).json({ success: true, ad: adPayload(ad, req) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put("/admin/ads/:id", requireAdmin, uploadImage.single("image"), async (req, res) => {
  try {
    const ad = await Advertisement.findByPk(req.params.id);
    if (!ad) return res.status(404).json({ error: "not_found" });

    if (req.body.title != null) {
      const title = String(req.body.title || "").trim();
      ad.title = title;
    }
    if (req.body.description != null) ad.description = String(req.body.description || "").trim();
    if (req.body.sortOrder != null) {
      const sortOrder = parseInt(req.body.sortOrder || "0", 10);
      ad.sortOrder = Number.isInteger(sortOrder) ? sortOrder : 0;
    }
    if (req.body.isActive != null) ad.isActive = toBool(req.body.isActive, ad.isActive);
    if (req.file?.filename) ad.image = req.file.filename;
    ad.updatedByAdminId = req.user?.id || null;

    await ad.save();
    res.json({ success: true, ad: adPayload(ad, req) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/admin/ads/:id", requireAdmin, async (req, res) => {
  try {
    const ad = await Advertisement.findByPk(req.params.id);
    if (!ad) return res.status(404).json({ error: "not_found" });
    await ad.destroy();
    res.json({ success: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
