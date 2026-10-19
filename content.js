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
})();
