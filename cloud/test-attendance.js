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
  parseAttendanceForm,
  parseAttendanceSessionDate,
  isAttendanceSessionPastOrCurrent
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

console.log(`\n=== All Attendance Tests Finished: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  throw new Error(`${failed} tests failed`);
}
