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
        cronSchedule: "Every 1 minute"
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

    // 3. 24/7 Cloud Submission Deadline Scanner & Urgent Alert Dispatch
    const deadlineResult = await checkCloudDeadlines(env, sessionData);

    // 4. 24/7 Cloud Course Announcement Scanner & Telegram Dispatch
    const announcementResult = await checkCloudAnnouncements(env, sessionData);

    return {
      status: "ok",
      timestamp: Date.now(),
      attendanceChecked: attendanceResult.checked,
      attendanceRecorded: attendanceResult.recorded,
      deadlinesChecked: deadlineResult.checked,
      deadlinesAlerted: deadlineResult.alerted,
      announcementsChecked: announcementResult.checked,
      announcementsSent: announcementResult.sent
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
          const sesskeyM = formHtml.match(/name=["']sesskey["'][^>]*value=["']([^"']+)["']/i) ||
                           formHtml.match(/value=["']([^"']+)["'][^>]*name=["']sesskey["']/i) ||
                           formHtml.match(/"sesskey":"([^"]+)"/);
          const formSesskey = sesskeyM ? sesskeyM[1] : (sessionData.sesskey || "");

          const formSessidM = formHtml.match(/name=["']sessid["'][^>]*value=["']([^"']+)["']/i) ||
                              formHtml.match(/value=["']([^"']+)["'][^>]*name=["']sessid["']/i);
          const formSessid = formSessidM ? formSessidM[1] : sessid;

          let statusId = null;
          const inputStatusRegex = /<input[^>]*name=["']status["'][^>]*>/gi;
          let inMatch;
          while ((inMatch = inputStatusRegex.exec(formHtml)) !== null) {
            const tagStr = inMatch[0];
            const valM = tagStr.match(/value=["'](\d+)["']/i);
            const idM = tagStr.match(/id=["']([^"']+)["']/i);
            if (!valM) continue;
            const val = valM[1];

            let isPresent = false;
            if (idM) {
              const labelForRegex = new RegExp(`<label[^>]*for=["']${idM[1]}["'][^>]*>([\\s\\S]*?)<\\/label>`, "i");
              const lMatch = formHtml.match(labelForRegex);
              if (lMatch && /present|hadir|^p\b/i.test(lMatch[1].replace(/<[^>]+>/g, "").trim())) {
                isPresent = true;
              }
            }
            if (!isPresent) {
              const afterInput = formHtml.substring(inputStatusRegex.lastIndex, inputStatusRegex.lastIndex + 300);
              const nextLabelM = afterInput.match(/^[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>/i);
              if (nextLabelM && /present|hadir|^p\b/i.test(nextLabelM[1].replace(/<[^>]+>/g, "").trim())) {
                isPresent = true;
              }
            }
            if (!isPresent) {
              const surrounding = formHtml.substring(Math.max(0, inMatch.index - 50), Math.min(formHtml.length, inMatch.index + 200));
              if (/present|hadir/i.test(surrounding)) {
                isPresent = true;
              }
            }
            if (isPresent) {
              statusId = val;
              break;
            }
          }

          if (!statusId) {
            const anyRadio = formHtml.match(/name=["']status["'][^>]*value=["'](\d+)["']/i) ||
                             formHtml.match(/value=["'](\d+)["'][^>]*name=["']status["']/i);
            if (anyRadio) statusId = anyRadio[1];
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

/**
 * 24/7 Cloud Deadline Scanner & Telegram Urgent Alert Routine
 */
async function checkCloudDeadlines(env, sessionData) {
  const { sessionToken, courses = [], occurrences = {} } = sessionData;
  if (!courses || courses.length === 0) {
    return { checked: 0, alerted: 0 };
  }

  const cookieHeader = `MoodleSession=${sessionToken}`;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return { checked: 0, alerted: 0 };
  }

  let alertedDeadlineIds = new Set();
  if (env.SPECTRA_KV) {
    const rawAlerted = await env.SPECTRA_KV.get("alerted_deadline_ids");
    if (rawAlerted) {
      try {
        alertedDeadlineIds = new Set(JSON.parse(rawAlerted));
      } catch (_) {}
    }
  }

  let alertedCount = 0;
  let checkedCourses = 0;
  const now = Date.now();

  for (const course of courses) {
    const courseId = course.id;
    const courseCode = course.code || course.id;
    const studentOcc = occurrences[courseId] || occurrences[courseCode] || "";

    try {
      // Check /mod/assign/index.php?id=...
      const res = await fetch(`https://spectrum.um.edu.my/mod/assign/index.php?id=${encodeURIComponent(courseId)}`, {
        headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
      });
      if (!res.ok) continue;
      const html = await res.text();
      checkedCourses++;

      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(html)) !== null) {
        const rowHtml = rowMatch[1];
        const linkMatch = rowHtml.match(/<a[^>]+href=["']([^"']*mod\/assign\/view\.php\?id=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;

        const assignUrl = linkMatch[1];
        const cmid = linkMatch[2];
        const rawTitle = linkMatch[3].replace(/<[^>]+>/g, "").trim();

        // Skip if already alerted
        if (alertedDeadlineIds.has(cmid)) continue;

        // Occurrence filter
        if (!matchesOccurrence("", studentOcc, rawTitle)) continue;

        // Extract cells
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const cells = [];
        let cM;
        while ((cM = cellRegex.exec(rowHtml)) !== null) {
          cells.push(cM[1].replace(/<[^>]+>/g, "").trim());
        }

        let dueDateText = "";
        let submissionStatusText = "";
        for (const c of cells) {
          if (c.includes(rawTitle)) continue;
          if (!dueDateText && (/\d{1,2}[:.]\d{2}/.test(c) || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|okt|mac|mei|ogo|dis)\b/i.test(c) || /\d{1,2}[\/\.\-]\d{1,2}/.test(c))) {
            dueDateText = c;
          } else if (!submissionStatusText && c && !/^(week|minggu|topic|topik|\d+)$/i.test(c)) {
            submissionStatusText = c;
          }
        }

        const isSubmitted = /submitted|graded|selesai|dihantar/i.test(submissionStatusText) && !/no submission|not submitted|belum/i.test(submissionStatusText);
        if (isSubmitted) continue;

        const dueTimestamp = dueDateText ? parseWorkerDateString(dueDateText) : null;
        if (!dueTimestamp) continue;

        const diffHours = (dueTimestamp - now) / (1000 * 60 * 60);
        if (diffHours > 0 && diffHours <= 24) {
          // Urgent deadline (< 24h)
          const hoursLeft = Math.max(1, Math.round(diffHours));
          const fullUrl = assignUrl.startsWith("http") ? assignUrl : `https://spectrum.um.edu.my/${assignUrl.replace(/^\//, "")}`;

          await dispatchTelegram(
            botToken,
            chatId,
            `⏰ <b>Spectra Urgent Submission Deadline!</b>\n` +
            `<b>Course:</b> ${courseCode}\n` +
            `<b>Task:</b> ${rawTitle}\n` +
            `<b>Due:</b> ${dueDateText} (${hoursLeft}h remaining)\n` +
            `<b>Status:</b> No submission recorded\n` +
            `🔗 <a href="${fullUrl}">Open Submission Dropbox on SPeCTRUM</a>`
          );

          alertedDeadlineIds.add(cmid);
          alertedCount++;
        }
      }
    } catch (err) {
      console.warn(`[Spectra Relay] Error checking deadlines for ${courseCode}:`, err);
    }
  }

  if (env.SPECTRA_KV && alertedCount > 0) {
    await env.SPECTRA_KV.put("alerted_deadline_ids", JSON.stringify(Array.from(alertedDeadlineIds)));
  }

  return { checked: checkedCourses, alerted: alertedCount };
}

function parseWorkerDateString(dateStr) {
  if (!dateStr) return null;
  const raw = String(dateStr).trim();
  const lower = raw.toLowerCase();
  const now = new Date();

  // Extract time
  let hours = 23, minutes = 59;
  const timeMatch = raw.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const meridiem = (timeMatch[3] || "").toLowerCase();
    if (meridiem === "pm" && h < 12) h += 12;
    if (meridiem === "am" && h === 12) h = 0;
    hours = h;
    minutes = m;
  }

  // Today / Tomorrow
  if (lower.includes("today") || lower.includes("hari ini")) {
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }
  if (lower.includes("tomorrow") || lower.includes("esok")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }

  // Normalize Malay months
  let cleaned = raw
    .replace(/\b(isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b/gi, "")
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\bjan(?:uari)?\b/gi, "Jan")
    .replace(/\bfeb(?:ruari)?\b/gi, "Feb")
    .replace(/\bmac\b/gi, "Mar")
    .replace(/\bapr(?:il)?\b/gi, "Apr")
    .replace(/\bmei\b/gi, "May")
    .replace(/\bjun\b/gi, "Jun")
    .replace(/\bjul(?:ai)?\b/gi, "Jul")
    .replace(/\bogo(?:s)?\b/gi, "Aug")
    .replace(/\bsep(?:tember)?\b/gi, "Sep")
    .replace(/\bokt(?:ober)?\b/gi, "Oct")
    .replace(/\bnov(?:ember)?\b/gi, "Nov")
    .replace(/\bdis(?:ember)?\b/gi, "Dec")
    .replace(/[,\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // DD/MM/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})[\.\/\-](\d{1,2})(?:[\.\/\-](\d{2,4}))?/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10) - 1;
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, month, day, hours, minutes, 0, 0).getTime();
  }

  // DD Month YYYY
  const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const wordMatch = cleaned.match(/(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{2,4}))?/);
  if (wordMatch) {
    const day = parseInt(wordMatch[1], 10);
    const monStr = wordMatch[2].slice(0, 3).toLowerCase();
    if (monthMap[monStr] !== undefined) {
      let year = wordMatch[3] ? parseInt(wordMatch[3], 10) : now.getFullYear();
      if (year < 100) year += 2000;
      return new Date(year, monthMap[monStr], day, hours, minutes, 0, 0).getTime();
    }
  }

  const d = new Date(raw);
  return !isNaN(d.getTime()) ? d.getTime() : null;
}

/**
 * 24/7 Cloud Announcement Scanner & Telegram Alert Routine
 * Discovers course forums, parses new instructor announcements,
 * and sends instant Telegram alerts with direct discussion links.
 */
async function checkCloudAnnouncements(env, sessionData) {
  const { sessionToken, courses = [] } = sessionData;
  if (!courses || courses.length === 0) {
    return { checked: 0, sent: 0 };
  }

  const cookieHeader = `MoodleSession=${sessionToken}`;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return { checked: 0, sent: 0 };
  }

  let sentAnnouncementIds = new Set();
  let isFirstRun = false;
  if (env.SPECTRA_KV) {
    const rawSent = await env.SPECTRA_KV.get("sent_announcement_ids");
    if (rawSent) {
      try {
        sentAnnouncementIds = new Set(JSON.parse(rawSent));
      } catch (_) {}
    } else {
      isFirstRun = true;
    }
  }

  let sentCount = 0;
  let checkedCourses = 0;

  for (const course of courses) {
    const courseId = course.id;
    const courseCode = course.code || course.id;

    try {
      // 1. Discover forum view URLs: first try /mod/forum/index.php, then /course/view.php
      const forumUrls = new Set();

      try {
        const indexRes = await fetch(`https://spectrum.um.edu.my/mod/forum/index.php?id=${encodeURIComponent(courseId)}`, {
          headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
        });
        if (indexRes.ok) {
          const indexHtml = await indexRes.text();
          const fMatches = indexHtml.match(/href=["']([^"']*\/mod\/forum\/view\.php\?id=\d+[^"']*)["']/gi) || [];
          for (const m of fMatches) {
            const urlM = m.match(/href=["']([^"']+)["']/i);
            if (urlM) {
              let u = urlM[1];
              if (!u.startsWith("http")) u = `https://spectrum.um.edu.my/${u.replace(/^\//, "")}`;
              forumUrls.add(u);
            }
          }
        }
      } catch (_) {}

      // Fallback: check course page if index gave no forums
      if (forumUrls.size === 0) {
        try {
          const courseRes = await fetch(`https://spectrum.um.edu.my/course/view.php?id=${encodeURIComponent(courseId)}`, {
            headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
          });
          if (courseRes.ok) {
            const courseHtml = await courseRes.text();
            const fMatches = courseHtml.match(/href=["']([^"']*\/mod\/forum\/view\.php\?id=\d+[^"']*)["']/gi) || [];
            for (const m of fMatches) {
              const urlM = m.match(/href=["']([^"']+)["']/i);
              if (urlM) {
                let u = urlM[1];
                if (!u.startsWith("http")) u = `https://spectrum.um.edu.my/${u.replace(/^\//, "")}`;
                forumUrls.add(u);
              }
            }
          }
        } catch (_) {}
      }

      if (forumUrls.size === 0) continue;
      checkedCourses++;

      // 2. Scan discussions in each forum
      for (const fUrl of forumUrls) {
        const forumRes = await fetch(fUrl, {
          headers: { "Cookie": cookieHeader, "User-Agent": "Mozilla/5.0 Spectra-Relay/1.0" }
        });
        if (!forumRes.ok) continue;
        const forumHtml = await forumRes.text();

        // Parse discussion rows
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowM;
        while ((rowM = rowRegex.exec(forumHtml)) !== null) {
          const rowHtml = rowM[1];
          const topicMatch = rowHtml.match(/<a[^>]*href=["']([^"']*discuss\.php\?d=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
          if (!topicMatch) continue;

          const rawDiscussUrl = topicMatch[1];
          const discussionId = topicMatch[2];
          const rawSubject = topicMatch[3].replace(/<[^>]+>/g, "").trim();
          if (!rawSubject) continue;

          // If already sent, skip
          if (sentAnnouncementIds.has(discussionId)) continue;

          // If this is the initial run with empty KV, seed existing announcements without blasting spam
          if (isFirstRun) {
            sentAnnouncementIds.add(discussionId);
            continue;
          }

          // Extract author & date if available
          const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          const cells = [];
          let cM;
          while ((cM = cellRegex.exec(rowHtml)) !== null) {
            cells.push(cM[1].replace(/<[^>]+>/g, "").trim());
          }

          const author = cells[1] || cells[2] || "Course Instructor";
          const dateText = cells[cells.length - 1] || "Recent";
          const fullDiscussUrl = rawDiscussUrl.startsWith("http")
            ? rawDiscussUrl
            : `https://spectrum.um.edu.my/${rawDiscussUrl.replace(/^\//, "")}`;

          await dispatchTelegram(
            botToken,
            chatId,
            `📢 <b>Spectra Announcement: ${courseCode}</b>\n` +
            `<b>Topic:</b> ${rawSubject}\n` +
            `<b>Author:</b> ${author} (${dateText})\n` +
            `🔗 <a href="${fullDiscussUrl}">Read Discussion on SPeCTRUM</a>`
          );

          sentAnnouncementIds.add(discussionId);
          sentCount++;
        }
      }
    } catch (err) {
      console.warn(`[Spectra Relay] Error checking announcements for ${courseCode}:`, err);
    }
  }

  if (env.SPECTRA_KV && (sentCount > 0 || isFirstRun)) {
    await env.SPECTRA_KV.put("sent_announcement_ids", JSON.stringify(Array.from(sentAnnouncementIds)));
  }

  return { checked: checkedCourses, sent: sentCount };
}


