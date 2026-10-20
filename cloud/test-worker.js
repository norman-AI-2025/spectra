/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Automated Test Suite for cloud-relay-worker.js
 *
 * Runs on standard JavaScriptCore (jsc) or Node.js.
 * Simulates Cloudflare Workers runtime (Request, Response, Headers, URL, KV).
 */

// -------------------------------------------------------------------
// Polyfills & Mock Runtime for Cloudflare Workers Environment
// -------------------------------------------------------------------
if (typeof console === "undefined") {
  globalThis.console = {
    log: (...args) => print("[WORKER]", ...args),
    warn: (...args) => print("[WORKER WARN]", ...args),
    error: (...args) => print("[WORKER ERR]", ...args),
    info: (...args) => print("[WORKER INFO]", ...args)
  };
} else {
  if (!console.error) console.error = (...args) => print("[WORKER ERR]", ...args);
  if (!console.warn) console.warn = (...args) => print("[WORKER WARN]", ...args);
  if (!console.log) console.log = (...args) => print("[WORKER]", ...args);
}

if (typeof URL === "undefined") {
  globalThis.URL = class URL {
    constructor(urlString) {
      this.href = urlString;
      const match = urlString.match(/^(?:https?:\/\/[^\/]+)?(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/);
      this.pathname = (match && match[1]) ? match[1] : "/";
      this.search = (match && match[2]) ? "?" + match[2] : "";
    }
  };
}

if (typeof Headers === "undefined") {
  globalThis.Headers = class Headers {
    constructor(init = {}) {
      this._headers = {};
      if (init) {
        for (const [k, v] of Object.entries(init)) {
          this._headers[k.toLowerCase()] = String(v);
        }
      }
    }
    get(name) {
      return this._headers[name.toLowerCase()] || null;
    }
    set(name, value) {
      this._headers[name.toLowerCase()] = String(value);
    }
  };
}

if (typeof Response === "undefined") {
  globalThis.Response = class Response {
    constructor(body = null, init = {}) {
      this._body = body;
      this.status = init.status || 200;
      this.headers = new Headers(init.headers || {});
    }
    async json() {
      if (typeof this._body === "string") {
        return JSON.parse(this._body);
      }
      return this._body;
    }
    async text() {
      if (typeof this._body === "string") return this._body;
      return JSON.stringify(this._body);
    }
  };
}

class MockRequest {
  constructor(url, options = {}) {
    this.url = url;
    this.method = options.method || "GET";
    this.headers = new Headers(options.headers || {});
    this._body = options.body;
  }
  async json() {
    if (typeof this._body === "string") {
      return JSON.parse(this._body);
    }
    return this._body || {};
  }
  async text() {
    return typeof this._body === "string" ? this._body : JSON.stringify(this._body);
  }
}

class MockKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key) || null;
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
  async delete(key) {
    this.store.delete(key);
  }
}

class MockExecutionContext {
  constructor() {
    this.promises = [];
  }
  waitUntil(promise) {
    this.promises.push(promise);
  }
}

// Global fetch mock for SPeCTRUM & Telegram
const networkCalls = [];
globalThis.fetch = async function mockFetch(url, options = {}) {
  networkCalls.push({ url, method: options.method || "GET", headers: options.headers, body: options.body });

  // Mock SPeCTRUM calendar endpoint
  if (url.includes("spectrum.um.edu.my/calendar/view.php")) {
    return {
      status: 200,
      url: url,
      ok: true,
      text: async () => `<div class="event"><h3 class="name">Lab Submission</h3></div>`
    };
  }

  // Mock SPeCTRUM attendance index
  if (url.includes("spectrum.um.edu.my/mod/attendance/index.php")) {
    return {
      status: 200,
      ok: true,
      text: async () => `<a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=9901">Attendance</a>`
    };
  }

  // Mock SPeCTRUM attendance view (All sessions)
  if (url.includes("spectrum.um.edu.my/mod/attendance/view.php")) {
    return {
      status: 200,
      ok: true,
      text: async () => `
        <table>
          <tr>
            <td>Mon 21 Oct 2024</td>
            <td>2:00PM - 4:00PM</td>
            <td>Occ 1</td>
            <td>Lecture 4</td>
            <td><a href="https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=7701">Submit attendance</a></td>
          </tr>
        </table>
      `
    };
  }

  // Mock SPeCTRUM attendance form
  if (url.includes("attendance.php?sessid=7701")) {
    return {
      status: 200,
      ok: true,
      text: async () => `
        <form action="attendance.php" method="post">
          <input type="hidden" name="sesskey" value="sess_cloud_123">
          <input type="hidden" name="sessid" value="7701">
          <input type="radio" name="status" value="701"><label>Present</label>
        </form>
      `
    };
  }

  // Mock SPeCTRUM forum index
  if (url.includes("spectrum.um.edu.my/mod/forum/index.php")) {
    return {
      status: 200,
      ok: true,
      text: async () => `<a href="https://spectrum.um.edu.my/mod/forum/view.php?id=8801">Announcements</a>`
    };
  }

  // Mock SPeCTRUM forum view
  if (url.includes("spectrum.um.edu.my/mod/forum/view.php")) {
    return {
      status: 200,
      ok: true,
      text: async () => `
        <table>
          <tr>
            <td><a href="https://spectrum.um.edu.my/mod/forum/discuss.php?d=5501">Replacement Class Scheduled</a></td>
            <td>Dr. Lecturer</td>
            <td>20 Oct 2024</td>
          </tr>
        </table>
      `
    };
  }

  // Mock Telegram sendMessage endpoint
  if (url.includes("api.telegram.org/bot")) {
    return {
      status: 200,
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 999 } })
    };
  }

  return {
    status: 200,
    ok: true,
    text: async () => "OK",
    json: async () => ({ ok: true })
  };
};

// -------------------------------------------------------------------
// Import Cloud Relay Worker
// -------------------------------------------------------------------
import worker from "./cloud-relay-worker.js";

// Test Runner Framework
let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  if (condition) {
    print(`  [PASS] ${testName}`);
    passedTests++;
  } else {
    print(`  [FAIL] ${testName}`);
    failedTests++;
  }
}

async function runTestSuite() {
  print("=================================================================");
  print("  Running Test Suite: Spectra Cloud Relay Worker");
  print("=================================================================\n");

  const kv = new MockKV();
  const env = {
    SPECTRA_KV: kv,
    RELAY_SECRET_KEY: "test-auth-secret-123",
    TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN",
    TELEGRAM_CHAT_ID: "987654321"
  };

  // Test 1: CORS Preflight (OPTIONS)
  print("Test 1: CORS Preflight (OPTIONS request)");
  const req1 = new MockRequest("https://worker.spectra.dev/sync", { method: "OPTIONS" });
  const res1 = await worker.fetch(req1, env, new MockExecutionContext());
  assert(res1.status === 200, "Returns HTTP 200 on OPTIONS preflight");
  assert(res1.headers.get("Access-Control-Allow-Origin") === "*", "Contains Access-Control-Allow-Origin header");
  assert(res1.headers.get("Access-Control-Allow-Methods") !== null, "Contains Access-Control-Allow-Methods header");

  // Test 2: Authentication Check - Missing Authorization Header
  print("\nTest 2: Security - Missing Bearer Token");
  const req2 = new MockRequest("https://worker.spectra.dev/status", { method: "GET" });
  const res2 = await worker.fetch(req2, env, new MockExecutionContext());
  assert(res2.status === 401, "Rejects request with HTTP 401 Unauthorized");
  const body2 = await res2.json();
  assert(body2.error && body2.error.includes("Unauthorized"), "Returns JSON error explaining missing/invalid Bearer token");

  // Test 3: Authentication Check - Invalid Bearer Token
  print("\nTest 3: Security - Invalid Bearer Token");
  const req3 = new MockRequest("https://worker.spectra.dev/status", {
    method: "GET",
    headers: { "Authorization": "Bearer wrong-passcode" }
  });
  const res3 = await worker.fetch(req3, env, new MockExecutionContext());
  assert(res3.status === 401, "Rejects incorrect Bearer token with HTTP 401");

  // Test 4: Initial Status Check (No Session in KV yet)
  print("\nTest 4: Initial Status Check (Empty KV)");
  const req4 = new MockRequest("https://worker.spectra.dev/status", {
    method: "GET",
    headers: { "Authorization": "Bearer test-auth-secret-123" }
  });
  const res4 = await worker.fetch(req4, env, new MockExecutionContext());
  assert(res4.status === 200, "Returns HTTP 200 for authenticated status query");
  const body4 = await res4.json();
  assert(body4.status === "online", "Worker status is 'online'");
  assert(body4.hasSession === false, "Reports hasSession: false when no session is stored");

  // Test 5: Session Synchronization (POST /sync with valid session)
  print("\nTest 5: Session Synchronization (POST /sync)");
  const sessionPayload = {
    action: "SESSION_SYNC",
    sessionToken: "MoodleSessionLiveToken_XYZ789",
    domain: "spectrum.um.edu.my",
    expires: 1799999999,
    courses: [{ id: "101", code: "WIX2002", name: "Software Engineering" }],
    occurrences: { "101": "Occ 1" },
    timestamp: Date.now()
  };
  const req5 = new MockRequest("https://worker.spectra.dev/sync", {
    method: "POST",
    headers: {
      "Authorization": "Bearer test-auth-secret-123",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(sessionPayload)
  });
  const res5 = await worker.fetch(req5, env, new MockExecutionContext());
  assert(res5.status === 200, "Returns HTTP 200 on successful sync");
  const body5 = await res5.json();
  assert(body5.success === true, "Response JSON indicates success: true");

  // Verify KV storage
  const storedKvData = await kv.get("moodle_session");
  assert(storedKvData !== null, "Session record was persisted to SPECTRA_KV");
  const parsedKv = JSON.parse(storedKvData);
  assert(parsedKv.sessionToken === "MoodleSessionLiveToken_XYZ789", "Stored session token matches payload");

  // Test 6: Status Check After Session Synchronization
  print("\nTest 6: Status Check After Synchronization");
  const req6 = new MockRequest("https://worker.spectra.dev/status", {
    method: "GET",
    headers: { "Authorization": "Bearer test-auth-secret-123" }
  });
  const res6 = await worker.fetch(req6, env, new MockExecutionContext());
  const body6 = await res6.json();
  assert(body6.hasSession === true, "Reports hasSession: true after sync");
  assert(body6.updatedAt !== null, "Includes ISO updatedAt timestamp");
  assert(body6.cronSchedule === "Every 1 minute", "Reports active 1m cron schedule");

  // Test 7: Error Validation - Missing sessionToken in POST /sync
  print("\nTest 7: Error Validation (Missing sessionToken in POST /sync)");
  const req7 = new MockRequest("https://worker.spectra.dev/sync", {
    method: "POST",
    headers: { "Authorization": "Bearer test-auth-secret-123" },
    body: JSON.stringify({ domain: "spectrum.um.edu.my" })
  });
  const res7 = await worker.fetch(req7, env, new MockExecutionContext());
  assert(res7.status === 400, "Returns HTTP 400 Bad Request when sessionToken is missing");
  const body7 = await res7.json();
  assert(body7.error === "Missing sessionToken", "Returns explicit validation message");

  // Test 8: Manual Poll Endpoint (POST /poll)
  print("\nTest 8: Manual Polling Execution (POST /poll)");
  const req8 = new MockRequest("https://worker.spectra.dev/poll", {
    method: "POST",
    headers: { "Authorization": "Bearer test-auth-secret-123" }
  });
  const res8 = await worker.fetch(req8, env, new MockExecutionContext());
  assert(res8.status === 200, "Returns HTTP 200 on manual poll execution");
  const body8 = await res8.json();
  assert(body8.status === "ok", "Polling status reports 'ok'");

  // Test 9: Cron Trigger Execution (scheduled event)
  print("\nTest 9: Cron Trigger Execution (scheduled event)");
  const ctx = new MockExecutionContext();
  await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
  assert(ctx.promises.length > 0, "ctx.waitUntil registered the background polling promise");
  await Promise.all(ctx.promises);
  assert(true, "Cron background polling job resolved successfully");

  // Test 10: Unknown Route (404 Not Found)
  print("\nTest 10: Routing - Unknown Endpoint");
  const req10 = new MockRequest("https://worker.spectra.dev/unknown-route", {
    method: "GET",
    headers: { "Authorization": "Bearer test-auth-secret-123" }
  });
  const res10 = await worker.fetch(req10, env, new MockExecutionContext());
  assert(res10.status === 404, "Returns HTTP 404 for undefined endpoints");

  // Test 11: 24/7 Cloud Attendance Auto-Submission
  print("\nTest 11: 24/7 Cloud Attendance Auto-Submission");
  const req11 = new MockRequest("https://worker.spectra.dev/poll", {
    method: "POST",
    headers: { "Authorization": "Bearer test-auth-secret-123" }
  });
  const res11 = await worker.fetch(req11, env, new MockExecutionContext());
  assert(res11.status === 200, "POST /poll executes successfully");
  const body11 = await res11.json();
  assert(body11.attendanceRecorded >= 0, "Cloud Relay polling job completed attendance check");

  // Verify recorded sessid was stored in KV to prevent double check-ins
  const storedRecorded = await kv.get("recorded_sessids");
  assert(storedRecorded !== null && storedRecorded.includes("7701"), "Sessid 7701 stored in recorded_sessids in KV");

  // Test 12: 24/7 Cloud Announcement Polling & Telegram Alert
  print("\nTest 12: 24/7 Cloud Announcement Polling");
  // Seed initial KV so next poll triggers alert for new announcement
  await kv.put("sent_announcement_ids", JSON.stringify(["5500"]));
  const req12 = new MockRequest("https://worker.spectra.dev/poll", {
    method: "POST",
    headers: { "Authorization": "Bearer test-auth-secret-123" }
  });
  const res12 = await worker.fetch(req12, env, new MockExecutionContext());
  assert(res12.status === 200, "POST /poll executes successfully for announcements");
  const body12 = await res12.json();
  assert(body12.announcementsSent >= 1, "Dispatched Telegram alert for new announcement 5501");

  const storedAnnouncements = await kv.get("sent_announcement_ids");
  assert(storedAnnouncements !== null && storedAnnouncements.includes("5501"), "Announcement 5501 persisted in sent_announcement_ids in KV");

  // Summary
  print("\n=================================================================");
  print(`  Test Results: ${passedTests} passed, ${failedTests} failed`);
  print("=================================================================");

  if (failedTests > 0) {
    throw new Error(`${failedTests} tests failed.`);
  }
}

// Execute test suite
runTestSuite().catch((err) => {
  print("\n[ERROR] Test suite encountered an unhandled error:\n" + err);
});
