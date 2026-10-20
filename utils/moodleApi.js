/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Manual MoodleSession Cookie Injection & Hybrid Authentication Fallback Engine
 *
 * Precedence:
 * 1. User-provided manualMoodleSession in chrome.storage.local
 * 2. Browser cookie store via chrome.cookies.get({ url: "https://spectrum.um.edu.my", name: "MoodleSession" })
 * 3. AUTH_REQUIRED UI state
 */

import { extractCourseCode, parseCoursePage, parseEnrolledCourses } from "./parser.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

export class AuthRequiredError extends Error {
  constructor(message = "No SPeCTRUM session configured. Please provide your MoodleSession cookie.") {
    super(message);
    this.name = "AUTH_REQUIRED";
    this.code = "AUTH_REQUIRED";
  }
}

export class InvalidSessionError extends Error {
  constructor(message = "SPeCTRUM session cookie is invalid or expired.") {
    super(message);
    this.name = "INVALID_SESSION";
    this.code = "INVALID_SESSION";
  }
}

export const AuthExpiredError = InvalidSessionError;

/**
 * Retrieve active session cookie following strict precedence:
 * 1. chrome.storage.local "manualMoodleSession"
 * 2. chrome.cookies store for spectrum.um.edu.my
 * Returns { source: "manual" | "browser" | null, cookieValue: string | null }
 */
export async function getEffectiveSessionCookie() {
  // Step 1: Check chrome.storage.local for manualMoodleSession (or fallback manual_moodle_session / moodle_session)
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["manualMoodleSession", "manual_moodle_session", "moodle_session"]);
      const manualToken = (stored.manualMoodleSession || stored.manual_moodle_session || "").trim();
      if (manualToken.length > 0) {
        return {
          source: "manual",
          cookieValue: manualToken
        };
      }
      const moodleVal = typeof stored.moodle_session === "object" && stored.moodle_session !== null
        ? (stored.moodle_session.value || "").trim()
        : (typeof stored.moodle_session === "string" ? stored.moodle_session.trim() : "");
      if (moodleVal.length > 0) {
        return {
          source: "manual",
          cookieValue: moodleVal
        };
      }
    } catch (err) {
      console.warn("[Spectra] Could not read manualMoodleSession from storage:", err);
    }
  }

  // Step 2: Fall back to browser cookie store
  if (typeof chrome !== "undefined" && chrome.cookies) {
    try {
      // Direct query with exact URL and path
      let cookie = await chrome.cookies.get({
        url: `${SPECTRUM_BASE_URL}/`,
        name: "MoodleSession"
      });

      // Fallback: search all cookies for spectrum.um.edu.my domain
      if (!cookie || !cookie.value) {
        const all = await chrome.cookies.getAll({ domain: "spectrum.um.edu.my" });
        cookie = all.find((c) => c.name === "MoodleSession");
      }

      if (cookie && cookie.value && cookie.value.trim().length > 0) {
        return {
          source: "browser",
          cookieValue: cookie.value.trim()
        };
      }
    } catch (err) {
      console.warn("[Spectra] Could not query chrome.cookies:", err);
    }
  }

  // Step 3: Neither exists
  return {
    source: null,
    cookieValue: null
  };
}

/**
 * Dynamically write session cookie to Chrome's cookie store with persistent expiration
 * so it survives browser restarts and all subsequent native fetch() calls pass it.
 */
export async function injectCookieToBrowser(sessionCookie) {
  if (!sessionCookie) return false;
  const clean = sessionCookie.trim();
  let injected = false;

  // Persistent expiration: 30 days into future so Chrome keeps it across restarts
  const expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

  // 1. Programmatically write to Chrome's cookie store for SPeCTRUM
  if (typeof chrome !== "undefined" && chrome.cookies?.set) {
    try {
      await chrome.cookies.set({
        url: `${SPECTRUM_BASE_URL}/`,
        name: "MoodleSession",
        value: clean,
        path: "/",
        secure: true,
        sameSite: "lax",
        expirationDate
      });
      injected = true;
      console.log("[Spectra] Injected persistent MoodleSession cookie into browser store.");
    } catch (err) {
      console.warn("[Spectra] chrome.cookies.set failed:", err);
    }
  }

  // 2. Set document.cookie directly if in SPeCTRUM domain context
  if (typeof document !== "undefined" && typeof location !== "undefined" && location.hostname?.includes("spectrum.um.edu.my")) {
    try {
      const maxAge = 30 * 24 * 60 * 60;
      document.cookie = `MoodleSession=${clean}; path=/; domain=spectrum.um.edu.my; max-age=${maxAge}; secure; samesite=lax`;
      document.cookie = `MoodleSession=${clean}; path=/; max-age=${maxAge}; secure; samesite=lax`;
      injected = true;
    } catch (e) {}
  }

  // 3. Inject cookie into active SPeCTRUM tabs if tabs & scripting permissions available
  if (typeof chrome !== "undefined" && chrome.tabs?.query && chrome.scripting?.executeScript) {
    try {
      const tabs = await chrome.tabs.query({ url: "*://spectrum.um.edu.my/*" });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (val) => {
              const maxAge = 30 * 24 * 60 * 60;
              document.cookie = `MoodleSession=${val}; path=/; domain=spectrum.um.edu.my; max-age=${maxAge}; secure; samesite=lax`;
              document.cookie = `MoodleSession=${val}; path=/; max-age=${maxAge}; secure; samesite=lax`;
            },
            args: [clean]
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }

  return injected;
}

/**
 * Verify session cookie against live SPeCTRUM portal and extract dynamic CSRF sesskey
 * Throws InvalidSessionError if redirected to SSO / login, or if sesskey missing
 */
export async function verifyAndFetchSesskey(sessionCookie) {
  if (!sessionCookie || !sessionCookie.trim()) {
    throw new AuthRequiredError("Session cookie cannot be empty.");
  }

  const cleanCookie = sessionCookie.trim();

  // 1. Programmatically align browser cookie store with active session
  await injectCookieToBrowser(cleanCookie);

  // 2. Query SPeCTRUM Dashboard (https://spectrum.um.edu.my/my/) with timeout
  let response;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    response = await fetch(`${SPECTRUM_BASE_URL}/my/`, {
      method: "GET",
      credentials: "include",
      signal: controller ? controller.signal : undefined,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
  } catch (netErr) {
    if (netErr.name === "AbortError") {
      throw new Error("Connection to SPeCTRUM timed out (server took too long to respond).");
    }
    throw new Error(`Network error connecting to SPeCTRUM: ${netErr.message}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // 3. Inspect response URL and redirects
  if (
    (response.redirected && (
      response.url.includes("/login/") ||
      response.url.includes("microsoftonline") ||
      response.url.includes("oidc") ||
      response.url.includes("sso")
    )) ||
    response.status === 401 ||
    response.status === 403
  ) {
    throw new InvalidSessionError("Redirected to UM login portal. The MoodleSession cookie is expired or invalid.");
  }

  const html = await response.text();

  // Validate if returned page is unauthenticated login form
  if (
    html.includes("You are not logged in") ||
    html.includes('action="https://spectrum.um.edu.my/login/index.php"') ||
    html.includes('name="logintoken"')
  ) {
    throw new InvalidSessionError("SPeCTRUM returned unauthenticated state. Please re-check your MoodleSession token.");
  }

  // 4. Extract CSRF sesskey
  let sesskey = null;
  const jsonMatch = html.match(/"sesskey":"([^"]+)"/);
  if (jsonMatch) sesskey = jsonMatch[1];

  if (!sesskey) {
    const inputMatch = html.match(/name="sesskey"\s+value="([^"]+)"/i) || html.match(/sesskey=([a-zA-Z0-9]+)/);
    if (inputMatch) sesskey = inputMatch[1];
  }

  if (!sesskey) {
    const cfgMatch = html.match(/M\.cfg\s*=\s*\{[^}]*"sesskey"\s*:\s*"([^"]+)"/);
    if (cfgMatch) sesskey = cfgMatch[1];
  }

  if (!sesskey) {
    throw new InvalidSessionError("No CSRF sesskey found in SPeCTRUM response. Session may be expired.");
  }

  // 5. Extract Student Profile Metadata
  let userName = "UM Student";
  let userId = "";
  let userAvatarUrl = "";

  // Direct regex match from working SPeCTRUM scraper
  const userMatch = html.match(/class="usertext[^"]*">([^<]+)<\/span>/i) || html.match(/class="userbutton"[^>]*>.*?<span class="usertext">([^<]+)<\/span>/is);
  if (userMatch && userMatch[1].trim()) {
    userName = userMatch[1].trim();
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Student Name DOM fallback
    if (userName === "UM Student") {
      const nameEl = doc.querySelector(".usertext, .logininfo a, .usermenu .usertext, span.user-name");
      if (nameEl && nameEl.textContent.trim()) {
        userName = nameEl.textContent.trim();
      } else {
        const altMatch = html.match(/alt="Picture of ([^"]+)"/i);
        if (altMatch) userName = altMatch[1].trim();
      }
    }

    // Student User ID
    const userProfileLink = doc.querySelector('a[href*="/user/profile.php?id="], a[href*="/user/view.php?id="]');
    if (userProfileLink) {
      const idMatch = userProfileLink.href.match(/id=(\d+)/);
      if (idMatch) userId = idMatch[1];
    }

    // Avatar URL
    const avatarEl = doc.querySelector(".userpicture, .userbutton img, .avatars img");
    if (avatarEl) {
      userAvatarUrl = avatarEl.getAttribute("src") || "";
    }
  } catch (domErr) {
    console.warn("[Spectra] Could not parse student profile elements:", domErr);
  }

  // 6. Cache verified session in chrome.storage.local
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      manualMoodleSession: cleanCookie,
      verifiedSesskey: sesskey,
      userName,
      userId,
      userAvatarUrl,
      sessionStatus: "connected",
      sessionLastVerified: Date.now()
    });
  }

  console.log(`[Spectra] Session verified successfully! Student: ${userName} (ID: ${userId || "N/A"})`);

  return {
    success: true,
    sesskey,
    userName,
    userId,
    userAvatarUrl,
    authenticated: true
  };
}

/**
 * High-level session discovery orchestrator.
 * Follows strict precedence: manualMoodleSession -> browser cookies -> AUTH_REQUIRED.
 */
export async function getSessionContext() {
  const { source, cookieValue } = await getEffectiveSessionCookie();

  if (!cookieValue) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ sessionStatus: "unset" });
    }
    throw new AuthRequiredError();
  }

  try {
    const result = await verifyAndFetchSesskey(cookieValue);
    return {
      ...result,
      source
    };
  } catch (err) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      if (err instanceof InvalidSessionError || err instanceof AuthRequiredError) {
        await chrome.storage.local.set({ sessionStatus: "expired" });
      }
    }
    throw err;
  }
}

/**
 * Register dynamic DeclarativeNetRequest rule to automatically attach
 * Cookie: MoodleSession=<token> on all extension fetches to spectrum.um.edu.my.
 */
export async function setupDeclarativeCookieRule(token) {
  if (typeof chrome !== "undefined" && chrome.declarativeNetRequest?.updateDynamicRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1001],
        addRules: [
          {
            id: 1001,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                {
                  header: "Cookie",
                  operation: "set",
                  value: `MoodleSession=${token.trim()}`
                }
              ]
            },
            condition: {
              urlFilter: "||spectrum.um.edu.my/",
              resourceTypes: ["xmlhttprequest", "sub_frame", "main_frame", "other"]
            }
          }
        ]
      });
      console.log("[Spectra] DeclarativeNetRequest dynamic cookie header rule registered.");
    } catch (err) {
      console.warn("[Spectra] declarativeNetRequest rule update notice:", err);
    }
  }
}

/**
 * The exact standalone in-page scraper injected directly into SPeCTRUM page tabs.
 * Runs in first-party browser context with native SameSite cookie privileges.
 */
export async function inPageSpectrumScraper(moodleSession) {
  const MOODLE_SESSION = moodleSession;

  console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
  // Set the cookie directly in the browser's context
  document.cookie = `MoodleSession=${MOODLE_SESSION}; path=/; domain=spectrum.um.edu.my`;
  document.cookie = `MoodleSession=${MOODLE_SESSION}; path=/;`;

  console.log("%c[2/4] Testing dashboard access & extracting sesskey...", "color: #3b82f6; font-weight: bold;");
  
  let sesskey = null;
  let userName = "Unknown";

  try {
    const dashboardRes = await fetch("https://spectrum.um.edu.my/my/", {
      credentials: "include"
    });

    if (dashboardRes.redirected && dashboardRes.url.includes("login")) {
      throw new Error("REDIRECTED_TO_LOGIN: The provided MoodleSession cookie is invalid or expired.");
    }

    const html = await dashboardRes.text();

    // 1. Extract sesskey (required for Moodle's native JSON APIs)
    const sesskeyMatch = html.match(/"sesskey":"([^"]+)"/);
    if (!sesskeyMatch) {
      throw new Error("Could not parse sesskey from dashboard. Check if session is valid.");
    }
    sesskey = sesskeyMatch[1];

    // 2. Extract logged-in user name
    const userMatch = html.match(/class="usertext[^"]*">([^<]+)<\/span>/i) || html.match(/class="userbutton"[^>]*>.*?<span class="usertext">([^<]+)<\/span>/is);
    if (userMatch) {
      userName = userMatch[1].trim();
    }

    console.log(`%c✔ Session Active! Welcome, ${userName}`, "color: #10b981; font-weight: bold;");
    console.log(`%c✔ Extracted sesskey: ${sesskey}`, "color: #10b981;");

  } catch (err) {
    console.error("%c✖ Session Handshake Failed:", "color: #ef4444; font-weight: bold;", err.message);
    return { success: false, error: err.message };
  }

  // [3/4] Scrape Live Deadlines & Assignments
  console.log("%c[3/4] Fetching live upcoming deadlines...", "color: #3b82f6; font-weight: bold;");
  let events = [];
  let calendarData = null;
  try {
    const calendarPayload = [{
      index: 0,
      methodname: "core_calendar_get_action_events_by_timesort",
      args: {
        limitnum: 15,
        timesortfrom: Math.floor(Date.now() / 1000) - 86400
      }
    }];

    const calendarRes = await fetch(`https://spectrum.um.edu.my/lib/ajax/service.php?sesskey=${sesskey}&info=core_calendar_get_action_events_by_timesort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(calendarPayload)
    });

    const [calParsed] = await calendarRes.json();
    calendarData = calParsed;

    if (calendarData.error) {
      console.warn("Calendar API returned an error:", calendarData.exception);
    } else {
      events = (calendarData.data?.events || []).map(event => ({
        "Course Code": event.course ? event.course.shortname : "N/A",
        "Assignment / Task": event.name,
        "Due Date": new Date(event.timesort * 1000).toLocaleString(),
        "Submitted?": event.action ? (event.action.actionable ? "Pending" : "Submitted") : "Unknown",
        "Direct Link": event.action ? event.action.url : event.url
      }));

      if (events.length === 0) {
        console.log("%cNo upcoming deadlines found.", "color: #f59e0b;");
      } else {
        console.log("%cUpcoming Deadlines:", "color: #10b981; font-weight: bold;");
        console.table(events);
      }
    }
  } catch (err) {
    console.error("Failed to query calendar deadlines:", err);
  }

  // [4/4] Scrape Enrolled Courses
  console.log("%c[4/4] Fetching enrolled courses...", "color: #3b82f6; font-weight: bold;");
  let courses = [];
  let courseData = null;
  try {
    const coursePayload = [{
      index: 0,
      methodname: "core_course_get_enrolled_courses_by_timeline_classification",
      args: {
        classification: "inprogress",
        limit: 0,
        offset: 0,
        sort: "fullname"
      }
    }];

    const courseRes = await fetch(`https://spectrum.um.edu.my/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(coursePayload)
    });

    const [coursesParsed] = await courseRes.json();
    courseData = coursesParsed;

    if (courseData.error) {
      console.warn("Course API returned an error:", courseData.exception);
    } else {
      courses = (courseData.data?.courses || []).map(c => ({
        "ID": c.id,
        "Code": c.shortname,
        "Course Name": c.fullname,
        "URL": c.viewurl
      }));

      console.log("%cEnrolled Courses:", "color: #10b981; font-weight: bold;");
      console.table(courses);
    }
  } catch (err) {
    console.error("Failed to query enrolled courses:", err);
  }

  console.log("%c✔ Scraping logic test complete.", "color: #10b981; font-weight: bold;");

  return {
    success: true,
    sesskey,
    userName,
    events,
    courses,
    rawCalendarEvents: (calendarData && calendarData.data && calendarData.data.events) || [],
    rawCourses: (courseData && courseData.data && courseData.data.courses) || []
  };
}

/**
 * Rebuilt Backend Scraper Injector:
 * Injects testSpectrumScraper directly into SPeCTRUM browser page context
 * and returns the extracted console data payload.
 */
export async function injectAndScrapeSpectrum(moodleSession) {
  if (!moodleSession || !moodleSession.trim()) {
    throw new AuthRequiredError("Session cookie cannot be empty.");
  }
  const token = moodleSession.trim();

  // 1. Setup declarative header rule & inject into browser cookie store
  await setupDeclarativeCookieRule(token);
  await injectCookieToBrowser(token);

  // 2. Locate or create a tab on spectrum.um.edu.my
  let result = null;
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.scripting) {
    let targetTab = null;
    let didCreateTab = false;

    try {
      const tabs = await chrome.tabs.query({ url: "*://spectrum.um.edu.my/*" });
      if (tabs.length > 0) {
        // Use active or first tab
        targetTab = tabs.find((t) => t.active) || tabs[0];
      } else {
        // Create a background tab on SPeCTRUM
        targetTab = await chrome.tabs.create({
          url: "https://spectrum.um.edu.my/my/",
          active: false
        });
        didCreateTab = true;

        // Wait for page to finish loading
        await new Promise((resolve) => {
          let timeoutId;
          const listener = (tabId, changeInfo) => {
            if (tabId === targetTab.id && changeInfo.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timeoutId);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          timeoutId = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 8000);
        });
      }

      if (targetTab && targetTab.id) {
        // Inject and execute testSpectrumScraper directly inside SPeCTRUM tab!
        const injectedResults = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: inPageSpectrumScraper,
          args: [token]
        });

        if (injectedResults && injectedResults[0] && injectedResults[0].result) {
          result = injectedResults[0].result;
        }
      }
    } catch (scriptErr) {
      console.warn("[Spectra] In-tab script injection notice:", scriptErr);
    } finally {
      if (didCreateTab && targetTab && targetTab.id) {
        setTimeout(() => {
          chrome.tabs.remove(targetTab.id).catch(() => {});
        }, 1500);
      }
    }
  }

  // If in-tab execution produced data
  if (result) {
    if (!result.success) {
      throw new InvalidSessionError(result.error || "SPeCTRUM handshake failed. Please verify token.");
    }

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        manualMoodleSession: token,
        verifiedSesskey: result.sesskey,
        userName: result.userName,
        sessionStatus: "connected",
        sessionLastVerified: Date.now(),
        cached_deadlines: result.events,
        cached_courses: result.courses,
        cached_raw_events: result.rawCalendarEvents,
        cached_raw_courses: result.rawCourses
      });
    }

    return result;
  }

  // 3. Fallback: direct fetch with declarativeNetRequest header
  const directResult = await verifyAndFetchSesskey(token);
  return directResult;
}

/**
 * Return current stored MoodleSession cookie value if available.
 */
export async function getStoredMoodleCookie() {
  const { cookieValue } = await getEffectiveSessionCookie();
  return cookieValue;
}

/**
 * Save manual MoodleSession token to local storage and verify it immediately.
 * Validates alphanumeric string (~26 characters), injects testSpectrumScraper into SPeCTRUM,
 * and confirms dashboard access, sesskey, deadlines, and courses.
 */
export async function saveManualSession(rawToken) {
  if (!rawToken || !rawToken.trim()) {
    throw new Error("Token cannot be empty");
  }

  const token = rawToken.trim();

  // Validate format (alphanumeric, 15 to 45 characters, typically ~26 chars)
  if (!/^[a-zA-Z0-9_-]{15,45}$/.test(token)) {
    throw new Error("Invalid format. MoodleSession cookie is typically ~26 alphanumeric characters.");
  }

  // Persist token in local storage
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ manualMoodleSession: token });
  }

  // Inject into Chrome cookies store
  await injectCookieToBrowser(token);

  // Inject scraper and verify
  return await injectAndScrapeSpectrum(token);
}

/**
 * Auto-detect MoodleSession from browser cookie store, save it, and verify.
 */
export async function autoDetectSession() {
  if (typeof chrome === "undefined" || !chrome.cookies) {
    throw new Error("Chrome cookies API is not accessible in this context.");
  }

  let cookie = await chrome.cookies.get({
    url: `${SPECTRUM_BASE_URL}/`,
    name: "MoodleSession"
  });

  if (!cookie || !cookie.value) {
    const all = await chrome.cookies.getAll({ domain: "spectrum.um.edu.my" });
    cookie = all.find((c) => c.name === "MoodleSession");
  }

  if (!cookie || !cookie.value || !cookie.value.trim()) {
    throw new Error("No MoodleSession cookie found for spectrum.um.edu.my in browser. Please sign in to SPeCTRUM in Chrome first.");
  }

  const token = cookie.value.trim();

  if (chrome.storage?.local) {
    await chrome.storage.local.set({ manualMoodleSession: token });
  }

  await injectCookieToBrowser(token);

  return await injectAndScrapeSpectrum(token);
}

export { getLiveEnrolledCourses, getLiveCourseMaterials, fetchLiveEnrolledCourses, fetchLiveCourseMaterials, fetchLiveAnnouncements } from "./courses.js";
export { fetchCourseAttendance, fetchLiveAllAttendance, autoSubmitAttendance, scanAndAutoRecordAttendance, formatAttendanceTelegram } from "./attendance.js";
