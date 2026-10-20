/**
 * Test Suite: Spectra Attendance & Auto-Checkin Pipeline
 * Tests occurrence matching, Moodle attendance HTML parsing,
 * status calculation, open check-in detection, form extraction, and Telegram alerts.
 */
if (typeof console === "undefined") {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

import {
  matchesOccurrence,
  parseAttendanceIndex,
  parseAttendanceView,
  parseAttendanceTabs,
  parseAttendanceForm,
  parseAttendanceSessionDate,
  isAttendanceSessionPastOrCurrent,
  extractStartTime
} from "../utils/parser.js";

import {
  fetchCourseAttendance,
  fetchLiveAllAttendance,
  autoSubmitAttendance,
  scanAndAutoRecordAttendance,
  formatAttendanceTelegram
} from "../utils/attendance.js";

console.log("=== Starting SPeCTRUM Attendance & Occurrence Tests ===");

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

// -------------------------------------------------------------
// 1. Occurrence Matching Tests
// -------------------------------------------------------------
assert(matchesOccurrence("All students", "Occ 1") === true, "All students matches Occ 1");
assert(matchesOccurrence("Semua pelajar", "Occ 2") === true, "Semua pelajar matches Occ 2");
assert(matchesOccurrence("", "Occ 1") === true, "Empty group matches Occ 1");
assert(matchesOccurrence("Group: Occ 1", "Occ 1") === true, "Group: Occ 1 matches Occ 1");
assert(matchesOccurrence("Lecture Occ 1", "Occ 1") === true, "Lecture Occ 1 matches Occ 1");
assert(matchesOccurrence("Tutorial Occ 2", "Occ 2") === true, "Tutorial Occ 2 matches Occ 2");
assert(matchesOccurrence("Occ 1", "Occurrence 1") === true, "Occ 1 matches Occurrence 1 (numeric equality)");
assert(matchesOccurrence("Occ 2", "Occ 1") === false, "Occ 2 does not match Occ 1");
assert(matchesOccurrence("Group 3", "Occ 1") === false, "Group 3 does not match Occ 1");
assert(matchesOccurrence("Occ 1", "all") === true, "Any group matches 'all'");

// -------------------------------------------------------------
// 2. parseAttendanceIndex Tests
// -------------------------------------------------------------
const sampleIndexHtml = `
  <div class="box generalbox">
    <table class="generaltable">
      <thead><tr><th>Name</th></tr></thead>
      <tbody>
        <tr>
          <td><a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=98765">Lecture Attendance</a></td>
        </tr>
      </tbody>
    </table>
  </div>
`;

const indexInstances = parseAttendanceIndex(sampleIndexHtml);
assert(indexInstances.length === 1, "Discovers 1 attendance instance");
assert(indexInstances[0].cmid === "98765", "Extracts cmid 98765 correctly");
assert(indexInstances[0].url.includes("view.php?id=98765"), "Extracts attendance URL correctly");

// -------------------------------------------------------------
// 3. parseAttendanceView Tests
// -------------------------------------------------------------
const sampleViewHtml = `
  <div class="attendance_view">
    <table class="generaltable attwidth">
      <tr><td>Taken sessions:</td><td>3</td></tr>
      <tr><td>Points over taken sessions:</td><td>5 / 6</td></tr>
      <tr><td>Percentage over taken sessions:</td><td>83.3%</td></tr>
    </table>

    <table class="generaltable attlist">
      <thead>
        <tr>
          <th>Date</th><th>Time</th><th>Type</th><th>Description</th><th>Status</th><th>Points</th><th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Mon 7 Oct 2024</td>
          <td>10:00AM - 12:00PM</td>
          <td>Occ 1</td>
          <td>Lecture 1: Intro to Data Science</td>
          <td>Present</td>
          <td>2 / 2</td>
          <td></td>
        </tr>
        <tr>
          <td>Mon 14 Oct 2024</td>
          <td>10:00AM - 12:00PM</td>
          <td>Occ 1</td>
          <td>Lecture 2: Supervised Learning</td>
          <td>Late</td>
          <td>1 / 2</td>
          <td>Late 5m</td>
        </tr>
        <tr>
          <td>Mon 21 Oct 2024</td>
          <td>10:00AM - 12:00PM</td>
          <td>Occ 1</td>
          <td>Lecture 3: Unsupervised Learning</td>
          <td>Absent</td>
          <td>0 / 2</td>
          <td></td>
        </tr>
        <tr>
          <td>Tue 22 Oct 2024</td>
          <td>02:00PM - 04:00PM</td>
          <td>Occ 2</td>
          <td>Tutorial Group 2 Only</td>
          <td>Present</td>
          <td>2 / 2</td>
          <td></td>
        </tr>
        <tr>
          <td>Mon 28 Oct 2024</td>
          <td>10:00AM - 12:00PM</td>
          <td>All students</td>
          <td>Lecture 4: Neural Networks</td>
          <td><a href="https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=44201&amp;sesskey=abc1234">Submit attendance</a></td>
          <td>?</td>
          <td></td>
        </tr>
      </tbody>
    </table>
  </div>
`;

const parsedViewOcc1 = parseAttendanceView(sampleViewHtml, "Occ 1");
assert(parsedViewOcc1.sessions.length === 5, "Extracts all 5 session rows");
assert(parsedViewOcc1.hasOpenSession === true, "Detects active open session for check-in");
assert(parsedViewOcc1.openSession?.sessid === "44201", "Extracts sessid 44201 for open session");
assert(parsedViewOcc1.summary.presentCount === 1, "Occ 1 present count is 1");
assert(parsedViewOcc1.summary.lateCount === 1, "Occ 1 late count is 1");
assert(parsedViewOcc1.summary.absentCount === 1, "Occ 1 absent count is 1");

// Test occurrence filtering: Occ 2 should count row 4 and open row 5
const parsedViewOcc2 = parseAttendanceView(sampleViewHtml, "Occ 2");
assert(parsedViewOcc2.summary.presentCount === 1, "Occ 2 present count is 1");
assert(parsedViewOcc2.summary.absentCount === 0, "Occ 2 absent count is 0 (row 3 was Occ 1)");

// -------------------------------------------------------------
// 4. parseAttendanceForm Tests
// -------------------------------------------------------------
const sampleFormHtml = `
  <form action="attendance.php" method="post" id="mform1">
    <input type="hidden" name="sessid" value="44201">
    <input type="hidden" name="sesskey" value="test_sesskey_999">
    <input type="hidden" name="mform_is_submitted" value="1">
    <div class="statusdesc">
      <input type="radio" name="status" value="701" id="id_status_701">
      <label for="id_status_701">Present</label>
      <input type="radio" name="status" value="702" id="id_status_702">
      <label for="id_status_702">Late</label>
    </div>
    <input type="submit" name="submitbutton" value="Save changes">
  </form>
`;

const formInfo = parseAttendanceForm(sampleFormHtml);
assert(formInfo.statusId === "701", "Extracts statusId 701 for 'Present'");
assert(formInfo.requiresPassword === false, "Detects no password required");
assert(formInfo.sesskey === "test_sesskey_999", "Extracts sesskey test_sesskey_999");
assert(formInfo.sessid === "44201", "Extracts sessid 44201");

// Form with password required
const samplePasswordFormHtml = `
  <form action="attendance.php" method="post">
    <input type="hidden" name="sessid" value="44202">
    <input type="hidden" name="sesskey" value="test_sesskey_888">
    <input type="radio" name="status" value="801"><label>Hadir</label>
    <input type="password" name="studentpassword" placeholder="Password">
  </form>
`;
const pwdFormInfo = parseAttendanceForm(samplePasswordFormHtml);
assert(pwdFormInfo.statusId === "801", "Extracts statusId 801 for 'Hadir'");
assert(pwdFormInfo.requiresPassword === true, "Detects password is required");

// -------------------------------------------------------------
// 5. Telegram Attendance Formatter Tests
// -------------------------------------------------------------
const tgSuccess = formatAttendanceTelegram({
  courseCode: "WIX2002",
  occurrence: "Occ 1",
  status: "Present",
  sessionDescription: "Lecture 4: Neural Networks",
  time: "10:00AM - 12:00PM",
  success: true
});
assert(tgSuccess.includes("Spectra Auto-Attendance: WIX2002"), "Formats success header");
assert(tgSuccess.includes("Successfully Recorded (Present)"), "Formats success status");
assert(tgSuccess.includes("Occ 1"), "Formats occurrence");

const tgPasswordAlert = formatAttendanceTelegram({
  courseCode: "WIX2002",
  occurrence: "Occ 1",
  sessionDescription: "Lecture 4",
  requiresPassword: true
});
assert(tgPasswordAlert.includes("Attendance is OPEN for check-in, but requires a password!"), "Formats password alert warning");

// -------------------------------------------------------------
// 6. Strict Respective Occurrence & Open Session Rejection Tests
// -------------------------------------------------------------
assert(matchesOccurrence("Occ 11", "Occ 1") === false, "Strict: Occ 11 does not match Occ 1");
assert(matchesOccurrence("Group: Occ 1", "Occ 1") === true, "Strict: Group: Occ 1 matches Occ 1");
assert(matchesOccurrence("Occ 1", "") === false, "Strict: Specific group does NOT match empty student occurrence");
assert(matchesOccurrence("All students", "") === true, "Strict: Universal group matches empty student occurrence");
assert(matchesOccurrence("Semua pelajar", "") === true, "Strict: Bahasa universal group matches empty student occurrence");

// Rejection when session is closed
const closedSubmission = await autoSubmitAttendance({
  sessid: "999",
  sesskey: "test_key",
  attendanceUrl: "https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=999",
  isOpen: false
});
assert(closedSubmission.success === false, "Strict: Rejects submission when session is not open");
assert(closedSubmission.error.includes("not currently open"), "Strict: Provides closed session rejection message");

// Rejection when occurrence does not match
const occMismatchSubmission = await autoSubmitAttendance({
  sessid: "999",
  sesskey: "test_key",
  attendanceUrl: "https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=999",
  sessionGroup: "Occ 2",
  studentOccurrence: "Occ 1",
  isOpen: true
});
assert(occMismatchSubmission.success === false, "Strict: Rejects submission when occurrence does not match");
assert(occMismatchSubmission.error.includes("does not match"), "Strict: Provides occurrence mismatch rejection message");

// -------------------------------------------------------------
// 7. Attendance Date Filtering: Only First Date Till Current Date
// -------------------------------------------------------------
const parsedDateEn = parseAttendanceSessionDate("Mon 7 Oct 2024", "10:00AM - 12:00PM");
assert(parsedDateEn !== null && !isNaN(parsedDateEn), "Parses English session date string");

const parsedDateMs = parseAttendanceSessionDate("Isnin 7 Okt 2024", "10:00AM - 12:00PM");
assert(parsedDateMs !== null && !isNaN(parsedDateMs), "Parses Bahasa Melayu session date string");

const parsedDateSlash = parseAttendanceSessionDate("07/10/2024");
assert(parsedDateSlash !== null && !isNaN(parsedDateSlash), "Parses DD/MM/YYYY session date string");

// Test isAttendanceSessionPastOrCurrent
const mockCurrentDate = new Date("2024-10-21T12:00:00Z");
assert(isAttendanceSessionPastOrCurrent("Mon 7 Oct 2024", "", "present", mockCurrentDate) === true, "Session on past date is included");
assert(isAttendanceSessionPastOrCurrent("Mon 21 Oct 2024", "", "unrecorded", mockCurrentDate) === true, "Session on current date is included");
assert(isAttendanceSessionPastOrCurrent("Mon 28 Oct 2024", "", "open", mockCurrentDate) === true, "Open session is included");
assert(isAttendanceSessionPastOrCurrent("Mon 28 Oct 2024", "", "unrecorded", mockCurrentDate) === false, "Unrecorded future session is excluded");

// Test parseAttendanceView with future sessions
const htmlWithFuture = `
  <table class="generaltable attlist">
    <tbody>
      <tr>
        <td>Mon 7 Oct 2024</td><td>10:00AM</td><td>Occ 1</td><td>Lecture 1</td><td>Present</td><td>2 / 2</td><td></td>
      </tr>
      <tr>
        <td>Mon 14 Oct 2024</td><td>10:00AM</td><td>Occ 1</td><td>Lecture 2</td><td>Late</td><td>1 / 2</td><td></td>
      </tr>
      <tr>
        <td>Mon 21 Oct 2024</td><td>10:00AM</td><td>Occ 1</td><td>Lecture 3 (Today)</td><td><a href="attendance.php?sessid=9901">Submit attendance</a></td><td>?</td><td></td>
      </tr>
      <tr>
        <td>Mon 28 Oct 2024</td><td>10:00AM</td><td>Occ 1</td><td>Lecture 4 (Next Week)</td><td>?</td><td>?</td><td></td>
      </tr>
      <tr>
        <td>Mon 4 Nov 2024</td><td>10:00AM</td><td>Occ 1</td><td>Lecture 5 (Future)</td><td>?</td><td>?</td><td></td>
      </tr>
    </tbody>
  </table>
`;

const viewResult = parseAttendanceView(htmlWithFuture, "Occ 1", mockCurrentDate);
assert(viewResult.sessions.length === 3, "Strict: Only 3 sessions from first date till current date are kept (future 2 excluded)");
assert(viewResult.sessions[0].date.includes("7 Oct"), "First session preserved");
assert(viewResult.sessions[2].date.includes("21 Oct"), "Current date session preserved");
assert(viewResult.hasOpenSession === true, "Open session on current date detected");

// -------------------------------------------------------------
// 8. Occurrence Filtering by Subject & Description
// -------------------------------------------------------------
assert(matchesOccurrence("All students", "Occ 1", "Occ 2 Lab") === false, "Universal group with Occ 2 in desc does not match Occ 1");
assert(matchesOccurrence("All students", "Occ 1", "Occ 1 Tutorial") === true, "Universal group with Occ 1 in desc matches Occ 1");
assert(matchesOccurrence("All students", "Occ 1", "General Lecture") === true, "Universal group with no occurrence in desc matches Occ 1");

// Test parseAttendanceView with occurrence not present in table
const parsedViewOcc99 = parseAttendanceView(sampleViewHtml, "Occ 99");
assert(parsedViewOcc99.summary.presentCount === 0, "Occ 99 present count is 0 (no fallback to other occs)");
assert(parsedViewOcc99.summary.lateCount === 0, "Occ 99 late count is 0");
assert(parsedViewOcc99.summary.absentCount === 0, "Occ 99 absent count is 0");

// Test fetchCourseAttendance occurrence filtering
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url.includes("index.php")) {
    return {
      ok: true,
      text: async () => `<a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=123">Attendance</a>`
    };
  }
  return {
    ok: true,
    text: async () => sampleViewHtml
  };
};

const recordOcc1 = await fetchCourseAttendance({ courseId: "123", courseCode: "WIX2002", occurrence: "Occ 1" });
assert(recordOcc1.sessions.length === 4, "fetchCourseAttendance for Occ 1 only returns 4 matching sessions (Occ 2 excluded)");
assert(recordOcc1.sessions.every(s => s.group !== "Occ 2"), "Occ 2 session strictly excluded for Occ 1");

const recordOcc2 = await fetchCourseAttendance({ courseId: "123", courseCode: "WIX2002", occurrence: "Occ 2" });
assert(recordOcc2.sessions.length === 2, "fetchCourseAttendance for Occ 2 only returns 2 matching sessions (Occ 1 excluded)");
assert(recordOcc2.sessions.every(s => s.group !== "Occ 1"), "Occ 1 sessions strictly excluded for Occ 2");

const recordAllOcc = await fetchCourseAttendance({ courseId: "123", courseCode: "WIX2002", occurrence: "" });
assert(recordAllOcc.sessions.length === 5, "fetchCourseAttendance with empty occurrence includes all sessions");

// -------------------------------------------------------------
// 9. Auto Attendance Scan & Self-Recording Pipeline Tests
// -------------------------------------------------------------
const sampleOpenOcc1Html = `
  <div class="attendance_view">
    <table class="generaltable attlist">
      <tbody>
        <tr>
          <td>Today</td>
          <td>10:00AM - 12:00PM</td>
          <td>Occ 1</td>
          <td>Lecture Check-in</td>
          <td><a href="https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=7701&amp;sesskey=sess123">Submit attendance</a></td>
          <td>?</td>
          <td></td>
        </tr>
      </tbody>
    </table>
  </div>
`;

const sampleOpenOcc2Html = `
  <div class="attendance_view">
    <table class="generaltable attlist">
      <tbody>
        <tr>
          <td>Today</td>
          <td>02:00PM - 04:00PM</td>
          <td>Occ 2</td>
          <td>Lab Check-in</td>
          <td><a href="https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=7702&amp;sesskey=sess123">Submit attendance</a></td>
          <td>?</td>
          <td></td>
        </tr>
      </tbody>
    </table>
  </div>
`;

const sampleStandardForm = `
  <form action="https://spectrum.um.edu.my/mod/attendance/attendance.php" method="post">
    <input type="hidden" name="sessid" value="7701">
    <input type="hidden" name="sesskey" value="sess123">
    <input type="radio" name="status" value="701"><label>Present</label>
    <input type="submit" name="submitbutton" value="Save changes">
  </form>
`;

const samplePasswordReqForm = `
  <form action="https://spectrum.um.edu.my/mod/attendance/attendance.php" method="post">
    <input type="hidden" name="sessid" value="7703">
    <input type="hidden" name="sesskey" value="sess123">
    <input type="radio" name="status" value="701"><label>Present</label>
    <input type="password" name="studentpassword" value="">
    <input type="submit" name="submitbutton" value="Save changes">
  </form>
`;

let postPayloadReceived = null;
globalThis.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (opts.method === "POST") {
    postPayloadReceived = opts.body;
    return {
      ok: true,
      text: async () => "Attendance has been successfully recorded."
    };
  }
  if (urlStr.includes("index.php")) {
    if (urlStr.includes("id=course_occ2")) {
      return {
        ok: true,
        text: async () => `<a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=cmid_occ2">Attendance</a>`
      };
    }
    return {
      ok: true,
      text: async () => `<a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=9901">Attendance</a>`
    };
  }
  if (urlStr.includes("view.php")) {
    if (urlStr.includes("id=cmid_occ2")) {
      return { ok: true, text: async () => sampleOpenOcc2Html };
    }
    return { ok: true, text: async () => sampleOpenOcc1Html };
  }
  if (urlStr.includes("attendance.php?sessid=7703")) {
    return { ok: true, text: async () => samplePasswordReqForm };
  }
  if (urlStr.includes("attendance.php")) {
    return { ok: true, text: async () => sampleStandardForm };
  }
  return { ok: true, text: async () => "" };
};

// 9.1: Auto-submit matches student occurrence
const autoResult1 = await scanAndAutoRecordAttendance({
  courses: [{ id: "101", code: "WIX2002", name: "Data Science" }],
  sesskey: "sess123",
  occurrencesMap: { "101": "Occ 1" },
  autoSubmit: true
});
assert(autoResult1.actions.length === 1, "Auto attendance: Detected 1 matching open session");
assert(autoResult1.actions[0].result.success === true, "Auto attendance: Successfully recorded attendance check-in");
assert(autoResult1.actions[0].result.status === "Present", "Auto attendance: Marked status as Present");
assert(postPayloadReceived && postPayloadReceived.includes("status=701"), "Auto attendance: POST payload contains status=701");
assert(postPayloadReceived.includes("sessid=7701"), "Auto attendance: POST payload contains sessid=7701");

// 9.2: Skips open session when occurrence does NOT match
const autoResult2 = await scanAndAutoRecordAttendance({
  courses: [{ id: "course_occ2", code: "WIA1001", name: "Programming" }],
  sesskey: "sess123",
  occurrencesMap: { "course_occ2": "Occ 1" }, // student is Occ 1, but session is Occ 2
  autoSubmit: true
});
assert(autoResult2.actions.length === 0, "Auto attendance: Strictly skipped open session belonging to different occurrence (Occ 2 vs student Occ 1)");

// 9.3: Password detection when password required but not supplied
const autoResult3 = await autoSubmitAttendance({
  sessid: "7703",
  sesskey: "sess123",
  attendanceUrl: "https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=7703",
  isOpen: true,
  sessionGroup: "Occ 1",
  studentOccurrence: "Occ 1"
});
assert(autoResult3.success === false, "Auto attendance: Pauses check-in when password is required");
assert(autoResult3.requiresPassword === true, "Auto attendance: Correctly flags requiresPassword: true");

// 9.4: Password submission succeeds when password provided
postPayloadReceived = null;
const autoResult4 = await autoSubmitAttendance({
  sessid: "7703",
  sesskey: "sess123",
  attendanceUrl: "https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=7703",
  password: "LECTURER_SECRET",
  isOpen: true,
  sessionGroup: "Occ 1",
  studentOccurrence: "Occ 1"
});
assert(autoResult4.success === true, "Auto attendance: Check-in succeeds with password provided");
assert(postPayloadReceived && postPayloadReceived.includes("studentpassword=LECTURER_SECRET"), "Auto attendance: Password included in POST request");

// 9.5: Duplicate prevention in background attendance loop
const mockRecordedSessids = new Set(["7701"]); // session 7701 was already processed in cycle 1
let alertsDispatched = 0;
for (const act of autoResult1.actions) {
  const sid = act.session?.sessid;
  if (!sid || mockRecordedSessids.has(sid)) continue;
  alertsDispatched++;
}
// -------------------------------------------------------------
// 10. Multi-Activity, Bottom-of-Page & Tab Discovery Tests
// -------------------------------------------------------------
// 10.1: parseAttendanceTabs extracts view mode and group tabs
const sampleTabHtml = `
  <div class="attendance-tabs">
    <ul class="nav nav-tabs">
      <li class="active"><a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=98765&amp;view=2">Weeks</a></li>
      <li><a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=98765&amp;view=1">Days</a></li>
      <li><a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=98765&amp;view=4">All past</a></li>
      <li><a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=98765&amp;view=5">All</a></li>
    </ul>
    <select name="group">
      <option value="0">All participants</option>
      <option value="101">Occ 1</option>
      <option value="102">Occ 2</option>
    </select>
  </div>
`;

const parsedTabs = parseAttendanceTabs(sampleTabHtml, "98765");
assert(parsedTabs.length >= 4, "Discovers attendance view mode and group tabs");
const hasAllTab = parsedTabs.some((t) => t.url.includes("view=5") || /all/i.test(t.label));
assert(hasAllTab, "Identifies the official 'All' tab (view=5)");
const hasOcc1Tab = parsedTabs.some((t) => t.isGroup && t.label.includes("Occ 1"));
assert(hasOcc1Tab, "Discovers group dropdown option for Occ 1");

// 10.2: Discovering attendance at the bottom of the course page
const sampleCourseWithBottomAttendance = `
  <div class="course-content">
    <div class="section" id="section-0">
      <div class="activityinstance">
        <a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=1111">Lecture Attendance</a>
      </div>
    </div>
    <div class="section" id="section-1">
      <p>Course notes...</p>
    </div>
    <!-- Attendance at the very bottom section -->
    <div class="section" id="section-14">
      <h3>Week 14 & Final Sessions</h3>
      <li class="activity attendance modtype_attendance" id="module-2222">
        <a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=2222">Tutorial Attendance (Occ 1)</a>
      </li>
      <li class="activity attendance modtype_attendance" id="module-3333">
        <a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=3333">Tutorial Attendance (Occ 2)</a>
      </li>
    </div>
  </div>
`;

const allCourseInstances = parseAttendanceIndex(sampleCourseWithBottomAttendance);
assert(allCourseInstances.length === 3, "Discovers all 3 attendance instances from top to bottom of course page");
assert(allCourseInstances.some((i) => i.cmid === "1111"), "Captures top section lecture attendance");
assert(allCourseInstances.some((i) => i.cmid === "2222"), "Captures bottom section Occ 1 attendance");
assert(allCourseInstances.some((i) => i.cmid === "3333"), "Captures bottom section Occ 2 attendance");

// 10.3: Occurrence matching using activityName
assert(matchesOccurrence("All students", "Occ 1", "", "Tutorial Attendance (Occ 1)") === true, "Activity with Occ 1 matches student Occ 1");
assert(matchesOccurrence("All students", "Occ 1", "", "Tutorial Attendance (Occ 2)") === false, "Activity with Occ 2 is strictly excluded for student Occ 1");
assert(matchesOccurrence("All students", "Occ 2", "", "Tutorial Attendance (Occ 2)") === true, "Activity with Occ 2 matches student Occ 2");
assert(matchesOccurrence("All students", "Occ 1", "", "Lecture Attendance") === true, "Universal lecture activity matches student Occ 1");

// 10.4: Past till current date ONLY for respective occurrence
const sampleMultiWeekHtml = `
  <table class="attlist">
    <tr>
      <td>Mon 7 Oct 2024</td><td>10:00AM</td><td>Occ 1</td><td>Past Session Occ 1</td><td>Present</td><td>2 / 2</td>
    </tr>
    <tr>
      <td>Mon 7 Oct 2024</td><td>10:00AM</td><td>Occ 2</td><td>Past Session Occ 2</td><td>Present</td><td>2 / 2</td>
    </tr>
    <tr>
      <td>Mon 21 Oct 2024</td><td>10:00AM</td><td>Occ 1</td><td>Current Date Session Occ 1</td><td><a href="https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=901">Submit attendance</a></td><td>?</td>
    </tr>
    <tr>
      <td>Mon 25 Nov 2024</td><td>10:00AM</td><td>Occ 1</td><td>Future Week Session Occ 1</td><td>?</td><td>?</td>
    </tr>
    <tr>
      <td>Mon 25 Nov 2024</td><td>10:00AM</td><td>Occ 2</td><td>Future Week Session Occ 2</td><td>?</td><td>?</td>
    </tr>
  </table>
`;

const parsedPastCurrentOnly = parseAttendanceView(sampleMultiWeekHtml, "Occ 1", new Date("2024-10-21T12:00:00"));
const sessionDescs = parsedPastCurrentOnly.sessions.map((s) => s.description);
assert(!sessionDescs.includes("Future Week Session Occ 1"), "Strict: Future unrecorded session is excluded");
assert(!sessionDescs.includes("Future Week Session Occ 2"), "Strict: Future unrecorded session for Occ 2 is excluded");
assert(sessionDescs.includes("Past Session Occ 1"), "Strict: Past session for respective occurrence is included");
assert(sessionDescs.includes("Current Date Session Occ 1"), "Strict: Current date session for respective occurrence is included");

// -------------------------------------------------------------
// 11. Current Date Scheduled Session & Auto-Fill Pipeline Tests
// Scenario: Current time is 12:00 PM, class is scheduled at 2:00 PM today.
// -------------------------------------------------------------
console.log("\n=== Testing Current Date Scheduled Sessions (12pm now, 2pm class) ===");

// 11.1: extractStartTime tests
const timeResult1 = extractStartTime("2:00PM - 4:00PM");
assert(timeResult1.hour === 14 && timeResult1.min === 0, "extractStartTime parses '2:00PM - 4:00PM' as hour 14");

const timeResult2 = extractStartTime("14:00 - 16:00");
assert(timeResult2.hour === 14 && timeResult2.min === 0, "extractStartTime parses '14:00 - 16:00' as hour 14");

const timeResult3 = extractStartTime("8.30 AM - 10.30 AM");
assert(timeResult3.hour === 8 && timeResult3.min === 30, "extractStartTime parses '8.30 AM' as hour 8, min 30");

// 11.2: Date parsing for today's 2pm session when reference time is 12pm
const ref12pm = new Date("2024-10-21T12:00:00"); // 12:00 PM on Mon 21 Oct 2024
const ts2pm = parseAttendanceSessionDate("Mon 21 Oct 2024", "2:00PM - 4:00PM", ref12pm);
const d2pm = new Date(ts2pm);
assert(d2pm.getDate() === 21 && d2pm.getHours() === 14, "parseAttendanceSessionDate reflects 2:00 PM today");

// 11.3: isAttendanceSessionPastOrCurrent for 2pm session today at 12pm
assert(
  isAttendanceSessionPastOrCurrent("Mon 21 Oct 2024", "2:00PM - 4:00PM", "unrecorded", ref12pm) === true,
  "2:00 PM unrecorded session today is included when current time is 12:00 PM"
);
assert(
  isAttendanceSessionPastOrCurrent("Today", "2:00PM - 4:00PM", "unrecorded", ref12pm) === true,
  "Today unrecorded session is included"
);
assert(
  isAttendanceSessionPastOrCurrent("Hari ini", "14:00 - 16:00", "unrecorded", ref12pm) === true,
  "Hari ini unrecorded session is included"
);
assert(
  isAttendanceSessionPastOrCurrent("Tue 22 Oct 2024", "2:00PM - 4:00PM", "unrecorded", ref12pm) === false,
  "Tomorrow 2:00 PM unrecorded session is excluded"
);

// 11.4: HTML parsing at 12pm: shows 2pm session with status 'today' / 'Scheduled Today (2:00PM)'
const tableWith2pmToday = `
  <table class="attlist">
    <tr>
      <td>Mon 14 Oct 2024</td><td>2:00PM - 4:00PM</td><td>Occ 1</td><td>Past Lecture</td><td>Present</td><td>2 / 2</td>
    </tr>
    <tr>
      <td>Mon 21 Oct 2024</td><td>2:00PM - 4:00PM</td><td>Occ 1</td><td>Today 2pm Lecture</td><td>?</td><td>?</td>
    </tr>
    <tr>
      <td>Mon 28 Oct 2024</td><td>2:00PM - 4:00PM</td><td>Occ 1</td><td>Next Week Lecture</td><td>?</td><td>?</td>
    </tr>
  </table>
`;

const parsedAt12pm = parseAttendanceView(tableWith2pmToday, "Occ 1", ref12pm);
assert(parsedAt12pm.sessions.length === 2, "At 12pm: Shows past session and today's 2pm session (next week excluded)");
const today2pmSess = parsedAt12pm.sessions.find(s => s.description === "Today 2pm Lecture");
assert(Boolean(today2pmSess), "Today's 2pm session is present in sessions list at 12pm");
assert(today2pmSess.isToday === true, "Today's 2pm session has isToday: true");
assert(today2pmSess.status === "today", "Today's 2pm unrecorded session has status: 'today'");
assert(today2pmSess.statusLabel.includes("Scheduled Today"), "Today's 2pm unrecorded session has statusLabel 'Scheduled Today'");
assert(parsedAt12pm.hasOpenSession === false, "At 12pm before check-in opens, hasOpenSession is false");

// 11.5: At 2:00 PM: Check-in opens on SPeCTRUM with submit link -> auto-fills
const tableWith2pmOpen = `
  <table class="attlist">
    <tr>
      <td>Mon 21 Oct 2024</td><td>2:00PM - 4:00PM</td><td>Occ 1</td><td>Today 2pm Lecture</td><td><a href="https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=9921">Submit attendance</a></td><td>?</td>
    </tr>
  </table>
`;
const parsedAt2pm = parseAttendanceView(tableWith2pmOpen, "Occ 1", ref12pm);
assert(parsedAt2pm.hasOpenSession === true, "When 2pm arrives and check-in opens, hasOpenSession is true");
assert(parsedAt2pm.openSession.sessid === "9921", "Open session matches sessid 9921");
assert(parsedAt2pm.openSession.status === "open", "Session status is 'open'");

// 11.6: Auto-fill check-in pipeline executes and submits Present for today's 2pm session
globalThis.fetch = async (url, options = {}) => {
  const urlStr = String(url);
  if (urlStr.includes("index.php")) {
    return {
      ok: true,
      text: async () => `<a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=9921">Attendance</a>`
    };
  }
  if (urlStr.includes("view.php")) {
    return { ok: true, text: async () => tableWith2pmOpen };
  }
  if (urlStr.includes("attendance.php?sessid=9921")) {
    return {
      ok: true,
      text: async () => `
        <form action="attendance.php" method="post">
          <input type="hidden" name="sesskey" value="sesskey_2pm">
          <input type="hidden" name="sessid" value="9921">
          <input type="radio" name="status" value="702"><label>Present</label>
        </form>
      `
    };
  }
  if (urlStr.includes("attendance.php") && options.method === "POST") {
    assert(options.body.includes("status=702"), "POST contains status=702 (Present)");
    assert(options.body.includes("sessid=9921"), "POST contains sessid=9921");
    return {
      ok: true,
      text: async () => `<div class="alert-success">Your attendance has been recorded</div>`
    };
  }
  return { ok: true, text: async () => "" };
};

const autoFillResult = await scanAndAutoRecordAttendance({
  courses: [{ id: "999", code: "WIX2002", name: "Software Engineering" }],
  sesskey: "sesskey_2pm",
  occurrencesMap: { "999": "Occ 1" },
  autoSubmit: true,
  referenceDate: ref12pm
});

assert(autoFillResult.actions.length === 1, "Auto attendance detected 1 open session at 2pm");
assert(autoFillResult.actions[0].result.success === true, "Successfully auto-filled attendance for today's 2pm session");
assert(autoFillResult.actions[0].result.status === "Present", "Recorded status is Present");

// -------------------------------------------------------------
// 13. Robust Attendance Form Parsing Tests (Attribute Orders & Labels)
// -------------------------------------------------------------
const reversedAttrFormHtml = `
  <form id="mform1" action="https://spectrum.um.edu.my/mod/attendance/attendance.php">
    <input value="test_sesskey_abc" name="sesskey" type="hidden">
    <input value="8821" name="sessid" type="hidden">
    <div class="status-option">
      <input value="301" name="status" type="radio" id="id_status_301">
      <label for="id_status_301">P (Present)</label>
    </div>
    <div class="status-option">
      <input value="302" name="status" type="radio" id="id_status_302">
      <label for="id_status_302">L (Late)</label>
    </div>
  </form>
`;
const parsedReversed = parseAttendanceForm(reversedAttrFormHtml);
assert(parsedReversed.sessid === "8821", "Extracts sessid when value precedes name");
assert(parsedReversed.sesskey === "test_sesskey_abc", "Extracts sesskey when value precedes name");
assert(parsedReversed.statusId === "301", "Extracts Present statusId when name precedes type and label uses for attribute");

const acronymFormHtml = `
  <form action="attendance.php">
    <input name="sesskey" value="key_123" type="hidden">
    <input name="sessid" value="9901" type="hidden">
    <label><input name="status" type="radio" value="501"> P</label>
    <label><input name="status" type="radio" value="502"> L</label>
  </form>
`;
const parsedAcronym = parseAttendanceForm(acronymFormHtml);
assert(parsedAcronym.statusId === "501", "Recognizes P acronym as Present");

const malayFormHtml = `
  <form action="attendance.php">
    <input name="sesskey" value="key_123" type="hidden">
    <input name="sessid" value="9902" type="hidden">
    <label><input name="status" type="radio" value="601"> Hadir</label>
    <label><input name="status" type="radio" value="602"> Lewat</label>
  </form>
`;
const parsedMalay = parseAttendanceForm(malayFormHtml);
assert(parsedMalay.statusId === "601", "Recognizes Hadir as Present");

console.log(`\n=== All Attendance Tests Finished: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  throw new Error(`${failed} tests failed`);
}
