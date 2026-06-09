self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = { title: "Flowix Paylink", body: event.data ? event.data.text() : "Ada update invoice." };
  }

  const title = payload.title || "Flowix Paylink";
  const options = {
    body: payload.body || "Ada pembayaran invoice terbaru.",
    tag: payload.tag || "flowix-paylink-notification",
    renotify: true,
    requireInteraction: true,
    data: payload.data || { url: payload.url || "/admin" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/admin";

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const absoluteUrl = new URL(targetUrl, self.location.origin).href;

    for (const client of allClients) {
      if (client.url === absoluteUrl && "focus" in client) return client.focus();
    }

    if (clients.openWindow) return clients.openWindow(absoluteUrl);
    return undefined;
  })());
});
