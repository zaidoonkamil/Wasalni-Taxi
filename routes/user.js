const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Op } = require("sequelize");
const { User, UserDevice } = require("../models");
const uploadImage = require("../middlewares/uploads");
const router = express.Router();
const upload = multer();
const saltRounds = 10;

const normalizePhone = (phone = "") => {
  phone = String(phone).trim();
  if (phone.startsWith("0")) return "964" + phone.slice(1);
  return phone;
};

const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "700d" }
  );
};

const requireAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Token is missing" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const admin = await User.findByPk(decoded.id);
    if (!admin) return res.status(401).json({ error: "User not found" });

    if (admin.role !== "admin") {
      return res.status(403).json({ error: "Not allowed" });
    }

    req.user = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const safeUser = (user) => {
  const u = user.toJSON();
  delete u.password;
  return u;
};

router.post("/users", upload.none(), async (req, res) => {
  try {
    const { name, password, role = "user", status } = req.body;
    let { phone } = req.body;

    phone = normalizePhone(phone);

    if (!name || !phone || !password) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة: الاسم, رقم الهاتف, كلمة المرور" });
    }

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "role مسموح فقط: user أو admin" });
    }

    if (status && !["active", "blocked", "pending"].includes(status)) {
      return res.status(400).json({ error: "status غير صحيح" });
    }

    const existingPhone = await User.findOne({ where: { phone } });
    if (existingPhone) {
      return res.status(400).json({ error: "تم استخدام رقم الهاتف من مستخدم اخر" });
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = await User.create({
      name,
      phone,
      password: hashedPassword,
      role,
      status: status || "active",
    });

    const token = generateToken(user);

    return res.status(201).json({
      message: "تم إنشاء الحساب بنجاح",
      user: safeUser(user),
      token,
    });
  } catch (err) {
    console.error("❌ Error creating user:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/drivers/register",
  uploadImage.fields([
    { name: "driverImage", maxCount: 1 },
    { name: "carImages", maxCount: 10 },     
    { name: "drivingLicenseFront", maxCount: 1 }, 
    { name: "drivingLicenseBack", maxCount: 1 }, 
  ]),
  async (req, res) => {
    try {
      const {
        name,
        password,
        vehicleType,
        vehicleColor,
        vehicleNumber,
        location,
      } = req.body;

      let { phone } = req.body;
      phone = normalizePhone(phone);

      if (!name || !phone || !password) {
        return res.status(400).json({ error: "جميع الحقول مطلوبة: name, phone, password" });
      }

      if (!vehicleType || !vehicleColor || !vehicleNumber) {
        return res.status(400).json({
          error: "حقول السائق مطلوبة: نوع السيارة, لون السيارة, رقم السيارة",
        });
      }

      const locationText = String(location || "").trim();
      if (!locationText) {
        return res.status(400).json({
          error: "الموقع مطلوب كنص مثال: بغداد الاعضمية قرب محطة البانزين خانة",
        });
      }

      const driverImg = req.files?.driverImage?.[0]?.filename;

      const carImgs =
        Array.isArray(req.files?.carImages) ? req.files.carImages.map((f) => f.filename) : [];

      const licFront = req.files?.drivingLicenseFront?.[0]?.filename;
      const licBack = req.files?.drivingLicenseBack?.[0]?.filename;

      if (!driverImg) {
        return res.status(400).json({ error: "صورة السائق مطلوبة" });
      }
      if (!carImgs.length) {
        return res.status(400).json({ error: "لازم ترفع على الأقل صورة واحدة للسيارة" });
      }
      if (!licFront || !licBack) {
        return res.status(400).json({
          error: "صور اجازة السوق مطلوبة: drivingLicenseFront, drivingLicenseBack",
        });
      }

      const existingPhone = await User.findOne({ where: { phone } });
      if (existingPhone) {
        return res.status(400).json({ error: "تم استخدام رقم الهاتف من مستخدم اخر" });
      }

      const hashedPassword = await bcrypt.hash(password, saltRounds);

      const driver = await User.create({
        name,
        phone,
        password: hashedPassword,
        role: "driver",
        status: "pending",
        driverImage: { main: driverImg },
        carImages: { main: carImgs[0], images: carImgs },
        vehicleType,
        vehicleColor,
        vehicleNumber,
        location: locationText,
        drivingLicenseFront: { main: licFront },
        drivingLicenseBack: { main: licBack },
      });

      const token = generateToken(driver);
      return res.status(201).json({
        message: "تم تسجيل السائق بنجاح (بانتظار تفعيل الأدمن)",
        user: safeUser(driver),
        token,
      });
    } catch (err) {
      console.error("❌ Error creating driver:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

router.post("/login", upload.none(), async (req, res) => {
  try {
    let { phone } = req.body;
    const { password } = req.body;

    phone = normalizePhone(phone);

    if (!phone || !password) {
      return res.status(400).json({ error: "يرجى إدخال رقم الهاتف وكلمة المرور" });
    }

    const user = await User.findOne({ where: { phone } });
    if (!user) {
      return res.status(400).json({ error: "يرجى إدخال رقم الهاتف بشكل صحيح" });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ error: "الحساب محظور" });
    }

    if (user.role === "driver" && user.status === "pending") {
      return res.status(403).json({ error: "حساب السائق بانتظار التفعيل" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
    }

    const token = generateToken(user);

    return res.status(200).json({
      message: "Login successful",
      user: safeUser(user),
      token,
    });
  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل الدخول:", err);
    return res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.get("/usersOnly", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: users } = await User.findAndCountAll({
      where: { role: { [Op.notIn]: ["admin","driver"] } },
      limit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      users,
      pagination: {
        totalUsers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/driversOnly", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: drivers } = await User.findAndCountAll({
      where: { role: "driver" },
      limit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      drivers,
      pagination: {
        totalDrivers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching drivers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/user/:id", async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ["password"] },
    });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
    return res.status(200).json(user);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/profile", async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "Token is missing" });

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });

    try {
      const user = await User.findByPk(decoded.id, {
        attributes: { exclude: ["password"] },
      });

      if (!user) return res.status(404).json({ error: "User not found" });

      return res.status(200).json(user);
    } catch (error) {
      console.error("❌ Error fetching user profile:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });
});

router.delete("/users/:id", async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      include: { model: UserDevice, as: "devices" },
    });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    await user.destroy();
    return res.status(200).json({ message: "تم حذف المستخدم وأجهزته بنجاح" });
  } catch (err) {
    console.error("❌ خطأ أثناء الحذف:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء عملية الحذف" });
  }
});

router.get("/drivers/pending", requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: drivers } = await User.findAndCountAll({
      where: { role: "driver", status: "pending" },
      limit,
      offset,
      order: [["createdAt", "ASC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      drivers,
      pagination: {
        totalDrivers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching pending drivers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/drivers/:id/activate", requireAdmin, async (req, res) => {
  try {
    const driverId = Number(req.params.id);

    const driver = await User.findByPk(driverId);
    if (!driver) return res.status(404).json({ error: "السائق غير موجود" });

    if (driver.role !== "driver") {
      return res.status(400).json({ error: "هذا المستخدم ليس سائق" });
    }

    if (driver.status === "active") {
      return res.status(200).json({ message: "السائق مفعل مسبقًا", driver: safeUser(driver) });
    }

    driver.status = "active";
    await driver.save();

    return res.status(200).json({
      message: "تم تفعيل السائق بنجاح",
      driver: safeUser(driver),
    });
  } catch (err) {
    console.error("❌ Error activating driver:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/users/:id/status", requireAdmin, upload.none(), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { status } = req.body;
    if (!["active", "blocked", "pending"].includes(status)) {
      return res.status(400).json({ error: "status غير صحيح (active | blocked | pending)" });
    }
    const target = await User.findByPk(userId);
    if (!target) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (target.role === "admin") {
      return res.status(403).json({ error: "لا يمكن تغيير حالة الأدمن" });
    }
    if (req.user && req.user.id === target.id) {
      return res.status(403).json({ error: "لا يمكنك تغيير حالتك أنت" });
    }
    target.status = status;
    await target.save();
    return res.status(200).json({
      message: "تم تحديث حالة المستخدم بنجاح",
      user: safeUser(target),
    });
  } catch (err) {
    console.error("❌ Error updating user status:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


module.exports = router;
module.exports.requireAdmin = requireAdmin;