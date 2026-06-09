const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});


const jakartaDateFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  weekday: "long",
  day: "2-digit",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short"
});

function parseDateMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 9999999999 ? numeric : numeric * 1000;
  }

  const sqlLocalMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw);
  const normalized = sqlLocalMatch && !hasTimezone
    ? `${sqlLocalMatch[1]}-${sqlLocalMatch[2]}-${sqlLocalMatch[3]}T${sqlLocalMatch[4]}:${sqlLocalMatch[5]}:${(sqlLocalMatch[6] || "00").padStart(2, "0")}+07:00`
    : raw;

  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function formatJakartaDate(ms) {
  if (!ms) return "-";
  return jakartaDateFormatter.format(new Date(ms)).replace(/ pukul 24\./, " pukul 00.");
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  if (totalMinutes <= 0) return "0 menit";

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) parts.push(`${days} hari`);
  if (hours) parts.push(`${hours} jam`);
  if (minutes || !parts.length) parts.push(`${minutes} menit`);

  return parts.slice(0, 2).join(" ");
}

function formatInvoiceExpiry(invoice, options = {}) {
  const expiredMs = parseDateMs(invoice?.expired_at);
  if (!expiredMs) return "Batas pembayaran belum tersedia";

  const now = Date.now();
  const exactDate = formatJakartaDate(expiredMs);
  const status = invoice?.status || "pending";

  if (status === "pending") {
    if (expiredMs <= now) return `Sudah lewat batas bayar sejak ${exactDate}`;
    return `Berakhir ${exactDate} • sisa ${formatDuration(expiredMs - now)}`;
  }

  if (status === "paid") return `Batas bayar sebelumnya ${exactDate}`;
  if (status === "expired") return `Expired pada ${exactDate}`;
  if (status === "canceled") return `Batas bayar invoice ${exactDate}`;
  if (status === "failed") return `Batas bayar invoice ${exactDate}`;

  return `Batas bayar ${exactDate}`;
}

const fallbackConfig = {
  min_invoice_amount: 1000,
  invoice_poll_interval_ms: 8000,
  expired_minutes: { min: 5, max: 60, default: 15 },
  default_fee_by_customer: true,
  web_push_enabled: false
};

let appConfig = { ...fallbackConfig };
let invoicePollTimer = null;
let adminListPollTimer = null;

const homeView = document.querySelector("#homeView");
const adminView = document.querySelector("#adminView");
const checkoutView = document.querySelector("#checkoutView");
const loginPanel = document.querySelector("#loginPanel");
const adminPanel = document.querySelector("#adminPanel");
const loginForm = document.querySelector("#loginForm");
const loginButton = document.querySelector("#loginButton");
const logoutButton = document.querySelector("#logoutButton");
const enablePushButton = document.querySelector("#enablePushButton");
const paymentForm = document.querySelector("#paymentForm");
const amountInput = document.querySelector("#amountInput");
const amountHelp = document.querySelector("#amountHelp");
const expiredSelect = document.querySelector("#expiredSelect");
const feeByCustomerSelect = document.querySelector("#feeByCustomerSelect");
const methodSelect = document.querySelector("#methodSelect");
const deliveryType = document.querySelector("#deliveryType");
const deliveryTextBox = document.querySelector("#deliveryTextBox");
const deliveryText = document.querySelector("#deliveryText");
const deliveryFileBox = document.querySelector("#deliveryFileBox");
const deliveryFile = document.querySelector("#deliveryFile");
const submitButton = document.querySelector("#submitButton");
const resultBox = document.querySelector("#resultBox");
const resultTitle = document.querySelector("#resultTitle");
const resultText = document.querySelector("#resultText");
const paymentLink = document.querySelector("#paymentLink");
const copyButton = document.querySelector("#copyButton");
const openLink = document.querySelector("#openLink");
const invoiceList = document.querySelector("#invoiceList");
const refreshListButton = document.querySelector("#refreshListButton");
const toast = document.querySelector("#toast");

const invoiceProduct = document.querySelector("#invoiceProduct");
const invoiceStatus = document.querySelector("#invoiceStatus");
const invoiceAmount = document.querySelector("#invoiceAmount");
const invoiceReff = document.querySelector("#invoiceReff");
const invoiceMethod = document.querySelector("#invoiceMethod");
const invoiceExpired = document.querySelector("#invoiceExpired");
const paymentBox = document.querySelector("#paymentBox");
const invoiceStatusPanel = document.querySelector("#invoiceStatusPanel");
const invoiceStatusIcon = document.querySelector("#invoiceStatusIcon");
const invoiceStatusTitle = document.querySelector("#invoiceStatusTitle");
const invoiceStatusDescription = document.querySelector("#invoiceStatusDescription");
const paidNote = document.querySelector("#paidNote");
const paidDelivery = document.querySelector("#paidDelivery");

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.message || "Request gagal.");
  }

  return payload.data;
}

async function loadConfig() {
  try {
    const config = await api("/api/config");
    appConfig = {
      ...fallbackConfig,
      ...config,
      expired_minutes: {
        ...fallbackConfig.expired_minutes,
        ...(config.expired_minutes || {})
      }
    };
  } catch (_error) {
    appConfig = { ...fallbackConfig };
  }

  applyConfigToForm();
}

function applyConfigToForm() {
  if (amountInput) {
    amountInput.min = String(appConfig.min_invoice_amount);
    amountInput.step = "1";
    amountInput.placeholder = String(Math.max(appConfig.min_invoice_amount, 150000));
  }

  if (amountHelp) {
    amountHelp.textContent = `Minimal nominal invoice ${rupiah.format(appConfig.min_invoice_amount)}.`;
  }

  if (feeByCustomerSelect) {
    feeByCustomerSelect.value = appConfig.default_fee_by_customer ? "true" : "false";
  }

  if (expiredSelect) {
    const min = Number(appConfig.expired_minutes.min || 5);
    const max = Number(appConfig.expired_minutes.max || 60);
    const selected = Number(appConfig.expired_minutes.default || 15);
    expiredSelect.innerHTML = [5, 10, 15, 30, 45, 60]
      .filter((minute) => minute >= min && minute <= max)
      .map((minute) => `<option value="${minute}"${minute === selected ? " selected" : ""}>${minute} menit</option>`)
      .join("");
  }
}

function showOnly(view) {
  [homeView, adminView, checkoutView].forEach((item) => item.classList.add("hidden"));
  view.classList.remove("hidden");
}

function getInvoiceIdFromPath() {
  const match = window.location.pathname.match(/^\/pay\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isAdminPath() {
  return window.location.pathname === "/admin";
}

function statusLabel(status) {
  if (status === "paid") return "PAID";
  return String(status || "pending").toUpperCase();
}

function hasPendingInvoices(invoices) {
  return Array.isArray(invoices) && invoices.some((invoice) => invoice.status === "pending");
}

function startAdminListPolling(invoices) {
  window.clearTimeout(adminListPollTimer);
  if (hasPendingInvoices(invoices)) {
    adminListPollTimer = window.setTimeout(loadInvoiceList, appConfig.invoice_poll_interval_ms || 8000);
  }
}

async function loadDepositMethods() {
  const methods = await api("/api/admin/deposit-methods");
  if (!methods.length) return;

  methodSelect.innerHTML = methods
    .map((method) => `<option value="${method.code}">${method.name} • min ${rupiah.format(method.min_amount)}</option>`)
    .join("");

  const qris = methods.find((method) => String(method.code).toUpperCase() === "QRIS") ||
    methods.find((method) => String(method.code).toUpperCase().includes("QRIS"));

  if (qris) methodSelect.value = qris.code;
  else methodSelect.value = methods[0].code;
}

async function renderAdminState() {
  showOnly(adminView);
  const session = await api("/api/admin/me");

  if (!session.authenticated) {
    loginPanel.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    logoutButton.classList.add("hidden");
    enablePushButton?.classList.add("hidden");
    window.clearTimeout(adminListPollTimer);
    return;
  }

  loginPanel.classList.add("hidden");
  adminPanel.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  enablePushButton?.classList.toggle("hidden", !appConfig.web_push_enabled);
  await Promise.all([loadDepositMethods(), loadInvoiceList(), refreshPushButtonState()]);
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);

  loginButton.disabled = true;
  loginButton.textContent = "Masuk...";

  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password")
      })
    });
    showToast("Login admin berhasil.");
    await renderAdminState();
  } catch (error) {
    showToast(error.message);
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = "Masuk Admin";
  }
});

logoutButton?.addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: "{}" });
  showToast("Admin logout.");
  await renderAdminState();
});


function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  return navigator.serviceWorker.register("/sw.js");
}

async function refreshPushButtonState() {
  if (!enablePushButton) return;
  if (!appConfig.web_push_enabled) {
    enablePushButton.textContent = "Notifikasi belum aktif di server";
    enablePushButton.disabled = true;
    return;
  }

  const registration = await getServiceWorkerRegistration();
  if (!registration || Notification.permission === "denied") {
    enablePushButton.textContent = "Notifikasi tidak didukung browser";
    enablePushButton.disabled = true;
    return;
  }

  const subscription = await registration.pushManager.getSubscription();
  enablePushButton.disabled = false;
  enablePushButton.textContent = subscription ? "Notifikasi Paid Aktif" : "Aktifkan Notifikasi Paid";
  enablePushButton.classList.toggle("is-active", Boolean(subscription));
}

enablePushButton?.addEventListener("click", async () => {
  try {
    if (!appConfig.web_push_enabled) {
      showToast("Isi VAPID_SUBJECT_EMAIL di .env dulu.");
      return;
    }

    const registration = await getServiceWorkerRegistration();
    if (!registration) {
      showToast("Browser ini belum mendukung web-push.");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("Izin notifikasi belum diberikan.");
      return;
    }

    const vapid = await api("/api/admin/push/public-key");
    if (!vapid.enabled || !vapid.public_key) {
      showToast(vapid.message || "Web-push belum aktif.");
      return;
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.public_key)
      });
    }

    await api("/api/admin/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription })
    });

    await refreshPushButtonState();
    showToast("Notifikasi payment PAID aktif.");
  } catch (error) {
    showToast(error.message);
  }
});

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(new Error("File gagal dibaca."));
    reader.readAsDataURL(file);
  });
}

function syncDeliveryFields() {
  const type = deliveryType?.value || "none";
  deliveryTextBox?.classList.toggle("hidden", type !== "text");
  deliveryFileBox?.classList.toggle("hidden", type !== "file");
}

deliveryType?.addEventListener("change", syncDeliveryFields);
syncDeliveryFields();

paymentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(paymentForm);
  const amount = Number(form.get("amount"));

  if (!Number.isInteger(amount) || amount < appConfig.min_invoice_amount) {
    showToast(`Harga minimal ${rupiah.format(appConfig.min_invoice_amount)}.`);
    amountInput?.focus();
    return;
  }

  const body = {
    product_name: form.get("product_name"),
    amount,
    method_code: form.get("method_code"),
    expired_minutes: Number(form.get("expired_minutes")),
    fee_by_customer: form.get("fee_by_customer") === "true",
    delivery_type: form.get("delivery_type") || "none"
  };

  if (body.delivery_type === "text") {
    body.delivery_text = String(form.get("delivery_text") || "").trim();
    if (!body.delivery_text) {
      showToast("Text customer wajib diisi atau pilih Tidak ada.");
      deliveryText?.focus();
      return;
    }
  }

  if (body.delivery_type === "file") {
    const file = deliveryFile?.files?.[0];
    if (!file) {
      showToast("File customer wajib dipilih atau pilih Tidak ada.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast("File customer maksimal 2MB.");
      return;
    }
    body.delivery_file_name = file.name;
    body.delivery_file_mime = file.type || "application/octet-stream";
    body.delivery_file_data = await readFileAsBase64(file);
  }

  submitButton.disabled = true;
  submitButton.textContent = "Generating...";

  try {
    const invoice = await api("/api/admin/payment-links", {
      method: "POST",
      body: JSON.stringify(body)
    });

    resultTitle.textContent = "Payment link siap";
    resultText.textContent = `Invoice ${invoice.id} berhasil dibuat. ${formatInvoiceExpiry(invoice)}`;
    paymentLink.value = invoice.payment_link;
    openLink.href = invoice.payment_link;
    resultBox.classList.remove("hidden");
    paymentForm.reset();
    applyConfigToForm();
    syncDeliveryFields();
    showToast("Payment link berhasil dibuat.");
    await loadInvoiceList();
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Generate Payment Link";
  }
});

copyButton?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(paymentLink.value);
  showToast("Link pembayaran berhasil disalin.");
});

refreshListButton?.addEventListener("click", loadInvoiceList);

async function loadInvoiceList() {
  const invoices = await api("/api/admin/payment-links");
  invoiceList.innerHTML = invoices.length
    ? invoices.map((invoice) => `
      <article class="invoice-item">
        <div>
          <strong>${invoice.product_name}</strong>
          <span>${invoice.id}</span>
          <small>${invoice.method_name || invoice.method_code} • ${formatInvoiceExpiry(invoice)} • fee ${invoice.fee_by_customer ? "customer" : "merchant"} • konten ${invoice.delivery_type || "none"}</small>
        </div>
        <div class="invoice-item-right">
          <b>${rupiah.format(invoice.amount_total)}</b>
          <em class="mini-status ${invoice.status}">${statusLabel(invoice.status)}</em>
          <a href="${invoice.payment_link}" target="_blank" rel="noopener">Buka</a>
        </div>
      </article>
    `).join("")
    : `<p class="muted empty-state">Belum ada invoice.</p>`;

  startAdminListPolling(invoices);
}

function inferPaymentType(invoice) {
  const method = `${invoice.method_code || ""} ${invoice.method_name || ""}`.toLowerCase();
  if (invoice.qr_image || invoice.qr_string || method.includes("qris") || method.includes("qr")) return "qr";
  if (invoice.pay_url) return "button";
  return "text";
}

function paymentTypeCopy(type) {
  if (type === "qr") {
    return {
      badge: "QR Payment",
      title: "Scan QR untuk membayar",
      desc: "Buka aplikasi e-wallet atau mobile banking, scan QR di bawah, lalu pastikan nominal pembayaran sesuai invoice.",
      icon: "▦"
    };
  }

  if (type === "button") {
    return {
      badge: "Payment Link",
      title: "Lanjutkan ke halaman pembayaran",
      desc: "Klik tombol pembayaran resmi di bawah. Status invoice akan diperbarui otomatis setelah transaksi dikonfirmasi.",
      icon: "↗"
    };
  }

  return {
    badge: "Kode Pembayaran",
    title: "Bayar memakai kode/rekening/VA",
    desc: "Salin kode pembayaran dengan presisi. Pastikan tidak ada angka yang tertinggal sebelum menyelesaikan transfer.",
    icon: "#"
  };
}

function renderPaymentBox(invoice) {
  if (invoice.status === "paid") {
    paymentBox.innerHTML = `<div class="success-mark">✓</div>`;
    return;
  }

  if (["expired", "canceled", "failed"].includes(invoice.status)) {
    paymentBox.innerHTML = `
      <div class="closed-payment">
        <span>${invoice.status === "expired" ? "⏱" : "✕"}</span>
        <strong>${statusLabel(invoice.status)}</strong>
        <p>Invoice ini sudah tidak bisa dibayar. Silakan hubungi admin untuk dibuatkan link baru.</p>
      </div>
    `;
    return;
  }

  const type = inferPaymentType(invoice);
  const copy = paymentTypeCopy(type);
  const safeMethod = escapeHtml(invoice.method_name || invoice.method_code || "Metode pembayaran");
  const qrImage = invoice.qr_image ? `
    <div class="qr-frame">
      <img src="${escapeHtml(invoice.qr_image)}" alt="QR pembayaran ${safeMethod}" />
    </div>
  ` : "";
  const qrString = invoice.qr_string ? `
    <details class="qr-string-details">
      <summary>QR String</summary>
      <div class="copy-block">
        <span>Data QRIS mentah</span>
        <code>${escapeHtml(invoice.qr_string)}</code>
      </div>
    </details>
  ` : "";
  const payCode = invoice.pay_code ? `
    <div class="copy-block main-code">
      <span>Kode / VA / Rekening</span>
      <code>${escapeHtml(invoice.pay_code)}</code>
    </div>
  ` : "";
  const payButton = invoice.pay_url ? `
    <a class="primary-link pay-action" href="${escapeHtml(invoice.pay_url)}" target="_blank" rel="noopener">Buka Pembayaran Resmi</a>
  ` : "";

  paymentBox.innerHTML = `
    <section class="payment-instruction payment-${type}">
      <div class="payment-instruction-head">
        <span>${copy.icon}</span>
        <div>
          <small>${copy.badge} • ${safeMethod}</small>
          <strong>${copy.title}</strong>
          <p>${copy.desc}</p>
        </div>
      </div>
      <div class="payment-instruction-body">
        ${qrImage}
        ${payButton}
        ${payCode}
        ${qrString}
        ${!qrImage && !payButton && !payCode && !qrString ? `
          <div class="closed-payment pending-instruction">
            <span>↗</span>
            <strong>Instruksi Pembayaran Diproses</strong>
            <p>Provider belum mengirim detail pembayaran lengkap. Tunggu sebentar, halaman ini akan memperbarui otomatis.</p>
          </div>
        ` : ""}
      </div>
      <div class="payment-safety-note">Bayar sesuai total invoice. Jangan tutup halaman sampai status berubah atau simpan nomor invoice untuk pengecekan.</div>
    </section>
  `;
}

function renderStatusPanel(invoice) {
  if (!invoiceStatusPanel) return;

  const map = {
    pending: {
      cls: "status-panel status-pending-panel",
      icon: "⌛",
      title: "Menunggu pembayaran",
      desc: "Selesaikan pembayaran sebelum waktu expired. Status akan diperbarui otomatis setelah Flowix mengonfirmasi pembayaran."
    },
    paid: {
      cls: "status-panel status-paid-panel",
      icon: "✓",
      title: "Pembayaran berhasil",
      desc: "Invoice sudah PAID. Konten customer akan terbuka di bawah jika admin menambahkan text atau file."
    },
    expired: {
      cls: "status-panel status-expired-panel",
      icon: "⏱",
      title: "Invoice expired",
      desc: "Waktu pembayaran sudah habis. Link ini dikunci agar tidak ada pending lama yang masih bisa dibayar."
    },
    failed: {
      cls: "status-panel status-expired-panel",
      icon: "!",
      title: "Pembayaran gagal",
      desc: "Provider menandai invoice gagal. Silakan hubungi admin untuk dibuatkan invoice baru."
    },
    canceled: {
      cls: "status-panel status-expired-panel",
      icon: "✕",
      title: "Invoice dibatalkan",
      desc: "Invoice ini sudah dibatalkan dan tidak bisa digunakan untuk pembayaran."
    }
  };

  const data = map[invoice.status] || map.pending;
  invoiceStatusPanel.className = data.cls;
  invoiceStatusIcon.textContent = data.icon;
  invoiceStatusTitle.textContent = data.title;
  invoiceStatusDescription.textContent = data.desc;
}

function renderPaidDelivery(invoice) {
  if (!paidDelivery) return;
  const delivery = invoice.delivery || { type: "none" };

  if (invoice.status !== "paid" || !delivery || delivery.type === "none") {
    paidDelivery.classList.add("hidden");
    paidDelivery.innerHTML = "";
    return;
  }

  if (delivery.type === "text") {
    paidDelivery.innerHTML = `
      <div class="delivery-success-head">
        <span>Konten Customer</span>
        <b>Unlocked</b>
      </div>
      <pre>${escapeHtml(delivery.text)}</pre>
    `;
    paidDelivery.classList.remove("hidden");
    return;
  }

  if (delivery.type === "file") {
    const href = delivery.download_url || "#";
    paidDelivery.innerHTML = `
      <div class="delivery-success-head">
        <span>File Customer</span>
        <b>Unlocked</b>
      </div>
      <p>${escapeHtml(delivery.file_name || "file-customer")}</p>
      <a class="primary-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">Download File</a>
      <small class="delivery-hint">File hanya bisa diakses setelah status invoice PAID/success.</small>
    `;
    paidDelivery.classList.remove("hidden");
  }
}

function renderInvoice(invoice) {
  invoiceProduct.textContent = invoice.product_name;
  invoiceStatus.textContent = statusLabel(invoice.status);
  invoiceStatus.className = `status ${invoice.status}`;
  invoiceAmount.textContent = rupiah.format(invoice.amount_total);
  invoiceReff.textContent = invoice.id;
  invoiceMethod.textContent = invoice.method_name || invoice.method_code;
  invoiceExpired.textContent = formatInvoiceExpiry(invoice);
  paidNote.classList.toggle("hidden", invoice.status !== "paid");
  renderStatusPanel(invoice);
  renderPaidDelivery(invoice);
  renderPaymentBox(invoice);
}

async function loadInvoice(invoiceId) {
  try {
    const invoice = await api(`/api/invoices/${encodeURIComponent(invoiceId)}`);
    renderInvoice(invoice);

    window.clearTimeout(invoicePollTimer);
    if (invoice.status === "pending") {
      invoicePollTimer = window.setTimeout(() => loadInvoice(invoiceId), appConfig.invoice_poll_interval_ms || 8000);
    }
  } catch (error) {
    showToast(error.message);
  }
}


function installScrollHandoff() {
  const selectors = [
    ".side-card",
    ".admin-grid > .card",
    ".invoice-card",
    ".payment-box",
    ".invoice-list",
    ".copy-block code",
    ".paid-delivery pre"
  ];

  const getScrollableNodes = () => selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((node) => {
      if (!node || node.dataset.scrollHandoffBound === "1") return false;
      const style = window.getComputedStyle(node);
      return /(auto|scroll)/.test(style.overflowY) || node.scrollHeight > node.clientHeight + 2;
    });

  const canScroll = (node) => node && node.scrollHeight > node.clientHeight + 2;
  const isAtTop = (node) => node.scrollTop <= 1;
  const isAtBottom = (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1;

  function handoffWheel(event) {
    const node = event.currentTarget;
    if (!canScroll(node)) return;

    const deltaY = event.deltaY || 0;
    if (!deltaY) return;

    const shouldHandoffUp = deltaY < 0 && isAtTop(node);
    const shouldHandoffDown = deltaY > 0 && isAtBottom(node);

    if (shouldHandoffUp || shouldHandoffDown) {
      event.preventDefault();
      window.scrollBy({ top: deltaY, left: 0, behavior: "auto" });
    }
  }

  function bindNode(node) {
    node.dataset.scrollHandoffBound = "1";
    node.classList.add("scroll-handoff-active");
    node.addEventListener("wheel", handoffWheel, { passive: false });

    let lastTouchY = 0;
    node.addEventListener("touchstart", (event) => {
      lastTouchY = event.touches?.[0]?.clientY || 0;
    }, { passive: true });

    node.addEventListener("touchmove", (event) => {
      if (!canScroll(node)) return;
      const currentY = event.touches?.[0]?.clientY || 0;
      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;

      const shouldHandoffUp = deltaY < 0 && isAtTop(node);
      const shouldHandoffDown = deltaY > 0 && isAtBottom(node);

      if (shouldHandoffUp || shouldHandoffDown) {
        event.preventDefault();
        window.scrollBy({ top: deltaY, left: 0, behavior: "auto" });
      }
    }, { passive: false });
  }

  const bindAll = () => getScrollableNodes().forEach(bindNode);
  bindAll();

  const observer = new MutationObserver(() => bindAll());
  observer.observe(document.body, { childList: true, subtree: true });
}

async function boot() {
  installScrollHandoff();
  await loadConfig();
  const invoiceId = getInvoiceIdFromPath();

  if (invoiceId) {
    showOnly(checkoutView);
    await loadInvoice(invoiceId);
    return;
  }

  if (isAdminPath()) {
    await renderAdminState();
    return;
  }

  showOnly(homeView);
}

boot().catch((error) => showToast(error.message));
