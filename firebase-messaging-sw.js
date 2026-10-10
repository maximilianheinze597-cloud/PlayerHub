importScripts("https://www.gstatic.com/firebasejs/12.3.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.3.0/firebase-messaging-compat.js");

/* Dieser eine Service Worker erledigt zwei Aufgaben (pro Scope ist nur einer möglich):
   1. Firebase-Push anzeigen und beim Klick die richtige Seite öffnen
   2. App-Hülle für Offline-Start cachen, aber immer zuerst das Netz fragen,
      damit nach einem Update nie veraltete Dateien ausgeliefert werden. */

const CACHE = "playerhub-shell-v2";
const SHELL = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];

firebase.initializeApp({
  apiKey: "AIzaSyDc9AIpeiloHQplOlh7tpkdLCQlX8siQgA",
  authDomain: "playerhub-3b588.firebaseapp.com",
  projectId: "playerhub-3b588",
  storageBucket: "playerhub-3b588.firebasestorage.app",
  messagingSenderId: "288970150411",
  appId: "1:288970150411:web:7f8e9d8abcd009925ded0e"
});

const messaging = firebase.messaging();

// Der Server sendet reine Daten-Nachrichten (ohne "notification"-Feld),
// deshalb zeigt ausschließlich dieser Handler die Meldung an – keine Duplikate.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || payload.notification?.title || "PlayerHub";

  return self.registration.showNotification(title, {
    body: d.body || payload.notification?.body || "Es gibt etwas Neues bei PlayerHub.",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.type ? `playerhub-${d.type}` : undefined,
    data: { url: d.url || self.registration.scope }
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  let target = self.registration.scope;
  try {
    const u = new URL(event.notification.data?.url || target, self.registration.scope);
    if (u.origin === self.location.origin) target = u.toString();
  } catch (e) { /* ungültige URL: Startseite öffnen */ }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          try { await client.navigate(target); } catch (e) { /* ignorieren */ }
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(target) : undefined;
    })
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("playerhub-shell-") && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Netz zuerst, Cache nur als Offline-Fallback. Nur eigene Dateien (GET):
// Supabase- und Firebase-Anfragen laufen unverändert am Cache vorbei.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) =>
          hit || (req.mode === "navigate" ? caches.match("index.html") : undefined)
        )
      )
  );
});
