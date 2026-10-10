import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = Deno.env.get("APP_URL") ||
  "https://maximilianheinze597-cloud.github.io/PlayerHub/";
const APP_ORIGIN = new URL(APP_URL).origin;

const cors = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function base64url(input: Uint8Array) {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeJson(value: unknown) {
  return base64url(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

function pemToArrayBuffer(pem: string) {
  const clean = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function getGoogleAccessToken() {
  const projectId = Deno.env.get("FCM_PROJECT_ID");
  const clientEmail = Deno.env.get("FCM_CLIENT_EMAIL");
  const privateKeyRaw = Deno.env.get("FCM_PRIVATE_KEY");

  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error("FCM-Secrets fehlen.");
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);

  const header = encodeJson({
    alg: "RS256",
    typ: "JWT",
  });

  const payload = encodeJson({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });

  const unsigned = `${header}.${payload}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );

  const jwt = `${unsigned}.${base64url(new Uint8Array(signature))}`;

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    },
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error_description ||
        "Google-Zugriffstoken konnte nicht erstellt werden.",
    );
  }

  return {
    accessToken: result.access_token,
    projectId,
  };
}

const ALLOWED_TYPES = new Set(["news", "potm", "test", "general"]);

function clip(value: unknown, max: number, fallback: string) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, max);
}

// Nur Links innerhalb der App zulassen (relativ wie "?news=<id>" oder gleiche Adresse).
function safeUrl(value: unknown) {
  try {
    const u = new URL(String(value || ""), APP_URL);
    return u.origin === APP_ORIGIN ? u.toString() : APP_URL;
  } catch {
    return APP_URL;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "POST erforderlich." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Authorization fehlt." }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace(/^Bearer\s+/i, ""),
    );
    if (userError || !user) return json({ error: "Nicht angemeldet." }, 401);

    // Rolle immer aus der Datenbank lesen, nie aus dem Client.
    const { data: profile, error: profileError } = await supabase
      .from("profiles").select("role").eq("id", user.id).single();
    if (profileError) return json({ error: "Profil konnte nicht geprüft werden." }, 500);
    if (profile?.role !== "admin") {
      return json({ error: "Nur Admins dürfen Push senden." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const title = clip(body?.title, 80, "PlayerHub");
    const message = clip(body?.body, 240, "Es gibt etwas Neues bei PlayerHub.");
    const type = ALLOWED_TYPES.has(String(body?.type)) ? String(body.type) : "general";
    const target = body?.target === "self" ? "self" : "all";
    const url = safeUrl(body?.url);

    let query = supabase.from("push_subscriptions").select("token");
    if (target === "self") query = query.eq("user_id", user.id);
    const { data: subscriptions, error } = await query;
    if (error) return json({ error: "Geräte konnten nicht geladen werden." }, 500);

    const tokens = [...new Set((subscriptions || []).map((x) => x.token).filter(Boolean))];

    let accepted = 0;
    let failed = 0;
    const deadTokens: string[] = [];
    const errorCodes: Record<string, number> = {};

    if (tokens.length) {
      const { accessToken, projectId } = await getGoogleAccessToken();

      // Reine Daten-Nachricht: der Service Worker zeigt sie selbst an.
      // (Mit "notification"-Feld würden Browser und Service Worker doppelt anzeigen.)
      const send = async (token: string) => {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token,
                data: { title, body: message, type, url },
                webpush: { headers: { Urgency: "high", TTL: "86400" } },
              },
            }),
          },
        );

        if (response.ok) {
          accepted++;
          return;
        }

        failed++;
        let code = `HTTP_${response.status}`;
        try {
          const err = await response.json();
          const details = err?.error?.details || [];
          const fcm = details.find((d: { errorCode?: string }) => d?.errorCode);
          code = fcm?.errorCode || err?.error?.status || code;
        } catch { /* Antwort war kein JSON */ }

        errorCodes[code] = (errorCodes[code] || 0) + 1;
        // Nur Tokens entfernen, die FCM ausdrücklich als nicht (mehr) registriert meldet.
        if (code === "UNREGISTERED" || code === "NOT_FOUND") deadTokens.push(token);
      };

      for (let i = 0; i < tokens.length; i += 20) {
        await Promise.all(tokens.slice(i, i + 20).map(send));
      }

      if (deadTokens.length) {
        await supabase.from("push_subscriptions").delete().in("token", deadTokens);
      }
    }

    // Protokoll ohne Tokens oder Schlüssel.
    const { error: logError } = await supabase.from("push_log").insert({
      sent_by: user.id,
      type,
      title,
      target,
      attempted: tokens.length,
      accepted,
      failed,
      removed: deadTokens.length,
      error_codes: Object.keys(errorCodes).length ? errorCodes : null,
    });
    if (logError) console.error("push_log:", logError.message);

    return json({
      success: true,
      type,
      target,
      attempted: tokens.length,
      accepted, // vom Push-Dienst angenommen, NICHT = auf dem Gerät angezeigt
      failed,
      removed: deadTokens.length,
      errors: errorCodes,
      message: tokens.length ? undefined : "Noch kein Gerät für Push registriert.",
    });
  } catch (error) {
    console.error("send-push:", error instanceof Error ? error.message : "Unbekannter Fehler");
    return json(
      { success: false, error: error instanceof Error ? error.message : "Unbekannter Fehler" },
      500,
    );
  }
});
