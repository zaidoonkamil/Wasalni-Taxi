const axios = require("axios");

const WA_BASE_URL = process.env.WA_BASE_URL;
const WA_API_KEY  = process.env.WA_API_KEY;

async function sendWhatsAppText(toPhoneE164NoPlus, message) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${WA_API_KEY}`,
  };

  const payload = {
    to: toPhoneE164NoPlus,
    message: message,
  };

  const { data } = await axios.post(`${WA_BASE_URL}/messages`, payload, { headers });
  return data;
}

module.exports = { sendWhatsAppText };
