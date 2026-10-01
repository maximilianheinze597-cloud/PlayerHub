importScripts("https://www.gstatic.com/firebasejs/12.3.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.3.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDc9AIpeiloHQplOlh7tpkdLCQlX8siQgA",
  authDomain: "playerhub-3b588.firebaseapp.com",
  projectId: "playerhub-3b588",
  storageBucket: "playerhub-3b588.firebasestorage.app",
  messagingSenderId: "288970150411",
  appId: "1:288970150411:web:7f8e9d8abcd009925ded0e"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("PlayerHub Push:", payload);

  const title =
    payload.notification?.title ||
    payload.data?.title ||
    "PlayerHub";

  const options = {
    body:
      payload.notification?.body ||
      payload.data?.body ||
      "Es gibt etwas Neues bei PlayerHub.",
    icon: "/PlayerHub/icon-192.png",
    badge: "/PlayerHub/icon-192.png",
    data: {
      url:
        payload.data?.url ||
        "https://maximilianheinze597-cloud.github.io/PlayerHub/"
    }
  };

  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url =
    event.notification.data?.url ||
    "https://maximilianheinze597-cloud.github.io/PlayerHub/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
