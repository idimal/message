// client/sw.js

self.addEventListener("push", event => {
    let data = {};
  
    if (event.data) {
      try {
        data = event.data.json();
      } catch (e) {
        data = { body: event.data.text() };
      }
    }
  
    const title = data.title || "Новое сообщение";
    const url = data.url || "/";
  
    const options = {
      body: data.body || "",
      icon: data.icon || "/icons/icon-192.png",
      badge: data.badge || "/icons/badge-72.png",
      data: { url },
      tag: data.tag || "chat-message",
      renotify: true
    };
  
    event.waitUntil(self.registration.showNotification(title, options));
  });
  
  self.addEventListener("notificationclick", event => {
    event.notification.close();
  
    const url = event.notification.data?.url || "/";
  
    event.waitUntil(
      clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
        for (const client of list) {
          if (client.url === new URL(url, self.location.origin).href && "focus" in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
    );
  });