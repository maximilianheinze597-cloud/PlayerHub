# PlayerHub

Fußball-PWA (HTML/CSS/JS) mit Supabase (Konten, Daten) und Firebase Cloud Messaging (Push). Hosting: GitHub Pages.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | gesamte App (UI + Logik) |
| `firebase-messaging-sw.js` | Service Worker: Push anzeigen, Klick-Ziel öffnen, Offline-Hülle (Netz zuerst) |
| `manifest.json`, `icon-*.png` | Installation als Home-Screen-App |
| `supabase/migrations/001_security_foundation.sql` | Rollen, RLS, Abstimmungen, Push-Tabellen |
| `supabase/functions/send-push/index.ts` | Push-Versand über FCM (nur Admins) |

## Einrichtung (einmalig)

1. **Backup** in Supabase prüfen, dann `supabase/migrations/001_security_foundation.sql` im SQL-Editor ausführen.
2. **Admin setzen** (SQL-Editor): `update public.profiles set role='admin' where id=(select id from auth.users where email='DEINE-MAIL');`
3. **Edge-Function-Secrets** in Supabase: `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` (aus dem Firebase-Dienstkonto). Optional `APP_URL`.
4. GitHub-Secret `SUPABASE_ACCESS_TOKEN` setzen, damit der Workflow die Function deployt.
5. Supabase → Authentication → URL-Konfiguration: Site-URL und Redirect-URL auf `https://maximilianheinze597-cloud.github.io/PlayerHub/` setzen (für E-Mail-Bestätigung und Passwort-Reset).

## Rechte

| Aktion | Nutzer | Admin |
|---|---|---|
| Spieler, News, Abstimmungen lesen | ja | ja |
| Eigenen Anzeigenamen ändern | ja | ja |
| Abstimmen (eine Stimme pro Abstimmung, serverseitig) | ja | ja |
| Spieler/News/Abstimmungen anlegen, ändern, löschen | nein | ja |
| Push senden, Push-Log lesen | nein | ja |
| Rollen ändern | nein | nein (nur SQL-Editor/service_role) |

Rechte werden von Postgres-RLS und der Funktion `is_admin()` erzwungen, nicht vom Browser. Der frühere Admin-Code ist entfernt.

## OVR (20–99), deterministisch

`base = 20 + min(35, Ø-Bewertung·4,2) + min(12, Spiele·0,45) + min(15, Tore·2,2) + min(10, Vorlagen·1,4) + min(6, Schüsse·0,18) − Gelb·0,7 − Rot·3 − (gesperrt: 2)`
Feldspieler: `+ min(7, Schüsse aufs Tor·0,3)`. Torhüter (TW): `+ min(12, Paraden·0,45) + min(8, Zu-Null·1,2)`.
Ohne Bewertungen gilt Ø = 6 (vorläufig). Ergebnis auf 20–99 begrenzt. „Form“ = letzte Spielbewertung, „Ø“ = Durchschnitt aller Bewertungen, „Kickbase-Punkte“ = eigener Punktwert. Das sind drei getrennte Größen.

## Push – was wirklich geprüft wird

Die App unterscheidet: Berechtigung erteilt → Gerät registriert → vom Push-Dienst **angenommen** → angezeigt. Nur die ersten drei werden gemeldet; „angezeigt“ kann nur am Gerät beobachtet werden.
iPhone: Web-Push funktioniert nur, wenn PlayerHub über Safari → Teilen → „Zum Home-Bildschirm“ installiert und von dort geöffnet wurde; die Berechtigung wird per Tippen auf „Push aktivieren“ angefragt.
Admin-Test: Verwaltung → „Test senden“ schickt nur an die eigenen Geräte. Jeder Versand steht (ohne Tokens) in `push_log`.

## Bekannte Lücken

- Spieler des Monats wird noch nicht als Wahl mit gespeichertem Ergebnis geführt; Kapitänswahl, Abstimmungszeiträume, News-Entwürfe/Bearbeiten, Spieler-Selbstbearbeitung und Spielberichte fehlen noch.
- Stimmen liegen als JSON mit Nutzer-IDs in `votes`; für geheime Wahlen muss das auf eine eigene Tabelle umgestellt werden.
- Spielerbilder liegen noch als Base64 in der Tabelle (Supabase Storage wäre besser).
