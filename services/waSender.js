const axios = require("axios");

const WA_BASE_URL = process.env.WA_BASE_URL; // من صفحة App Details (Base URL)
const WA_API_KEY  = process.env.WA_API_KEY;  // API key

async function sendWhatsAppText(toPhoneE164NoPlus, message) {
  // ملاحظة: بعض المنصات تحتاج header "X-API-KEY" أو Authorization Bearer
  // من صفحتك مكتوب "Authorization: API key ..." لذلك نخليها Bearer/ApiKey حسب المطلوب.
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
