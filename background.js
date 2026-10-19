/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Background Service Worker (Manifest V3) - Zero-Mock Production
 * Handles cookie synchronization, periodic alarms, cloud relay,
 * live forum announcement polling, and Telegram / ntfy notification pipeline.
 */

import {
  getSessionContext,
  getLiveEnrolledCourses,
  fetchLiveAnnouncements,
  injectAndScrapeSpectrum,
  setupDeclarativeCookieRule,
  injectCookieToBrowser,
  AuthExpiredError,
  InvalidSessionError,
  AuthRequiredError
} from "./utils/moodleApi.js";

import { fetchLiveDeadlines } from "./utils/calendar.js";
import { parseForumDiscussions, calculateUrgency } from "./utils/parser.js";
import {
  sendTelegramMessage,
  sendTelegramTestMessage,
  formatAnnouncementTelegram,
  formatDeadlineTelegram
} from "./utils/telegram.js";

import {
  fetchCourseAttendance,
  fetchLiveAllAttendance,
  autoSubmitAttendance,
  scanAndAutoRecordAttendance,
  formatAttendanceTelegram
} from "./utils/attendance.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";
const COOKIE_NAME = "MoodleSession";

// -------------------------------------------------------------
// Lifecycle & Alarms Initialization
// -------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Spectra] Live service worker initialized:", details.reason);

  const defaults = {
    telegram_bot_token: "",
    telegram_chat_id: "",
    ntfy_topic: "",
    custom_webhook_url: "",
    cloud_relay_enabled: false,
    cloud_relay_url: "",
    cloud_relay_secret: "",
    poll_interval_mins: 15,
    notify_announcements: true,
    notify_urgent_deadlines: true,
    completed_assignment_ids: [],
    seen_announcement_ids: [],
    seen_deadline_alert_ids: [],
    last_sync_timestamp: null,
    semester_start_date: "2026-10-05"
  };

  const stored = await chrome.storage.local.get(Object.keys(defaults));
  const toSet = {};
  for (const [key, val] of Object.entries(defaults)) {
    if (stored[key] === undefined) {
      toSet[key] = val;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  // Register background alarms
  await setupAlarms(stored.poll_interval_mins || 15);

  // Check active session cookie
  await checkActiveSession();
});

// -------------------------------------------------------------
// Browser Startup Listener (Persistent Re-Injection on Chrome Boot)
// -------------------------------------------------------------
chrome.runtime.onStartup.addListener(async () => {
  console.log("[Spectra] Chrome browser launched. Restoring session state...");

  try {
    const stored = await chrome.storage.local.get([
      "manualMoodleSession",
      "manual_moodle_session",
      "moodle_session",
      "poll_interval_mins"
    ]);

    const token = (
      stored.manualMoodleSession ||
      stored.manual_moodle_session ||
      (stored.moodle_session && typeof stored.moodle_session === "object" ? stored.moodle_session.value : stored.moodle_session) ||
      ""
    ).trim();

    if (token) {
      await injectCookieToBrowser(token);
      await setupDeclarativeCookieRule(token);
      console.log("[Spectra] Persistent MoodleSession re-injected on Chrome boot.");
    }

    await setupAlarms(stored.poll_interval_mins || 15);
  } catch (err) {
    console.warn("[Spectra] onStartup initialization notice:", err);
  }
});

// Setup periodic alarms
async function setupAlarms(intervalMinutes = 15) {
  await chrome.alarms.clearAll();

  // Announcement polling alarm
  chrome.alarms.create("spectra_poll_announcements", {
    periodInMinutes: Math.max(5, intervalMinutes),
    delayInMinutes: 1
  });

  // Urgent deadline checker alarm (every 30 mins)
  chrome.alarms.create("spectra_check_deadlines", {
    periodInMinutes: 30,
    delayInMinutes: 5
  });

  // Auto-attendance scanner alarm (every 15 mins)
  chrome.alarms.create("spectra_check_attendance", {
    periodInMinutes: Math.max(10, intervalMinutes),
    delayInMinutes: 2
  });

  console.log(`[Spectra] Alarms registered with ${intervalMinutes}m interval.`);
}

// -------------------------------------------------------------
// Alarm Listener
// -------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "spectra_poll_announcements") {
    await pollAnnouncements();
  } else if (alarm.name === "spectra_check_deadlines") {
    await checkUpcomingDeadlines();
  } else if (alarm.name === "spectra_check_attendance") {
    await checkAutoAttendance();
  }
});

// -------------------------------------------------------------
// Cookie Listener (MoodleSession on spectrum.um.edu.my)
// -------------------------------------------------------------
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const { cookie, removed, cause } = changeInfo;
  if (!cookie.domain.includes("spectrum.um.edu.my") || cookie.name !== COOKIE_NAME) {
    return;
  }

  if (removed) {
    console.log(`[Spectra] MoodleSession cookie removed (cause: ${cause}). Checking persisted backup...`);
    // Check if manualMoodleSession is saved in chrome.storage.local
    const stored = await chrome.storage.local.get(["manualMoodleSession", "manual_moodle_session"]);
    const manualToken = (stored.manualMoodleSession || stored.manual_moodle_session || "").trim();

    if (manualToken) {
      // Re-inject the persistent cookie backup so Chrome doesn't lose it on quit
      console.log("[Spectra] Re-injecting manual session backup after cookie removal.");
      await injectCookieToBrowser(manualToken);
    } else if (cause === "explicit") {
      await chrome.storage.local.set({
        moodle_session_valid: false,
        moodle_session_updated: Date.now()
      });
    }
    return;
  }

  const sessionData = {
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires: cookie.expirationDate || null,
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({
    moodle_session: sessionData,
    manualMoodleSession: cookie.value,
    moodle_session_valid: true,
    moodle_session_updated: Date.now()
  });

  // Ensure persistent expiration if missing
  if (!cookie.expirationDate) {
    await injectCookieToBrowser(cookie.value);
  }

  // Trigger Cloud Relay Sync if enabled
  const config = await chrome.storage.local.get(["cloud_relay_enabled", "cloud_relay_url", "cloud_relay_secret"]);
  if (config.cloud_relay_enabled && config.cloud_relay_url) {
    await syncSessionToCloudRelay(sessionData, config.cloud_relay_url, config.cloud_relay_secret);
  }
});

// -------------------------------------------------------------
// Session Verification
// -------------------------------------------------------------
async function checkActiveSession() {
  try {
    const session = await getSessionContext();
    const cookie = await chrome.cookies.get({
      url: SPECTRUM_BASE_URL,
      name: COOKIE_NAME
    });

    const sessionData = {
      value: cookie ? cookie.value : (session.cookieValue || ""),
      sesskey: session.sesskey,
      userName: session.userName,
      userAvatarUrl: session.userAvatarUrl,
      updatedAt: Date.now()
    };

    await chrome.storage.local.set({
      moodle_session: sessionData,
      manualMoodleSession: sessionData.value || cookie?.value || "",
      moodle_session_valid: true,
      moodle_session_updated: Date.now()
    });

    return { authenticated: true, session: sessionData };
  } catch (err) {
    const isExplicitAuthFailure =
      err instanceof AuthRequiredError ||
      err instanceof InvalidSessionError ||
      err.message?.includes("Redirected to UM login") ||
      err.message?.includes("unauthenticated state");

    if (isExplicitAuthFailure) {
      await chrome.storage.local.set({
        moodle_session_valid: false,
        moodle_session_updated: Date.now()
      });
    } else {
      console.warn("[Spectra] Non-fatal network notice during checkActiveSession:", err.message);
    }
    return { authenticated: false, session: null, error: err.message };
  }
}

// -------------------------------------------------------------
// Cloud Relay Sync
// -------------------------------------------------------------
async function syncSessionToCloudRelay(sessionData, relayUrl, secretKey) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (secretKey) {
      headers["Authorization"] = `Bearer ${secretKey}`;
    }

    const payload = {
      action: "SESSION_SYNC",
      timestamp: Date.now(),
      domain: "spectrum.um.edu.my",
      cookieName: COOKIE_NAME,
      sessionToken: sessionData.value,
      expires: sessionData.expires,
      client: "Spectra Chrome Extension v1.0.0"
    };

    const res = await fetch(relayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      await chrome.storage.local.set({ last_cloud_sync_timestamp: Date.now() });
      return { success: true };
    } else {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------
// Notification Dispatchers (Telegram & ntfy)
// -------------------------------------------------------------
export { sendTelegramMessage };

export async function sendNtfyMessage(topic, title, message, clickUrl = "") {
  if (!topic) {
    throw new Error("Missing ntfy topic");
  }

  const endpoint = `https://ntfy.sh/${topic.trim()}`;
  const headers = {
    "Title": title,
    "Priority": "high",
    "Tags": "loudspeaker,mortarboard"
  };
  if (clickUrl) {
    headers["Click"] = clickUrl;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: message
  });

  if (!response.ok) {
    throw new Error(`ntfy.sh returned HTTP ${response.status}`);
  }
  return true;
}

// -------------------------------------------------------------
// Live Announcement Polling Workflow
// -------------------------------------------------------------
async function pollAnnouncements() {
  const store = await chrome.storage.local.get([
    "telegram_bot_token",
    "telegram_chat_id",
    "ntfy_topic",
    "notify_announcements",
    "seen_announcement_ids",
    "telegram_sent_announcement_ids"
  ]);

  if (!store.notify_announcements) return;

  const hasTelegram = Boolean(store.telegram_bot_token && store.telegram_chat_id);
  const hasNtfy = Boolean(store.ntfy_topic);
  if (!hasTelegram && !hasNtfy) return;

  // 1. Verify live session
  let sessionContext;
  try {
    sessionContext = await getSessionContext();
  } catch (err) {
    console.log("[Spectra] Background polling skipped: SPeCTRUM session not authenticated.");
    return;
  }

  const seenIds = new Set(store.seen_announcement_ids || []);
  const telegramSentIds = new Set(store.telegram_sent_announcement_ids || []);
  let announcements = [];

  // 2. Query enrolled courses & forum announcements
  try {
    const courses = await getLiveEnrolledCourses(sessionContext.sesskey);
    announcements = await fetchLiveAnnouncements(courses, sessionContext.sesskey);
  } catch (err) {
    console.warn("[Spectra] Polling live announcements failed:", err);
    return;
  }

  // 3. Dispatch to Telegram and ntfy (ONLY send announcements that haven't been flagged!)
  for (const item of announcements) {
    const itemIdStr = String(item.id);

    // STRICT REQUIREMENT: Only send announcements that have NOT been flagged as sent to Telegram
    if (hasTelegram && !telegramSentIds.has(itemIdStr)) {
      try {
        const telegramHtml = formatAnnouncementTelegram(item);
        const res = await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, telegramHtml);
        if (res && (res.ok || res.message_id)) {
          telegramSentIds.add(itemIdStr);
          console.log(`[Spectra Telegram] Sent announcement "${item.subject}" (${itemIdStr}) and flagged as sent.`);
        }
      } catch (tgErr) {
        console.error("[Spectra] Telegram dispatch failed:", tgErr);
      }
    }

    if (hasNtfy && !seenIds.has(itemIdStr)) {
      try {
        await sendNtfyMessage(
          store.ntfy_topic,
          `Spectra Alert: [${item.courseCode}] ${item.subject}`,
          `By ${item.author || "Instructor"}: ${item.subject}`,
          item.url
        );
      } catch (ntfyErr) {
        console.error("[Spectra] ntfy dispatch failed:", ntfyErr);
      }
    }

    seenIds.add(itemIdStr);
  }

  // Cache current announcements for popup UI with telegramSent flag annotated
  const annotatedAnnouncements = announcements.map((a) => ({
    ...a,
    telegramSent: telegramSentIds.has(String(a.id))
  }));

  await chrome.storage.local.set({
    cached_announcements: annotatedAnnouncements,
    seen_announcement_ids: Array.from(seenIds),
    telegram_sent_announcement_ids: Array.from(telegramSentIds),
    last_sync_timestamp: Date.now()
  });
}

// -------------------------------------------------------------
// Live Urgent Deadline Checking (< 24 Hours)
// -------------------------------------------------------------
async function checkUpcomingDeadlines() {
  const store = await chrome.storage.local.get([
    "notify_urgent_deadlines",
    "telegram_bot_token",
    "telegram_chat_id",
    "ntfy_topic",
    "completed_assignment_ids",
    "seen_deadline_alert_ids",
    "telegram_sent_deadline_ids"
  ]);

  if (!store.notify_urgent_deadlines) return;

  const hasTelegram = Boolean(store.telegram_bot_token && store.telegram_chat_id);
  const hasNtfy = Boolean(store.ntfy_topic);
  if (!hasTelegram && !hasNtfy) return;

  let sessionContext;
  try {
    sessionContext = await getSessionContext();
  } catch (err) {
    return;
  }

  const completed = new Set(store.completed_assignment_ids || []);
  const alerted = new Set(store.seen_deadline_alert_ids || []);
  const telegramSentDeadlineIds = new Set(store.telegram_sent_deadline_ids || []);

  let deadlines = [];
  try {
    deadlines = await fetchLiveDeadlines(sessionContext.sesskey);
  } catch (err) {
    console.warn("[Spectra] Error querying live deadlines in background:", err);
    return;
  }

  const now = Date.now();
  const urgentItems = deadlines.filter((d) => {
    if (completed.has(String(d.id))) return false;
    if (!d.dueTimestamp) return false;
    const diffHours = (d.dueTimestamp - now) / (1000 * 60 * 60);
    // Alert for impending submissions due 1 day before (0 < diffHours <= 24)
    return diffHours > 0 && diffHours <= 24;
  });

  for (const item of urgentItems) {
    const itemIdStr = String(item.id);
    const hoursLeft = Math.max(1, Math.round((item.dueTimestamp - Date.now()) / (1000 * 60 * 60)));

    // STRICT REQUIREMENT: Only send due date submission that has NOT been flagged as sent to Telegram
    if (hasTelegram && !telegramSentDeadlineIds.has(itemIdStr)) {
      try {
        const telegramHtml = formatDeadlineTelegram(item);
        const res = await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, telegramHtml);
        if (res && (res.ok || res.message_id)) {
          telegramSentDeadlineIds.add(itemIdStr);
          console.log(`[Spectra Telegram] Sent deadline alert "${item.title}" (${itemIdStr}) and flagged as sent.`);
        }
      } catch (e) {
        console.error("[Spectra] Telegram deadline alert failed:", e);
      }
    }

    if (hasNtfy && !alerted.has(itemIdStr)) {
      try {
        await sendNtfyMessage(
          store.ntfy_topic,
          `⏰ URGENT: [${item.courseCode}] due in ${hoursLeft}h`,
          `${item.title}\nDue: ${item.formattedTime || "Soon"}`,
          item.url
        );
      } catch (e) {
        console.error("[Spectra] ntfy deadline alert failed:", e);
      }
    }

    alerted.add(itemIdStr);
  }

  await chrome.storage.local.set({
    seen_deadline_alert_ids: Array.from(alerted),
    telegram_sent_deadline_ids: Array.from(telegramSentDeadlineIds)
  });
}

// -------------------------------------------------------------
// Live Auto-Attendance Scanner (< 15 Mins / On Open)
// -------------------------------------------------------------
async function checkAutoAttendance() {
  const store = await chrome.storage.local.get([
    "pref_auto_attendance",
    "course_occurrences",
    "course_passwords",
    "recorded_attendance_sessids",
    "telegram_bot_token",
    "telegram_chat_id",
    "ntfy_topic"
  ]);

  // Default to true if not explicitly turned off
  const autoAttendanceEnabled = store.pref_auto_attendance !== false;
  if (!autoAttendanceEnabled) return;

  const hasTelegram = Boolean(store.telegram_bot_token && store.telegram_chat_id);
  const hasNtfy = Boolean(store.ntfy_topic);

  let sessionContext;
  try {
    sessionContext = await getSessionContext();
  } catch (err) {
    console.log("[Spectra] Attendance scan skipped: not authenticated.");
    return;
  }

  let courses = [];
  try {
    courses = await getLiveEnrolledCourses(sessionContext.sesskey);
  } catch (err) {
    console.warn("[Spectra] Error loading courses for attendance check:", err);
    return;
  }

  const occurrencesMap = store.course_occurrences || {};
  const passwordsMap = store.course_passwords || {};
  const recordedSessids = new Set(store.recorded_attendance_sessids || []);

  try {
    const { attendance, actions } = await scanAndAutoRecordAttendance({
      courses,
      sesskey: sessionContext.sesskey,
      occurrencesMap,
      autoSubmit: true,
      passwordsMap
    });

    // Cache latest attendance state for popup UI
    await chrome.storage.local.set({
      cached_attendance: attendance,
      last_attendance_sync: Date.now()
    });

    for (const act of actions) {
      const sessid = act.session?.sessid;
      if (!sessid || recordedSessids.has(sessid)) continue;

      if (act.result?.success) {
        recordedSessids.add(sessid);

        if (hasTelegram) {
          try {
            const html = formatAttendanceTelegram({
              courseCode: act.courseCode,
              occurrence: act.occurrence,
              status: "Present",
              sessionDescription: act.session?.description,
              time: act.session?.time,
              success: true
            });
            await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, html);
          } catch (tgErr) {
            console.error("[Spectra] Telegram auto-attendance dispatch error:", tgErr);
          }
        }

        if (hasNtfy) {
          try {
            await sendNtfyMessage(
              store.ntfy_topic,
              `Spectra Auto-Attendance: [${act.courseCode}] Present!`,
              `Recorded Present for ${act.occurrence} - ${act.session?.description || "Lecture"}`,
              act.session?.submitUrl || "https://spectrum.um.edu.my"
            );
          } catch (ntfyErr) {
            console.error("[Spectra] ntfy auto-attendance dispatch error:", ntfyErr);
          }
        }
      } else if (act.result?.requiresPassword) {
        if (hasTelegram && !recordedSessids.has(`pwd_${sessid}`)) {
          recordedSessids.add(`pwd_${sessid}`);
          try {
            const html = formatAttendanceTelegram({
              courseCode: act.courseCode,
              occurrence: act.occurrence,
              sessionDescription: act.session?.description,
              time: act.session?.time,
              requiresPassword: true
            });
            await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, html);
          } catch (tgErr) {
            console.error("[Spectra] Telegram password alert error:", tgErr);
          }
        }
      }
    }

    await chrome.storage.local.set({
      recorded_attendance_sessids: Array.from(recordedSessids)
    });
  } catch (err) {
    console.warn("[Spectra] Error during auto-attendance run:", err);
  }
}

// -------------------------------------------------------------
// Batch Download Handler
// -------------------------------------------------------------
async function handleBatchDownload(files, courseCode, weekNumber) {
  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, message: "No files provided for download." };
  }

  const cleanCourse = (courseCode || "UM").replace(/[^a-zA-Z0-9_-]/g, "");
  const folderPath = `Spectra/${cleanCourse}/Week_${weekNumber}`;
  const downloadResults = [];

  for (const file of files) {
    try {
      const sanitizedFilename = (file.name || "download")
        .replace(/[/\\?%*:|"<>]/g, "_")
        .trim();

      const targetPath = `${folderPath}/${sanitizedFilename}`;

      const downloadId = await chrome.downloads.download({
        url: file.url,
        filename: targetPath,
        saveAs: false,
        conflictAction: "uniquify"
      });

      downloadResults.push({ id: downloadId, name: sanitizedFilename, success: true });
    } catch (err) {
      console.warn(`[Spectra] Failed downloading ${file.name}:`, err);
      downloadResults.push({ name: file.name, success: false, error: err.message });
    }
  }

  return {
    success: true,
    total: files.length,
    downloaded: downloadResults.filter((r) => r.success).length,
    results: downloadResults,
    folder: folderPath
  };
}

// Helper: Escape Telegram Markdown characters
function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+=|{}.!-])/g, "\\$1");
}

// -------------------------------------------------------------
// Message Router
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action, payload } = request;

  (async () => {
    try {
      switch (action) {
        case "CHECK_SESSION": {
          const session = await checkActiveSession();
          sendResponse({ success: true, data: session });
          break;
        }

        case "SEND_TEST_TELEGRAM": {
          const { botToken, chatId } = payload || {};
          const result = await sendTelegramTestMessage(botToken, chatId);
          sendResponse({ success: true, message: "Telegram test notification delivered successfully!", data: result });
          break;
        }

        case "SEND_TEST_NTFY": {
          const { topic } = payload || {};
          await sendNtfyMessage(
            topic,
            "Spectra Notification Verified",
            "SPeCTRUM alerts will be dispatched directly to your mobile device.",
            "https://spectrum.um.edu.my"
          );
          sendResponse({ success: true, message: "ntfy.sh test notification delivered successfully!" });
          break;
        }

        case "SYNC_CLOUD_RELAY_NOW": {
          const session = await checkActiveSession();
          if (!session.authenticated) {
            sendResponse({ success: false, message: "No active MoodleSession found. Please log in to SPeCTRUM first." });
            return;
          }
          const { relayUrl, secretKey } = payload || {};
          const result = await syncSessionToCloudRelay(session.session, relayUrl, secretKey);
          sendResponse(result);
          break;
        }

        case "INJECT_AND_SCRAPE_SPECTRUM": {
          const { moodleSession } = payload || {};
          const res = await injectAndScrapeSpectrum(moodleSession);
          sendResponse({ success: true, data: res });
          break;
        }

        case "DOWNLOAD_WEEK_PACK": {
          const { files, courseCode, weekNumber } = payload || {};
          const result = await handleBatchDownload(files, courseCode, weekNumber);
          sendResponse(result);
          break;
        }

        case "MANUAL_SYNC_ANNOUNCEMENTS": {
          await pollAnnouncements();
          const stored = await chrome.storage.local.get(["cached_announcements"]);
          sendResponse({ success: true, announcements: stored.cached_announcements || [] });
          break;
        }

        case "GET_LIVE_ANNOUNCEMENTS": {
          const stored = await chrome.storage.local.get(["cached_announcements"]);
          if (stored.cached_announcements && stored.cached_announcements.length > 0) {
            sendResponse({ success: true, announcements: stored.cached_announcements });
          } else {
            await pollAnnouncements();
            const recheck = await chrome.storage.local.get(["cached_announcements"]);
            sendResponse({ success: true, announcements: recheck.cached_announcements || [] });
          }
          break;
        }

        case "GET_LIVE_ATTENDANCE": {
          const store = await chrome.storage.local.get(["course_occurrences", "cached_attendance"]);
          const occurrencesMap = store.course_occurrences || {};
          const session = await getSessionContext();
          const courses = await getLiveEnrolledCourses(session.sesskey);
          const attendanceData = await fetchLiveAllAttendance(courses, session.sesskey, occurrencesMap);
          await chrome.storage.local.set({ cached_attendance: attendanceData, last_attendance_sync: Date.now() });
          sendResponse({ success: true, data: attendanceData });
          break;
        }

        case "SAVE_COURSE_OCCURRENCE": {
          const { courseId, occurrence } = payload || {};
          const store = await chrome.storage.local.get(["course_occurrences"]);
          const occurrencesMap = store.course_occurrences || {};
          if (courseId) {
            occurrencesMap[courseId] = (occurrence || "").trim();
            await chrome.storage.local.set({ course_occurrences: occurrencesMap });
          }
          sendResponse({ success: true, occurrences: occurrencesMap });
          break;
        }

        case "SCAN_AUTO_ATTENDANCE_NOW": {
          const store = await chrome.storage.local.get(["course_occurrences", "course_passwords"]);
          const occurrencesMap = store.course_occurrences || {};
          const passwordsMap = store.course_passwords || {};
          const session = await getSessionContext();
          const courses = await getLiveEnrolledCourses(session.sesskey);
          const scanRes = await scanAndAutoRecordAttendance({
            courses,
            sesskey: session.sesskey,
            occurrencesMap,
            autoSubmit: true,
            passwordsMap
          });
          sendResponse({ success: true, data: scanRes });
          break;
        }

        case "SUBMIT_MANUAL_ATTENDANCE": {
          const { sessid, attendanceUrl, password } = payload || {};
          const session = await getSessionContext();
          const result = await autoSubmitAttendance({
            sessid,
            sesskey: session.sesskey,
            attendanceUrl,
            password
          });
          sendResponse(result);
          break;
        }

        case "UPDATE_ALARMS": {
          const { intervalMinutes } = payload || {};
          await setupAlarms(intervalMinutes || 15);
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, message: `Unknown action: ${action}` });
      }
    } catch (err) {
      console.error(`[Spectra] Action ${action} threw error:`, err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});
