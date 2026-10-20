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
        const { sessionToken, expires, domain, courses, occurrences, passwords, sesskey } = body;

        if (!sessionToken) {
          return new Response(JSON.stringify({ error: "Missing sessionToken" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // Store session and course configurations in Cloudflare KV
        const sessionRecord = {
          sessionToken,
          domain: domain || "spectrum.um.edu.my",
          expires: expires || null,
          courses: courses || [],
          occurrences: occurrences || {},
          passwords: passwords || {},
          sesskey: sesskey || "",
          updatedAt: Date.now()
        };

        if (env.SPECTRA_KV) {
          await env.SPECTRA_KV.put("moodle_session", JSON.stringify(sessionRecord));
        }

        return new Response(JSON.stringify({
          success: true,
          message: "MoodleSession and attendance settings synchronized to Cloud Relay KV.",
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
        coursesCount: record?.courses?.length || 0,
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
    // 1. Fetch SPeCTRUM calendar upcoming to verify session and check upcoming tasks
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
          `⚠️ <b>Spectra Relay Warning</b>\nYour UM SPeCTRUM session has expired. Please open SPeCTRUM in your browser to renew your login.`
        );
      }
      return { status: "expired" };
    }

    console.log("[Spectra Relay] Successfully authenticated to SPeCTRUM via Cloud Relay.");

    // 2. 24/7 Cloud Attendance Scanner & Auto-Submission
    const attendanceResult = await checkAndRecordCloudAttendance(env, sessionData);

    return {
      status: "ok",
      timestamp: Date.now(),
      attendanceChecked: attendanceResult.checked,
      attendanceRecorded: attendanceResult.recorded
    };
  } catch (err) {
    console.error("[Spectra Relay] Polling job failed:", err);
    return { status: "error", message: err.message };
  }
}

/**
 * 24/7 Cloud Attendance Scanner & Self-Checkin Routine
 */
async function checkAndRecordCloudAttendance(env, sessionData) {
  const { sessionToken, courses = [], occurrences = {}, passwords = {} } = sessionData;
  if (!courses || courses.length === 0) {
    return { checked: 0, recorded: 0 };
  }

  const cookieHeader = `MoodleSession=${sessionToken}`;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  let recordedSessids = new Set();
  if (env.SPECTRA_KV) {
    const rawRecorded = await env.SPECTRA_KV.get("recorded_sessids");
    if (rawRecorded) {
      try {
        recordedSessids = new Set(JSON.parse(rawRecorded));
      } catch (_) {}
    }
  }

  let recordedCount = 0;
  let checkedCourses = 0;

  for (const course of courses) {
    const courseId = course.id;
    const courseCode = course.code || course.id;
    const studentOcc = occurrences[courseId] || occurrences[courseCode] || "";
    const storedPwd = passwords[courseId] || passwords[courseCode] || "";

    try {
      // 1. Discover attendance view URL via /mod/attendance/index.php
      const indexRes = await fetch(`https://spectrum.um.edu.my/mod/attendance/index.php?id=${encodeURIComponent(courseId)}`, {
        headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
      });
      if (!indexRes.ok) continue;
      const indexHtml = await indexRes.text();

      // Extract attendance view link(s)
      const viewMatches = indexHtml.match(/href=["']([^"']*\/mod\/attendance\/view\.php\?[^"']*)["']/gi) || [];
      if (viewMatches.length === 0) continue;

      checkedCourses++;

      for (const rawMatch of viewMatches) {
        const urlMatch = rawMatch.match(/href=["']([^"']+)["']/i);
        if (!urlMatch) continue;
        let viewUrl = urlMatch[1];
        if (!viewUrl.startsWith("http")) {
          viewUrl = `https://spectrum.um.edu.my/${viewUrl.replace(/^\//, "")}`;
        }

        // Fetch All sessions view (view=5)
        const allViewUrl = viewUrl.includes("view=") ? viewUrl.replace(/view=\d+/, "view=5") : `${viewUrl}&view=5`;

        const viewRes = await fetch(allViewUrl, {
          headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
        });
        if (!viewRes.ok) continue;
        const viewHtml = await viewRes.text();

        // Check for self-recording submit links: attendance.php?sessid=...
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowM;
        while ((rowM = rowRegex.exec(viewHtml)) !== null) {
          const rowHtml = rowM[1];
          const submitM = rowHtml.match(/href=["']([^"']*attendance\.php\?sessid=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
          if (!submitM) continue;

          const submitUrl = submitM[1];
          const sessid = submitM[2];

          // Skip if already submitted
          if (recordedSessids.has(sessid)) continue;

          // Extract table cells
          const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          const cells = [];
          let cM;
          while ((cM = cellRegex.exec(rowHtml)) !== null) {
            cells.push(cM[1].replace(/<[^>]+>/g, "").trim());
          }

          const dateText = cells[0] || "Today";
          const timeText = cells[1] || "";
          const groupText = cells.length >= 6 ? cells[2] : "All students";
          const descText = cells.length >= 6 ? cells[3] : cells[2] || "Class Session";

          // Occurrence filter check
          if (studentOcc && !matchesOccurrence(groupText, studentOcc, descText)) {
            continue;
          }

          // Fetch attendance form
          const formTargetUrl = submitUrl.startsWith("http")
            ? submitUrl
            : `https://spectrum.um.edu.my/${submitUrl.replace(/^\//, "")}`;

          const formRes = await fetch(formTargetUrl, {
            headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
          });
          if (!formRes.ok) continue;
          const formHtml = await formRes.text();

          // Extract sesskey, sessid, and statusId for Present
          const sesskeyM = formHtml.match(/name=["']sesskey["']\s+value=["']([^"']+)["']/i) || formHtml.match(/"sesskey":"([^"]+)"/);
          const formSesskey = sesskeyM ? sesskeyM[1] : (sessionData.sesskey || "");

          const formSessidM = formHtml.match(/name=["']sessid["']\s+value=["']([^"']+)["']/i);
          const formSessid = formSessidM ? formSessidM[1] : sessid;

          let statusId = null;
          const radioRegex = /<input[^>]+type=["']radio["'][^>]+name=["']status["'][^>]+value=["'](\d+)["'][^>]*>([\s\S]*?)<\/label>/gi;
          let rMatch;
          while ((rMatch = radioRegex.exec(formHtml)) !== null) {
            if (/present|hadir/i.test(rMatch[2])) {
              statusId = rMatch[1];
              break;
            }
          }

          if (!statusId) continue;

          // Check if password required
          const requiresPassword = /<input[^>]+name=["'](studentpassword|password)["']/i.test(formHtml);
          if (requiresPassword && !storedPwd) {
            if (botToken && chatId) {
              await dispatchTelegram(
                botToken,
                chatId,
                `⚠️ <b>Spectra Cloud Relay: Attendance Password Required</b>\n` +
                `<b>Course:</b> ${courseCode}\n` +
                `<b>Session:</b> ${descText} (${dateText} ${timeText})\n` +
                `Please enter the attendance password in Spectra settings.`
              );
            }
            continue;
          }

          // Submit check-in POST
          let bodyStr = "";
          if (typeof URLSearchParams !== "undefined") {
            const postParams = new URLSearchParams();
            postParams.append("sessid", formSessid);
            postParams.append("sesskey", formSesskey);
            postParams.append("mform_is_submitted", "1");
            postParams.append("status", statusId);
            postParams.append("submitbutton", "Save changes");
            if (storedPwd) {
              postParams.append("studentpassword", storedPwd);
              postParams.append("password", storedPwd);
            }
            bodyStr = postParams.toString();
          } else {
            const parts = [
              `sessid=${encodeURIComponent(formSessid)}`,
              `sesskey=${encodeURIComponent(formSesskey)}`,
              "mform_is_submitted=1",
              `status=${encodeURIComponent(statusId)}`,
              `submitbutton=${encodeURIComponent("Save changes")}`
            ];
            if (storedPwd) {
              parts.push(`studentpassword=${encodeURIComponent(storedPwd)}`);
              parts.push(`password=${encodeURIComponent(storedPwd)}`);
            }
            bodyStr = parts.join("&");
          }

          const postRes = await fetch("https://spectrum.um.edu.my/mod/attendance/attendance.php", {
            method: "POST",
            headers: {
              "Cookie": cookieHeader,
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0"
            },
            body: bodyStr
          });

          if (postRes.ok) {
            recordedSessids.add(sessid);
            recordedCount++;

            if (botToken && chatId) {
              await dispatchTelegram(
                botToken,
                chatId,
                `✅ <b>Spectra Cloud Relay: Auto-Attendance Recorded!</b>\n` +
                `<b>Course:</b> ${courseCode}\n` +
                `<b>Occurrence:</b> ${studentOcc || "General"}\n` +
                `<b>Session:</b> ${descText} (${dateText} ${timeText})\n` +
                `<b>Status:</b> Present\n` +
                `<i>Submitted automatically 24/7 via Cloudflare Relay!</i>`
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Spectra Relay] Error checking attendance for ${courseCode}:`, err);
    }
  }

  if (env.SPECTRA_KV && recordedCount > 0) {
    await env.SPECTRA_KV.put("recorded_sessids", JSON.stringify(Array.from(recordedSessids)));
  }

  return { checked: checkedCourses, recorded: recordedCount };
}

function matchesOccurrence(groupStr, studentOcc, descStr = "") {
  if (!studentOcc || studentOcc.trim().toLowerCase() === "all") return true;
  const targetOcc = studentOcc.trim().toLowerCase();
  const targetNum = targetOcc.replace(/\D+/g, "");

  const g = String(groupStr || "").trim().toLowerCase();
  const d = String(descStr || "").trim().toLowerCase();

  if (g.includes(targetOcc) || d.includes(targetOcc)) return true;

  if (targetNum) {
    const numRegex = new RegExp(`\\b(?:occ|occurrence|kumpulan|group)\\s*#?\\s*0*${targetNum}\\b`, "i");
    if (numRegex.test(g) || numRegex.test(d)) return true;
  }

  if (g === "all students" || g === "semua pelajar" || g === "" || g === "all") {
    const otherOccRegex = /\b(?:occ|occurrence|kumpulan|group)\s*#?\s*\d+\b/i;
    if (otherOccRegex.test(d)) {
      return targetNum ? new RegExp(`\\b(?:occ|occurrence|kumpulan|group)\\s*#?\\s*0*${targetNum}\\b`, "i").test(d) : false;
    }
    return true;
  }

  return false;
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
