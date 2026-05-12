const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.join(__dirname, "..", ".wwebjs_auth");
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "wasalni";
const AUTO_INIT = process.env.WHATSAPP_AUTO_INIT === "true";
const RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 15000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_MAX_RECONNECT_DELAY_MS || 120000);
// Set to "false" to keep expired session files (not recommended)
const CLEAR_EXPIRED_SESSION = process.env.WHATSAPP_CLEAR_EXPIRED_SESSION !== "false";

// WhatsApp disconnect reasons that mean the session is permanently invalid.
// NAVIGATION  = user logged out from phone
// CONFLICT    = user logged in from another browser/device
// UNLAUNCHED  = session was never properly started
// DEPRECATED_VERSION = client version rejected by WhatsApp
const EXPIRED_SESSION_REASONS = new Set([
  "NAVIGATION",
  "CONFLICT",
  "UNLAUNCHED",
  "DEPRECATED_VERSION",
]);

let client = null;
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

function resetRuntimeState() {
  latestQrText = null;
  latestQrImage = null;
  connectedNumber = null;
  authenticated = false;
}

function isProfileLockError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("profile appears to be in use") ||
    message.includes("chromium has locked the profile") ||
    message.includes("failed to launch the browser process") ||
    message.includes("already running")
  );
}

function dropClientReference(reason = "client_reset") {
  latestError = reason;
  connectionStatus = "disconnected";
  client = null;
  initializingPromise = null;
  resetRuntimeState();
}

function isRecoverableSessionError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("detached frame") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("target closed") ||
    message.includes("session closed") ||
    message.includes("protocol error")
  );
}

async function destroyClientSilently(instance) {
  if (!instance) return;
  try {
    await Promise.race([
      instance.destroy(),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  } catch (_) {}
}

function ensureSessionPath() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function getSessionSearchTokens() {
  const normalized = SESSION_PATH.replace(/\\/g, "/");
  const authDirName = path.basename(SESSION_PATH);
  const clientDirName = `session-${CLIENT_ID}`;
  return [normalized, authDirName, clientDirName].filter(Boolean);
}

function killChromiumProcessesForSession() {
  if (process.platform === "win32") return;

  const tokens = getSessionSearchTokens();
  for (const token of tokens) {
    try {
      execSync(`pkill -f "${token}"`, { stdio: "ignore" });
    } catch (_) {}
  }
  try {
    execSync(`pkill -f "chrome.*${CLIENT_ID}"`, { stdio: "ignore" });
  } catch (_) {}
  try {
    execSync(`pkill -f "chromium.*${CLIENT_ID}"`, { stdio: "ignore" });
  } catch (_) {}
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true, recursive: true });
  } catch (_) {}
}

function getClientSessionDirectory() {
  return path.join(SESSION_PATH, `session-${CLIENT_ID}`);
}

function removeDirectoryIfExists(dirPath) {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

function clearStaleWhatsAppSession() {
  removeDirectoryIfExists(getClientSessionDirectory());
}

function clearChromiumProfileLocks(rootDir) {
  if (!fs.existsSync(rootDir)) return;

  const lockNames = new Set([
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    ".com.google.Chrome",
  ]);

  const walk = (currentDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const matchesWildcard = entry.name.startsWith(".org.chromium.Chromium.");
      if (lockNames.has(entry.name) || matchesWildcard) {
        removeFileIfExists(fullPath);
      }
    }
  };

  walk(rootDir);
}

// Deletes the entire session profile so the next reconnect forces a fresh QR scan.
// Called when auth_failure fires or when WhatsApp signals a permanent disconnection.
function clearExpiredSessionFiles() {
  clearChromiumProfileLocks(SESSION_PATH);
  clearStaleWhatsAppSession();
  console.log(`[WhatsApp] Expired session cleared for client "${CLIENT_ID}" — next start will request a new QR scan`);
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

function bindClientEvents(instance) {
  instance.on("qr", async (qrText) => {
    clearReconnectTimer();
    connectionStatus = "qr_ready";
    latestError = null;
    connectedNumber = null;
    authenticated = false;

    try {
      await buildQrImage(qrText);
    } catch (error) {
      latestError = `QR generation failed: ${error.message}`;
    }
  });

  instance.on("authenticated", () => {
    clearReconnectTimer();
    reconnectAttempts = 0;
    authenticated = true;
    latestError = null;
    connectionStatus = "authenticated";
  });

  instance.on("ready", async () => {
    clearReconnectTimer();
    reconnectAttempts = 0;
    connectionStatus = "ready";
    latestQrText = null;
    latestQrImage = null;
    latestError = null;

    try {
      const wid = instance.info?.wid?._serialized || "";
      connectedNumber = wid.replace("@c.us", "") || null;
    } catch (_) {
      connectedNumber = null;
    }
  });

  // auth_failure means the saved session is rejected by WhatsApp (expired/revoked).
  // Destroy the browser and wipe session files so the next attempt starts with a fresh QR.
  instance.on("auth_failure", async (message) => {
    clearReconnectTimer();
    authenticated = false;
    connectionStatus = "auth_failure";
    latestError = message || "Authentication failed — session expired";

    const staleClient = client;
    client = null;
    initializingPromise = null;
    resetRuntimeState();

    await destroyClientSilently(staleClient);

    if (CLEAR_EXPIRED_SESSION) {
      clearExpiredSessionFiles();
    }

    if (!manualLogout && !isShuttingDown && AUTO_INIT) {
      scheduleReconnect("auth_failure_session_cleared");
    }
  });

  // disconnected fires for temporary network drops AND for permanent logouts.
  // For permanent reasons (NAVIGATION, CONFLICT, etc.) wipe the session so we get a fresh QR.
  instance.on("disconnected", async (reason) => {
    const staleClient = client;
    dropClientReference(reason || "Client disconnected");

    // Destroy the browser process before scheduling reconnect —
    // otherwise the new browser launch fails with "already running".
    await destroyClientSilently(staleClient);

    if (CLEAR_EXPIRED_SESSION && EXPIRED_SESSION_REASONS.has(reason)) {
      clearExpiredSessionFiles();
    } else {
      // Always remove lock files even for temporary disconnects
      clearChromiumProfileLocks(SESSION_PATH);
    }

    if (!manualLogout && !isShuttingDown) {
      scheduleReconnect(reason || "Client disconnected");
    }
  });
}

async function initWhatsAppClient() {
  if (client) return getStatus();

  if (initializingPromise) {
    await initializingPromise;
    return getStatus();
  }

  connectionStatus = "initializing";
  latestError = null;
  manualLogout = false;
  clearReconnectTimer();
  ensureSessionPath();

  // Kill stale processes and remove lock files before every browser launch
  killChromiumProcessesForSession();
  clearChromiumProfileLocks(SESSION_PATH);

  const buildClient = () =>
    new Client({
      authStrategy: new LocalAuth({
        clientId: CLIENT_ID,
        dataPath: SESSION_PATH,
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      },
    });

  client = buildClient();
  bindClientEvents(client);

  initializingPromise = client
    .initialize()
    .catch(async (error) => {
      if (isProfileLockError(error)) {
        killChromiumProcessesForSession();
        clearChromiumProfileLocks(SESSION_PATH);
        clearStaleWhatsAppSession();
      }
      latestError = error.message;
      connectionStatus = "failed";

      const failedClient = client;
      client = null;
      await destroyClientSilently(failedClient);

      if (!manualLogout && !isShuttingDown) {
        scheduleReconnect(error.message);
      }
      throw error;
    })
    .finally(() => {
      initializingPromise = null;
    });

  try {
    await initializingPromise;
  } catch (error) {
    // If a profile lock error, retry once after cleanup
    if (!isProfileLockError(error)) throw error;

    killChromiumProcessesForSession();
    clearChromiumProfileLocks(SESSION_PATH);
    clearStaleWhatsAppSession();
    connectionStatus = "initializing";
    latestError = "Retrying after clearing Chromium locks and stale session";

    client = buildClient();
    bindClientEvents(client);

    initializingPromise = client
      .initialize()
      .catch(async (retryError) => {
        latestError = retryError.message;
        connectionStatus = "failed";

        const failedClient = client;
        client = null;
        await destroyClientSilently(failedClient);

        if (!manualLogout && !isShuttingDown) {
          scheduleReconnect(retryError.message);
        }
        throw retryError;
      })
      .finally(() => {
        initializingPromise = null;
      });

    await initializingPromise;
  }

  return getStatus();
}

async function recoverClientFromRuntimeError(error) {
  const failingClient = client;
  clearReconnectTimer();
  dropClientReference(error?.message || "recoverable_runtime_error");
  await destroyClientSilently(failingClient);
  clearChromiumProfileLocks(SESSION_PATH);
  return initWhatsAppClient();
}

function ensureClientReady() {
  if (!client || connectionStatus !== "ready") {
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

  if (!client) {
    connectionStatus = "idle";
    resetRuntimeState();
    return { success: true, status: connectionStatus };
  }

  const activeClient = client;
  client = null;
  initializingPromise = null;

  try {
    await activeClient.logout();
  } catch (_) {}

  await destroyClientSilently(activeClient);
  clearChromiumProfileLocks(SESSION_PATH);
  clearStaleWhatsAppSession();

  latestError = null;
  connectionStatus = "idle";
  resetRuntimeState();

  return { success: true, status: connectionStatus };
}

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearReconnectTimer();

  const activeClient = client;
  client = null;

  await destroyClientSilently(activeClient);
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

  // Remove stale lock files before the very first launch
  killChromiumProcessesForSession();
  clearChromiumProfileLocks(SESSION_PATH);
  scheduleReconnect("server_boot");
}

async function resolveChatId(phone) {
  ensureClientReady();

  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const numberId = await client.getNumberId(normalizedPhone);

  if (!numberId?._serialized) {
    throw new Error("This number does not appear to have WhatsApp");
  }

  return { phone: normalizedPhone, chatId: numberId._serialized };
}

async function sendWhatsAppText(phone, message) {
  if (!message || !String(message).trim()) {
    throw new Error("Message is required");
  }

  try {
    const { phone: normalizedPhone, chatId } = await resolveChatId(phone);
    const sentMessage = await client.sendMessage(chatId, String(message).trim());

    return {
      to: normalizedPhone,
      messageId: sentMessage?.id?._serialized || null,
      timestamp: sentMessage?.timestamp || null,
      status: "sent",
    };
  } catch (error) {
    if (!isRecoverableSessionError(error)) throw error;

    latestError = `Recovered from runtime error: ${error.message || error}`;
    await recoverClientFromRuntimeError(error);

    const { phone: normalizedPhone, chatId } = await resolveChatId(phone);
    const sentMessage = await client.sendMessage(chatId, String(message).trim());

    return {
      to: normalizedPhone,
      messageId: sentMessage?.id?._serialized || null,
      timestamp: sentMessage?.timestamp || null,
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
