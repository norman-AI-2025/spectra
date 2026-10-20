/**
 * Test Suite: Spectra Live Course Deadlines & Occurrence Filtering
 * Validates scanning of /mod/assign/index.php and /course/view.php (top to bottom)
 * with strict occurrence filtering and deduplication.
 */

if (typeof console === "undefined") {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

import {
  parseCourseAssignmentsIndex,
  parseCourseViewSubmissions,
  isRespectiveOccurrence,
  calculateUrgency,
  formatTimeRemaining,
  cleanMoodleTitle
} from "../utils/parser.js";
import { fetchLiveDeadlines } from "../utils/calendar.js";

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

console.log("=== Testing Spectra Course Submission Pages & Occurrence Filtering ===");

// -------------------------------------------------------------
// Test 1: isRespectiveOccurrence with compound titles
// -------------------------------------------------------------
console.log("\n--- Sub-test 1: isRespectiveOccurrence ---");
assert(isRespectiveOccurrence("", "Occ 1", "Assignment 1 (Occ 1)"), "Assignment 1 (Occ 1) matches student Occ 1");
assert(!isRespectiveOccurrence("", "Occ 1", "Assignment 1 (Occ 2)"), "Assignment 1 (Occ 2) strictly rejected for student Occ 1");
assert(!isRespectiveOccurrence("", "Occ 2", "Assignment 2 (Occ 1)"), "Assignment 2 (Occ 1) strictly rejected for student Occ 2");
assert(isRespectiveOccurrence("", "Occ 2", "Assignment 2 (Occ 2)"), "Assignment 2 (Occ 2) matches student Occ 2");
assert(isRespectiveOccurrence("", "Occ 1", "Final Project (Universal Submission)"), "Universal assignment matches student Occ 1");
assert(isRespectiveOccurrence("", "Occ 1", "General Assignment 3"), "General assignment with number matches student Occ 1");
assert(!isRespectiveOccurrence("", "Occ 1", "Lab Report - Kumpulan 2"), "Kumpulan 2 rejected for student Occ 1");
assert(isRespectiveOccurrence("", "Occ 1", "Lab Report - Kumpulan 1"), "Kumpulan 1 matches student Occ 1");

// -------------------------------------------------------------
// Test 2: parseCourseAssignmentsIndex (/mod/assign/index.php)
// -------------------------------------------------------------
console.log("\n--- Sub-test 2: parseCourseAssignmentsIndex ---");
const mockAssignIndexHtml = `
<table class="generaltable mod_index">
  <thead>
    <tr>
      <th>Topic</th>
      <th>Name</th>
      <th>Due date</th>
      <th>Submission</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Week 1</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1001">Assignment 1 (Occ 1)</a></td>
      <td>Friday, 24 October 2026, 11:59 PM</td>
      <td>Submitted for grading</td>
    </tr>
    <tr>
      <td>Week 1</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1002">Assignment 1 (Occ 2)</a></td>
      <td>Friday, 24 October 2026, 11:59 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 5</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1003">Midterm Project (All Students)</a></td>
      <td>Monday, 10 November 2026, 5:00 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 14</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1004">Final Dropbox (Occ 2)</a></td>
      <td>Sunday, 20 December 2026, 11:59 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 14</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1005">Final Dropbox (Occ 1)</a></td>
      <td>Sunday, 20 December 2026, 11:59 PM</td>
      <td>No submission</td>
    </tr>
  </tbody>
</table>
`;

const occ1Assignments = parseCourseAssignmentsIndex(mockAssignIndexHtml, "WIF3001", "Software Engineering", "Occ 1");
assert(occ1Assignments.length === 3, `Occ 1 gets exactly 3 assignments (got ${occ1Assignments.length})`);
assert(occ1Assignments.some(a => a.cmid === "1001" && a.isSubmittedOnSpectrum === true), "Assignment 1 (Occ 1) is included and marked Submitted");
assert(occ1Assignments.some(a => a.cmid === "1003"), "Universal Midterm Project is included");
assert(occ1Assignments.some(a => a.cmid === "1005"), "Bottom Week 14 Final Dropbox (Occ 1) is included");
assert(!occ1Assignments.some(a => a.cmid === "1002"), "Assignment 1 (Occ 2) is strictly excluded");
assert(!occ1Assignments.some(a => a.cmid === "1004"), "Final Dropbox (Occ 2) is strictly excluded");

const occ2Assignments = parseCourseAssignmentsIndex(mockAssignIndexHtml, "WIF3001", "Software Engineering", "Occ 2");
assert(occ2Assignments.length === 3, `Occ 2 gets exactly 3 assignments (got ${occ2Assignments.length})`);
assert(occ2Assignments.some(a => a.cmid === "1002"), "Assignment 1 (Occ 2) is included for Occ 2");
assert(occ2Assignments.some(a => a.cmid === "1004"), "Final Dropbox (Occ 2) is included for Occ 2");
assert(!occ2Assignments.some(a => a.cmid === "1001"), "Assignment 1 (Occ 1) is strictly excluded for Occ 2");

// -------------------------------------------------------------
// Test 3: parseCourseViewSubmissions (/course/view.php)
// -------------------------------------------------------------
console.log("\n--- Sub-test 3: parseCourseViewSubmissions (Top to bottom) ---");
const mockCourseViewHtml = `
<ul class="topics">
  <!-- Top Section (Week 1) -->
  <li class="section main" id="section-1">
    <h3 class="sectionname">Week 1: Introduction</h3>
    <ul class="section img-text">
      <li class="activity assign modtype_assign" id="module-2001">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=2001">
            <span class="instancename">Diagnostic Quiz / Assignment (Occ 1)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Friday, 24 October 2026, 11:59 PM</div>
        <div class="activity-information"><span class="badge">Done</span></div>
      </li>
      <li class="activity assign modtype_assign" id="module-2002">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=2002">
            <span class="instancename">Diagnostic Quiz / Assignment (Occ 2)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Friday, 24 October 2026, 11:59 PM</div>
      </li>
    </ul>
  </li>

  <!-- Middle Section (Week 7) -->
  <li class="section main" id="section-7">
    <h3 class="sectionname">Week 7: Midterm Quiz</h3>
    <ul class="section img-text">
      <li class="activity quiz modtype_quiz" id="module-2003">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/quiz/view.php?id=2003">
            <span class="instancename">Midterm Online Quiz (All Students)</span>
          </a>
        </div>
        <div class="activity-dates">Closes: Saturday, 15 November 2026, 10:00 PM</div>
      </li>
    </ul>
  </li>

  <!-- Bottom Section (Week 14) -->
  <li class="section main" id="section-14">
    <h3 class="sectionname">Week 14: Project Submission</h3>
    <ul class="section img-text">
      <li class="activity turnitintooltwo modtype_turnitintooltwo" id="module-2004">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/turnitintooltwo/view.php?id=2004">
            <span class="instancename">Final Capstone Report Turnitin (Occ 2)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Thursday, 24 December 2026, 11:59 PM</div>
      </li>
      <li class="activity turnitintooltwo modtype_turnitintooltwo" id="module-2005">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/turnitintooltwo/view.php?id=2005">
            <span class="instancename">Final Capstone Report Turnitin (Occ 1)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Thursday, 24 December 2026, 11:59 PM</div>
      </li>
    </ul>
  </li>
</ul>
`;

const courseSubmissionsOcc1 = parseCourseViewSubmissions(mockCourseViewHtml, "WIF3002", "Data Science", "Occ 1");
assert(courseSubmissionsOcc1.length === 3, `Discovers 3 submissions for Occ 1 from top to bottom (got ${courseSubmissionsOcc1.length})`);
assert(courseSubmissionsOcc1.some(s => s.cmid === "2001" && s.type === "assign"), "Top section Week 1 Occ 1 assignment captured");
assert(courseSubmissionsOcc1.some(s => s.cmid === "2003" && s.type === "quiz"), "Middle section Week 7 Quiz captured");
assert(courseSubmissionsOcc1.some(s => s.cmid === "2005" && s.type === "turnitin"), "Bottom section Week 14 Turnitin Occ 1 captured");
assert(!courseSubmissionsOcc1.some(s => s.cmid === "2002"), "Top section Occ 2 assignment excluded");
assert(!courseSubmissionsOcc1.some(s => s.cmid === "2004"), "Bottom section Occ 2 Turnitin excluded");

// -------------------------------------------------------------
// Test 4: End-to-End fetchLiveDeadlines with Mocked Fetches
// -------------------------------------------------------------
console.log("\n--- Sub-test 4: fetchLiveDeadlines Pipeline ---");

// Mock global fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const urlStr = String(url);

  // Moodle AJAX calendar
  if (urlStr.includes("core_calendar_get_action_events_by_timesort")) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          data: {
            events: [
              {
                id: 9001,
                instance: 1001,
                name: "Assignment 1 (Occ 1) is due",
                timesort: Math.floor(Date.now() / 1000) + 3600 * 12, // 12h away (< 24h: urgent)
                course: { id: 10, shortname: "WIF3001", fullname: "Software Engineering" },
                url: "https://spectrum.um.edu.my/mod/assign/view.php?id=1001",
                action: { actionable: false } // already submitted
              },
              {
                id: 9002,
                instance: 1002,
                name: "Assignment 1 (Occ 2) is due",
                timesort: Math.floor(Date.now() / 1000) + 3600 * 12,
                course: { id: 10, shortname: "WIF3001", fullname: "Software Engineering" },
                url: "https://spectrum.um.edu.my/mod/assign/view.php?id=1002",
                action: { actionable: true }
              }
            ]
          }
        }
      ]
    };
  }

  // Assign index
  if (urlStr.includes("/mod/assign/index.php")) {
    return {
      ok: true,
      status: 200,
      text: async () => mockAssignIndexHtml
    };
  }

  // Course view
  if (urlStr.includes("/course/view.php")) {
    return {
      ok: true,
      status: 200,
      text: async () => mockCourseViewHtml
    };
  }

  return { ok: false, status: 404, text: async () => "" };
};

const mockCourses = [
  { id: "10", code: "WIF3001", name: "Software Engineering" }
];
const mockOccurrences = {
  "10": "Occ 1"
};

const deadlines = await fetchLiveDeadlines("test_sesskey", mockCourses, mockOccurrences);

assert(Array.isArray(deadlines), "fetchLiveDeadlines returns an array");
assert(deadlines.length > 0, `Returns merged deadlines list (count: ${deadlines.length})`);

// Check that Occ 2 items were strictly excluded
const hasOcc2 = deadlines.some(d => d.title.includes("Occ 2"));
assert(!hasOcc2, "Strict: No Occ 2 activities in the resulting deadlines list");

// Check deduplication
const item1001List = deadlines.filter(d => d.cmid === "1001" || d.id === "1001" || d.id === "9001");
assert(item1001List.length === 1, "Assignment 1 (Occ 1) is deduplicated into a single entry");

// Check completion status
const item1001 = item1001List[0];
assert(item1001 && item1001.isCompleted === true, "Item 1001 is correctly marked isCompleted: true");
assert(item1001 && item1001.isSubmittedOnSpectrum === true, "Item 1001 is marked isSubmittedOnSpectrum: true");

// Check bottom dropbox included
const bottomItem = deadlines.find(d => d.cmid === "1005" || d.title.includes("Final Dropbox (Occ 1)"));
assert(Boolean(bottomItem), "Bottom Week 14 dropbox Final Dropbox (Occ 1) is present in deadlines");

// Restore fetch
globalThis.fetch = originalFetch;

console.log(`\n=== All Deadlines Tests Finished: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  throw new Error(`${failed} tests failed!`);
}
