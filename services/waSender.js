const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const P = require("pino");
const baileys = require("@whiskeysockets/baileys");

const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} = baileys;

const makeWASocket = baileys.default;

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.join(__dirname, "..", ".baileys_auth");
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "wasalni";
const AUTO_INIT = process.env.WHATSAPP_AUTO_INIT === "true";
const RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 15000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_MAX_RECONNECT_DELAY_MS || 120000);
const CLEAR_EXPIRED_SESSION = process.env.WHATSAPP_CLEAR_EXPIRED_SESSION !== "false";

const logger = P({ level: process.env.WHATSAPP_LOG_LEVEL || "silent" });

let socket = null;
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
let isShuttingDown = false;
let saveCredsHandler = null;

function resetRuntimeState() {
  latestQrText = null;
  latestQrImage = null;
  connectedNumber = null;
  authenticated = false;
}

function ensureSessionPath() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function removeDirectoryIfExists(dirPath) {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

function clearSessionFiles() {
  removeDirectoryIfExists(SESSION_PATH);
  console.log(`[WhatsApp] Baileys session cleared for client "${CLIENT_ID}"`);
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

function scheduleReconnect(reason = "unknown") {
  if (!AUTO_INIT || manualLogout || isShuttingDown || reconnectTimer || initializingPromise) {
    return;
  }

  reconnectAttempts += 1;
  const delay = getReconnectDelay();
  connectionStatus = "reconnecting";
  latestError = `Reconnecting after disconnect: ${reason}`;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (isShuttingDown || manualLogout) return;

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
  if (!value) throw new Error("Phone number is required");

  value = value.replace(/[^\d+]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("00")) value = value.slice(2);
  if (value.startsWith("0")) value = `964${value.slice(1)}`;

  if (!/^\d{8,15}$/.test(value)) throw new Error("Phone number format is invalid");
  return value;
}

function getStatus() {
  return {
    status: connectionStatus,
    authenticated,
    hasQr: Boolean(latestQrImage),
    connectedNumber,
    lastError: latestError,
  };
}

async function buildQrImage(qrText) {
  latestQrText = qrText;
  latestQrImage = await qrcode.toDataURL(qrText);
}

function getDisconnectCode(lastDisconnect) {
  return lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || null;
}

function getDisconnectReason(lastDisconnect) {
  const code = getDisconnectCode(lastDisconnect);
  const message = lastDisconnect?.error?.message || lastDisconnect?.error?.toString?.() || "connection closed";
  return code ? `${message} (${code})` : message;
}

function isLoggedOutDisconnect(lastDisconnect) {
  return getDisconnectCode(lastDisconnect) === DisconnectReason.loggedOut;
}

async function closeSocketSilently(instance) {
  if (!instance) return;
  try {
    instance.ev?.removeAllListeners?.();
  } catch (_) {}
  try {
    instance.ws?.close?.();
  } catch (_) {}
  try {
    instance.end?.();
  } catch (_) {}
}

function dropSocketReference(reason = "socket_reset") {
  latestError = reason;
  connectionStatus = "disconnected";
  socket = null;
  initializingPromise = null;
  saveCredsHandler = null;
  resetRuntimeState();
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    clearReconnectTimer();
    connectionStatus = "qr_ready";
    latestError = null;
    authenticated = false;
    connectedNumber = null;

    try {
      await buildQrImage(qr);
    } catch (error) {
      latestError = `QR generation failed: ${error.message}`;
    }
  }

  if (connection === "connecting") {
    connectionStatus = latestQrImage ? "qr_ready" : "connecting";
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
      const jid = socket?.user?.id || socket?.user?.jid || "";
      connectedNumber = String(jid).split(":")[0].replace("@s.whatsapp.net", "") || null;
    } catch (_) {
      connectedNumber = null;
    }
  }

  if (connection === "close") {
    const reason = getDisconnectReason(lastDisconnect);
    const shouldClearSession = CLEAR_EXPIRED_SESSION && isLoggedOutDisconnect(lastDisconnect);
    const staleSocket = socket;

    dropSocketReference(reason);
    await closeSocketSilently(staleSocket);

    if (shouldClearSession) {
      clearSessionFiles();
      connectionStatus = "auth_failure";
    }

    if (!manualLogout && !isShuttingDown && !shouldClearSession) {
      scheduleReconnect(reason);
    }
  }
}

async function initWhatsAppClient() {
  if (socket) return getStatus();

  if (initializingPromise) {
    await initializingPromise;
    return getStatus();
  }

  connectionStatus = "initializing";
  latestError = null;
  manualLogout = false;
  clearReconnectTimer();
  ensureSessionPath();

  initializingPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    saveCredsHandler = saveCreds;
    socket = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: [CLIENT_ID, "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });

    socket.ev.on("creds.update", saveCredsHandler);
    socket.ev.on("connection.update", handleConnectionUpdate);
  })()
    .catch(async (error) => {
      latestError = error.message || String(error);
      connectionStatus = "failed";

      const failedSocket = socket;
      socket = null;
      saveCredsHandler = null;
      await closeSocketSilently(failedSocket);

      if (!manualLogout && !isShuttingDown) {
        scheduleReconnect(latestError);
      }

      throw error;
    })
    .finally(() => {
      initializingPromise = null;
    });

  await initializingPromise;
  return getStatus();
}

async function recoverClientFromRuntimeError(error) {
  const failingSocket = socket;
  clearReconnectTimer();
  dropSocketReference(error?.message || "recoverable_runtime_error");
  await closeSocketSilently(failingSocket);
  return initWhatsAppClient();
}

function ensureClientReady() {
  if (!socket || connectionStatus !== "ready") {
    throw new Error("WhatsApp client is not ready. Scan QR and wait until status becomes ready.");
  }
}

async function getQrCode() {
  return {
    status: connectionStatus,
    qrText: latestQrText,
    qrImage: latestQrImage,
  };
}

async function logoutWhatsApp() {
  manualLogout = true;
  clearReconnectTimer();

  const activeSocket = socket;
  socket = null;
  initializingPromise = null;
  saveCredsHandler = null;

  if (activeSocket) {
    try {
      await activeSocket.logout();
    } catch (_) {}
    await closeSocketSilently(activeSocket);
  }

  clearSessionFiles();

  latestError = null;
  connectionStatus = "idle";
  resetRuntimeState();

  return { success: true, status: connectionStatus };
}

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearReconnectTimer();

  const activeSocket = socket;
  socket = null;
  saveCredsHandler = null;

  await closeSocketSilently(activeSocket);
}

process.once("SIGTERM", async () => {
  await gracefulShutdown();
  process.exit(0);
});

process.once("SIGINT", async () => {
  await gracefulShutdown();
  process.exit(0);
});

function startWhatsAppAutoInit() {
  if (!AUTO_INIT) return;
  scheduleReconnect("server_boot");
}

async function resolveChatId(phone) {
  ensureClientReady();

  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const chatId = `${normalizedPhone}@s.whatsapp.net`;
  const exists = await socket.onWhatsApp(normalizedPhone);

  if (!exists?.[0]?.exists) {
    throw new Error("This number does not appear to have WhatsApp");
  }

  return { phone: normalizedPhone, chatId };
}

function isRecoverableSessionError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("connection closed") ||
    message.includes("timed out") ||
    message.includes("socket") ||
    message.includes("stream errored") ||
    message.includes("not open")
  );
}

async function sendWhatsAppText(phone, message) {
  if (!message || !String(message).trim()) {
    throw new Error("Message is required");
  }

  try {
    const { phone: normalizedPhone, chatId } = await resolveChatId(phone);
    const sentMessage = await socket.sendMessage(chatId, { text: String(message).trim() });

    return {
      to: normalizedPhone,
      messageId: sentMessage?.key?.id || null,
      timestamp: sentMessage?.messageTimestamp || null,
      status: "sent",
    };
  } catch (error) {
    if (!isRecoverableSessionError(error)) throw error;

    latestError = `Recovered from runtime error: ${error.message || error}`;
    await recoverClientFromRuntimeError(error);

    const { phone: normalizedPhone, chatId } = await resolveChatId(phone);
    const sentMessage = await socket.sendMessage(chatId, { text: String(message).trim() });

    return {
      to: normalizedPhone,
      messageId: sentMessage?.key?.id || null,
      timestamp: sentMessage?.messageTimestamp || null,
      status: "sent_after_recovery",
    };
  }
}

module.exports = {
  getQrCode,
  getStatus,
  initWhatsAppClient,
  logoutWhatsApp,
  normalizeWhatsAppPhone,
  sendWhatsAppText,
  startWhatsAppAutoInit,
};
