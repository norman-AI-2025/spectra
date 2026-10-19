if (typeof console === "undefined") {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

// Global mock environment for Chrome extension APIs
const mockStorage = {};
const mockCookies = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const res = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) {
          if (mockStorage[k] !== undefined) res[k] = mockStorage[k];
        }
        return res;
      },
      set: async (obj) => {
        Object.assign(mockStorage, obj);
      }
    }
  },
  cookies: {
    get: async ({ url, name }) => {
      return mockCookies.find((c) => c.name === name) || null;
    },
    getAll: async ({ domain }) => {
      return mockCookies;
    },
    set: async ({ url, name, value, path, secure, sameSite }) => {
      const idx = mockCookies.findIndex((c) => c.name === name);
      const entry = { url, name, value, path, secure, sameSite };
      if (idx >= 0) mockCookies[idx] = entry;
      else mockCookies.push(entry);
      return entry;
    }
  }
};

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    testsFailed++;
    print("❌ FAIL: " + message);
    throw new Error(message);
  } else {
    testsPassed++;
    print("✅ PASS: " + message);
  }
}

// Simple DOMParser mock for jsc
globalThis.DOMParser = class {
  parseFromString(str, type) {
    return {
      querySelector: (selector) => {
        if (selector.includes("usertext")) {
          const match = str.match(/class="usertext">([^<]+)<\/span>/);
          return match ? { textContent: match[1] } : null;
        }
        if (selector.includes("/user/profile.php")) {
          const match = str.match(/href="([^"]*\/user\/profile\.php\?id=(\d+))"/);
          return match ? { href: match[1] } : null;
        }
        if (selector.includes("userpicture")) {
          const match = str.match(/class="userpicture"[^>]*src="([^"]+)"/);
          return match ? { getAttribute: (a) => match[1] } : null;
        }
        return null;
      }
    };
  }
};

async function runTests() {
  print("=== Starting Manual MoodleSession & Hybrid Authentication Tests ===");

  // 1. Test getEffectiveSessionCookie precedence
  const {
    getEffectiveSessionCookie,
    injectCookieToBrowser,
    verifyAndFetchSesskey,
    saveManualSession,
    autoDetectSession,
    getSessionContext,
    AuthRequiredError,
    InvalidSessionError
  } = await import("../utils/moodleApi.js");

  // Case 1A: Empty storage & empty cookies -> returns null
  delete mockStorage.manualMoodleSession;
  delete mockStorage.manual_moodle_session;
  mockCookies.length = 0;

  const res1 = await getEffectiveSessionCookie();
  assert(res1.source === null && res1.cookieValue === null, "Precedence 3: Neither exists -> null");

  // Case 1B: Browser cookie exists, no manual storage -> returns browser cookie
  mockCookies.push({ name: "MoodleSession", value: "browser_token_123456789012345" });
  const res2 = await getEffectiveSessionCookie();
  assert(res2.source === "browser" && res2.cookieValue === "browser_token_123456789012345", "Precedence 2: Browser cookie fallback");

  // Case 1C: Manual session in storage takes precedence over browser cookie
  mockStorage.manualMoodleSession = "manual_token_abcdef1234567890";
  const res3 = await getEffectiveSessionCookie();
  assert(res3.source === "manual" && res3.cookieValue === "manual_token_abcdef1234567890", "Precedence 1: manualMoodleSession has highest precedence");

  // 2. Test injectCookieToBrowser
  await injectCookieToBrowser("injected_moodle_session_test");
  const injectedCookie = mockCookies.find((c) => c.name === "MoodleSession");
  assert(injectedCookie && injectedCookie.value === "injected_moodle_session_test", "injectCookieToBrowser writes to chrome.cookies");

  // 3. Test verifyAndFetchSesskey regex parsing
  // Mock globalThis.fetch for SPeCTRUM /my/
  globalThis.fetch = async (url, options) => {
    if (url.includes("/my/")) {
      return {
        ok: true,
        status: 200,
        redirected: false,
        url: url,
        text: async () => `
          <!DOCTYPE html>
          <html>
            <head><script>M.cfg = {"sesskey":"test_csrf_sesskey_999"};</script></head>
            <body>
              <span class="usertext">Norman Lee</span>
              <a href="https://spectrum.um.edu.my/user/profile.php?id=88421">Profile</a>
              <img class="userpicture" src="https://spectrum.um.edu.my/theme/image.php/boost/core/1/u/f1" />
            </body>
          </html>
        `
      };
    }
    return { ok: false, status: 404 };
  };

  const verifyRes = await verifyAndFetchSesskey("valid_manual_session_token_123");
  assert(verifyRes.authenticated === true, "verifyAndFetchSesskey succeeds on valid response");
  assert(verifyRes.sesskey === "test_csrf_sesskey_999", "verifyAndFetchSesskey extracts sesskey");
  assert(verifyRes.userName === "Norman Lee", "verifyAndFetchSesskey extracts student name");
  assert(verifyRes.userId === "88421", "verifyAndFetchSesskey extracts student user ID");
  assert(mockStorage.verifiedSesskey === "test_csrf_sesskey_999", "verifiedSesskey cached in storage");
  assert(mockStorage.sessionStatus === "connected", "sessionStatus stored as connected");

  // 4. Test SSO Redirect detection
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      status: 200,
      redirected: true,
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      text: async () => "<html>Sign in to Microsoft 365</html>"
    };
  };

  let caughtInvalid = false;
  try {
    await verifyAndFetchSesskey("expired_cookie_token");
  } catch (err) {
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") {
      caughtInvalid = true;
    }
  }
  assert(caughtInvalid, "Redirect to Microsoft SSO throws InvalidSessionError");

  // 5. Test saveManualSession
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: url,
      text: async () => '{"sesskey":"new_sesskey_xyz"}<span class="usertext">Norman</span>'
    };
  };

  const saveRes = await saveManualSession("uhe4fg1agh90g925grgtk22ob0");
  assert(saveRes.sesskey === "new_sesskey_xyz", "saveManualSession validates, persists, and extracts sesskey");
  assert(mockStorage.manualMoodleSession === "uhe4fg1agh90g925grgtk22ob0", "manualMoodleSession saved in storage");

  // 6. Test saveManualSession format validation
  let caughtFormatErr = false;
  try {
    await saveManualSession("short");
  } catch (err) {
    caughtFormatErr = true;
  }
  assert(caughtFormatErr, "Short/invalid token format rejected");

  // 7. Test autoDetectSession
  mockCookies.length = 0;
  mockCookies.push({ name: "MoodleSession", value: "autodetected_token_1234567890" });
  const autoRes = await autoDetectSession();
  assert(autoRes.sesskey === "new_sesskey_xyz", "autoDetectSession grabs browser cookie and verifies");
  assert(mockStorage.manualMoodleSession === "autodetected_token_1234567890", "auto-detected token written to manualMoodleSession");

  // 9. Test inPageSpectrumScraper with mock endpoints
  const { inPageSpectrumScraper } = await import("../utils/moodleApi.js");
  globalThis.document = { cookie: "" };
  globalThis.console.table = (t) => print("[table] " + JSON.stringify(t));

  globalThis.fetch = async (url, options) => {
    if (url.includes("/my/")) {
      return {
        ok: true,
        redirected: false,
        url: url,
        text: async () => '{"sesskey":"test_sesskey_12345"}<span class="usertext">Norman Lee</span>'
      };
    }
    if (url.includes("core_calendar_get_action_events_by_timesort")) {
      return {
        ok: true,
        json: async () => [{
          data: {
            events: [{
              id: 991,
              name: "WIX2002 Lab Submission",
              timesort: 1729340000,
              course: { shortname: "WIX2002", fullname: "Data Science" },
              action: { actionable: true, url: "https://spectrum.um.edu.my/mod/assign/view.php?id=991" }
            }]
          }
        }]
      };
    }
    if (url.includes("core_course_get_enrolled_courses_by_timeline_classification")) {
      return {
        ok: true,
        json: async () => [{
          data: {
            courses: [{
              id: 456,
              shortname: "WIX2002",
              fullname: "Data Science Special Topics",
              viewurl: "https://spectrum.um.edu.my/course/view.php?id=456"
            }]
          }
        }]
      };
    }
    return { ok: true, text: async () => "{}" };
  };

  const scrapeResult = await inPageSpectrumScraper("uhe4fg1agh90g925grgtk22ob0");
  assert(scrapeResult.success === true, "inPageSpectrumScraper executed successfully");
  assert(scrapeResult.sesskey === "test_sesskey_12345", "inPageSpectrumScraper extracted sesskey");
  assert(scrapeResult.userName === "Norman Lee", "inPageSpectrumScraper extracted userName");
  assert(scrapeResult.events.length === 1, "inPageSpectrumScraper scraped calendar event");
  assert(scrapeResult.events[0]["Assignment / Task"] === "WIX2002 Lab Submission", "Scraped event name matches");
  assert(scrapeResult.courses.length === 1, "inPageSpectrumScraper scraped enrolled course");
  assert(scrapeResult.courses[0]["Code"] === "WIX2002", "Scraped course code matches");

  print(`\n=== All Tests Finished: ${testsPassed} passed, ${testsFailed} failed ===`);
}

runTests().catch((e) => {
  print("Fatal Error in tests: " + e + "\n" + e.stack);
});
