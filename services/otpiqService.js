const axios = require("axios");
const { normalizePhone } = require("./phoneUtils");

const OTPIQ_BASE_URL = (process.env.OTPIQ_BASE_URL || "https://api.otpiq.com/api").replace(/\/+$/, "");
const OTPIQ_PROVIDER = "whatsapp";
const OTPIQ_TIMEOUT_MS = Number(process.env.OTPIQ_TIMEOUT_MS || 15000);

function normalizeOtpiqPhone(phone = "") {
  return normalizePhone(phone);
}

function optionalPayloadFields() {
  const fields = {};

  if (process.env.OTPIQ_SENDER_ID) {
    fields.senderId = process.env.OTPIQ_SENDER_ID;
  }

  if (process.env.OTPIQ_WHATSAPP_ACCOUNT_ID) {
    fields.whatsappAccountId = process.env.OTPIQ_WHATSAPP_ACCOUNT_ID;
  }

  if (process.env.OTPIQ_WHATSAPP_PHONE_ID) {
    fields.whatsappPhoneId = process.env.OTPIQ_WHATSAPP_PHONE_ID;
  }

  if (process.env.OTPIQ_TEMPLATE_NAME) {
    fields.templateName = process.env.OTPIQ_TEMPLATE_NAME;
  }

  return fields;
}

function getOtpiqApiKey() {
  const apiKey = String(process.env.OTPIQ_API_KEY || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (!apiKey) {
    throw new Error("OTPIQ_API_KEY is missing in environment variables");
  }
  return apiKey;
}

async function getOtpiqProjectInfo() {
  try {
    const response = await axios.get(`${OTPIQ_BASE_URL}/info`, {
      timeout: OTPIQ_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${getOtpiqApiKey()}`,
      },
    });

    return {
      success: true,
      projectName: response.data?.projectName || null,
      credit: response.data?.credit ?? null,
      raw: response.data,
    };
  } catch (error) {
    const responseError =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message;
    const wrapped = new Error(`OTPIQ status failed: ${responseError}`);
    wrapped.status = error.response?.status || 500;
    throw wrapped;
  }
}

async function sendOtpiqVerificationCode(phone, code) {
  const phoneNumber = normalizeOtpiqPhone(phone);
  if (!phoneNumber) {
    throw new Error("Invalid phone number");
  }

  const payload = {
    phoneNumber,
    smsType: "verification",
    provider: OTPIQ_PROVIDER,
    verificationCode: String(code),
    ...optionalPayloadFields(),
  };

  try {
    const response = await axios.post(`${OTPIQ_BASE_URL}/sms`, payload, {
      timeout: OTPIQ_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${getOtpiqApiKey()}`,
        "Content-Type": "application/json",
      },
    });

    return {
      success: true,
      phone: phoneNumber,
      provider: OTPIQ_PROVIDER,
      smsId: response.data?.smsId || null,
      cost: response.data?.cost ?? null,
      remainingCredit: response.data?.remainingCredit ?? null,
      raw: response.data,
    };
  } catch (error) {
    const responseError =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message;
    throw new Error(`OTPIQ send failed: ${responseError}`);
  }
}

module.exports = {
  getOtpiqProjectInfo,
  normalizeOtpiqPhone,
  sendOtpiqVerificationCode,
};
