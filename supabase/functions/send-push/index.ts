import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "POST erforderlich." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return json(
        { error: "Authorization fehlt." },
        401,
      );
    }

    const userToken = authHeader.replace(
      /^Bearer\s+/i,
      "",
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(userToken);

    if (userError || !user) {
      return json(
        { error: "Nicht angemeldet." },
        401,
      );
    }

    const { data: profile, error: profileError } =
      await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

    if (profileError) {
      return json(
        { error: profileError.message },
        500,
      );
    }

    if (profile?.role !== "admin") {
      return json(
        { error: "Nur Admins dürfen Push senden." },
        403,
      );
    }

    const body = await req.json().catch(() => ({}));

    const title = String(
      body?.title || "PlayerHub",
    );

    const message = String(
      body?.body ||
        "Es gibt etwas Neues bei PlayerHub.",
    );

    const type = String(
      body?.type || "general",
    );

    const { data: subscriptions, error } =
      await supabase
        .from("push_subscriptions")
        .select("token");

    if (error) {
      return json({ error: error.message }, 500);
    }

    const tokens = [
      ...new Set(
        (subscriptions || [])
          .map((x) => x.token)
          .filter(Boolean),
      ),
    ];

    if (!tokens.length) {
      return json({
        success: true,
        sent: 0,
        removed: 0,
        message:
          "Noch kein Gerät für Push registriert.",
      });
    }

    const { accessToken, projectId } =
      await getGoogleAccessToken();

    let sent = 0;
    const deadTokens: string[] = [];

    for (const token of tokens) {
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

              notification: {
                title,
                body: message,
              },

              data: {
                type,
                url:
                  "https://maximilianheinze597-cloud.github.io/PlayerHub/",
              },

              webpush: {
                fcm_options: {
                  link:
                    "https://maximilianheinze597-cloud.github.io/PlayerHub/",
                },
              },
            },
          }),
        },
      );

      if (response.ok) {
        sent++;
      } else {
        const errorText = await response.text();

        if (
          /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/i.test(
            errorText,
          )
        ) {
          deadTokens.push(token);
        } else {
          console.error(
            "FCM Fehler:",
            errorText,
          );
        }
      }
    }

    if (deadTokens.length) {
      await supabase
        .from("push_subscriptions")
        .delete()
        .in("token", deadTokens);
    }

    return json({
      success: true,
      sent,
      removed: deadTokens.length,
      type,
    });
  } catch (error) {
    console.error(error);

    return json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unbekannter Fehler",
      },
      500,
    );
  }
});
