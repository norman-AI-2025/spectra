/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Calendar & Deadline Pipeline
 * Directly binds to SPeCTRUM's native AJAX calendar service and scans each enrolled course's
 * submission pages (/mod/assign/index.php and /course/view.php) from top to bottom,
 * filtering strictly by the student's respective occurrence.
 */

import {
  cleanMoodleTitle,
  extractCourseCode,
  calculateUrgency,
  parseCalendarEvents,
  parseCourseAssignmentsIndex,
  parseCourseViewSubmissions,
  parseEnrolledCourses,
  isRespectiveOccurrence
} from "./parser.js";
import { InvalidSessionError, getSessionContext } from "./moodleApi.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Generate normalized activity key for deduplicating activities across
 * Calendar AJAX, /mod/assign/index.php, and /course/view.php
 */
function getActivityKey(item) {
  if (item.url) {
    const m = item.url.match(/id=(\d+)/);
    const mod = item.url.match(/mod\/([a-z0-9_]+)\//);
    const modName = mod ? mod[1] : (item.type || "assign");
    if (m) return `${modName}_${m[1]}`;
  }
  if (item.cmid) return `${item.type || "assign"}_${item.cmid}`;
  if (item.id) return `${item.type || "assign"}_${item.id}`;
  return `${item.courseCode || ""}_${item.title || ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Fetch live submission deadlines directly from Moodle's native AJAX calendar service,
 * plus all course assignment pages and course view pages (scanned top to bottom),
 * filtering out activities that belong to other occurrences.
 *
 * @param {string} [sesskey] - User session key
 * @param {Array} [courses] - Enrolled course objects [{ id, code, name }]
 * @param {Object} [occurrencesMap] - Map of courseId/courseCode -> student occurrence string (e.g. "Occ 1")
 * @param {string} [defaultOccurrence] - Fallback student occurrence
 * @returns {Promise<Array>} Array of unified deadlines
 */
export async function fetchLiveDeadlines(sesskey, courses = [], occurrencesMap = {}, defaultOccurrence = "") {
  if (!sesskey) {
    try {
      const ctx = await getSessionContext();
      sesskey = ctx.sesskey;
    } catch (e) {
      // Session context retrieval failed, will proceed if courses are already available or throw if unauthenticated
    }
  }

  // Load courses and occurrences from storage if not provided
  if (!courses || courses.length === 0) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get(["courses", "courseOccurrences", "studentOccurrence"]);
        if (Array.isArray(stored.courses) && stored.courses.length > 0) {
          courses = stored.courses;
        }
        if (stored.courseOccurrences && Object.keys(occurrencesMap).length === 0) {
          occurrencesMap = stored.courseOccurrences;
        }
        if (!defaultOccurrence && stored.studentOccurrence) {
          defaultOccurrence = stored.studentOccurrence;
        }
      } catch (e) {}
    }
  }

  // If courses list is still empty, auto-discover enrolled courses from /my/
  if (!courses || courses.length === 0) {
    try {
      const myRes = await fetch(`${SPECTRUM_BASE_URL}/my/`, { credentials: "include" });
      if (myRes.ok) {
        const myHtml = await myRes.text();
        courses = parseEnrolledCourses(myHtml);
      }
    } catch (e) {
      console.warn("[Spectra] Could not auto-fetch enrolled courses from /my/:", e);
    }
  }

  // Retrieve locally marked completed IDs
  let completedSet = new Set();
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["completed_assignment_ids"]);
      completedSet = new Set(stored.completed_assignment_ids || []);
    } catch (e) {}
  }

  const deadlinesMap = new Map();

  // -------------------------------------------------------------
  // 1. Fetch Native SPeCTRUM AJAX Calendar Service / Upcoming Events First (Fastest)
  // -------------------------------------------------------------
  let eventsData = null;
  if (sesskey) {
    const timesortfrom = Math.floor(Date.now() / 1000) - 86400; // 24h past to catch impending / overdue items
    const ajaxEndpoint = `${SPECTRUM_BASE_URL}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_calendar_get_action_events_by_timesort`;

    const payload = [
      {
        index: 0,
        methodname: "core_calendar_get_action_events_by_timesort",
        args: {
          limitnum: 50,
          timesortfrom: timesortfrom
        }
      }
    ];

    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 6000) : null;
      let res;
      try {
        res = await fetch(ajaxEndpoint, {
          method: "POST",
          credentials: "include",
          signal: controller?.signal,
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(payload)
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (res.status === 401 || res.status === 403) {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          await chrome.storage.local.set({ sessionStatus: "expired" });
        }
        throw new InvalidSessionError("SPeCTRUM calendar API returned HTTP " + res.status);
      }

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data[0]) {
          if (data[0].error === true) {
            const exception = data[0].exception || "";
            if (exception === "servicerequireslogin" || data[0].message?.toLowerCase().includes("login")) {
              if (typeof chrome !== "undefined" && chrome.storage?.local) {
                await chrome.storage.local.set({ sessionStatus: "expired" });
              }
              throw new InvalidSessionError("SPeCTRUM requires active login. Please update your MoodleSession cookie.");
            }
          } else if (data[0].data?.events) {
            eventsData = data[0].data.events;
          }
        }
      }
    } catch (err) {
      if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") {
        throw err;
      }
      console.warn("[Spectra] AJAX calendar query failed, trying /calendar/view.php fallback:", err);
    }
  }

  // Fallback: live HTML scrape of /calendar/view.php?view=upcoming if AJAX gave no data
  if (!eventsData && deadlinesMap.size === 0) {
    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;
      let htmlRes;
      try {
        htmlRes = await fetch(`${SPECTRUM_BASE_URL}/calendar/view.php?view=upcoming`, {
          method: "GET",
          credentials: "include",
          signal: controller?.signal
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (htmlRes && htmlRes.redirected && (htmlRes.url.includes("login") || htmlRes.url.includes("microsoftonline"))) {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          await chrome.storage.local.set({ sessionStatus: "expired" });
        }
        throw new InvalidSessionError("Redirected to login portal.");
      }

      if (htmlRes && htmlRes.ok) {
        const html = await htmlRes.text();
        const rawEvents = parseCalendarEvents(html);
        rawEvents.forEach((evt) => {
          const key = getActivityKey(evt);
          deadlinesMap.set(key, {
            ...evt,
            isCompleted: completedSet.has(evt.id)
          });
        });
      }
    } catch (htmlErr) {
      if (htmlErr instanceof InvalidSessionError || htmlErr.name === "INVALID_SESSION") throw htmlErr;
    }
  }

  // Merge events from AJAX Calendar into deadlinesMap
  if (Array.isArray(eventsData)) {
    for (const evt of eventsData) {
      const timestamp = (evt.timesort || evt.timestart) * 1000;
      const courseCode = extractCourseCode(evt.course?.shortname || evt.course?.fullname || "");
      const courseId = evt.course?.id ? String(evt.course.id) : "";
      const studentOcc = occurrencesMap[courseId] || occurrencesMap[courseCode] || defaultOccurrence || "";
      const cleanedTitle = cleanMoodleTitle(evt.name);

      // Strict occurrence filter for calendar events as well!
      if (!isRespectiveOccurrence("", studentOcc, cleanedTitle)) {
        continue;
      }

      const eventUrl = evt.action?.url || evt.url || `${SPECTRUM_BASE_URL}/mod/${evt.modulename || "assign"}/view.php?id=${evt.instance || evt.id}`;
      const eventId = String(evt.id);
      const isSubmittedOnSpectrum = evt.action ? !evt.action.actionable : false;

      const calItem = {
        id: eventId,
        cmid: String(evt.instance || evt.id),
        title: cleanedTitle,
        courseCode: courseCode || (evt.course?.shortname || "N/A"),
        courseName: evt.course?.fullname || courseCode,
        dueDate: new Date(timestamp).toISOString(),
        dueTimestamp: timestamp,
        formattedTime: evt.formattedtime || new Date(timestamp).toLocaleString("en-MY", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }),
        url: eventUrl,
        type: evt.modulename || "assign",
        urgency: calculateUrgency(timestamp),
        isSubmittedOnSpectrum,
        isCompleted: isSubmittedOnSpectrum || completedSet.has(eventId),
        weight: "",
        matchesOccurrence: true
      };

      const key = getActivityKey(calItem);
      deadlinesMap.set(key, calItem);
    }
  }

  // -------------------------------------------------------------
  // 2. Fetch Course-Specific Submission Pages (/mod/assign/index.php & /course/view.php)
  //    Enriches calendar data and catches dropboxes whether at the top, middle, or bottom of the page.
  // -------------------------------------------------------------
  if (Array.isArray(courses) && courses.length > 0) {
    const coursePromises = courses.map(async (course) => {
      const courseId = course.id;
      const courseCode = course.code || course.shortname || extractCourseCode(course.name) || "Course";
      const courseName = course.name || courseCode;
      const studentOcc = occurrencesMap[courseId] || occurrencesMap[courseCode] || defaultOccurrence || "";

      // A. Check /mod/assign/index.php?id={courseId} (Assignments overview page)
      try {
        const assignIndexUrl = `${SPECTRUM_BASE_URL}/mod/assign/index.php?id=${encodeURIComponent(courseId)}`;
        const ctrl1 = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tid1 = ctrl1 ? setTimeout(() => ctrl1.abort(), 4000) : null;
        let res;
        try {
          res = await fetch(assignIndexUrl, { credentials: "include", signal: ctrl1?.signal });
        } finally {
          if (tid1) clearTimeout(tid1);
        }
        if (res && res.ok) {
          const html = await res.text();
          const items = parseCourseAssignmentsIndex(html, courseCode, courseName, studentOcc);
          items.forEach((item) => {
            const key = getActivityKey(item);
            if (deadlinesMap.has(key)) {
              const existing = deadlinesMap.get(key);
              if (item.isSubmittedOnSpectrum) {
                existing.isSubmittedOnSpectrum = true;
                existing.isCompleted = true;
                existing.submissionStatus = "Submitted";
              }
            } else {
              deadlinesMap.set(key, item);
            }
          });
        }
      } catch (err) {
        console.warn(`[Spectra] Error checking assign index for ${courseCode}:`, err);
      }

      // B. Check /course/view.php?id={courseId} (Full course page scanned top to bottom for quizzes, workshops, Turnitin, and bottom dropboxes)
      try {
        const courseViewUrl = `${SPECTRUM_BASE_URL}/course/view.php?id=${encodeURIComponent(courseId)}`;
        const ctrl2 = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tid2 = ctrl2 ? setTimeout(() => ctrl2.abort(), 4000) : null;
        let res;
        try {
          res = await fetch(courseViewUrl, { credentials: "include", signal: ctrl2?.signal });
        } finally {
          if (tid2) clearTimeout(tid2);
        }
        if (res && res.ok) {
          const html = await res.text();
          const items = parseCourseViewSubmissions(html, courseCode, courseName, studentOcc);
          items.forEach((item) => {
            const key = getActivityKey(item);
            if (deadlinesMap.has(key)) {
              const existing = deadlinesMap.get(key);
              if (!existing.dueTimestamp && item.dueTimestamp) {
                existing.dueTimestamp = item.dueTimestamp;
                existing.dueDate = item.dueDate;
                existing.formattedTime = item.formattedTime;
              }
              if (item.isSubmittedOnSpectrum) {
                existing.isSubmittedOnSpectrum = true;
                existing.isCompleted = true;
                existing.submissionStatus = "Submitted";
              }
            } else {
              deadlinesMap.set(key, item);
            }
          });
        }
      } catch (err) {
        console.warn(`[Spectra] Error checking course view submissions for ${courseCode}:`, err);
      }
    });

    await Promise.allSettled(coursePromises);
  }

  // -------------------------------------------------------------
  // 3. Finalize Urgency, Local Completion, and Sort
  // -------------------------------------------------------------
  const allDeadlines = Array.from(deadlinesMap.values()).map((item) => {
    const isCompleted = item.isSubmittedOnSpectrum || completedSet.has(String(item.id)) || completedSet.has(String(item.cmid));
    const urgency = item.dueTimestamp ? calculateUrgency(item.dueTimestamp) : "upcoming";
    return {
      ...item,
      isCompleted,
      urgency
    };
  });

  // Sort: Incomplete first, then by earliest due date. Items with no due date go to the bottom of incomplete.
  allDeadlines.sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    if (a.dueTimestamp && b.dueTimestamp) return a.dueTimestamp - b.dueTimestamp;
    if (a.dueTimestamp && !b.dueTimestamp) return -1;
    if (!a.dueTimestamp && b.dueTimestamp) return 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  return allDeadlines;
}
