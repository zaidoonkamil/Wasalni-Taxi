const crypto = require("crypto");
const { Op } = require("sequelize");
const { OtpCode, PasswordResetOtp } = require("../models");

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);
const OTP_RESEND_MS = Number(process.env.OTP_RESEND_MS || 60 * 1000);
const OTP_ATTEMPTS = Number(process.env.OTP_ATTEMPTS || 5);

const OTP_PURPOSES = {
  verifyAccount: "verify_account",
  passwordReset: "password_reset",
};

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function normalizePhone(phone = "") {
  const raw = String(phone).trim();

  if (raw.startsWith("964") && raw.length === 13) {
    return raw;
  }

  if (raw.startsWith("0") && raw.length === 11) {
    return `964${raw.slice(1)}`;
  }

  if (raw.length === 10) {
    return `964${raw}`;
  }

  return raw;
}

function resolveStore(purpose) {
  return purpose === OTP_PURPOSES.passwordReset ? PasswordResetOtp : OtpCode;
}

async function createOtp(phone, purpose = OTP_PURPOSES.verifyAccount) {
  const normalizedPhone = normalizePhone(phone);
  const Store = resolveStore(purpose);
  const now = new Date();

  const latestOtp = await Store.findOne({
    where: {
      phone: normalizedPhone,
      consumedAt: null,
      expiresAt: {
        [Op.gt]: now,
      },
    },
    order: [["createdAt", "DESC"]],
  });

  if (latestOtp) {
    const nextAllowedAt = latestOtp.createdAt.getTime() + OTP_RESEND_MS;
    if (nextAllowedAt > Date.now()) {
      const waitSeconds = Math.ceil((nextAllowedAt - Date.now()) / 1000);
      throw new Error(`يرجى الانتظار ${waitSeconds} ثانية قبل إعادة الإرسال`);
    }
  }

  await Store.update(
    { consumedAt: now },
    {
      where: {
        phone: normalizedPhone,
        consumedAt: null,
      },
    }
  );

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const payload = {
    phone: normalizedPhone,
    codeHash: hashOtp(code),
    expiresAt,
    attemptsLeft: OTP_ATTEMPTS,
    consumedAt: null,
  };

  if (Store === OtpCode) {
    payload.purpose = OTP_PURPOSES.verifyAccount;
  }

  await Store.create(payload);

  return {
    phone: normalizedPhone,
    code,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    retryAfterSeconds: Math.floor(OTP_RESEND_MS / 1000),
    purpose,
  };
}

async function verifyOtp(phone, code, purpose = OTP_PURPOSES.verifyAccount) {
  const normalizedPhone = normalizePhone(phone);
  const Store = resolveStore(purpose);
  const where = {
    phone: normalizedPhone,
    consumedAt: null,
  };

  if (Store === OtpCode) {
    where.purpose = OTP_PURPOSES.verifyAccount;
  }

  const otpRow = await Store.findOne({
    where,
    order: [["createdAt", "DESC"]],
  });

  if (!otpRow) {
    throw new Error("لا يوجد رمز فعال");
  }

  if (new Date() > new Date(otpRow.expiresAt)) {
    throw new Error("انتهت صلاحية الرمز");
  }

  if (otpRow.attemptsLeft <= 0) {
    throw new Error("تم تجاوز عدد المحاولات");
  }

  const inputHash = hashOtp(code);
  if (inputHash !== otpRow.codeHash) {
    otpRow.attemptsLeft -= 1;
    await otpRow.save();
    throw new Error("رمز غير صحيح");
  }

  otpRow.consumedAt = new Date();
  await otpRow.save();

  return {
    phone: normalizedPhone,
    verified: true,
    purpose,
  };
}

module.exports = {
  OTP_PURPOSES,
  createOtp,
  normalizePhone,
  verifyOtp,
};
