const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const P = require("pino");
const {
  DisconnectReason,
  Browsers,
  WAMessageStatus,
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.join(__dirname, "..", ".baileys_auth");
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "wasalni";
const SESSION_DIR = path.join(SESSION_PATH, CLIENT_ID);
const AUTO_INIT = process.env.WHATSAPP_AUTO_INIT !== "false";
const RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 15000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_MAX_RECONNECT_DELAY_MS || 120000);
const READY_WAIT_TIMEOUT_MS = Number(process.env.WHATSAPP_READY_WAIT_TIMEOUT_MS || 20000);
const VERIFY_NUMBER_EXISTS = process.env.WHATSAPP_VERIFY_NUMBER === "true";

let socket = null;
let authState = null;
let saveCreds = null;
let initializingPromise = null;
let latestQrText = null;
let latestQrImage = null;
let latestError = null;
let connectionStatus = "idle";
let authenticated = false;
let connectedNumber = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualLogout = false;
let latestNewChatCap = null;
let latestReachoutTimeLock = null;

const pendingMessages = new Map();
const MESSAGE_STATUS_NAMES = Object.fromEntries(
  Object.entries(WAMessageStatus).map(([name, value]) => [value, name])
);

function ensureSessionPath() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function getReconnectDelay() {
  const delay = RECONNECT_DELAY_MS * Math.max(1, reconnectAttempts);
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

function removeDirectoryIfExists(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_) {}
}

function clearStaleWhatsAppSession() {
  removeDirectoryIfExists(SESSION_DIR);
}

function normalizeDisconnectReason(error) {
  return (
    error?.output?.statusCode ||
    error?.statusCode ||
    error?.data?.statusCode ||
    null
  );
}

function shouldReconnect(error) {
  return normalizeDisconnectReason(error) !== DisconnectReason.loggedOut;
}

function scheduleReconnect(reason = "unknown") {
  if (!AUTO_INIT || manualLogout || initializingPromise || reconnectTimer) {
    return;
  }

  reconnectAttempts += 1;
  const delay = getReconnectDelay();
  connectionStatus = "reconnecting";
  latestError = `Reconnecting after disconnect: ${reason}`;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await initWhatsAppClient();
    } catch (error) {
      latestError = error.message || String(error);
      scheduleReconnect(latestError);
    }
  }, delay);
}

function normalizeWhatsAppPhone(phone = "") {
  let value = String(phone).trim();

  if (!value) {
    throw new Error("Phone number is required");
  }

  value = value.replace(/[^\d+]/g, "");

  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("00")) value = value.slice(2);
  if (value.startsWith("0")) value = `964${value.slice(1)}`;

  if (!/^\d{8,15}$/.test(value)) {
    throw new Error("Phone number format is invalid");
  }

  return value;
}

function getStatus() {
  return {
    status: connectionStatus,
    authenticated,
    hasQr: Boolean(latestQrImage),
    connectedNumber,
    lastError: latestError,
    newChatCap: latestNewChatCap,
    reachoutTimeLock: latestReachoutTimeLock,
  };
}

function waitForClientReady(timeoutMs = READY_WAIT_TIMEOUT_MS) {
  if (socket && connectionStatus === "ready") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (socket && connectionStatus === "ready") {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("WhatsApp client is not ready yet. Wait a few seconds and try again."));
      }
    }, 500);
  });
}

async function buildQrImage(qrText) {
  latestQrText = qrText;
  latestQrImage = await qrcode.toDataURL(qrText);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

async function refreshWhatsAppSendLimits(instance) {
  try {
    latestNewChatCap = await instance.fetchNewChatMessageCap?.();
    if (latestNewChatCap) {
      console.info(`WhatsApp new chat cap: ${safeJson(latestNewChatCap)}`);
    }
  } catch (error) {
    console.warn(`WhatsApp new chat cap check failed: ${error.message || error}`);
  }

  try {
    latestReachoutTimeLock = await instance.fetchAccountReachoutTimelock?.();
    if (latestReachoutTimeLock) {
      console.info(`WhatsApp reachout timelock: ${safeJson(latestReachoutTimeLock)}`);
    }
  } catch (error) {
    console.warn(`WhatsApp reachout timelock check failed: ${error.message || error}`);
  }
}

function bindSocketEvents(instance) {
  instance.ev.on("creds.update", saveCreds);

  instance.ev.on("messages.update", (updates) => {
    for (const update of updates || []) {
      const messageId = update?.key?.id;
      if (!messageId) continue;

      const meta = pendingMessages.get(messageId);
      if (!meta) continue;

      const status = update.update?.status;
      const statusName = MESSAGE_STATUS_NAMES[status] || status || "unknown";
      const error = update.update?.error || update.update?.messageStubParameters;
      const line = `WhatsApp message update for ${meta.phone} via ${meta.chatId}: ${messageId} status=${statusName}`;

      if (error || status === WAMessageStatus.ERROR) {
        console.warn(`${line} error=${safeJson(error || update.update)}`);
      } else {
        console.info(line);
      }

      if (
        status === WAMessageStatus.ERROR ||
        status === WAMessageStatus.DELIVERY_ACK ||
        status === WAMessageStatus.READ ||
        status === WAMessageStatus.PLAYED
      ) {
        pendingMessages.delete(messageId);
      }
    }
  });

  instance.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      clearReconnectTimer();
      connectionStatus = "qr_ready";
      latestError = null;
      connectedNumber = null;
      authenticated = false;

      try {
        await buildQrImage(qr);
      } catch (error) {
        latestError = `QR generation failed: ${error.message}`;
      }
    }

    if (connection === "connecting") {
      connectionStatus = "connecting";
      latestError = null;
    }

    if (connection === "open") {
      clearReconnectTimer();
      reconnectAttempts = 0;
      connectionStatus = "ready";
      authenticated = true;
      latestQrText = null;
      latestQrImage = null;
      latestError = null;

      try {
        connectedNumber = instance.user?.id?.split(":")[0] || null;
      } catch (_) {
        connectedNumber = null;
      }

      refreshWhatsAppSendLimits(instance);
    }

    if (connection === "close") {
      authenticated = false;
      socket = null;
      initializingPromise = null;
      latestQrText = null;
      latestQrImage = null;
      connectedNumber = null;

      const error = lastDisconnect?.error;
      const reasonCode = normalizeDisconnectReason(error);
      const reason = error?.message || `disconnect:${reasonCode || "unknown"}`;
      latestError = reason;

      if (shouldReconnect(error) && !manualLogout) {
        connectionStatus = "disconnected";
        scheduleReconnect(reason);
      } else {
        connectionStatus = "logged_out";
        clearStaleWhatsAppSession();
      }
    }
  });
}

async function buildSocket() {
  ensureSessionPath();
  const auth = await useMultiFileAuthState(SESSION_DIR);
  authState = auth.state;
  saveCreds = auth.saveCreds;

  const { version } = await fetchLatestBaileysVersion();
  const instance = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    browser: Browsers.macOS("Wasalni"),
    logger: P({ level: process.env.WHATSAPP_LOG_LEVEL || "silent" }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  bindSocketEvents(instance);
  return instance;
}

async function initWhatsAppClient() {
  if (socket) {
    return getStatus();
  }

  if (initializingPromise) {
    await initializingPromise;
    return getStatus();
  }

  connectionStatus = "initializing";
  latestError = null;
  manualLogout = false;
  clearReconnectTimer();

  initializingPromise = buildSocket()
    .then((instance) => {
      socket = instance;
      return getStatus();
    })
    .catch((error) => {
      latestError = error.message || String(error);
      connectionStatus = "failed";
      socket = null;
      scheduleReconnect(latestError);
      throw error;
    })
    .finally(() => {
      initializingPromise = null;
    });

  await initializingPromise;
  return getStatus();
}

async function ensureClientReady() {
  if (!socket && AUTO_INIT && !initializingPromise) {
    try {
      await initWhatsAppClient();
    } catch (_) {}
  }

  if (socket && connectionStatus === "ready") {
    return;
  }

  await waitForClientReady();

  if (!socket || connectionStatus !== "ready") {
    throw new Error("WhatsApp client is not ready yet. Wait a few seconds and try again.");
  }
}

async function ensureWhatsAppReady() {
  try {
    await ensureClientReady();
    return getStatus();
  } catch (error) {
    if (connectionStatus === "qr_ready") {
      throw new Error("WhatsApp is not connected yet. Please scan the QR code from admin settings first.");
    }

    if (connectionStatus === "logged_out") {
      throw new Error("WhatsApp is logged out. Please reconnect WhatsApp from admin settings.");
    }

    throw error;
  }
}

async function getQrCode() {
  if (!socket && !initializingPromise) {
    await initWhatsAppClient();
  }

  return {
    status: connectionStatus,
    qrText: latestQrText,
    qrImage: latestQrImage,
  };
}

async function logoutWhatsApp() {
  manualLogout = true;
  clearReconnectTimer();

  if (socket) {
    try {
      await socket.logout();
    } catch (_) {}
    try {
      socket.end?.();
    } catch (_) {}
  }

  socket = null;
  initializingPromise = null;
  authState = null;
  saveCreds = null;
  latestQrText = null;
  latestQrImage = null;
  latestError = null;
  connectionStatus = "idle";
  authenticated = false;
  connectedNumber = null;
  clearStaleWhatsAppSession();

  return { success: true, status: connectionStatus };
}

function startWhatsAppAutoInit() {
  if (!AUTO_INIT) {
    return;
  }

  scheduleReconnect("server_boot");
}

function getErrorMessage(error) {
  return error?.message || error?.output?.payload?.message || String(error);
}

function addUniqueChatId(list, jid) {
  if (!jid || list.includes(jid)) return;
  list.push(jid);
}

async function getOnWhatsAppJids(normalizedPhone, directJid) {
  const found = [];
  const queries = [directJid, normalizedPhone];

  for (const query of queries) {
    try {
      const result = await socket.onWhatsApp(query);

      for (const item of result || []) {
        if (item?.exists) {
          addUniqueChatId(found, item.jid || directJid);
          addUniqueChatId(found, item.lid);
        }
      }
    } catch (_) {}
  }

  return found;
}

async function resolveChatIds(phone) {
  await ensureClientReady();

  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const directJid = `${normalizedPhone}@s.whatsapp.net`;
  const chatIds = [];
  const checkedJids = await getOnWhatsAppJids(normalizedPhone, directJid);

  for (const jid of checkedJids) {
    addUniqueChatId(chatIds, jid);
  }

  if (VERIFY_NUMBER_EXISTS && chatIds.length === 0) {
    throw new Error("This number does not appear to have WhatsApp");
  }

  addUniqueChatId(chatIds, directJid);

  return {
    phone: normalizedPhone,
    chatIds,
  };
}

async function sendWhatsAppText(phone, message) {
  if (!message || !String(message).trim()) {
    throw new Error("Message is required");
  }

  const { phone: normalizedPhone, chatIds } = await resolveChatIds(phone);
  let lastError = null;

  for (const chatId of chatIds) {
    try {
      const sentMessage = await socket.sendMessage(chatId, {
        text: String(message).trim(),
      });
      const messageId = sentMessage?.key?.id || null;
      const status = chatId === chatIds[0] ? "sent" : "sent_after_jid_fallback";

      if (messageId) {
        pendingMessages.set(messageId, {
          phone: normalizedPhone,
          chatId,
          createdAt: Date.now(),
        });
      }

      console.info(`WhatsApp send success for ${normalizedPhone} via ${chatId}: ${messageId || "no_message_id"}`);

      return {
        to: normalizedPhone,
        chatId,
        messageId,
        timestamp: sentMessage?.messageTimestamp || null,
        status,
      };
    } catch (error) {
      lastError = error;
      latestError = `WhatsApp send failed for ${normalizedPhone} via ${chatId}: ${getErrorMessage(error)}`;
      console.warn(latestError);
    }
  }

  throw new Error(`WhatsApp send failed for ${normalizedPhone}: ${getErrorMessage(lastError)}`);
}

module.exports = {
  ensureWhatsAppReady,
  getQrCode,
  getStatus,
  initWhatsAppClient,
  logoutWhatsApp,
  normalizeWhatsAppPhone,
  sendWhatsAppText,
  startWhatsAppAutoInit,
};
