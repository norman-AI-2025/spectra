/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * In-Page Content Script (runs inside https://spectrum.um.edu.my/*)
 *
 * Automatically captures live Moodle session keys, student profile,
 * and acts as an in-page proxy for calendar & coursework requests
 * with 100% native SameSite cookie privileges.
 */

(function () {
  console.log("[Spectra Content] Initialized on SPeCTRUM:", window.location.href);

  // Auto-capture session on page load
  captureLiveSession();

  // Instant in-page auto-attendance and session watcher
  initInPageAttendance();

  // Listen for requests from Spectra popup or background worker
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const { action, payload } = request || {};

      if (action === "GET_INPAGE_SESSION") {
        const session = captureLiveSession();
        sendResponse({ success: true, data: session });
        return false;
      }

      if (action === "INPAGE_AJAX_CALL") {
        const { endpoint, body } = payload || {};
        fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(body)
        })
          .then((res) => res.json())
          .then((data) => sendResponse({ success: true, data }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
      }

      if (action === "INPAGE_FETCH_HTML") {
        const { url } = payload || {};
        fetch(url)
          .then((res) => res.text())
          .then((html) => sendResponse({ success: true, html }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      if (action === "RUN_SPECTRUM_SCRAPER") {
        const { moodleSession } = payload || {};
        runSpectrumScraperInPage(moodleSession)
          .then((res) => sendResponse({ success: true, data: res }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      return false;
    });
  }

  function captureLiveSession() {
    // 1. Detect if user is logged in
    const bodyText = document.body ? document.body.innerText : "";
    const isGuest = bodyText.includes("You are not logged in") || document.querySelector('input[name="logintoken"]');

    if (isGuest) {
      console.log("[Spectra Content] Guest / unauthenticated state detected.");
      return { authenticated: false };
    }

    // 2. Discover Moodle CSRF sesskey
    let sesskey = null;

    // Check hidden input
    const inputEl = document.querySelector('input[name="sesskey"]');
    if (inputEl && inputEl.value) {
      sesskey = inputEl.value;
    }

    // Check logout links (very reliable in Moodle: /login/logout.php?sesskey=XYZ)
    if (!sesskey) {
      const logoutLink = document.querySelector('a[href*="logout.php?sesskey="]');
      if (logoutLink) {
        const m = logoutLink.href.match(/sesskey=([a-zA-Z0-9]+)/);
        if (m) sesskey = m[1];
      }
    }

    // Check inline scripts
    if (!sesskey) {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const content = s.textContent || "";
        const m = content.match(/"sesskey":"([^"]+)"/) || content.match(/M\.cfg\.sesskey\s*=\s*"([^"]+)"/);
        if (m) {
          sesskey = m[1];
          break;
        }
      }
    }

    // 3. Discover Student Name & Avatar
    let userName = "UM Student";
    let userAvatarUrl = "";

    const userTextEl = document.querySelector(".usertext, .logininfo a, .usermenu .usertext, span.user-name");
    if (userTextEl && userTextEl.textContent.trim()) {
      userName = userTextEl.textContent.trim();
    }

    const avatarEl = document.querySelector(".userpicture, .userbutton img, .avatars img");
    if (avatarEl) {
      userAvatarUrl = avatarEl.getAttribute("src") || "";
    }

    // 4. Discover Enrolled Courses
    const courses = [];
    const seenIds = new Set();
    const courseLinks = document.querySelectorAll('a[href*="course/view.php?id="]');
    courseLinks.forEach((a) => {
      const href = a.href;
      const m = href.match(/id=(\d+)/);
      if (m && m[1] !== "1" && !seenIds.has(m[1])) {
        seenIds.add(m[1]);
        const text = a.textContent.trim();
        if (text && text.length >= 3) {
          const codeMatch = text.match(/\b([A-Z]{3,4}\d{4})\b/i);
          const code = codeMatch ? codeMatch[1].toUpperCase() : "UM";
          courses.push({
            id: m[1],
            code,
            name: text.replace(code, "").replace(/^[\s\-:]+/, "").trim() || text,
            url: href
          });
        }
      }
    });

    const sessionPayload = {
      authenticated: Boolean(sesskey),
      sesskey,
      userName,
      userAvatarUrl,
      courses,
      updatedAt: Date.now()
    };

    if (sesskey && typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({
        spectrum_live_session: sessionPayload,
        moodle_session_valid: true
      });
      console.log("[Spectra Content] Live SPeCTRUM session captured for:", userName);
    }

    return sessionPayload;
  }

  async function runSpectrumScraperInPage(moodleSession) {
    const MOODLE_SESSION = moodleSession || "uhe4fg1agh90g925grgtk22ob0";

    console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
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
    let rawCalendarData = null;
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

      const [calendarData] = await calendarRes.json();
      rawCalendarData = calendarData;

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
    let rawCourseData = null;
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

      const [courseData] = await courseRes.json();
      rawCourseData = courseData;

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

    const payload = {
      success: true,
      sesskey,
      userName,
      events,
      courses,
      rawCalendarEvents: rawCalendarData?.data?.events || [],
      rawCourses: rawCourseData?.data?.courses || []
    };

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({
        spectrum_scraped_data: payload,
        verifiedSesskey: sesskey,
        userName,
        sessionStatus: "connected"
      });
    }

    return payload;
  }

  // -------------------------------------------------------------
  // Instant In-Page Auto-Attendance Engine & Live Watcher
  // -------------------------------------------------------------
  async function initInPageAttendance() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    try {
      const store = await chrome.storage.local.get([
        "pref_auto_attendance",
        "course_occurrences",
        "course_passwords",
        "recorded_attendance_sessids"
      ]);

      const isAutoEnabled = store.pref_auto_attendance !== false;
      if (!isAutoEnabled) {
        console.log("[Spectra Content] Auto-attendance paused in user preferences.");
        return;
      }

      const currentUrl = window.location.href;

      // 1. PAGE: /mod/attendance/attendance.php (The check-in form itself)
      if (currentUrl.includes("/mod/attendance/attendance.php")) {
        handleAttendanceFormPage(store);
        return;
      }

      // 2. PAGE: /mod/attendance/view.php (Attendance session records table)
      if (currentUrl.includes("/mod/attendance/view.php")) {
        handleAttendanceViewPage(store);
        return;
      }

      // 3. PAGE: /course/view.php (Course home page)
      if (currentUrl.includes("/course/view.php")) {
        handleCourseViewPage(store);
        return;
      }
    } catch (e) {
      console.warn("[Spectra Content] Error initializing in-page attendance:", e);
    }
  }

  function handleAttendanceFormPage(store) {
    console.log("[Spectra Attendance] Active on attendance form page:", window.location.href);

    // Check if attendance is already recorded
    const bodyText = document.body ? document.body.innerText : "";
    if (
      bodyText.includes("Your attendance has been recorded") ||
      bodyText.includes("Kehadiran anda telah direkodkan") ||
      bodyText.includes("Attendance has been recorded")
    ) {
      showSpectraToast("Attendance recorded as Present! ✅", "success");
      const sessidMatch = window.location.href.match(/sessid=(\d+)/);
      if (sessidMatch) {
        chrome.runtime.sendMessage({
          action: "RECORD_ATTENDANCE_SUCCESS",
          payload: { sessid: sessidMatch[1], status: "Present" }
        }).catch(() => {});
      }
      return;
    }

    const form = document.querySelector('form[action*="attendance.php"], form#mform1');
    if (!form) return;

    // Extract sessid
    const sessidInput = form.querySelector('input[name="sessid"]');
    const sessidMatch = window.location.href.match(/sessid=(\d+)/);
    const sessid = sessidInput ? sessidInput.value : (sessidMatch ? sessidMatch[1] : null);

    // Find Present / Hadir radio button
    const radioInputs = form.querySelectorAll('input[name="status"]');
    let presentRadio = null;

    for (const r of radioInputs) {
      const id = r.id;
      const label = id ? document.querySelector(`label[for="${id}"]`) : null;
      const parentLabel = r.closest("label");
      const text = `${label?.textContent || ""} ${parentLabel?.textContent || ""} ${r.parentElement?.textContent || ""}`.trim();
      if (/present|hadir|^p\b/i.test(text)) {
        presentRadio = r;
        break;
      }
    }

    if (!presentRadio && radioInputs.length > 0) {
      presentRadio = radioInputs[0];
    }

    if (!presentRadio) {
      console.warn("[Spectra Attendance] Present option not found in form.");
      return;
    }

    // Select the Present radio button
    presentRadio.checked = true;
    presentRadio.dispatchEvent(new Event("change", { bubbles: true }));
    presentRadio.dispatchEvent(new Event("click", { bubbles: true }));

    // Check password field
    const pwdInput = form.querySelector('input[name="studentpassword"], input[name="password"], input[type="password"]');
    if (pwdInput) {
      const passwordsMap = store.course_passwords || {};
      let matchedPwd = "";
      for (const val of Object.values(passwordsMap)) {
        if (val && String(val).trim()) {
          matchedPwd = String(val).trim();
          break;
        }
      }

      if (matchedPwd) {
        pwdInput.value = matchedPwd;
        pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
        pwdInput.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        pwdInput.focus();
        pwdInput.style.outline = "3px solid #f59e0b";
        showSpectraToast("Password required: please enter password and submit.", "warning");
        return;
      }
    }

    // Find submit button
    const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], input#id_submitbutton');
    if (submitBtn) {
      showSpectraToast("Submitting attendance as Present... ⏳", "info");
      setTimeout(() => {
        submitBtn.click();
      }, 300);
    }
  }

  function handleAttendanceViewPage(store) {
    console.log("[Spectra Attendance] Active on attendance view page:", window.location.href);

    function scanForOpenSessions() {
      const submitLinks = document.querySelectorAll('a[href*="attendance.php?sessid="]');
      if (submitLinks.length === 0) return false;

      // Extract course code or occurrence context if available
      const courseIdMatch = window.location.href.match(/id=(\d+)/);
      const courseId = courseIdMatch ? courseIdMatch[1] : "";
      const preferredOcc = (store.course_occurrences && store.course_occurrences[courseId]) || "";

      for (const link of submitLinks) {
        const row = link.closest("tr");
        const rowText = row ? row.innerText : "";
        const linkText = link.innerText.trim();

        if (/submit|hantar|rekod/i.test(linkText) || /submit|hantar|rekod/i.test(rowText)) {
          console.log("[Spectra Attendance] Open session detected! Navigating to form:", link.href);
          showSpectraToast("Open attendance session found! Auto-submitting... 🚀", "success");
          window.location.href = link.href;
          return true;
        }
      }
      return false;
    }

    // Check immediately on page load
    const found = scanForOpenSessions();

    // If not found yet, set a gentle 10s poll to watch when lecturer opens it
    if (!found) {
      const watchInterval = setInterval(() => {
        if (scanForOpenSessions()) {
          clearInterval(watchInterval);
        }
      }, 10000);
    }
  }

  function handleCourseViewPage(store) {
    const directAttendanceLinks = document.querySelectorAll('a[href*="/mod/attendance/attendance.php?sessid="]');
    if (directAttendanceLinks.length > 0) {
      console.log("[Spectra Attendance] Direct attendance link found on course page:", directAttendanceLinks[0].href);
      showSpectraToast("Active attendance link detected! Auto-navigating... 🚀", "success");
      setTimeout(() => {
        window.location.href = directAttendanceLinks[0].href;
      }, 500);
    }
  }

  function showSpectraToast(message, type = "info") {
    const existing = document.getElementById("spectra-inpage-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "spectra-inpage-toast";
    const bgColors = {
      success: "#059669",
      warning: "#d97706",
      error: "#dc2626",
      info: "#2563eb"
    };

    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: ${bgColors[type] || bgColors.info};
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.25);
      transition: opacity 0.3s ease, transform 0.3s ease;
      display: flex;
      align-items: center;
      gap: 10px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }
})();
