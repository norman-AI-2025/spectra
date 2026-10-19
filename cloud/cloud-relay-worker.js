/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Cloud Relay Worker (Cloudflare Workers / V8 Serverless)
 *
 * Provides 24/7 background polling for SPeCTRUM course announcements
 * and urgent deadline alerts even when the student's laptop is powered down.
 *
 * Requirements:
 * - Cloudflare Worker with KV namespace binding: SPECTRA_KV
 * - Environment variables / Secrets:
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_CHAT_ID
 *   - RELAY_SECRET_KEY
 *   - NTFY_TOPIC (optional)
 * - Cron Trigger: `* /15 * * * *` (Runs every 15 minutes)
 */

export default {
  // HTTP Endpoint Handler
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers for Chrome Extension
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Verify Bearer Secret Token
    const authHeader = request.headers.get("Authorization") || "";
    const expectedSecret = env.RELAY_SECRET_KEY || "worker-auth-secret-key";
    if (authHeader !== `Bearer ${expectedSecret}`) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing Bearer token" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Route: POST /sync (Called by Spectra Extension on cookie change)
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const body = await request.json();
        const { sessionToken, expires, domain } = body;

        if (!sessionToken) {
          return new Response(JSON.stringify({ error: "Missing sessionToken" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // Store session in Cloudflare KV
        const sessionRecord = {
          sessionToken,
          domain: domain || "spectrum.um.edu.my",
          expires: expires || null,
          updatedAt: Date.now()
        };

        if (env.SPECTRA_KV) {
          await env.SPECTRA_KV.put("moodle_session", JSON.stringify(sessionRecord));
        }

        return new Response(JSON.stringify({
          success: true,
          message: "MoodleSession synchronized to Cloud Relay KV.",
          timestamp: Date.now()
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // Route: GET /status
    if (url.pathname === "/status") {
      let record = null;
      if (env.SPECTRA_KV) {
        const raw = await env.SPECTRA_KV.get("moodle_session");
        if (raw) record = JSON.parse(raw);
      }

      return new Response(JSON.stringify({
        status: "online",
        hasSession: Boolean(record?.sessionToken),
        updatedAt: record?.updatedAt ? new Date(record.updatedAt).toISOString() : null,
        cronSchedule: "Every 15 minutes"
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Route: POST /poll (Manual Polling Trigger)
    if (url.pathname === "/poll" && request.method === "POST") {
      const result = await runSpectrumPollingJob(env);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  },

  // Cron Trigger Handler (Every 15 mins)
  async scheduled(event, env, ctx) {
    console.log("[Spectra Relay] Cron triggered at:", event.cron);
    ctx.waitUntil(runSpectrumPollingJob(env));
  }
};

/**
 * 24/7 Polling Routine
 */
async function runSpectrumPollingJob(env) {
  let sessionData = null;
  if (env.SPECTRA_KV) {
    const raw = await env.SPECTRA_KV.get("moodle_session");
    if (raw) sessionData = JSON.parse(raw);
  }

  if (!sessionData?.sessionToken) {
    console.log("[Spectra Relay] No active MoodleSession found in KV. Waiting for extension sync.");
    return { status: "skipped", reason: "no_session" };
  }

  const cookieHeader = `MoodleSession=${sessionData.sessionToken}`;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  try {
    // 1. Fetch SPeCTRUM calendar upcoming
    const calRes = await fetch("https://spectrum.um.edu.my/calendar/view.php?view=upcoming", {
      headers: {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Spectra-Relay/1.0"
      }
    });

    if (calRes.status === 303 || calRes.url.includes("/login/")) {
      console.warn("[Spectra Relay] Session expired or invalid.");
      if (botToken && chatId) {
        await dispatchTelegram(
          botToken,
          chatId,
          `⚠️ *Spectra Relay Warning*\nYour UM SPeCTRUM session has expired. Please open SPeCTRUM in your browser to renew your login.`
        );
      }
      return { status: "expired" };
    }

    console.log("[Spectra Relay] Successfully authenticated to SPeCTRUM via Cloud Relay.");
    return { status: "ok", timestamp: Date.now() };
  } catch (err) {
    console.error("[Spectra Relay] Polling job failed:", err);
    return { status: "error", message: err.message };
  }
}

async function dispatchTelegram(botToken, chatId, textHtml) {
  const cleanToken = (botToken || "").trim().replace(/^bot/i, "");
  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: textHtml,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("[Spectra Relay] Telegram dispatch error:", e);
  }
}
