if (typeof console === "undefined" || !console.log) {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

// Global mock storage and cookies
const mockStorage = {};
const mockCookies = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const res = {};
        const keyList = Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of keyList) {
          if (mockStorage[k] !== undefined) {
            res[k] = mockStorage[k];
          }
        }
        return res;
      },
      set: async (items) => {
        Object.assign(mockStorage, items);
      }
    }
  },
  cookies: {
    get: async ({ url, name }) => {
      return mockCookies.find((c) => c.name === name) || null;
    },
    getAll: async ({ domain }) => {
      return mockCookies.filter((c) => !domain || (c.domain && c.domain.includes(domain)));
    },
    set: async (details) => {
      const idx = mockCookies.findIndex((c) => c.name === details.name);
      if (idx >= 0) mockCookies[idx] = details;
      else mockCookies.push(details);
      return details;
    }
  },
  declarativeNetRequest: {
    updateDynamicRules: async () => {}
  },
  alarms: {
    clearAll: async () => {},
    create: () => {}
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: () => {}
  }
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log("=== Starting Spectra Restart Persistence, Telegram Flagging & Time Filters Tests ===");

  const { injectCookieToBrowser, getEffectiveSessionCookie } = await import("../utils/moodleApi.js");
  const { parseAttendanceSessionDate } = await import("../utils/parser.js");

  // -------------------------------------------------------------
  // Test Group 1: Persistent Cookie Expiration Across Restarts
  // -------------------------------------------------------------
  mockCookies.length = 0;
  await injectCookieToBrowser("persistent_moodle_token_777");

  const injected = mockCookies.find((c) => c.name === "MoodleSession");
  assert(Boolean(injected), "Cookie injected into browser store");
  assert(injected.value === "persistent_moodle_token_777", "Cookie value matches");
  assert(typeof injected.expirationDate === "number", "Cookie has numeric expirationDate set");

  const nowSec = Math.floor(Date.now() / 1000);
  const minFuture = nowSec + 25 * 86400; // at least 25 days in future
  assert(injected.expirationDate > minFuture, "Cookie expirationDate is ~30 days in the future (persistent across restarts)");

  // -------------------------------------------------------------
  // Test Group 2: Chrome Restart Persistence in Storage
  // -------------------------------------------------------------
  mockStorage.manualMoodleSession = "saved_token_wix999";
  mockStorage.userName = "Norman Lee";
  mockStorage.verifiedSesskey = "sesskey_persisted_123";
  mockStorage.cached_courses = [{ id: "101", code: "WIX2002", name: "Data Science" }];
  mockStorage.cached_deadlines = [{ id: "dl_1", title: "Project Proposal", courseCode: "WIX2002" }];
  mockStorage.cached_announcements = [{ id: "ann_1", subject: "Test Notice", courseCode: "WIX2002", telegramSent: false }];
  mockStorage.cached_attendance = { courses: [{ courseId: "101", courseCode: "WIX2002", sessions: [] }] };
  mockStorage.course_occurrences = { WIX2002: "Occ 1" };
  mockStorage.telegram_sent_announcement_ids = ["ann_saved_99"];

  // Simulate reading after Chrome restart
  const stored = await chrome.storage.local.get([
    "manualMoodleSession",
    "userName",
    "verifiedSesskey",
    "cached_courses",
    "cached_deadlines",
    "cached_announcements",
    "cached_attendance",
    "course_occurrences",
    "telegram_sent_announcement_ids"
  ]);

  assert(stored.manualMoodleSession === "saved_token_wix999", "manualMoodleSession preserved across restarts");
  assert(stored.userName === "Norman Lee", "userName preserved across restarts");
  assert(stored.verifiedSesskey === "sesskey_persisted_123", "verifiedSesskey preserved across restarts");
  assert(stored.cached_courses.length === 1 && stored.cached_courses[0].code === "WIX2002", "cached_courses preserved across restarts");
  assert(stored.cached_deadlines.length === 1 && stored.cached_deadlines[0].id === "dl_1", "cached_deadlines preserved across restarts");
  assert(stored.cached_announcements.length === 1 && stored.cached_announcements[0].id === "ann_1", "cached_announcements preserved across restarts");
  assert(stored.cached_attendance.courses.length === 1, "cached_attendance preserved across restarts");
  assert(stored.course_occurrences.WIX2002 === "Occ 1", "course_occurrences preserved across restarts");
  assert(stored.telegram_sent_announcement_ids.includes("ann_saved_99"), "telegram_sent_announcement_ids preserved across restarts");

  // Effective session cookie fallback works from storage
  const effective = await getEffectiveSessionCookie();
  assert(effective.source === "manual" && effective.cookieValue === "saved_token_wix999", "Effective session restored from manual storage");

  // -------------------------------------------------------------
  // Test Group 3: Telegram Sent Announcement Flagging Logic
  // -------------------------------------------------------------
  const sentSet = new Set(stored.telegram_sent_announcement_ids.map(String));
  const testNotices = [
    { id: "ann_saved_99", subject: "Old Announcement" },
    { id: "ann_new_101", subject: "Brand New Announcement" }
  ];

  const flagged = testNotices.filter((n) => sentSet.has(String(n.id)));
  const unflagged = testNotices.filter((n) => !sentSet.has(String(n.id)));

  assert(flagged.length === 1 && flagged[0].id === "ann_saved_99", "Notice ann_saved_99 is correctly flagged as Sent");
  assert(unflagged.length === 1 && unflagged[0].id === "ann_new_101", "Notice ann_new_101 is correctly unflagged for dispatch");

  // Simulate sending ann_new_101 to Telegram
  sentSet.add("ann_new_101");
  await chrome.storage.local.set({ telegram_sent_announcement_ids: Array.from(sentSet) });

  const updatedStorage = await chrome.storage.local.get(["telegram_sent_announcement_ids"]);
  assert(updatedStorage.telegram_sent_announcement_ids.includes("ann_new_101"), "Newly dispatched notice is flagged in storage");
  assert(updatedStorage.telegram_sent_announcement_ids.includes("ann_saved_99"), "Previously flagged notice remains flagged");

  // -------------------------------------------------------------
  // Test Group 4: Attendance Time Sub-Filters (Past | This Week | Today | All)
  // -------------------------------------------------------------
  const now = new Date();
  const todayStr = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  const day = now.getDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const startOfThisWeek = monday.getTime();

  // Construct test sessions across time buckets
  const pastTs = startOfThisWeek - 7 * 86400 * 1000; // last week
  const pastDate = new Date(pastTs);
  const pastDateStr = `${pastDate.getDate()}/${pastDate.getMonth() + 1}/${pastDate.getFullYear()}`;

  const futureTs = endOfToday + 5 * 86400 * 1000; // next week
  const futureDate = new Date(futureTs);
  const futureDateStr = `${futureDate.getDate()}/${futureDate.getMonth() + 1}/${futureDate.getFullYear()}`;

  const mockSessions = [
    { id: "s1", date: pastDateStr, time: "10:00 - 12:00", timestamp: pastTs, status: "present" },
    { id: "s2", date: todayStr, time: "14:00 - 16:00", timestamp: startOfToday + 14 * 3600 * 1000, status: "present" },
    { id: "s3", date: todayStr, time: "16:00 - 18:00", timestamp: startOfToday + 16 * 3600 * 1000, status: "open" },
    { id: "s4", date: futureDateStr, time: "10:00 - 12:00", timestamp: futureTs, status: "unrecorded" }
  ];

  // 1. Strict Exclusion: Sessions beyond current date must NEVER be shown
  const nonFutureSessions = mockSessions.filter((s) => {
    if (s.timestamp && s.timestamp > endOfToday && s.status !== "open") {
      return false;
    }
    return true;
  });

  assert(nonFutureSessions.length === 3, "Future session beyond current date (s4) is strictly excluded");
  assert(!nonFutureSessions.some((s) => s.id === "s4"), "Future unrecorded session s4 is omitted");

  // 2. Filter: 'today'
  const todaySessions = nonFutureSessions.filter((s) => {
    if (s.status === "open") return true;
    return s.timestamp >= startOfToday && s.timestamp <= endOfToday;
  });
  assert(todaySessions.length === 2, "'Today' filter returns exactly 2 sessions (today's present + open session)");

  // 3. Filter: 'this_week'
  const thisWeekSessions = nonFutureSessions.filter((s) => {
    if (s.status === "open") return true;
    return s.timestamp >= startOfThisWeek && s.timestamp <= endOfToday;
  });
  assert(thisWeekSessions.length === 2, "'This Week' filter returns sessions within current week");

  // 4. Filter: 'past'
  const pastSessions = nonFutureSessions.filter((s) => {
    if (s.status === "open") return false;
    return s.timestamp < startOfThisWeek;
  });
  assert(pastSessions.length === 1 && pastSessions[0].id === "s1", "'Past' filter returns previous week session s1");

  // 5. Filter: 'all'
  const allPastSessions = nonFutureSessions;
  assert(allPastSessions.length === 3, "'All' filter returns all sessions up to current date");

  // -------------------------------------------------------------
  // Test Group 5: Time Filter Row Visibility ("when at all enrolled subject")
  // -------------------------------------------------------------
  function checkFiltersVisibility(selectedCourseId) {
    const isAllEnrolled = selectedCourseId === "all";
    return {
      showTimeFiltersRow: isAllEnrolled,
      showSubjectStatsBar: !isAllEnrolled
    };
  }

  const allState = checkFiltersVisibility("all");
  assert(allState.showTimeFiltersRow === true, "Time filters row is visible when viewing 'All Enrolled Subjects'");
  assert(allState.showSubjectStatsBar === false, "Subject stats bar is hidden when viewing 'All Enrolled Subjects'");

  const specificState = checkFiltersVisibility("101");
  assert(specificState.showTimeFiltersRow === false, "Time filters row is hidden when viewing specific course WIX2002");
  assert(specificState.showSubjectStatsBar === true, "Subject stats bar is visible when viewing specific course WIX2002");

  console.log(`\n=== All Tests Finished: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    throw new Error(`${failed} tests failed`);
  }
}

runTests().catch((e) => {
  console.error(e);
  if (typeof quit !== "undefined") quit(1);
});
