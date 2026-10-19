/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Calendar & Deadline Pipeline
 * Directly binds to SPeCTRUM's native AJAX calendar service with verified sesskey & session error boundaries
 */

import {
  cleanMoodleTitle,
  extractCourseCode,
  calculateUrgency,
  parseCalendarEvents
} from "./parser.js";
import { InvalidSessionError, getSessionContext } from "./moodleApi.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Fetch live submission deadlines directly from Moodle's native AJAX calendar service
 * Endpoint: POST /lib/ajax/service.php?sesskey=...&info=core_calendar_get_action_events_by_timesort
 */
export async function fetchLiveDeadlines(sesskey) {
  if (!sesskey) {
    const ctx = await getSessionContext();
    sesskey = ctx.sesskey;
  }

  const timesortfrom = Math.floor(Date.now() / 1000) - 86400; // 24h past to catch impending / overdue items
  const ajaxEndpoint = `${SPECTRUM_BASE_URL}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_calendar_get_action_events_by_timesort`;

  const payload = [
    {
      index: 0,
      methodname: "core_calendar_get_action_events_by_timesort",
      args: {
        limitnum: 30,
        timesortfrom: timesortfrom
      }
    }
  ];

  let eventsData = null;

  try {
    const res = await fetch(ajaxEndpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 401 || res.status === 403) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ sessionStatus: "expired" });
      }
      throw new InvalidSessionError("SPeCTRUM calendar API returned HTTP " + res.status);
    }

    if (res.ok) {
      const data = await res.json();

      // Check for Moodle error exception
      if (Array.isArray(data) && data[0]) {
        if (data[0].error === true) {
          const exception = data[0].exception || "";
          if (exception === "servicerequireslogin" || data[0].message?.toLowerCase().includes("login")) {
            if (typeof chrome !== "undefined" && chrome.storage?.local) {
              await chrome.storage.local.set({ sessionStatus: "expired" });
            }
            throw new InvalidSessionError("SPeCTRUM requires active login. Please update your MoodleSession cookie.");
          }
          throw new Error(data[0].message || "Moodle calendar API error");
        }

        if (data[0].data?.events) {
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

  // Retrieve locally marked completed IDs
  let completedSet = new Set();
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["completed_assignment_ids"]);
      completedSet = new Set(stored.completed_assignment_ids || []);
    } catch (e) {}
  }

  // If eventsData was obtained from Moodle AJAX
  if (Array.isArray(eventsData)) {
    return eventsData.map((evt) => {
      const timestamp = (evt.timesort || evt.timestart) * 1000;
      const courseCode = extractCourseCode(evt.course?.shortname || evt.course?.fullname || "");
      const eventUrl = evt.action?.url || evt.url || `${SPECTRUM_BASE_URL}/mod/${evt.modulename || "assign"}/view.php?id=${evt.instance || evt.id}`;
      const eventId = String(evt.id);
      // SPeCTRUM Moodle marks actionable: false when the student has already submitted
      const isSubmittedOnSpectrum = evt.action ? !evt.action.actionable : false;

      return {
        id: eventId,
        title: cleanMoodleTitle(evt.name),
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
        weight: ""
      };
    });
  }

  // Fallback: live HTML scrape of /calendar/view.php?view=upcoming
  try {
    const htmlRes = await fetch(`${SPECTRUM_BASE_URL}/calendar/view.php?view=upcoming`, {
      method: "GET",
      credentials: "include"
    });

    if (htmlRes.redirected && (htmlRes.url.includes("login") || htmlRes.url.includes("microsoftonline"))) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ sessionStatus: "expired" });
      }
      throw new InvalidSessionError("Redirected to login portal.");
    }

    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const rawEvents = parseCalendarEvents(html);
      return rawEvents.map((evt) => ({
        ...evt,
        isCompleted: completedSet.has(evt.id)
      }));
    }
  } catch (htmlErr) {
    if (htmlErr instanceof InvalidSessionError || htmlErr.name === "INVALID_SESSION") throw htmlErr;
  }

  return [];
}
