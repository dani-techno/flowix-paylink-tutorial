const crypto = require("crypto");
const express = require("express");
const {
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
  getConfiguredFlowixWebhookUrl,
  money,
  clampInteger,
  parseBoolean,
  createLocalInvoiceId,
  createDefaultProductName,
  normalizeStatus,
  cleanDeliveryPayload,
  safeInvoice,
  signSession,
  getAdminSession,
  requireAdmin,
  readInvoices,
  configureWebPush,
  upsertPushSubscription,
  removePushSubscription,
  registerFlowixWebhookFromEnv,
  getDepositMethods,
  findDepositMethod,
  callFlowix,
  createLocalExpiredAt,
  saveInvoiceAndNotify,
  findInvoice,
  syncInvoiceWithFlowix,
  verifyFlowixSignature,
  sweepExpiredInvoices
} = require("../services/flowix");

const router = express.Router();

router.get("/api/config", (req, res) => {
  res.json({
    success: true,
    data: {
      min_invoice_amount: MIN_INVOICE_AMOUNT,
      invoice_poll_interval_ms: INVOICE_POLL_INTERVAL_MS,
      expired_sweep_interval_ms: EXPIRED_SWEEP_INTERVAL_MS,
      deposit_method_refresh_interval_ms: DEPOSIT_METHOD_REFRESH_INTERVAL_MS,
      expired_minutes: {
        min: MIN_EXPIRED_MINUTES,
        max: MAX_EXPIRED_MINUTES,
        default: DEFAULT_EXPIRED_MINUTES
      },
      default_fee_by_customer: DEFAULT_FEE_BY_CUSTOMER,
      admin_session_days: ADMIN_SESSION_MAX_AGE_DAYS,
      web_push_enabled: Boolean(VAPID_SUBJECT_EMAIL),
      flowix_webhook: {
        receiver_path: "/webhooks/flowix",
        callback_url: getConfiguredFlowixWebhookUrl(),
        auto_register_enabled: AUTO_REGISTER_FLOWIX_WEBHOOK
      }
    }
  });
});

router.post("/api/admin/login", async (req, res, next) => {
  try {
    ensureAdminConfig();
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const userOk = username === ADMIN_USERNAME;
    const passOk = password.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));

    if (!userOk || !passOk) {
      return res.status(401).json({ success: false, message: "Username atau password admin salah." });
    }

    const expiresAt = Date.now() + ADMIN_SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const token = signSession({ username, expires_at: expiresAt });
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";

    res.setHeader(
      "Set-Cookie",
      `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`
    );

    res.json({ success: true, data: { username, expires_at: new Date(expiresAt).toISOString() } });
  } catch (error) {
    next(error);
  }
});

router.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ success: true, data: { logged_out: true } });
});

router.get("/api/admin/me", (req, res) => {
  const session = getAdminSession(req);
  res.json({ success: true, data: { authenticated: Boolean(session), username: session?.username || null } });
});

router.get("/api/admin/push/public-key", requireAdmin, async (req, res, next) => {
  try {
    if (!VAPID_SUBJECT_EMAIL) {
      return res.json({ success: true, data: { enabled: false, public_key: null, message: "VAPID_SUBJECT_EMAIL belum diisi." } });
    }

    const keys = await configureWebPush();
    res.json({ success: true, data: { enabled: true, public_key: keys.publicKey } });
  } catch (error) {
    next(error);
  }
});

router.post("/api/admin/push/subscribe", requireAdmin, async (req, res, next) => {
  try {
    if (!VAPID_SUBJECT_EMAIL) {
      return res.status(422).json({ success: false, message: "VAPID_SUBJECT_EMAIL wajib diisi di .env untuk web-push." });
    }
    await configureWebPush();
    const subscriptions = await upsertPushSubscription(req.body.subscription, req.admin.username);
    res.json({ success: true, data: { subscribed: true, total: subscriptions.length } });
  } catch (error) {
    next(error);
  }
});

router.post("/api/admin/push/unsubscribe", requireAdmin, async (req, res, next) => {
  try {
    const subscriptions = await removePushSubscription(req.body.endpoint);
    res.json({ success: true, data: { unsubscribed: true, total: subscriptions.length } });
  } catch (error) {
    next(error);
  }
});

router.post("/api/admin/flowix-webhook/register", requireAdmin, async (req, res, next) => {
  try {
    const result = await registerFlowixWebhookFromEnv("admin_manual");
    if (result.skipped) {
      return res.status(422).json({ success: false, message: result.reason, data: result });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get("/api/admin/deposit-methods", requireAdmin, async (req, res, next) => {
  try {
    const cache = await getDepositMethods();
    res.json({ success: true, data: cache.methods });
  } catch (error) {
    next(error);
  }
});

router.get("/api/admin/payment-links", requireAdmin, async (req, res, next) => {
  try {
    await sweepExpiredInvoices();
    const invoices = await readInvoices();
    res.json({ success: true, data: invoices.slice(0, 100).map((invoice) => safeInvoice(invoice, true, req.appUrl)) });
  } catch (error) {
    next(error);
  }
});

router.post("/api/admin/payment-links", requireAdmin, async (req, res, next) => {
  try {
    const rawProductName = String(req.body.product_name || "").trim();
    const productName = rawProductName || createDefaultProductName();
    const methodCode = String(req.body.method_code || "").trim();
    const amount = Number(req.body.amount);
    const expiredMinutes = clampInteger(req.body.expired_minutes, MIN_EXPIRED_MINUTES, MAX_EXPIRED_MINUTES, DEFAULT_EXPIRED_MINUTES);
    const feeByCustomer = parseBoolean(req.body.fee_by_customer, DEFAULT_FEE_BY_CUSTOMER);
    const deliveryPayload = cleanDeliveryPayload(req.body);

    if (productName.length < 3 || productName.length > 120) {
      return res.status(422).json({ success: false, message: "Nama produk maksimal 120 karakter. Kosongkan untuk memakai nama produk otomatis." });
    }

    if (!Number.isInteger(amount) || amount < MIN_INVOICE_AMOUNT) {
      return res.status(422).json({ success: false, message: `Harga wajib angka bulat minimal Rp${MIN_INVOICE_AMOUNT.toLocaleString("id-ID")}.` });
    }

    if (!methodCode) {
      return res.status(422).json({ success: false, message: "Metode pembayaran wajib dipilih." });
    }

    const methodCache = await getDepositMethods();
    const selectedMethod = findDepositMethod(methodCache.methods, methodCode);
    if (!selectedMethod) {
      return res.status(422).json({ success: false, message: "Metode pembayaran tidak tersedia di cache Flowix terbaru." });
    }

    const flowix = await callFlowix("/deposit", {
      method: "POST",
      body: JSON.stringify({
        amount,
        method_code: methodCode,
        fee_by_customer: feeByCustomer
      })
    });

    const deposit = flowix.data || {};
    if (!deposit.reff_id) {
      return res.status(502).json({ success: false, message: "Flowix tidak mengembalikan reff_id deposit." });
    }

    const localInvoice = await saveInvoiceAndNotify({
      id: createLocalInvoiceId(),
      reff_id: deposit.reff_id,
      product_name: productName,
      method_code: deposit.method_code || methodCode,
      method_name: deposit.method_name || selectedMethod.name || methodCode,
      amount_request: money(deposit.amount_request || amount),
      amount_total: money(deposit.amount_total || amount),
      amount_received: money(deposit.amount_received || amount),
      fee: money(deposit.fee),
      fee_by_customer: feeByCustomer,
      expired_minutes: expiredMinutes,
      local_expired_at: createLocalExpiredAt(expiredMinutes),
      status: normalizeStatus(deposit.status),
      qr_image: deposit.qr_image || null,
      qr_string: deposit.qr_string || null,
      pay_code: deposit.pay_code || null,
      pay_url: deposit.pay_url || null,
      expired_at: deposit.expired_at || null,
      provider_ref: deposit.provider_ref || null,
      note: deposit.note || null,
      ...deliveryPayload
    }, "flowix_create");

    res.status(201).json({ success: true, data: safeInvoice(localInvoice, true, req.appUrl) });
  } catch (error) {
    next(error);
  }
});

router.get("/api/invoices/:invoiceId/delivery-file", async (req, res, next) => {
  try {
    const invoice = await findInvoice(req.params.invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, message: "Invoice tidak ditemukan." });
    }

    const syncedInvoice = await syncInvoiceWithFlowix(invoice);
    if (normalizeStatus(syncedInvoice.status) !== "paid") {
      return res.status(403).json({ success: false, message: "File customer hanya bisa diunduh setelah invoice PAID." });
    }

    if (syncedInvoice.delivery_type !== "file" || !syncedInvoice.delivery_file_data) {
      return res.status(404).json({ success: false, message: "File customer tidak tersedia." });
    }

    const fileName = String(syncedInvoice.delivery_file_name || "file-customer").replace(/[\r\n"]/g, "");
    const mime = String(syncedInvoice.delivery_file_mime || "application/octet-stream").replace(/[^-\w.+/]/g, "") || "application/octet-stream";
    const buffer = Buffer.from(String(syncedInvoice.delivery_file_data), "base64");

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

router.get("/api/invoices/:invoiceId", async (req, res, next) => {
  try {
    const localInvoice = await findInvoice(req.params.invoiceId);

    if (!localInvoice) {
      return res.status(404).json({ success: false, message: "Invoice tidak ditemukan." });
    }

    const syncedInvoice = await syncInvoiceWithFlowix(localInvoice);
    res.json({ success: true, data: safeInvoice(syncedInvoice, false, req.appUrl) });
  } catch (error) {
    next(error);
  }
});

router.post(["/webhooks/flowix", "/webhook/flowix"], async (req, res, next) => {
  try {
    const signature = req.header("X-Flowix-Signature");
    const key = req.header("X-Flowix-Key");
    const merchant = req.header("X-Flowix-Merchant");

    if (!verifyFlowixSignature(req.body, signature, key, merchant)) {
      return res.status(401).json({ success: false, message: "Invalid Flowix webhook signature." });
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    const event = String(payload.event || req.header("X-Flowix-Event") || "");
    const data = payload.data || {};

    if (event === "deposit.status" && data.reff_id) {
      const invoice = await findInvoice(data.reff_id);

      if (invoice) {
        const incomingStatus = normalizeStatus(data.status);
        const currentStatus = normalizeStatus(invoice.status);
        const finalStatus = currentStatus === "expired" && incomingStatus === "canceled" ? "expired" : incomingStatus;

        await saveInvoiceAndNotify({
          ...invoice,
          status: finalStatus,
          amount_total: money(data.original_amount || data.amount_total || invoice.amount_total),
          amount_received: money(data.amount || data.amount_received || invoice.amount_received),
          provider_ref: data.provider_ref || invoice.provider_ref || null,
          note: data.note || invoice.note || null,
          last_webhook_event_id: payload.id || invoice.last_webhook_event_id || null,
          last_webhook_at: new Date().toISOString(),
          paid_at: finalStatus === "paid" ? new Date().toISOString() : invoice.paid_at || null
        }, "flowix_webhook");
      }
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});



module.exports = router;
