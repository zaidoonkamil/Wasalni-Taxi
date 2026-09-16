require("dotenv").config({ override: true });

const axios = require("axios");

const baseUrl = (process.env.OTPIQ_BASE_URL || "https://api.otpiq.com/api").replace(/\/+$/, "");
const apiKey = String(process.env.OTPIQ_TEST_API_KEY || process.env.OTPIQ_API_KEY || "")
  .trim()
  .replace(/^['"]|['"]$/g, "");
const provider = process.env.OTPIQ_TEST_PROVIDER || process.env.OTPIQ_PROVIDER || "whatsapp";
const phone = String(process.argv[2] || "").replace(/\D/g, "");
const code = String(process.argv[3] || "123456");

function printKeyInfo() {
  console.log("OTPIQ key:", apiKey ? `${apiKey.slice(0, 8)}... length=${apiKey.length}` : "missing");
  console.log("OTPIQ base:", baseUrl);
  console.log("OTPIQ provider:", provider);
}

async function main() {
  printKeyInfo();

  if (!apiKey) {
    console.error("Missing OTPIQ_API_KEY in .env");
    process.exitCode = 1;
    return;
  }

  try {
    const info = await axios.get(`${baseUrl}/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: Number(process.env.OTPIQ_TIMEOUT_MS || 15000),
    });
    console.log("Project info OK:", {
      projectName: info.data?.projectName,
      credit: info.data?.credit,
    });
  } catch (error) {
    console.error("Project info failed:", {
      status: error.response?.status,
      data: error.response?.data || error.message,
    });
    process.exitCode = 1;
    return;
  }

  try {
    const resources = await axios.get(`${baseUrl}/whatsapp/resources`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: Number(process.env.OTPIQ_TIMEOUT_MS || 15000),
    });
    const accounts = [];
    for (const business of resources.data?.data?.businesses || []) {
      for (const account of business.whatsappAccounts || []) {
        for (const number of account.phoneNumbers || []) {
          accounts.push({
            accountIdForEnv: account.id,
            metaWabaId: account.whatsappBusinessId,
            phoneIdForEnv: number.id,
            metaPhoneNumberId: number.phoneNumberId,
            displayPhoneNumber: number.displayPhoneNumber,
            status: number.status,
            nameStatus: number.nameStatus,
            qualityRating: number.qualityRating,
          });
        }
      }
    }
    console.log("WhatsApp resources:", accounts);
  } catch (error) {
    console.log("WhatsApp resources skipped/failed:", {
      status: error.response?.status,
      data: error.response?.data || error.message,
    });
  }

  if (!phone) {
    console.log("No phone passed, send test skipped.");
    console.log("Usage: node scripts/test-otpiq.js 9647XXXXXXXX 123456");
    return;
  }

  try {
    const payload = {
      phoneNumber: phone,
      smsType: "verification",
      verificationCode: code,
      provider,
    };

    if (process.env.OTPIQ_WHATSAPP_ACCOUNT_ID) {
      payload.whatsappAccountId = process.env.OTPIQ_WHATSAPP_ACCOUNT_ID;
    }
    if (process.env.OTPIQ_WHATSAPP_PHONE_ID) {
      payload.whatsappPhoneId = process.env.OTPIQ_WHATSAPP_PHONE_ID;
    }
    if (process.env.OTPIQ_TEMPLATE_NAME) {
      payload.templateName = process.env.OTPIQ_TEMPLATE_NAME;
    }
    if (process.env.OTPIQ_SENDER_ID) {
      payload.senderId = process.env.OTPIQ_SENDER_ID;
    }

    const sent = await axios.post(`${baseUrl}/sms`, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: Number(process.env.OTPIQ_TIMEOUT_MS || 15000),
    });

    console.log("Send OK:", {
      smsId: sent.data?.smsId,
      cost: sent.data?.cost,
      remainingCredit: sent.data?.remainingCredit,
      message: sent.data?.message,
    });
  } catch (error) {
    console.error("Send failed:", {
      status: error.response?.status,
      data: error.response?.data || error.message,
    });
    process.exitCode = 1;
  }
}

main();
