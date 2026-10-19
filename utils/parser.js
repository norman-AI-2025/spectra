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
  const lower = dateStr.toLowerCase();

  // Check for "Today, HH:MM"
  if (lower.includes("today")) {
    const timeMatch = dateStr.match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const ampm = timeMatch[3];
      if (ampm) {
        if (ampm.toUpperCase() === "PM" && hours < 12) hours += 12;
        if (ampm.toUpperCase() === "AM" && hours === 12) hours = 0;
      }
      const d = new Date(now);
      d.setHours(hours, minutes, 0, 0);
      return d.getTime();
    }
  }

  // Check for "Tomorrow, HH:MM"
  if (lower.includes("tomorrow")) {
    const timeMatch = dateStr.match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const ampm = timeMatch[3];
      if (ampm) {
        if (ampm.toUpperCase() === "PM" && hours < 12) hours += 12;
        if (ampm.toUpperCase() === "AM" && hours === 12) hours = 0;
      }
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(hours, minutes, 0, 0);
      return d.getTime();
    }
  }

  // Standard date parsing attempt
  const cleanStr = dateStr.replace(/^[A-Za-z]+,\s*/, ""); // remove day of week like "Monday, "
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
export function matchesOccurrence(sessionGroup, studentOccurrence) {
  return isRespectiveOccurrence(sessionGroup, studentOccurrence);
}

/**
 * Strict occurrence checker:
 * Ensures attendance is only filled/recorded for the student's respective occurrence.
 * - Universal groups ("All students", "Semua pelajar", empty) match everyone.
 * - If session specifies a group (e.g. "Occ 1", "Occ 2"), student must have configured that exact occurrence.
 * - If student has NOT configured an occurrence, group-specific sessions will NOT match.
 */
export function isRespectiveOccurrence(sessionGroup, studentOccurrence) {
  const group = (sessionGroup || "").trim().toLowerCase();
  const occ = (studentOccurrence || "").trim().toLowerCase();

  // Universal groups apply to all students regardless of occurrence
  if (!group || group.includes("all students") || group.includes("semua pelajar") || group === "all") {
    return true;
  }

  // If session specifies a specific occurrence group, student MUST have configured a matching occurrence
  if (!occ) {
    return false;
  }

  if (occ === "all") {
    return true;
  }

  // Extract primary occurrence/group number if present (e.g. Occ 1 vs Occ 11, Occ 2 vs Occ 1)
  const occDigits = occ.match(/\b\d+\b/) || occ.match(/\d+/);
  const groupDigits = group.match(/\b\d+\b/) || group.match(/\d+/);

  if (occDigits && groupDigits) {
    return occDigits[0] === groupDigits[0];
  }

  // If no numbers, require word boundary match
  const safeOcc = occ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${safeOcc}\\b`, "i");
  return regex.test(group);
}

/**
 * Parses SPeCTRUM /mod/attendance/index.php?id={courseId}
 * Discovers attendance instances in the course.
 */
export function parseAttendanceIndex(html) {
  if (!html) return [];
  const links = [];

  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const aEls = doc.querySelectorAll("a[href*='mod/attendance/view.php']");
      aEls.forEach((a) => {
        const href = a.getAttribute("href") || "";
        const idMatch = href.match(/id=(\d+)/);
        if (idMatch) {
          links.push({
            cmid: idMatch[1],
            name: a.textContent.trim() || "Attendance",
            url: href.startsWith("http") ? href : `https://spectrum.um.edu.my/${href.replace(/^\//, "")}`
          });
        }
      });
      if (links.length > 0) return links;
    } catch (e) {}
  }

  // Regex fallback
  const regex = /<a[^>]+href=["']([^"']*mod\/attendance\/view\.php\?id=(\d+)[^"']*)["'][^>]*>(.*?)<\/a>/gi;
  let match;
  const seen = new Set();
  while ((match = regex.exec(html)) !== null) {
    const rawUrl = match[1];
    const cmid = match[2];
    if (!seen.has(cmid)) {
      seen.add(cmid);
      const name = match[3].replace(/<[^>]+>/g, "").trim() || "Attendance";
      const fullUrl = rawUrl.startsWith("http") ? rawUrl : `https://spectrum.um.edu.my/${rawUrl.replace(/^\//, "")}`;
      links.push({ cmid, name, url: fullUrl });
    }
  }
  return links;
}

/**
 * Normalizes and parses SPeCTRUM attendance date strings
 * Supports English and Bahasa Melayu dates, as well as DD/MM/YYYY and YYYY-MM-DD.
 */
export function parseAttendanceSessionDate(dateText, timeText = "") {
  if (!dateText) return null;

  let cleaned = String(dateText)
    .replace(/\b(isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b/gi, "")
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
    .trim();

  // Try standard parse
  let ts = Date.parse(cleaned);
  if (!isNaN(ts)) return ts;

  // DD/MM/YYYY or DD.MM.YYYY
  const m = cleaned.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const parsedTs = new Date(year, month, day).getTime();
    if (!isNaN(parsedTs)) return parsedTs;
  }

  return null;
}

/**
 * Checks whether an attendance session is scheduled on or before the current date.
 * - Open sessions are currently active today -> true
 * - Already recorded sessions (present, late, absent, excused) have already occurred -> true
 * - Future unrecorded sessions (date > current date) -> false
 */
export function isAttendanceSessionPastOrCurrent(dateText, timeText = "", status = "", referenceDate = new Date()) {
  if (status === "open" || status === "present" || status === "late" || status === "absent" || status === "excused") {
    return true;
  }

  const ts = parseAttendanceSessionDate(dateText, timeText);
  if (!ts) return true; // keep if cannot determine date

  const ref = new Date(referenceDate);
  const endOfRefDate = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999).getTime();

  return ts <= endOfRefDate;
}

/**
 * Parses SPeCTRUM /mod/attendance/view.php?id={cmid}
 * Extracts session rows, attendance status, open self-recording links, and statistical summaries.
 * STRICT REQUIREMENT: Only includes attendance sessions from the first date till the current date.
 */
export function parseAttendanceView(html, studentOccurrence = "", referenceDate = new Date()) {
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

        const isMatch = matchesOccurrence(groupText, studentOccurrence);
        const sessionTs = parseAttendanceSessionDate(dateText, timeText);
        const isPastOrCurrent = isAttendanceSessionPastOrCurrent(dateText, timeText, status, referenceDate);

        sessions.push({
          id: sessid,
          sessid,
          date: dateText,
          time: timeText,
          timestamp: sessionTs,
          isPastOrCurrent,
          group: groupText,
          description: descText,
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

      const isMatch = matchesOccurrence(groupText, studentOccurrence);
      const sessionTs = parseAttendanceSessionDate(dateText, timeText);
      const isPastOrCurrent = isAttendanceSessionPastOrCurrent(dateText, timeText, status, referenceDate);

      sessions.push({
        id: sessid,
        sessid,
        date: dateText,
        time: timeText,
        timestamp: sessionTs,
        isPastOrCurrent,
        group: groupText,
        description: descText,
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
  const relevantSessions = pastOrCurrentSessions.filter((s) => s.matchesOccurrence);
  const targetSessions = relevantSessions.length > 0 ? relevantSessions : pastOrCurrentSessions;

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
    if (s.status === "open" && s.submitUrl && isRespectiveOccurrence(s.group, studentOccurrence)) {
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

  // Extract sesskey & sessid
  const sesskeyMatch = html.match(/name=["']sesskey["']\s+value=["']([^"']+)["']/i) || html.match(/"sesskey":"([^"]+)"/);
  if (sesskeyMatch) sesskey = sesskeyMatch[1];

  const sessidMatch = html.match(/name=["']sessid["']\s+value=["']([^"']+)["']/i);
  if (sessidMatch) sessid = sessidMatch[1];

  // Check if password field exists
  if (/<input[^>]+name=["'](studentpassword|password)["']/i.test(html)) {
    requiresPassword = true;
  }

  // Find radio button for Present / Hadir
  const radioRegex = /<input[^>]+type=["']radio["'][^>]+name=["']status["'][^>]+value=["'](\d+)["'][^>]*>([\s\S]*?)<\/label>/gi;
  let rMatch;
  while ((rMatch = radioRegex.exec(html)) !== null) {
    const val = rMatch[1];
    const label = rMatch[2];
    if (/present|hadir/i.test(label)) {
      statusId = val;
      break;
    }
  }

  // Fallback: If label tag wasn't adjacent, search for status radio value
  if (!statusId) {
    const anyRadio = html.match(/name=["']status["'][^>]+value=["'](\d+)["']/i);
    if (anyRadio) statusId = anyRadio[1];
  }

  return { statusId, requiresPassword, sesskey, sessid };
}
