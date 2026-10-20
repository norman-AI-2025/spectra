/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Resilient DOM and RegEx parsing routines for SPeCTRUM markup
 */

// Helper to extract course code like WIX2002, WIA1001, KIE2004, GIG1004, etc.
export function extractCourseCode(text) {
  if (!text) return "UM";
  const match = text.match(/\b([A-Z]{3,4}\s*\d{4}[A-Z]?)\b/i);
  if (match) {
    return match[1].replace(/\s+/g, "").toUpperCase();
  }
  // Fallback: search for acronyms or first two words
  const clean = text.trim();
  const words = clean.split(/\s+/);
  if (words.length > 0 && words[0].length >= 4 && words[0].length <= 8) {
    return words[0].toUpperCase();
  }
  return "UM";
}

// Clean Moodle instance names (Moodle appends " File", " Assignment", etc. to screen readers)
export function cleanMoodleTitle(raw) {
  if (!raw) return "";
  return raw
    .replace(/\s+(File|Assignment|URL|Folder|Quiz|Forum|Page|Book)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Determine urgency level based on due date timestamp
 * - Urgent: < 24 hours
 * - This Week: < 7 days
 * - Upcoming: >= 7 days
 */
export function calculateUrgency(timestamp) {
  const now = Date.now();
  const diffHours = (timestamp - now) / (1000 * 60 * 60);

  if (diffHours <= 24 && diffHours > -48) {
    return "urgent";
  } else if (diffHours <= 168 && diffHours > 24) {
    return "this_week";
  } else {
    return "upcoming";
  }
}

/**
 * Format relative remaining time (e.g. "5h 12m left" or "2d left")
 */
export function formatTimeRemaining(timestamp) {
  if (!timestamp || isNaN(timestamp)) {
    return "View Dropbox";
  }
  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) {
    const overdueHrs = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
    if (overdueHrs === 0) return "Due just now";
    if (overdueHrs < 24) return `${overdueHrs}h overdue`;
    const overdueDays = Math.floor(overdueHrs / 24);
    return `${overdueDays}d overdue`;
  }

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours < 24) {
    return `${hours}h ${minutes}m left`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days < 7) {
    return remainingHours > 0 ? `${days}d ${remainingHours}h left` : `${days}d left`;
  }
  return `${days} days left`;
}

/**
 * Parses calendar deadlines from SPeCTRUM HTML or JSON
 * Can accept raw HTML string from /calendar/view.php?view=upcoming
 * or parsed JSON from core_calendar_get_action_events_by_timesort
 */
export function parseCalendarEvents(sourceData) {
  if (!sourceData) return [];

  // Case 1: Moodle AJAX JSON response
  if (typeof sourceData === "object" && sourceData.events) {
    return sourceData.events.map((evt) => {
      const timestamp = (evt.timesort || evt.timestart) * 1000;
      const courseCode = extractCourseCode(evt.course?.shortname || evt.course?.fullname || "");
      const eventUrl = evt.action?.url || (evt.url ? evt.url : `https://spectrum.um.edu.my/mod/${evt.modulename || "assign"}/view.php?id=${evt.instance || evt.id}`);

      return {
        id: String(evt.id),
        title: cleanMoodleTitle(evt.name),
        courseCode,
        courseName: evt.course?.fullname || courseCode,
        dueDate: new Date(timestamp).toISOString(),
        dueTimestamp: timestamp,
        formattedTime: evt.formattedtime || new Date(timestamp).toLocaleString("en-MY", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        url: eventUrl,
        type: evt.modulename || "assign",
        urgency: calculateUrgency(timestamp),
        isCompleted: false
      };
    });
  }

  // Case 2: Raw HTML string parsing
  if (typeof sourceData === "string") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(sourceData, "text/html");
    const events = [];

    // Query calendar event containers
    const eventCards = doc.querySelectorAll(".event, .calendar-event, [data-event-title], .card.event");

    eventCards.forEach((card, idx) => {
      try {
        const titleEl = card.querySelector("[data-event-title], .name, .card-title, h3, h4, a[href*='mod/']");
        const title = cleanMoodleTitle(titleEl ? titleEl.textContent : `Assignment ${idx + 1}`);

        // Link
        const linkEl = card.querySelector("a[href*='mod/assign'], a[href*='mod/quiz'], a[href*='mod/'], a.card-link");
        let url = linkEl ? linkEl.getAttribute("href") : "https://spectrum.um.edu.my/calendar/view.php";
        if (url && !url.startsWith("http")) {
          url = "https://spectrum.um.edu.my/" + url.replace(/^\//, "");
        }

        // Course information
        const courseEl = card.querySelector(".course, a[href*='course/view.php'], .card-footer, .text-muted");
        const courseText = courseEl ? courseEl.textContent : "";
        const courseCode = extractCourseCode(courseText || title);

        // Date extraction
        const dateEl = card.querySelector(".date, [data-region='event-date'], .col-11, .time");
        const dateStr = dateEl ? dateEl.textContent.trim() : "";

        // Rough date approximation from string or default to +2 days if unparseable
        let timestamp = Date.now() + 2 * 86400 * 1000;
        if (dateStr) {
          const parsedTimestamp = parseMoodleDateString(dateStr);
          if (parsedTimestamp) timestamp = parsedTimestamp;
        }

        // ID extraction
        const eventId = card.getAttribute("data-event-id") || `parsed_event_${idx}_${Date.now()}`;

        events.push({
          id: eventId,
          title,
          courseCode,
          courseName: courseText ? courseText.trim() : courseCode,
          dueDate: new Date(timestamp).toISOString(),
          dueTimestamp: timestamp,
          formattedTime: dateStr || new Date(timestamp).toLocaleString("en-MY", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
          url,
          type: url.includes("mod/quiz") ? "quiz" : "assign",
          urgency: calculateUrgency(timestamp),
          isCompleted: false
        });
      } catch (err) {
        console.warn("Failed parsing individual event card:", err);
      }
    });

    return events;
  }

  return [];
}

/**
 * Resilient parser for Moodle date strings such as:
 * "Monday, 20 October, 11:59 PM"
 * "Today, 11:59 PM"
 * "Tomorrow, 5:00 PM"
 * "20 Oct 2026, 23:59"
 */
export function parseMoodleDateString(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const raw = String(dateStr).replace(/\u00a0/g, " ").trim();
  const lower = raw.toLowerCase();

  // If text indicates no due date
  if (lower.includes("no due date") || lower.includes("tiada tarikh akhir") || raw === "-") {
    return null;
  }

  // Extract time if present
  let hours = 23;
  let minutes = 59;
  const timeMatch = raw.match(/(\d{1,2})[:.](\d{2})(?:\s*([ap]m))?/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    hours = h;
    minutes = m;
  }

  // Check for "today" / "hari ini"
  if (lower.includes("today") || lower.includes("hari ini")) {
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }

  // Check for "tomorrow" / "esok"
  if (lower.includes("tomorrow") || lower.includes("esok")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }

  // Normalize Malay day names and month names
  let cleaned = raw
    .replace(/\b(isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b/gi, "")
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/gi, "")
    .replace(/\bjan(?:uari)?\b/gi, "Jan")
    .replace(/\bfeb(?:ruari)?\b/gi, "Feb")
    .replace(/\bmac\b/gi, "Mar")
    .replace(/\bapr(?:il)?\b/gi, "Apr")
    .replace(/\bmei\b/gi, "May")
    .replace(/\bjun\b/gi, "Jun")
    .replace(/\bjul(?:ai)?\b/gi, "Jul")
    .replace(/\bogo(?:s)?\b/gi, "Aug")
    .replace(/\bsep(?:tember)?\b/gi, "Sep")
    .replace(/\bokt(?:ober)?\b/gi, "Oct")
    .replace(/\bnov(?:ember)?\b/gi, "Nov")
    .replace(/\bdis(?:ember)?\b/gi, "Dec")
    .replace(/[,\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 1. Try DD/MM/YYYY or DD.MM.YYYY or DD-MM-YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})[\.\/\-](\d{1,2})(?:[\.\/\-](\d{2,4}))?/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10) - 1;
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day, hours, minutes, 0, 0);
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // 2. Try DD Month YYYY (e.g. "25 Oct 2024" or "25 October 2024")
  const monthNames = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const wordMatch = cleaned.match(/(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{2,4}))?/);
  if (wordMatch) {
    const day = parseInt(wordMatch[1], 10);
    const monStr = wordMatch[2].slice(0, 3).toLowerCase();
    if (monthNames[monStr] !== undefined) {
      let year = wordMatch[3] ? parseInt(wordMatch[3], 10) : now.getFullYear();
      if (year < 100) year += 2000;
      const d = new Date(year, monthNames[monStr], day, hours, minutes, 0, 0);
      if (!isNaN(d.getTime())) return d.getTime();
    }
  }

  // 3. Fallback to standard Date parse
  const cleanStr = raw.replace(/^[A-Za-z]+,\s*/, "");
  const directDate = new Date(cleanStr);
  if (!isNaN(directDate.getTime())) {
    if (directDate.getFullYear() < 2000) {
      directDate.setFullYear(now.getFullYear());
    }
    return directDate.getTime();
  }

  return null;
}

/**
 * Parses SPeCTRUM /mod/assign/index.php?id={courseId}
 * Extracts all assignment submission dropboxes and filters by student occurrence.
 */
export function parseCourseAssignmentsIndex(html, courseCode = "", courseName = "", studentOccurrence = "") {
  if (!html) return [];
  const assignments = [];

  // 1. DOMParser Method (Browser / Extensions)
  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const rows = doc.querySelectorAll("table.generaltable tr, table.mod_index tr");
      rows.forEach((tr, idx) => {
        const linkEl = tr.querySelector("a[href*='mod/assign/view.php']");
        if (!linkEl) return;

        const cells = tr.querySelectorAll("td");
        if (cells.length < 2) return;

        const rawUrl = linkEl.getAttribute("href") || "";
        const url = rawUrl.startsWith("http") ? rawUrl : `https://spectrum.um.edu.my/${rawUrl.replace(/^\//, "")}`;
        const idMatch = url.match(/id=(\d+)/);
        const cmid = idMatch ? idMatch[1] : `assign_${idx}`;

        const rawTitle = linkEl.textContent.trim();
        const title = cleanMoodleTitle(rawTitle);

        // Filter by occurrence: if student specified an occurrence, title must match or be universal
        const matchesOcc = isRespectiveOccurrence("", studentOccurrence, title);
        if (!matchesOcc) return;

        // Find due date cell and submission status cell
        let dueDateText = "";
        let submissionStatusText = "";

        cells.forEach((td) => {
          if (td.contains(linkEl)) return; // Name cell
          const text = td.textContent.trim();
          if (/\b(?:submitted|grading|graded|submission|dihantar|tiada|hantar|penghantaran)\b/i.test(text)) {
            submissionStatusText = text;
          } else if (!dueDateText && (/\d{1,2}[:.]\d{2}/.test(text) || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|okt|mac|mei|ogo|dis)\b/i.test(text) || /\d{1,2}[\/\.\-]\d{1,2}/.test(text))) {
            dueDateText = text;
          } else if (!submissionStatusText && text && !/^(?:week|minggu|topic|topik)\s*\d*$/i.test(text) && !/^\d+$/.test(text)) {
            submissionStatusText = text;
          }
        });

        const dueTimestamp = dueDateText ? parseMoodleDateString(dueDateText) : null;
        const isSubmitted = /submitted|graded|selesai|dihantar/i.test(submissionStatusText) && !/no submission|not submitted|belum/i.test(submissionStatusText);

        assignments.push({
          id: cmid,
          cmid,
          title,
          courseCode: courseCode || "Course",
          courseName: courseName || courseCode,
          dueDate: dueTimestamp ? new Date(dueTimestamp).toISOString() : "",
          dueTimestamp,
          formattedTime: dueDateText || (dueTimestamp ? new Date(dueTimestamp).toLocaleString("en-MY", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "No due date"),
          url,
          type: "assign",
          submissionStatus: submissionStatusText || (isSubmitted ? "Submitted" : "No submission"),
          isSubmittedOnSpectrum: isSubmitted,
          isCompleted: isSubmitted,
          urgency: dueTimestamp ? calculateUrgency(dueTimestamp) : "upcoming",
          matchesOccurrence: true
        });
      });

      if (assignments.length > 0) return assignments;
    } catch (e) {
      console.warn("[Spectra Parser] DOM parseCourseAssignmentsIndex error:", e);
    }
  }

  // 2. Regex Method Fallback (Node / Serverless / JSC)
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let idx = 0;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const linkMatch = rowHtml.match(/<a[^>]+href=["']([^"']*mod\/assign\/view\.php\?id=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1];
    const cmid = linkMatch[2];
    const rawTitle = linkMatch[3].replace(/<[^>]+>/g, "").trim();
    const title = cleanMoodleTitle(rawTitle);

    const matchesOcc = isRespectiveOccurrence("", studentOccurrence, title);
    if (!matchesOcc) continue;

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellM;
    while ((cellM = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellM[1].replace(/<[^>]+>/g, "").trim());
    }

    let dueDateText = "";
    let submissionStatusText = "";
    for (const c of cells) {
      if (c.includes(rawTitle)) continue;
      if (/\b(?:submitted|grading|graded|submission|dihantar|tiada|hantar|penghantaran)\b/i.test(c)) {
        submissionStatusText = c;
      } else if (!dueDateText && (/\d{1,2}[:.]\d{2}/.test(c) || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|okt|mac|mei|ogo|dis)\b/i.test(c) || /\d{1,2}[\/\.\-]\d{1,2}/.test(c))) {
        dueDateText = c;
      } else if (!submissionStatusText && c && !/^(?:week|minggu|topic|topik)\s*\d*$/i.test(c) && !/^\d+$/.test(c)) {
        submissionStatusText = c;
      }
    }

    const dueTimestamp = dueDateText ? parseMoodleDateString(dueDateText) : null;
    const isSubmitted = /submitted|graded|selesai|dihantar/i.test(submissionStatusText) && !/no submission|not submitted|belum/i.test(submissionStatusText);
    const url = rawUrl.startsWith("http") ? rawUrl : `https://spectrum.um.edu.my/${rawUrl.replace(/^\//, "")}`;

    assignments.push({
      id: cmid,
      cmid,
      title,
      courseCode: courseCode || "Course",
      courseName: courseName || courseCode,
      dueDate: dueTimestamp ? new Date(dueTimestamp).toISOString() : "",
      dueTimestamp,
      formattedTime: dueDateText || (dueTimestamp ? new Date(dueTimestamp).toLocaleString("en-MY", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "No due date"),
      url,
      type: "assign",
      submissionStatus: submissionStatusText || (isSubmitted ? "Submitted" : "No submission"),
      isSubmittedOnSpectrum: isSubmitted,
      isCompleted: isSubmitted,
      urgency: dueTimestamp ? calculateUrgency(dueTimestamp) : "upcoming",
      matchesOccurrence: true
    });
  }

  return assignments;
}

/**
 * Scrapes /course/view.php?id={courseId} from top to bottom
 * Discovers all submission activities (assignments, quizzes, workshops, turnitin)
 * across every section and filters by student occurrence.
 */
export function parseCourseViewSubmissions(html, courseCode = "", courseName = "", studentOccurrence = "") {
  if (!html) return [];
  const submissions = [];
  const seenIds = new Set();

  // 1. DOMParser Method
  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const activityLinks = doc.querySelectorAll(
        "a[href*='mod/assign/view.php'], a[href*='mod/quiz/view.php'], a[href*='mod/workshop/view.php'], a[href*='mod/turnitintooltwo/view.php']"
      );

      activityLinks.forEach((linkEl, idx) => {
        const rawUrl = linkEl.getAttribute("href") || "";
        const idMatch = rawUrl.match(/id=(\d+)/);
        if (!idMatch) return;
        const cmid = idMatch[1];
        if (seenIds.has(cmid)) return;
        seenIds.add(cmid);

        const url = rawUrl.startsWith("http") ? rawUrl : `https://spectrum.um.edu.my/${rawUrl.replace(/^\//, "")}`;
        const rawTitle = linkEl.querySelector(".instancename") ? linkEl.querySelector(".instancename").textContent : linkEl.textContent;
        const title = cleanMoodleTitle(rawTitle);

        // Strict occurrence filter
        const matchesOcc = isRespectiveOccurrence("", studentOccurrence, title);
        if (!matchesOcc) return;

        // Find parent container to inspect due dates and completion tags
        const parentAct = linkEl.closest("li.activity, .activityinstance, .activity-item, div.activity");
        let dueDateText = "";
        let isSubmitted = false;

        if (parentAct) {
          const actText = parentAct.textContent;

          // Due date patterns
          const dueM = actText.match(/(?:due|closes|tarikh akhir|tutup)[\s:]+([^\n\r<]+)/i);
          if (dueM) {
            dueDateText = dueM[1].trim();
          }

          // Submission / completion indicator
          if (/submitted|dihantar|done|selesai/i.test(actText) && !/not submitted|belum/i.test(actText)) {
            isSubmitted = true;
          }
        }

        const dueTimestamp = dueDateText ? parseMoodleDateString(dueDateText) : null;
        let type = "assign";
        if (url.includes("mod/quiz")) type = "quiz";
        else if (url.includes("mod/workshop")) type = "workshop";
        else if (url.includes("turnitintooltwo")) type = "turnitin";

        submissions.push({
          id: cmid,
          cmid,
          title,
          courseCode: courseCode || "Course",
          courseName: courseName || courseCode,
          dueDate: dueTimestamp ? new Date(dueTimestamp).toISOString() : "",
          dueTimestamp,
          formattedTime: dueDateText || (dueTimestamp ? new Date(dueTimestamp).toLocaleString("en-MY", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "View Dropbox"),
          url,
          type,
          submissionStatus: isSubmitted ? "Submitted" : "No submission",
          isSubmittedOnSpectrum: isSubmitted,
          isCompleted: isSubmitted,
          urgency: dueTimestamp ? calculateUrgency(dueTimestamp) : "upcoming",
          matchesOccurrence: true
        });
      });

      if (submissions.length > 0) return submissions;
    } catch (e) {
      console.warn("[Spectra Parser] DOM parseCourseViewSubmissions error:", e);
    }
  }

  // 2. Regex Method Fallback
  const linkRegex = /<a[^>]+href=["']([^"']*mod\/(?:assign|quiz|workshop|turnitintooltwo)\/view\.php\?id=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const cmid = match[2];
    if (seenIds.has(cmid)) continue;
    seenIds.add(cmid);

    const rawTitle = match[3].replace(/<[^>]+>/g, "").trim();
    const title = cleanMoodleTitle(rawTitle);

    const matchesOcc = isRespectiveOccurrence("", studentOccurrence, title);
    if (!matchesOcc) continue;

    const url = rawUrl.startsWith("http") ? rawUrl : `https://spectrum.um.edu.my/${rawUrl.replace(/^\//, "")}`;

    let type = "assign";
    if (url.includes("mod/quiz")) type = "quiz";
    else if (url.includes("mod/workshop")) type = "workshop";
    else if (url.includes("turnitintooltwo")) type = "turnitin";

    // Extract nearby text snippet to capture due date and submission status
    const contextSnippet = html.slice(match.index, match.index + 1200);
    const dueM = contextSnippet.match(/(?:due|closes|tarikh akhir|tutup)[\s:]+([^\n\r<]+)/i);
    let dueDateText = "";
    if (dueM) {
      dueDateText = dueM[1].trim();
    }
    const isSubmitted = /submitted|dihantar|done|selesai/i.test(contextSnippet) && !/not submitted|belum|to do/i.test(contextSnippet);
    const dueTimestamp = dueDateText ? parseMoodleDateString(dueDateText) : null;

    submissions.push({
      id: cmid,
      cmid,
      title,
      courseCode: courseCode || "Course",
      courseName: courseName || courseCode,
      dueDate: dueTimestamp ? new Date(dueTimestamp).toISOString() : "",
      dueTimestamp,
      formattedTime: dueDateText || (dueTimestamp ? new Date(dueTimestamp).toLocaleString("en-MY", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "View Dropbox"),
      url,
      type,
      submissionStatus: isSubmitted ? "Submitted" : (dueDateText ? "No submission" : "View on SPeCTRUM"),
      isSubmittedOnSpectrum: isSubmitted,
      isCompleted: isSubmitted,
      urgency: dueTimestamp ? calculateUrgency(dueTimestamp) : "upcoming",
      matchesOccurrence: true
    });
  }

  return submissions;
}

/**
 * Categorize a course module item into Slides, Tutorials, or Labs
 */
export function categorizeModuleItem(title, url = "", rawExt = "") {
  const combined = `${title} ${url} ${rawExt}`.toLowerCase();

  // Labs & Practicals
  if (
    combined.includes("lab") ||
    combined.includes("practical") ||
    combined.includes("source") ||
    combined.includes("code") ||
    combined.includes(".zip") ||
    combined.includes(".py") ||
    combined.includes(".java") ||
    combined.includes(".ipynb") ||
    combined.includes(".cpp") ||
    combined.includes(".c") ||
    combined.includes(".sql") ||
    combined.includes(".csv") ||
    combined.includes("dataset")
  ) {
    return "labs";
  }

  // Tutorials & Problem Sets
  if (
    combined.includes("tutorial") ||
    combined.includes("tut") ||
    combined.includes("worksheet") ||
    combined.includes("question") ||
    combined.includes("exercise") ||
    combined.includes("problem") ||
    combined.includes(".docx")
  ) {
    return "tutorials";
  }

  // Lecture Slides & Notes (Default fallback for slides / resources)
  return "slides";
}

/**
 * Detect file extension from URL, title, or Moodle activity icon
 */
export function detectFileExtension(title, url, iconSrc = "") {
  const match = (title + " " + url).match(/\.([a-zA-Z0-9]{2,5})(?:\?|$|\s)/);
  if (match) {
    return match[1].toLowerCase();
  }
  if (iconSrc.includes("pdf")) return "pdf";
  if (iconSrc.includes("powerpoint") || iconSrc.includes("ppt")) return "pptx";
  if (iconSrc.includes("word") || iconSrc.includes("document")) return "docx";
  if (iconSrc.includes("archive") || iconSrc.includes("zip")) return "zip";
  if (url.includes("mod/resource")) return "pdf";
  return "pdf";
}

/**
 * Parses course page HTML (/course/view.php?id=...)
 * Returns categorized items organized by week/section
 */
export function parseCoursePage(html, requestedWeek = null) {
  if (!html) return {};

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const weeksMap = {};

  // Sections in Moodle are typically li.section, div.section, or #section-N
  const sections = doc.querySelectorAll("li.section, div.section, .course-content ul.topics > li, ul.weeks > li");

  sections.forEach((section, idx) => {
    // Determine week index
    let weekNum = idx + 1;
    const secId = section.getAttribute("id") || "";
    const idMatch = secId.match(/section-(\d+)/);
    if (idMatch && parseInt(idMatch[1], 10) > 0) {
      weekNum = parseInt(idMatch[1], 10);
    }

    const headingEl = section.querySelector(".sectionname, .section-title, h3");
    const headingText = headingEl ? headingEl.textContent.trim() : `Week ${weekNum}`;

    // Check if heading has "Week X"
    const weekMatch = headingText.match(/(?:Week|Minggu)\s*(\d+)/i);
    if (weekMatch) {
      weekNum = parseInt(weekMatch[1], 10);
    }

    if (!weeksMap[weekNum]) {
      weeksMap[weekNum] = {
        week: weekNum,
        title: headingText,
        slides: [],
        tutorials: [],
        labs: []
      };
    }

    // Parse activities inside this section
    const activities = section.querySelectorAll("li.activity, .activityinstance");
    activities.forEach((act) => {
      const linkEl = act.querySelector("a[href*='mod/resource'], a[href*='mod/folder'], a[href*='mod/url'], a[href*='pluginfile.php']");
      if (!linkEl) return;

      const rawUrl = linkEl.getAttribute("href");
      let url = rawUrl;
      if (url && !url.startsWith("http")) {
        url = "https://spectrum.um.edu.my/" + url.replace(/^\//, "");
      }

      const iconEl = act.querySelector("img.activityicon, .icon");
      const iconSrc = iconEl ? (iconEl.getAttribute("src") || "") : "";

      const rawTitle = linkEl.querySelector(".instancename") ? linkEl.querySelector(".instancename").textContent : linkEl.textContent;
      const title = cleanMoodleTitle(rawTitle);
      const ext = detectFileExtension(title, url, iconSrc);
      const category = categorizeModuleItem(title, url, ext);

      // Ensure title has extension for clear download naming
      let cleanFilename = title;
      if (!cleanFilename.toLowerCase().endsWith("." + ext)) {
        cleanFilename += `.${ext}`;
      }

      weeksMap[weekNum][category].push({
        id: act.getAttribute("id") || `item_${Math.random().toString(36).substring(2, 9)}`,
        name: cleanFilename,
        ext,
        url,
        category,
        size: "SPeCTRUM File"
      });
    });
  });

  return weeksMap;
}

/**
 * Parses user's enrolled courses from /my/ (dashboard)
 */
export function parseEnrolledCourses(html) {
  if (!html) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const courses = [];
  const seenIds = new Set();

  const links = doc.querySelectorAll("a[href*='course/view.php?id=']");
  links.forEach((a) => {
    const href = a.getAttribute("href");
    const idMatch = href.match(/id=(\d+)/);
    if (!idMatch) return;
    const courseId = idMatch[1];
    if (seenIds.has(courseId) || courseId === "1") return; // id=1 is site home
    seenIds.add(courseId);

    const fullText = a.textContent.trim();
    if (!fullText || fullText.length < 3) return;

    const courseCode = extractCourseCode(fullText);
    courses.push({
      id: courseId,
      code: courseCode,
      name: fullText.replace(courseCode, "").replace(/^[\s\-:]+/, "").trim() || fullText,
      shortname: courseCode,
      url: href.startsWith("http") ? href : `https://spectrum.um.edu.my/course/view.php?id=${courseId}`
    });
  });

  return courses;
}

/**
 * Parses forum discussions from /mod/forum/view.php?id=...
 */
export function parseForumDiscussions(html, courseCode = "UM") {
  if (!html) return [];
  const discussions = [];

  // Method 1: DOMParser (when available in window / browser context)
  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const rows = doc.querySelectorAll("tr.discussion, .discussion-list .discussion, tr[data-discussionid]");
      rows.forEach((row, idx) => {
        try {
          const topicEl = row.querySelector(".topic a, a[href*='discuss.php?d=']");
          if (!topicEl) return;

          const subject = topicEl.textContent.trim();
          let url = topicEl.getAttribute("href");
          if (url && !url.startsWith("http")) {
            url = "https://spectrum.um.edu.my/" + url.replace(/^\//, "");
          }

          const idMatch = url.match(/d=(\d+)/);
          const discussionId = idMatch ? idMatch[1] : `disc_${idx}_${Date.now()}`;

          const authorEl = row.querySelector(".author, td.author, .author-name, .media-body h5");
          const author = authorEl ? authorEl.textContent.trim() : "Course Instructor";

          const dateEl = row.querySelector(".lastpost, td.lastpost, time, .text-muted time");
          const dateText = dateEl ? dateEl.textContent.trim() : "Recent";

          discussions.push({
            id: discussionId,
            courseCode,
            subject,
            author,
            date: dateText,
            url,
            timestamp: Date.now()
          });
        } catch (err) {
          console.warn("Failed parsing forum discussion row:", err);
        }
      });

      if (discussions.length > 0) return discussions;
    } catch (domErr) {
      console.warn("DOMParser error in parseForumDiscussions, falling back to regex:", domErr);
    }
  }

  // Method 2: Regex Parser (for Service Worker context where DOMParser is undefined)
  const seenDiscIds = new Set();
  const topicRegex = /<a[^>]*href="([^"]*discuss\.php\?d=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = topicRegex.exec(html)) !== null) {
    let url = match[1];
    const discussionId = match[2];
    let rawSubject = match[3].replace(/<[^>]+>/g, "").trim();

    if (!rawSubject || seenDiscIds.has(discussionId)) continue;
    seenDiscIds.add(discussionId);

    if (!url.startsWith("http")) {
      url = "https://spectrum.um.edu.my/" + url.replace(/^\//, "");
    }

    discussions.push({
      id: discussionId,
      courseCode,
      subject: rawSubject,
      author: "Course Instructor",
      date: "Recent",
      url,
      timestamp: Date.now()
    });
  }

  return discussions;
}

/**
 * Calculates current academic week (Week 1 through Week 14)
 * UM typically operates on a 14-week semester system:
 * - Weeks 1 to 7: Lectures
 * - Mid-Semester Break: 1 week
 * - Weeks 8 to 14: Lectures
 * - Revision Week: 1 week
 * - Final Exams: 2-3 weeks
 */
export function calculateAcademicWeek(semesterStartDateStr = null) {
  const now = new Date();
  let start = semesterStartDateStr ? new Date(semesterStartDateStr) : null;

  // Fallback: estimate semester start (Semester 1 around Oct 1, Semester 2 around March 1)
  if (!start || isNaN(start.getTime())) {
    const curYear = now.getFullYear();
    const curMonth = now.getMonth(); // 0-indexed (9 = Oct)
    if (curMonth >= 8 || curMonth <= 1) {
      // Semester 1 (roughly Oct 1st)
      const yr = curMonth <= 1 ? curYear - 1 : curYear;
      start = new Date(yr, 9, 6); // First Monday of October
    } else {
      // Semester 2 (roughly March 1st)
      start = new Date(curYear, 2, 2); // Early March
    }
  }

  const diffDays = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return { week: 1, isBreak: false, label: "Orientation / Pre-Semester" };
  }

  const weekNumber = Math.floor(diffDays / 7) + 1;

  if (weekNumber <= 7) {
    return { week: weekNumber, isBreak: false, label: `Week ${weekNumber}` };
  } else if (weekNumber === 8) {
    return { week: 7, isBreak: true, label: "Mid-Semester Break" };
  } else if (weekNumber <= 15) {
    const adjWeek = weekNumber - 1; // offset for 1-week mid-sem break
    return { week: Math.min(adjWeek, 14), isBreak: false, label: `Week ${Math.min(adjWeek, 14)}` };
  } else if (weekNumber === 16) {
    return { week: 14, isBreak: false, label: "Revision Week" };
  } else {
    return { week: 14, isBreak: false, label: "Final Examination Period" };
  }
}

/**
 * Matches a session's group/type string against a student's configured occurrence
 */
export function matchesOccurrence(sessionGroup, studentOccurrence, sessionDescription = "", activityName = "") {
  return isRespectiveOccurrence(sessionGroup, studentOccurrence, sessionDescription, activityName);
}

/**
 * Strict occurrence checker:
 * Ensures attendance is only filled/recorded for the student's respective occurrence.
 * - Universal groups ("All students", "Semua pelajar", empty) match everyone.
 * - If session or activityName specifies a group (e.g. "Occ 1", "Occ 2") or mentions it in description,
 *   student must have configured that exact occurrence.
 * - If student has NOT configured an occurrence, group-specific sessions will NOT match.
 */
export function isRespectiveOccurrence(sessionGroup, studentOccurrence, sessionDescription = "", activityName = "") {
  const group = (sessionGroup || "").trim().toLowerCase();
  const desc = (sessionDescription || "").trim().toLowerCase();
  const actName = (activityName || "").trim().toLowerCase();
  const occ = (studentOccurrence || "").trim().toLowerCase();

  // If student occurrence is 'all', matches everything
  if (occ === "all") {
    return true;
  }

  // 1. If activityName explicitly declares a specific occurrence (e.g. "Tutorial Attendance Occ 2", "Attendance - Group 1")
  const actHasOcc = actName && (/\bocc(?:urrence)?\s*\d+\b/i.test(actName) || /\bkumpulan\s*\d+\b/i.test(actName) || /\bgroup\s*\d+\b/i.test(actName));
  if (actHasOcc) {
    if (!occ) return false;
    const occM = occ.match(/\b(?:occ|occurrence|kumpulan|group)\s*#?\s*(\d+)\b/i) || occ.match(/\b\d+\b/);
    const actM = actName.match(/\b(?:occ|occurrence|kumpulan|group)\s*#?\s*(\d+)\b/i);
    const occNum = occM ? (occM[1] || occM[0]) : null;
    const actNum = actM ? actM[1] : null;
    if (occNum && actNum && parseInt(occNum, 10) !== parseInt(actNum, 10)) {
      // Activity specifically belongs to another occurrence!
      return false;
    }
  }

  // 2. Detect if group or description specifies a specific occurrence or group number
  const groupIsUniversal = !group || group.includes("all students") || group.includes("semua pelajar") || group === "all";
  const descHasOcc = desc && (/\bocc(?:urrence)?\s*\d+\b/i.test(desc) || /\bkumpulan\s*\d+\b/i.test(desc) || /\bgroup\s*\d+\b/i.test(desc));

  // Determine target text for occurrence extraction
  let targetText = "";
  if (!groupIsUniversal) {
    targetText = group;
  } else if (descHasOcc) {
    targetText = desc;
  } else if (actHasOcc) {
    targetText = actName;
  }

  // Universal session (no specific group or occurrence in group, description, or activity name)
  if (!targetText) {
    return true;
  }

  // Session is group-specific, but student has not configured an occurrence
  if (!occ) {
    return false;
  }

  // Extract occurrence number specifically associated with occ/kumpulan/group keywords if present
  const occNumberMatch = targetText.match(/\b(?:occ|occurrence|kumpulan|group)\s*#?\s*(\d+)\b/i);
  let textNum = null;
  if (occNumberMatch) {
    textNum = occNumberMatch[1];
  } else {
    // If targetText is purely a group name like "Group 1" or "1", fallback to first digits
    const m = targetText.match(/\b\d+\b/) || targetText.match(/\d+/);
    if (m) textNum = m[0];
  }

  const occDigits = occ.match(/\b(?:occ|occurrence|kumpulan|group)\s*#?\s*(\d+)\b/i) || occ.match(/\b\d+\b/) || occ.match(/\d+/);
  const studentNum = occDigits ? (occDigits[1] || occDigits[0]) : null;

  if (studentNum && textNum) {
    return parseInt(studentNum, 10) === parseInt(textNum, 10);
  }

  // If no numbers, require word boundary match
  const safeOcc = occ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${safeOcc}\\b`, "i");
  return regex.test(targetText);
}

/**
 * Parses SPeCTRUM /mod/attendance/index.php?id={courseId} or course view
 * Discovers ALL attendance instances in the course, from top to bottom of page.
 */
export function parseAttendanceIndex(html) {
  if (!html) return [];
  const links = [];
  const seenCmids = new Set();

  function addInstance(cmid, name, rawUrl) {
    if (!cmid || seenCmids.has(cmid)) return;
    seenCmids.add(cmid);
    const fullUrl = rawUrl.startsWith("http") ? rawUrl : `https://spectrum.um.edu.my/${rawUrl.replace(/^\//, "")}`;
    links.push({
      cmid: String(cmid),
      name: (name || "Attendance").trim().replace(/^(Activity|Aktiviti)\s+/i, ""),
      url: fullUrl
    });
  }

  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      // 1. Look for view.php links anywhere on the page
      const aEls = doc.querySelectorAll("a[href*='mod/attendance/view.php']");
      aEls.forEach((a) => {
        const href = a.getAttribute("href") || "";
        const idMatch = href.match(/id=(\d+)/);
        if (idMatch) {
          const text = a.textContent.trim() || a.getAttribute("title") || "Attendance";
          addInstance(idMatch[1], text, href);
        }
      });

      // 2. Look for modtype_attendance containers across all sections (top to bottom)
      const actContainers = doc.querySelectorAll(".modtype_attendance, li.activity.attendance, div.activityinstance");
      actContainers.forEach((el) => {
        const a = el.querySelector("a[href*='mod/attendance/']");
        if (a) {
          const href = a.getAttribute("href") || "";
          const idMatch = href.match(/id=(\d+)/);
          if (idMatch) {
            const text = a.textContent.trim() || el.querySelector(".instancename")?.textContent?.trim() || "Attendance";
            addInstance(idMatch[1], text, href);
          }
        }
      });

      if (links.length > 0) return links;
    } catch (e) {}
  }

  // Regex fallback
  const regex = /<a[^>]+href=["']([^"']*mod\/attendance\/view\.php\?id=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawUrl = match[1];
    const cmid = match[2];
    const name = match[3].replace(/<[^>]+>/g, "").trim() || "Attendance";
    addInstance(cmid, name, rawUrl);
  }

  return links;
}

/**
 * Parses all attendance tabs and group selectors from SPeCTRUM /mod/attendance/view.php
 * Extracts:
 * - View mode tabs (All [view=5], All Past [view=4], Months [view=3], Weeks [view=2], Days [view=1])
 * - Group/occurrence tabs and dropdown options (e.g. Occ 1, Occ 2, Group 1)
 */
export function parseAttendanceTabs(html, cmid, baseUrl = "https://spectrum.um.edu.my") {
  if (!html) return [];
  const tabs = [];
  const seenUrls = new Set();

  function addTab(label, rawUrl, isGroup = false) {
    if (!rawUrl) return;
    const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${baseUrl}/${rawUrl.replace(/^\//, "")}`;
    if (!seenUrls.has(fullUrl)) {
      seenUrls.add(fullUrl);
      tabs.push({
        label: (label || "").trim(),
        url: fullUrl,
        isGroup
      });
    }
  }

  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      // Tab navigation: nav-tabs, nav-pills, tabtree, attendance-tabs, ul.nav, etc.
      const tabLinks = doc.querySelectorAll(
        ".nav-tabs a, .nav-pills a, .tabtree a, .attendance-tabs a, ul.nav a, a[href*='mod/attendance/view.php']"
      );
      tabLinks.forEach((a) => {
        const href = a.getAttribute("href") || "";
        const label = a.textContent.trim();
        if (href && (href.includes("view=") || href.includes("group=") || href.includes("curdate="))) {
          addTab(label, href, href.includes("group="));
        }
      });

      // Group select dropdowns: <select name="group">
      const groupSelects = doc.querySelectorAll("select[name='group']");
      groupSelects.forEach((select) => {
        select.querySelectorAll("option").forEach((opt) => {
          const val = opt.getAttribute("value");
          const label = opt.textContent.trim();
          if (val && val !== "0" && cmid) {
            addTab(label, `/mod/attendance/view.php?id=${cmid}&group=${val}&view=5`, true);
          }
        });
      });

      if (tabs.length > 0) return tabs;
    } catch (e) {}
  }

  // Regex fallback
  const tabRegex = /<a[^>]+href=["']([^"']*mod\/attendance\/view\.php\?[^"']*(?:view=|group=)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = tabRegex.exec(html)) !== null) {
    const rawUrl = m[1];
    const label = m[2].replace(/<[^>]+>/g, "").trim();
    addTab(label, rawUrl, rawUrl.includes("group="));
  }

  const optRegex = /<option[^>]+value=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let optM;
  while ((optM = optRegex.exec(html)) !== null) {
    const val = optM[1];
    const label = optM[2].replace(/<[^>]+>/g, "").trim();
    if (val !== "0" && cmid) {
      addTab(label, `/mod/attendance/view.php?id=${cmid}&group=${val}&view=5`, true);
    }
  }

  return tabs;
}

/**
 * Extracts hour and minute (24-hour format) from time string
 * Supports "2:00PM", "14:00", "2PM", "02:00 PM - 04:00 PM", "8.30 AM", etc.
 */
export function extractStartTime(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).replace(/\u00a0/g, " ").trim();
  const m = str.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;

  if (ampm === "pm" && hour < 12) hour += 12;
  else if (ampm === "am" && hour === 12) hour = 0;

  return { hour, min };
}

/**
 * Normalizes and parses SPeCTRUM attendance date strings
 * Supports English and Bahasa Melayu dates, dates without year, Today / Hari ini, as well as DD/MM/YYYY, DD.MM.YYYY, and DD-MM-YYYY.
 */
export function parseAttendanceSessionDate(dateText, timeText = "", referenceDate = new Date()) {
  if (!dateText) return null;

  const ref = new Date(referenceDate || new Date());
  const currentYear = ref.getFullYear();

  let raw = String(dateText).replace(/\u00a0/g, " ").trim();
  const parsedTime = extractStartTime(timeText) || extractStartTime(raw);

  const lower = raw.toLowerCase();
  // Check for today / hari ini
  if (lower.includes("today") || lower.includes("hari ini")) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    if (parsedTime) {
      d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
    }
    return d.getTime();
  }

  // Check for yesterday / semalam
  if (lower.includes("yesterday") || lower.includes("semalam")) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
    if (parsedTime) {
      d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
    }
    return d.getTime();
  }

  let cleaned = raw
    // Strip day names (English & Malay)
    .replace(/\b(isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b/gi, "")
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/gi, "")
    // Normalize Malay months to English abbreviations
    .replace(/\bjan(?:uari)?\b/gi, "Jan")
    .replace(/\bfeb(?:ruari)?\b/gi, "Feb")
    .replace(/\bmac\b/gi, "Mar")
    .replace(/\bapr(?:il)?\b/gi, "Apr")
    .replace(/\bmei\b/gi, "May")
    .replace(/\bjun\b/gi, "Jun")
    .replace(/\bjul(?:ai)?\b/gi, "Jul")
    .replace(/\bogo(?:s)?\b/gi, "Aug")
    .replace(/\bsep(?:tember)?\b/gi, "Sep")
    .replace(/\bokt(?:ober)?\b/gi, "Oct")
    .replace(/\bnov(?:ember)?\b/gi, "Nov")
    .replace(/\bdis(?:ember)?\b/gi, "Dec")
    // Clean unwanted characters and symbols like commas, brackets, etc.
    .replace(/[,\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 1. Try DD/MM/YYYY or DD.MM.YYYY or DD-MM-YYYY or DD/MM/YY
  const slashMatch = cleaned.match(/^(\d{1,2})[\.\/\-](\d{1,2})(?:[\.\/\-](\d{2,4}))?/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10) - 1;
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : currentYear;
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (parsedTime) {
      d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
    }
    const parsedTs = d.getTime();
    if (!isNaN(parsedTs)) return parsedTs;
  }

  // 2. Try YYYY-MM-DD
  const isoMatch = cleaned.match(/^(\d{4})[\.\/\-](\d{1,2})[\.\/\-](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const d = new Date(year, month, day);
    if (parsedTime) {
      d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
    }
    const parsedTs = d.getTime();
    if (!isNaN(parsedTs)) return parsedTs;
  }

  // 3. Try DD Month (e.g. "20 Oct" or "20 Oct 2026")
  const monthNames = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const wordMatch = cleaned.match(/(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{2,4}))?/);
  if (wordMatch) {
    const day = parseInt(wordMatch[1], 10);
    const monStr = wordMatch[2].slice(0, 3).toLowerCase();
    if (monthNames[monStr] !== undefined) {
      let year = wordMatch[3] ? parseInt(wordMatch[3], 10) : currentYear;
      if (year < 100) year += 2000;
      const d = new Date(year, monthNames[monStr], day);
      if (parsedTime) {
        d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
      }
      const parsedTs = d.getTime();
      if (!isNaN(parsedTs)) return parsedTs;
    }
  }

  // 4. Try Month DD, YYYY (e.g. "October 20 2026")
  const monthFirstMatch = cleaned.match(/([A-Za-z]+)\s+(\d{1,2})(?:[\s,]+(\d{2,4}))?/);
  if (monthFirstMatch) {
    const monStr = monthFirstMatch[1].slice(0, 3).toLowerCase();
    const day = parseInt(monthFirstMatch[2], 10);
    if (monthNames[monStr] !== undefined) {
      let year = monthFirstMatch[3] ? parseInt(monthFirstMatch[3], 10) : currentYear;
      if (year < 100) year += 2000;
      const d = new Date(year, monthNames[monStr], day);
      if (parsedTime) {
        d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
      }
      const parsedTs = d.getTime();
      if (!isNaN(parsedTs)) return parsedTs;
    }
  }

  // 5. Fallback: If year is missing in string, append current year and try native parse
  if (!/\b\d{4}\b/.test(cleaned)) {
    cleaned = `${cleaned} ${currentYear}`;
  }

  let ts = Date.parse(cleaned);
  if (!isNaN(ts)) {
    if (parsedTime) {
      const d = new Date(ts);
      d.setHours(parsedTime.hour, parsedTime.min, 0, 0);
      return d.getTime();
    }
    return ts;
  }

  return null;
}

/**
 * Checks whether an attendance session is scheduled on or before the current date.
 * - Open sessions are currently active today -> true
 * - Already recorded sessions (present, late, absent, excused) have already occurred -> true
 * - Today's sessions (regardless of time, e.g. 2pm when it's 12pm) -> true
 * - Future unrecorded sessions (date > current date) -> false
 */
export function isAttendanceSessionPastOrCurrent(dateText, timeText = "", status = "", referenceDate = new Date()) {
  if (status === "open" || status === "present" || status === "late" || status === "absent" || status === "excused" || status === "today") {
    return true;
  }

  const rawLower = String(dateText || "").toLowerCase();
  if (rawLower.includes("today") || rawLower.includes("hari ini")) {
    return true;
  }

  const ts = parseAttendanceSessionDate(dateText, timeText, referenceDate);
  if (!ts) {
    // If unrecorded session date cannot be parsed, strictly exclude from past/current
    return false;
  }

  const ref = new Date(referenceDate || new Date());
  const endOfRefDate = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999).getTime();

  return ts <= endOfRefDate;
}

/**
 * Parses SPeCTRUM /mod/attendance/view.php?id={cmid}
 * Extracts session rows, attendance status, open self-recording links, and statistical summaries.
 * STRICT REQUIREMENT: Only includes attendance sessions from the first date till the current date.
 */
export function parseAttendanceView(html, studentOccurrence = "", referenceDate = new Date(), activityName = "") {
  if (!html) {
    return {
      summary: { takenSessions: 0, points: "0 / 0", percentage: "0.0%", presentCount: 0, absentCount: 0, lateCount: 0, excusedCount: 0, unrecordedCount: 0 },
      sessions: [],
      hasOpenSession: false,
      openSession: null
    };
  }

  const sessions = [];
  let summary = {
    takenSessions: 0,
    points: "0 / 0",
    percentage: "0.0%",
    presentCount: 0,
    absentCount: 0,
    lateCount: 0,
    excusedCount: 0,
    unrecordedCount: 0
  };

  const ref = new Date(referenceDate || new Date());

  // 1. DOMParser Method (Browser / Popup)
  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      // Extract Sessions Table
      const rows = doc.querySelectorAll("table.attlist tr, table.generaltable tr");
      rows.forEach((tr, idx) => {
        const cells = tr.querySelectorAll("td");
        if (cells.length < 3) return; // Header or empty row

        const dateText = cells[0]?.textContent?.trim() || "Session";
        const timeText = cells[1]?.textContent?.trim() || "";
        const groupText = cells.length >= 6 ? cells[2]?.textContent?.trim() || "All students" : "All students";
        const descText = cells.length >= 6 ? cells[3]?.textContent?.trim() || "" : cells[2]?.textContent?.trim() || "";
        const statusCell = cells.length >= 6 ? cells[4] : cells[3];
        const pointsCell = cells.length >= 6 ? cells[5] : cells[4];
        const remarksCell = cells.length >= 7 ? cells[6] : null;

        const statusRaw = statusCell?.textContent?.trim() || "";
        const pointsText = pointsCell?.textContent?.trim() || "";
        const remarksText = remarksCell?.textContent?.trim() || "";

        // Check for self-recording submit link
        const submitLinkEl = tr.querySelector("a[href*='attendance.php?sessid='], a[href*='mod/attendance/attendance.php']");
        const submitUrl = submitLinkEl ? (
          submitLinkEl.getAttribute("href").startsWith("http")
            ? submitLinkEl.getAttribute("href")
            : `https://spectrum.um.edu.my/${submitLinkEl.getAttribute("href").replace(/^\//, "")}`
        ) : null;

        const sessidMatch = (submitUrl || tr.innerHTML).match(/sessid=(\d+)/);
        const sessid = sessidMatch ? sessidMatch[1] : `sess_${idx}`;

        let status = "unrecorded";
        let statusLabel = statusRaw || "Unrecorded";

        if (submitUrl || statusRaw.toLowerCase().includes("submit") || statusRaw.toLowerCase().includes("record")) {
          status = "open";
          statusLabel = "Open for Check-In";
        } else if (/present|hadir/i.test(statusRaw)) {
          status = "present";
          statusLabel = "Present";
        } else if (/late|lewat/i.test(statusRaw)) {
          status = "late";
          statusLabel = "Late";
        } else if (/absent|tidak hadir/i.test(statusRaw)) {
          status = "absent";
          statusLabel = "Absent";
        } else if (/excused|dimaafkan/i.test(statusRaw)) {
          status = "excused";
          statusLabel = "Excused";
        }

        const isMatch = matchesOccurrence(groupText, studentOccurrence, descText, activityName);
        const sessionTs = parseAttendanceSessionDate(dateText, timeText, referenceDate);
        const isPastOrCurrent = isAttendanceSessionPastOrCurrent(dateText, timeText, status, referenceDate);

        // Check if session is on the current date (today)
        const isToday = Boolean(
          String(dateText).toLowerCase().includes("today") ||
          String(dateText).toLowerCase().includes("hari ini") ||
          (sessionTs && (
            new Date(sessionTs).getFullYear() === ref.getFullYear() &&
            new Date(sessionTs).getMonth() === ref.getMonth() &&
            new Date(sessionTs).getDate() === ref.getDate()
          ))
        );

        if (status === "unrecorded" && isToday) {
          status = "today";
          const startT = timeText ? timeText.split("-")[0].trim() : "";
          statusLabel = startT ? `Scheduled Today (${startT})` : "Scheduled Today";
        }

        sessions.push({
          id: sessid,
          sessid,
          date: dateText,
          time: timeText,
          timestamp: sessionTs,
          isToday,
          isPastOrCurrent,
          group: groupText,
          description: descText,
          activityName,
          status,
          statusLabel,
          points: pointsText,
          remarks: remarksText,
          submitUrl,
          matchesOccurrence: isMatch
        });
      });

      // Extract Summary Stats from page
      const summaryTable = doc.querySelector(".attwidth, .generaltable.attwidth");
      if (summaryTable) {
        summaryTable.querySelectorAll("tr").forEach((row) => {
          const text = row.textContent.toLowerCase();
          const val = row.querySelector("td:last-child")?.textContent?.trim() || "";
          if (text.includes("taken session") || text.includes("sesi diambil")) {
            summary.takenSessions = parseInt(val, 10) || summary.takenSessions;
          } else if (text.includes("point") || text.includes("mata")) {
            summary.points = val || summary.points;
          } else if (text.includes("percentage") || text.includes("peratus")) {
            summary.percentage = val.includes("%") ? val : `${val}%`;
          }
        });
      }
    } catch (e) {
      console.warn("[Spectra Parser] DOM attendance parsing error:", e);
    }
  }

  // 2. Regex Method Fallback (if DOMParser is not available or returned 0 sessions)
  if (sessions.length === 0) {
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    let idx = 0;
    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const rowContent = rowMatch[1];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
      }

      if (cells.length < 3) continue;

      const dateText = cells[0] || "Session";
      const timeText = cells[1] || "";
      const groupText = cells.length >= 6 ? cells[2] || "All students" : "All students";
      const descText = cells.length >= 6 ? cells[3] || "" : cells[2] || "";
      const statusRaw = cells.length >= 6 ? cells[4] || "" : cells[3] || "";
      const pointsText = cells.length >= 6 ? cells[5] || "" : cells[4] || "";

      let submitUrl = null;
      const submitMatch = rowContent.match(/href=["']([^"']*attendance\.php\?sessid=\d+[^"']*)["']/i);
      if (submitMatch) {
        submitUrl = submitMatch[1].startsWith("http")
          ? submitMatch[1]
          : `https://spectrum.um.edu.my/${submitMatch[1].replace(/^\//, "")}`;
      }

      const sessidMatch = (submitUrl || rowContent).match(/sessid=(\d+)/);
      const sessid = sessidMatch ? sessidMatch[1] : `sess_${idx++}`;

      let status = "unrecorded";
      let statusLabel = statusRaw || "Unrecorded";

      if (submitUrl || /submit|record|daftar/i.test(statusRaw)) {
        status = "open";
        statusLabel = "Open for Check-In";
      } else if (/present|hadir/i.test(statusRaw)) {
        status = "present";
        statusLabel = "Present";
      } else if (/late|lewat/i.test(statusRaw)) {
        status = "late";
        statusLabel = "Late";
      } else if (/absent|tidak hadir/i.test(statusRaw)) {
        status = "absent";
        statusLabel = "Absent";
      } else if (/excused|dimaafkan/i.test(statusRaw)) {
        status = "excused";
        statusLabel = "Excused";
      }

      const isMatch = matchesOccurrence(groupText, studentOccurrence, descText, activityName);
      const sessionTs = parseAttendanceSessionDate(dateText, timeText, referenceDate);
      const isPastOrCurrent = isAttendanceSessionPastOrCurrent(dateText, timeText, status, referenceDate);

      // Check if session is on the current date (today)
      const isToday = Boolean(
        String(dateText).toLowerCase().includes("today") ||
        String(dateText).toLowerCase().includes("hari ini") ||
        (sessionTs && (
          new Date(sessionTs).getFullYear() === ref.getFullYear() &&
          new Date(sessionTs).getMonth() === ref.getMonth() &&
          new Date(sessionTs).getDate() === ref.getDate()
        ))
      );

      if (status === "unrecorded" && isToday) {
        status = "today";
        const startT = timeText ? timeText.split("-")[0].trim() : "";
        statusLabel = startT ? `Scheduled Today (${startT})` : "Scheduled Today";
      }

      sessions.push({
        id: sessid,
        sessid,
        date: dateText,
        time: timeText,
        timestamp: sessionTs,
        isToday,
        isPastOrCurrent,
        group: groupText,
        description: descText,
        activityName,
        status,
        statusLabel,
        points: pointsText,
        remarks: "",
        submitUrl,
        matchesOccurrence: isMatch
      });
    }

    // Regex summary fallback
    const takenMatch = html.match(/(?:taken sessions?|sesi diambil)[^:]*:?\s*(\d+)/i);
    if (takenMatch) summary.takenSessions = parseInt(takenMatch[1], 10);

    const pointsMatch = html.match(/(?:points over taken sessions?|mata sesi diambil)[^:]*:?\s*([\d\s/]+)/i);
    if (pointsMatch) summary.points = pointsMatch[1].trim();

    const pctMatch = html.match(/(?:percentage over taken sessions?|peratus sesi diambil)[^:]*:?\s*([\d.]+)%?/i);
    if (pctMatch) summary.percentage = `${pctMatch[1]}%`;
  }

  // STRICT REQUIREMENT: Only show the attendance from first till the current date
  const pastOrCurrentSessions = sessions.filter((s) => s.isPastOrCurrent);

  // Calculate detailed counts based on student's occurrence
  const isOccSpecified = Boolean(studentOccurrence && studentOccurrence.trim().toLowerCase() !== "all");
  const relevantSessions = isOccSpecified
    ? pastOrCurrentSessions.filter((s) => s.matchesOccurrence)
    : pastOrCurrentSessions;
  const targetSessions = relevantSessions;

  let present = 0, absent = 0, late = 0, excused = 0, unrecorded = 0;
  let openSession = null;

  targetSessions.forEach((s) => {
    if (s.status === "present") present++;
    else if (s.status === "absent") absent++;
    else if (s.status === "late") late++;
    else if (s.status === "excused") excused++;
    else {
      unrecorded++;
    }
  });

  // STRICT REQUIREMENT: Only select openSession if the session is genuinely OPEN and matches the respective occurrence!
  for (const s of pastOrCurrentSessions) {
    if (s.status === "open" && s.submitUrl && isRespectiveOccurrence(s.group, studentOccurrence, s.description, s.activityName || activityName)) {
      openSession = s;
      break;
    }
  }

  const totalCompleted = present + absent + late + excused;
  if (totalCompleted > 0 && (!summary.takenSessions || summary.takenSessions === 0)) {
    summary.takenSessions = totalCompleted;
    const score = (present * 1.0) + (late * 0.5) + (excused * 1.0);
    const pct = ((score / totalCompleted) * 100).toFixed(1);
    summary.percentage = `${pct}%`;
    summary.points = `${score} / ${totalCompleted}`;
  }

  summary.presentCount = present;
  summary.absentCount = absent;
  summary.lateCount = late;
  summary.excusedCount = excused;
  summary.unrecordedCount = unrecorded;

  return {
    summary,
    sessions: pastOrCurrentSessions,
    hasOpenSession: Boolean(openSession),
    openSession
  };
}

/**
 * Parses SPeCTRUM /mod/attendance/attendance.php form
 * Extracts the Present status ID and detects password protection.
 */
export function parseAttendanceForm(html) {
  if (!html) return { statusId: null, requiresPassword: false, sesskey: null, sessid: null };

  let statusId = null;
  let requiresPassword = false;
  let sesskey = null;
  let sessid = null;

  // Extract sesskey
  const sesskeyMatch = html.match(/name=["']sesskey["'][^>]*value=["']([^"']+)["']/i) ||
                       html.match(/value=["']([^"']+)["'][^>]*name=["']sesskey["']/i) ||
                       html.match(/"sesskey":"([^"]+)"/);
  if (sesskeyMatch) sesskey = sesskeyMatch[1];

  // Extract sessid
  const sessidMatch = html.match(/name=["']sessid["'][^>]*value=["']([^"']+)["']/i) ||
                      html.match(/value=["']([^"']+)["'][^>]*name=["']sessid["']/i) ||
                      html.match(/sessid=(\d+)/i);
  if (sessidMatch) sessid = sessidMatch[1];

  // Check if password field exists
  if (/<input[^>]+name=["'](studentpassword|password)["']/i.test(html) || /<input[^>]+type=["']password["']/i.test(html)) {
    requiresPassword = true;
  }

  // 1. DOMParser approach if available (Browser context)
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const statusInputs = doc.querySelectorAll('input[name="status"]');
      for (const input of statusInputs) {
        const val = input.value;
        const id = input.id;
        let labelText = "";
        if (id) {
          const lbl = doc.querySelector(`label[for="${id}"]`);
          if (lbl) labelText += " " + lbl.textContent;
        }
        const parentLabel = input.closest("label");
        if (parentLabel) labelText += " " + parentLabel.textContent;
        const nextElem = input.nextElementSibling;
        if (nextElem && nextElem.tagName.toLowerCase() === "label") labelText += " " + nextElem.textContent;
        if (input.parentElement) labelText += " " + input.parentElement.textContent;

        const cleanLabel = labelText.trim();
        if (/present|hadir|^p\b/i.test(cleanLabel)) {
          statusId = val;
          break;
        }
      }
    } catch (_) {}
  }

  // 2. Fallback: Robust regex search across all status radio inputs
  if (!statusId) {
    const inputStatusRegex = /<input[^>]*name=["']status["'][^>]*>/gi;
    let inMatch;
    while ((inMatch = inputStatusRegex.exec(html)) !== null) {
      const tagStr = inMatch[0];
      const valM = tagStr.match(/value=["'](\d+)["']/i);
      const idM = tagStr.match(/id=["']([^"']+)["']/i);
      if (!valM) continue;
      const val = valM[1];

      let isPresent = false;
      if (idM) {
        const labelForRegex = new RegExp(`<label[^>]*for=["']${idM[1]}["'][^>]*>([\\s\\S]*?)<\\/label>`, "i");
        const lMatch = html.match(labelForRegex);
        if (lMatch && /present|hadir|^p\b/i.test(lMatch[1].replace(/<[^>]+>/g, "").trim())) {
          isPresent = true;
        }
      }

      if (!isPresent) {
        const afterInput = html.substring(inputStatusRegex.lastIndex, inputStatusRegex.lastIndex + 300);
        const nextLabelM = afterInput.match(/^[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>/i);
        if (nextLabelM && /present|hadir|^p\b/i.test(nextLabelM[1].replace(/<[^>]+>/g, "").trim())) {
          isPresent = true;
        }
      }

      if (!isPresent) {
        const surrounding = html.substring(Math.max(0, inMatch.index - 50), Math.min(html.length, inMatch.index + 200));
        if (/present|hadir/i.test(surrounding)) {
          isPresent = true;
        }
      }

      if (isPresent) {
        statusId = val;
        break;
      }
    }
  }

  // 3. Fallback: If no label matched, pick first status input value
  if (!statusId) {
    const anyRadio = html.match(/name=["']status["'][^>]*value=["'](\d+)["']/i) ||
                     html.match(/value=["'](\d+)["'][^>]*name=["']status["']/i);
    if (anyRadio) statusId = anyRadio[1];
  }

  return { statusId, requiresPassword, sesskey, sessid };
}
