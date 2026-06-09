require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const webpush = require("web-push");


const PORT = Number(process.env.PORT || 3000);
const FLOWIX_BASE_URL = (process.env.FLOWIX_BASE_URL || "https://flowix.web.id/api/v1").replace(/\/$/, "");
const FLOWIX_API_KEY = process.env.FLOWIX_API_KEY || "";
const FLOWIX_MERCHANT_ID = process.env.FLOWIX_MERCHANT_ID || "";
const FLOWIX_WEBHOOK_SECRET = process.env.FLOWIX_WEBHOOK_SECRET || "";
const FLOWIX_WEBHOOK_CALLBACK_URL = String(process.env.FLOWIX_WEBHOOK_CALLBACK_URL || "").trim();
const AUTO_REGISTER_FLOWIX_WEBHOOK = parseBoolean(process.env.AUTO_REGISTER_FLOWIX_WEBHOOK, true);
const DEFAULT_FEE_BY_CUSTOMER = true;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_MAX_AGE_DAYS = clampInteger(process.env.ADMIN_SESSION_MAX_AGE_DAYS, 1, 365, 30);
const ADMIN_COOKIE_NAME = "flowix_paylink_admin";
const VAPID_SUBJECT_EMAIL = String(process.env.VAPID_SUBJECT_EMAIL || "").trim();
const INVOICE_POLL_INTERVAL_MS = 8000;
const EXPIRED_SWEEP_INTERVAL_MS = 15000;
const DEPOSIT_METHOD_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INVOICE_AMOUNT = Math.max(1, Math.floor(Number(process.env.MIN_INVOICE_AMOUNT || 1000)));
const MIN_EXPIRED_MINUTES = 5;
const MAX_EXPIRED_MINUTES = 60;
const DEFAULT_EXPIRED_MINUTES = 15;

const dataDir = path.join(__dirname, "..", "data");
const cacheDir = path.join(dataDir, "cache");
const invoicesFile = path.join(dataDir, "invoices.json");
const depositMethodsCacheFile = path.join(cacheDir, "deposit-methods.json");
const vapidKeysFile = path.join(dataDir, "vapid-keys.json");
const pushSubscriptionsFile = path.join(dataDir, "push-subscriptions.json");
let writeQueue = Promise.resolve();
let syncPendingRunning = false;
let expireSweepRunning = false;
let depositMethodRefreshRunning = false;
let vapidRuntimeKeys = null;
let webPushConfigured = false;

function ensureFlowixCredentials() {
  if (!FLOWIX_API_KEY || !FLOWIX_MERCHANT_ID) {
    const error = new Error("Flowix API key and merchant ID are required.");
    error.statusCode = 500;
    throw error;
  }
}

function ensureAdminConfig() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 6) {
    const error = new Error("ADMIN_PASSWORD wajib diisi minimal 6 karakter di .env.");
    error.statusCode = 500;
    throw error;
  }
}

function getAdminSessionSecret() {
  ensureAdminConfig();
  return crypto
    .createHash("sha256")
    .update(`flowix-paylink-admin-session:v2:${ADMIN_USERNAME}:${ADMIN_PASSWORD}`)
    .digest("hex");
}

function getAppUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || (req.secure ? "https" : "http");
  const host = forwardedHost || req.get("host") || `localhost:${PORT}`;
  return `${protocol}://${host}`.replace(/\/$/, "");
}

function getLocalAppUrl() {
  return `http://localhost:${PORT}`;
}


function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getConfiguredFlowixWebhookUrl() {
  const url = normalizeBaseUrl(FLOWIX_WEBHOOK_CALLBACK_URL);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (["your-domain.com", "example.com", "localhost", "127.0.0.1"].includes(host)) return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch (_error) {
    return null;
  }
}

function money(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const clean = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;
  return fallback;
}

function createLocalInvoiceId() {
  return `INV-${Date.now()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

function createDefaultProductName() {
  const categories = [
    "Invoice Layanan Digital",
    "Pembayaran Produk Digital",
    "Tagihan Order Customer",
    "Invoice Transaksi Online",
    "Pembayaran Layanan Premium"
  ];
  const label = categories[crypto.randomInt(0, categories.length)];
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${label} ${code}`;
}

function normalizeStatus(status) {
  const clean = String(status || "pending").toLowerCase();
  if (["success", "paid"].includes(clean)) return "paid";
  if (["failed", "expired", "canceled", "pending"].includes(clean)) return clean;
  return "pending";
}

function cleanDeliveryPayload(payload = {}) {
  const type = String(payload.delivery_type || "none").toLowerCase();
  const text = String(payload.delivery_text || "").trim();
  const fileName = String(payload.delivery_file_name || "").trim().replace(/[\\/<>:"|?*]+/g, "-").slice(0, 120);
  const fileMime = String(payload.delivery_file_mime || "application/octet-stream").trim().slice(0, 120);
  const fileData = String(payload.delivery_file_data || "").trim();

  if (type === "text" && text) {
    return {
      delivery_type: "text",
      delivery_text: text.slice(0, 12000),
      delivery_file_name: null,
      delivery_file_mime: null,
      delivery_file_data: null
    };
  }

  if (type === "file" && fileName && fileData) {
    const base64 = fileData.includes(",") ? fileData.split(",").pop() : fileData;
    if (!/^[A-Za-z0-9+/=]+$/.test(base64) || Buffer.byteLength(base64, "base64") > 2 * 1024 * 1024) {
      const error = new Error("File customer maksimal 2MB dan harus valid base64.");
      error.statusCode = 422;
      throw error;
    }

    return {
      delivery_type: "file",
      delivery_text: null,
      delivery_file_name: fileName || "file-customer",
      delivery_file_mime: fileMime || "application/octet-stream",
      delivery_file_data: base64
    };
  }

  return {
    delivery_type: "none",
    delivery_text: null,
    delivery_file_name: null,
    delivery_file_mime: null,
    delivery_file_data: null
  };
}

function safeDelivery(invoice) {
  const type = String(invoice?.delivery_type || "none").toLowerCase();
  if (normalizeStatus(invoice?.status) !== "paid" || type === "none") {
    return { type: "none" };
  }

  if (type === "text" && invoice.delivery_text) {
    return { type: "text", text: String(invoice.delivery_text) };
  }

  if (type === "file" && invoice.delivery_file_name && invoice.delivery_file_data) {
    return {
      type: "file",
      file_name: invoice.delivery_file_name,
      file_mime: invoice.delivery_file_mime || "application/octet-stream",
      download_url: `/api/invoices/${encodeURIComponent(invoice.id || invoice.reff_id)}/delivery-file`
    };
  }

  return { type: "none" };
}

function parseDateMs(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const raw = String(value).trim().replace(/,$/, "");
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const number = Number(raw);
    if (!Number.isFinite(number)) return null;
    return number > 9999999999 ? number : number * 1000;
  }

  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw);
  const sqlLocalMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (sqlLocalMatch && !hasTimezone) {
    const [, year, month, day, hour, minute, second = "0"] = sqlLocalMatch;
    // Flowix deposit expired_at commonly arrives as SQL datetime without timezone, e.g. 2026-06-10 13:31:35.
    // Treat it as Asia/Jakarta/WIB (+07:00), not server local time, so expiry is consistent on UTC hosting.
    const isoJakarta = `${year}-${month}-${day}T${hour}:${minute}:${second.padStart(2, "0")}+07:00`;
    const jakartaMs = Date.parse(isoJakarta);
    if (Number.isFinite(jakartaMs)) return jakartaMs;
  }

  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function createLocalExpiredAt(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function getInvoiceExpiryMs(invoice) {
  if (!invoice) return null;

  const localExpiredMs = parseDateMs(invoice.local_expired_at);
  if (localExpiredMs) return localExpiredMs;

  const createdMs = parseDateMs(invoice.created_at);
  const expiredMinutes = Number.isFinite(Number(invoice.expired_minutes)) && Number(invoice.expired_minutes) > 0
    ? Number(invoice.expired_minutes)
    : DEFAULT_EXPIRED_MINUTES;
  if (createdMs && expiredMinutes > 0) {
    return createdMs + expiredMinutes * 60 * 1000;
  }

  const providerExpiredMs = parseDateMs(invoice.expired_at);
  if (providerExpiredMs) return providerExpiredMs;

  return null;
}

function isInvoiceLocallyExpired(invoice, now = Date.now()) {
  if (!invoice || normalizeStatus(invoice.status) !== "pending") return false;
  const expiredMs = getInvoiceExpiryMs(invoice);
  return Boolean(expiredMs && expiredMs <= now);
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, chunk) => {
    const index = chunk.indexOf("=");
    if (index === -1) return cookies;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function signSession(payload) {
  ensureAdminConfig();
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", getAdminSessionSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  ensureAdminConfig();

  const [encoded, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", getAdminSessionSecret()).update(encoded).digest("base64url");
  const validLength = Buffer.byteLength(signature) === Buffer.byteLength(expected);

  if (!validLength || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload?.username || !payload?.expires_at || Date.now() > payload.expires_at) return null;
  return payload;
}

function getAdminSession(req) {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    return verifySession(cookies[ADMIN_COOKIE_NAME]);
  } catch (_error) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const session = getAdminSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "Admin login required." });
  }
  req.admin = session;
  next();
}

function safeInvoice(invoice, includeAdminFields = false, appUrl = getLocalAppUrl()) {
  const expiryMs = getInvoiceExpiryMs(invoice);
  const safeExpiredAt = invoice.local_expired_at || (expiryMs ? new Date(expiryMs).toISOString() : invoice.expired_at || null);
  const base = {
    id: invoice.id,
    reff_id: invoice.reff_id,
    product_name: invoice.product_name,
    amount_request: money(invoice.amount_request),
    amount_total: money(invoice.amount_total),
    fee: money(invoice.fee),
    status: normalizeStatus(invoice.status),
    method_code: invoice.method_code,
    method_name: invoice.method_name,
    qr_image: invoice.qr_image || null,
    qr_string: invoice.qr_string || null,
    pay_code: invoice.pay_code || null,
    pay_url: invoice.pay_url || null,
    expired_at: safeExpiredAt,
    created_at: invoice.created_at || null,
    updated_at: invoice.updated_at || null,
    delivery: safeDelivery(invoice),
    payment_link: `${appUrl}/pay/${encodeURIComponent(invoice.id)}`
  };

  if (includeAdminFields) {
    base.flowix_reff_id = invoice.reff_id;
    base.provider_ref = invoice.provider_ref || null;
    base.note = invoice.note || null;
    base.fee_by_customer = invoice.fee_by_customer !== false;
    base.expired_minutes = clampInteger(invoice.expired_minutes, MIN_EXPIRED_MINUTES, MAX_EXPIRED_MINUTES, DEFAULT_EXPIRED_MINUTES);
    base.flowix_expired_at = invoice.expired_at || null;
    base.delivery_type = invoice.delivery_type || "none";
    base.delivery_file_name = invoice.delivery_file_name || null;
    base.delivery_has_text = Boolean(invoice.delivery_text);
  }

  return base;
}

async function readInvoices() {
  try {
    const raw = await fs.readFile(invoicesFile, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeInvoices(invoices) {
  await fs.mkdir(path.dirname(invoicesFile), { recursive: true });
  await fs.writeFile(invoicesFile, JSON.stringify(invoices, null, 2));
}

async function readJsonFile(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

function normalizeDepositMethod(method) {
  const code = String(method?.code || "").trim();
  if (!code) return null;

  return {
    code,
    name: String(method.name || code).trim(),
    type: method.type || null,
    group: method.group || null,
    fee_flat: money(method.fee_flat),
    fee_percent: money(method.fee_percent),
    min_amount: money(method.min_amount),
    max_amount: money(method.max_amount),
    icon_url: method.icon_url || null
  };
}

function filterDepositMethods(methods) {
  return (Array.isArray(methods) ? methods : [])
    .filter((method) => method?.is_available !== false && method?.hidden !== true && method?.disabled !== true)
    .map(normalizeDepositMethod)
    .filter(Boolean);
}

async function readDepositMethodsCache() {
  const cached = await readJsonFile(depositMethodsCacheFile, { updated_at: null, methods: [] });
  return {
    updated_at: cached?.updated_at || null,
    methods: Array.isArray(cached?.methods) ? cached.methods.map(normalizeDepositMethod).filter(Boolean) : []
  };
}


async function readPushSubscriptions() {
  const subscriptions = await readJsonFile(pushSubscriptionsFile, []);
  return Array.isArray(subscriptions) ? subscriptions.filter((item) => item && item.endpoint) : [];
}

async function writePushSubscriptions(subscriptions) {
  const unique = [];
  const seen = new Set();
  for (const item of Array.isArray(subscriptions) ? subscriptions : []) {
    if (!item?.endpoint || seen.has(item.endpoint)) continue;
    seen.add(item.endpoint);
    unique.push(item);
  }
  await writeJsonFile(pushSubscriptionsFile, unique);
  return unique;
}

async function upsertPushSubscription(subscription, adminUsername = ADMIN_USERNAME) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    const error = new Error("Push subscription tidak valid.");
    error.statusCode = 422;
    throw error;
  }

  const subscriptions = await readPushSubscriptions();
  const now = new Date().toISOString();
  const clean = {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime || null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth
    },
    admin_username: adminUsername,
    updated_at: now
  };
  const index = subscriptions.findIndex((item) => item.endpoint === clean.endpoint);
  if (index >= 0) subscriptions[index] = { ...subscriptions[index], ...clean };
  else subscriptions.push({ ...clean, created_at: now });
  return writePushSubscriptions(subscriptions);
}

async function removePushSubscription(endpoint) {
  if (!endpoint) return [];
  const subscriptions = await readPushSubscriptions();
  return writePushSubscriptions(subscriptions.filter((item) => item.endpoint !== endpoint));
}

async function getOrCreateVapidKeys() {
  if (vapidRuntimeKeys?.publicKey && vapidRuntimeKeys?.privateKey) return vapidRuntimeKeys;

  const saved = await readJsonFile(vapidKeysFile, null);
  if (saved?.publicKey && saved?.privateKey) {
    vapidRuntimeKeys = saved;
    return vapidRuntimeKeys;
  }

  const fresh = {
    ...webpush.generateVAPIDKeys(),
    created_at: new Date().toISOString(),
    note: "Auto-generated by backend. Keep this file private."
  };
  await writeJsonFile(vapidKeysFile, fresh);
  vapidRuntimeKeys = fresh;
  return vapidRuntimeKeys;
}

async function configureWebPush() {
  if (!VAPID_SUBJECT_EMAIL) return null;
  const keys = await getOrCreateVapidKeys();
  if (!webPushConfigured) {
    webpush.setVapidDetails(`mailto:${VAPID_SUBJECT_EMAIL}`, keys.publicKey, keys.privateKey);
    webPushConfigured = true;
  }
  return keys;
}

function buildPaidNotificationPayload(invoice) {
  const amount = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(money(invoice.amount_total));

  return {
    title: "Payment Invoice PAID",
    body: `${invoice.product_name || "Invoice"} sudah dibayar ${amount}.`,
    tag: `invoice-paid-${invoice.id || invoice.reff_id}`,
    url: `/pay/${encodeURIComponent(invoice.id || invoice.reff_id)}`,
    data: {
      invoice_id: invoice.id,
      reff_id: invoice.reff_id,
      status: "paid",
      url: `/pay/${encodeURIComponent(invoice.id || invoice.reff_id)}`
    }
  };
}

async function sendPaymentPaidNotification(invoice, source = "status_update") {
  if (!VAPID_SUBJECT_EMAIL) return { sent: 0, skipped: true, reason: "VAPID_SUBJECT_EMAIL_empty" };
  await configureWebPush();

  const subscriptions = await readPushSubscriptions();
  if (!subscriptions.length) return { sent: 0, skipped: true, reason: "no_subscriptions" };

  const payload = JSON.stringify(buildPaidNotificationPayload(invoice));
  const staleEndpoints = [];
  let sent = 0;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 * 60 });
      sent += 1;
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) staleEndpoints.push(subscription.endpoint);
      console.error(`[Web Push Error] ${source}: ${error.message}`);
    }
  }

  if (staleEndpoints.length) {
    const latest = await readPushSubscriptions();
    await writePushSubscriptions(latest.filter((item) => !staleEndpoints.includes(item.endpoint)));
  }

  return { sent, skipped: false };
}

async function saveInvoiceAndNotify(invoice, source = "status_update") {
  const previous = await findInvoice(invoice.id || invoice.reff_id);
  const saved = await saveInvoice(invoice);
  const wasPaid = normalizeStatus(previous?.status) === "paid";
  const isPaid = normalizeStatus(saved.status) === "paid";

  if (isPaid && !wasPaid && !saved.push_notified_at) {
    const result = await sendPaymentPaidNotification(saved, source);
    return saveInvoice({
      ...saved,
      push_notified_at: new Date().toISOString(),
      push_notification_result: result
    });
  }

  return saved;
}

async function refreshDepositMethodsCache({ force = false } = {}) {
  if (depositMethodRefreshRunning) return readDepositMethodsCache();

  const cached = await readDepositMethodsCache();
  const cacheAge = cached.updated_at ? Date.now() - parseDateMs(cached.updated_at) : Infinity;
  if (!force && cached.methods.length && cacheAge < DEPOSIT_METHOD_REFRESH_INTERVAL_MS) return cached;

  depositMethodRefreshRunning = true;
  try {
    const payload = await callFlowix("/deposit");
    const methods = filterDepositMethods(payload.data);
    const fresh = {
      updated_at: new Date().toISOString(),
      refresh_interval_ms: DEPOSIT_METHOD_REFRESH_INTERVAL_MS,
      source: "flowix_api",
      methods
    };
    await writeJsonFile(depositMethodsCacheFile, fresh);
    return fresh;
  } catch (error) {
    if (cached.methods.length) {
      console.error(`[Deposit Method Cache Warning] Using cached methods: ${error.message}`);
      return cached;
    }
    throw error;
  } finally {
    depositMethodRefreshRunning = false;
  }
}

async function getDepositMethods() {
  return refreshDepositMethodsCache({ force: false });
}

function findDepositMethod(methods, code) {
  const clean = String(code || "").trim().toUpperCase();
  return methods.find((method) => String(method.code || "").trim().toUpperCase() === clean) || null;
}

function queueInvoiceWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

async function saveInvoice(invoice) {
  return queueInvoiceWrite(async () => {
    const invoices = await readInvoices();
    const now = new Date().toISOString();
    const index = invoices.findIndex((item) => item.id === invoice.id || item.reff_id === invoice.reff_id);

    if (index >= 0) {
      const existing = invoices[index];
      const existingStatus = normalizeStatus(existing.status);
      const incomingStatus = normalizeStatus(invoice.status);
      const terminalStatuses = new Set(["paid", "expired", "failed", "canceled"]);
      const guardedStatus = terminalStatuses.has(existingStatus) && incomingStatus === "pending" ? existingStatus : incomingStatus;
      invoices[index] = { ...existing, ...invoice, status: guardedStatus, updated_at: now };
    } else {
      invoices.unshift({ ...invoice, status: normalizeStatus(invoice.status), created_at: now, updated_at: now });
    }

    await writeInvoices(invoices);
    return index >= 0 ? invoices[index] : invoices[0];
  });
}

async function findInvoice(id) {
  const invoices = await readInvoices();
  return invoices.find((invoice) => invoice.id === id || invoice.reff_id === id);
}

async function callFlowix(endpoint, options = {}) {
  ensureFlowixCredentials();

  const response = await fetch(`${FLOWIX_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      api_key: FLOWIX_API_KEY,
      merchant_id: FLOWIX_MERCHANT_ID,
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    const message = payload?.message || `Flowix request failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status || 502;
    error.payload = payload;
    throw error;
  }

  return payload;
}


async function registerFlowixWebhookFromEnv(source = "startup") {
  if (!AUTO_REGISTER_FLOWIX_WEBHOOK) {
    return { skipped: true, reason: "AUTO_REGISTER_FLOWIX_WEBHOOK_disabled" };
  }

  const webhookUrl = getConfiguredFlowixWebhookUrl();
  if (!webhookUrl) {
    return { skipped: true, reason: "FLOWIX_WEBHOOK_CALLBACK_URL_empty_or_invalid" };
  }

  const payload = await callFlowix("/profile", {
    method: "POST",
    body: JSON.stringify({
      action: "update_webhook",
      webhook_url: webhookUrl
    })
  });

  const result = {
    skipped: false,
    source,
    webhook_url: webhookUrl,
    message: payload.message || "Webhook URL updated."
  };
  await writeJsonFile(path.join(dataDir, "flowix-webhook-sync.json"), {
    ...result,
    updated_at: new Date().toISOString()
  });
  return result;
}

function verifyFlowixSignature(rawBody, signature, key, merchant) {
  if (!FLOWIX_WEBHOOK_SECRET || !signature) return false;
  if (key && key !== FLOWIX_API_KEY) return false;
  if (merchant && merchant !== FLOWIX_MERCHANT_ID) return false;

  const incoming = String(signature || "").trim().replace(/^sha256=/i, "");
  const expected = crypto.createHmac("sha256", FLOWIX_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const sameLength = Buffer.byteLength(expected) === Buffer.byteLength(incoming);
  return sameLength && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(incoming));
}

async function expireInvoice(localInvoice, source = "local_expiry") {
  if (!localInvoice || normalizeStatus(localInvoice.status) !== "pending") return localInvoice;

  let flowixCancelStatus = "not_sent";
  let flowixCancelMessage = null;

  try {
    await callFlowix(`/deposit/${encodeURIComponent(localInvoice.reff_id)}/cancel`, {
      method: "POST",
      body: "{}"
    });
    flowixCancelStatus = "sent";
  } catch (error) {
    flowixCancelStatus = "failed";
    flowixCancelMessage = error.message;
  }

  return saveInvoice({
    ...localInvoice,
    status: "expired",
    expired_by: source,
    expired_at_local_status: new Date().toISOString(),
    flowix_cancel_status: flowixCancelStatus,
    flowix_cancel_message: flowixCancelMessage,
    note: flowixCancelMessage
      ? `Local expired. Flowix cancel failed: ${flowixCancelMessage}`
      : "Local expired. Flowix cancel endpoint executed."
  });
}

async function syncInvoiceWithFlowix(localInvoice) {
  if (!localInvoice || normalizeStatus(localInvoice.status) !== "pending") return localInvoice;

  if (isInvoiceLocallyExpired(localInvoice)) {
    return expireInvoice(localInvoice, "invoice_read");
  }

  const flowix = await callFlowix(`/deposit/${encodeURIComponent(localInvoice.reff_id)}`);
  const deposit = flowix.data || {};
  const flowixStatus = normalizeStatus(deposit.status);

  if (flowixStatus === "pending" && isInvoiceLocallyExpired(localInvoice)) {
    return expireInvoice(localInvoice, "invoice_read_after_sync");
  }

  return saveInvoiceAndNotify({
    ...localInvoice,
    status: flowixStatus,
    amount_total: money(deposit.amount_total || localInvoice.amount_total),
    fee: money(deposit.fee || localInvoice.fee),
    qr_image: deposit.qr_image || localInvoice.qr_image,
    qr_string: deposit.qr_string || localInvoice.qr_string,
    pay_code: deposit.pay_code || localInvoice.pay_code,
    pay_url: deposit.pay_url || localInvoice.pay_url,
    expired_at: deposit.expired_at || localInvoice.expired_at,
    provider_ref: deposit.provider_ref || localInvoice.provider_ref || null,
    note: deposit.note || localInvoice.note || null,
    paid_at: flowixStatus === "paid" ? new Date().toISOString() : localInvoice.paid_at || null
  }, "flowix_sync");
}

async function syncPendingInvoices() {
  if (syncPendingRunning) return;
  syncPendingRunning = true;

  try {
    const invoices = await readInvoices();
    const pendingInvoices = invoices.filter((invoice) => normalizeStatus(invoice.status) === "pending");

    for (const invoice of pendingInvoices) {
      try {
        await syncInvoiceWithFlowix(invoice);
      } catch (error) {
        console.error(`[Pending Sync Error] ${invoice.id || invoice.reff_id}: ${error.message}`);
      }
    }
  } finally {
    syncPendingRunning = false;
  }
}

async function sweepExpiredInvoices() {
  if (expireSweepRunning) return;
  expireSweepRunning = true;

  try {
    const invoices = await readInvoices();
    const now = Date.now();
    const expiredInvoices = invoices.filter((invoice) => isInvoiceLocallyExpired(invoice, now));

    for (const invoice of expiredInvoices) {
      try {
        await expireInvoice(invoice, "expired_sweep");
      } catch (error) {
        console.error(`[Expired Sweep Error] ${invoice.id || invoice.reff_id}: ${error.message}`);
      }
    }
  } finally {
    expireSweepRunning = false;
  }
}

module.exports = {
  PORT,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_DAYS,
  DEFAULT_FEE_BY_CUSTOMER,
  AUTO_REGISTER_FLOWIX_WEBHOOK,
  INVOICE_POLL_INTERVAL_MS,
  EXPIRED_SWEEP_INTERVAL_MS,
  DEPOSIT_METHOD_REFRESH_INTERVAL_MS,
  MIN_INVOICE_AMOUNT,
  MIN_EXPIRED_MINUTES,
  MAX_EXPIRED_MINUTES,
  DEFAULT_EXPIRED_MINUTES,
  VAPID_SUBJECT_EMAIL,
  ensureAdminConfig,
  getAdminSessionSecret,
  getAppUrl,
  getLocalAppUrl,
  getConfiguredFlowixWebhookUrl,
  money,
  clampInteger,
  parseBoolean,
  createLocalInvoiceId,
  createDefaultProductName,
  normalizeStatus,
  cleanDeliveryPayload,
  safeInvoice,
  parseDateMs,
  createLocalExpiredAt,
  getInvoiceExpiryMs,
  isInvoiceLocallyExpired,
  parseCookies,
  signSession,
  verifySession,
  getAdminSession,
  requireAdmin,
  readInvoices,
  writeInvoices,
  readJsonFile,
  writeJsonFile,
  normalizeDepositMethod,
  filterDepositMethods,
  readDepositMethodsCache,
  readPushSubscriptions,
  writePushSubscriptions,
  upsertPushSubscription,
  removePushSubscription,
  getOrCreateVapidKeys,
  configureWebPush,
  buildPaidNotificationPayload,
  sendPaymentPaidNotification,
  saveInvoiceAndNotify,
  refreshDepositMethodsCache,
  getDepositMethods,
  findDepositMethod,
  queueInvoiceWrite,
  saveInvoice,
  findInvoice,
  callFlowix,
  registerFlowixWebhookFromEnv,
  verifyFlowixSignature,
  expireInvoice,
  syncInvoiceWithFlowix,
  syncPendingInvoices,
  sweepExpiredInvoices
};
