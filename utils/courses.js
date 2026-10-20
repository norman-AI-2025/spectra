/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Enrolled Courses & Course Materials Pipeline
 * Directly interacts with SPeCTRUM's native AJAX endpoints and course views
 * with verified sesskey & session error boundaries.
 */

import { extractCourseCode, parseCoursePage, parseEnrolledCourses, parseForumDiscussions } from "./parser.js";
import { InvalidSessionError, AuthRequiredError, injectCookieToBrowser, getSessionContext } from "./moodleApi.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Fetch live enrolled courses directly from SPeCTRUM via Moodle AJAX or DOM scraping.
 * Throws InvalidSessionError if session is expired or requires login.
 */
export async function getLiveEnrolledCourses(sesskey) {
  // If sesskey is not provided, attempt to retrieve from session context
  if (!sesskey) {
    const ctx = await getSessionContext();
    sesskey = ctx.sesskey;
  }

  // Method 1: Moodle AJAX core_course_get_enrolled_courses_by_timeline_classification
  try {
    // Primary query: inprogress courses (active semester courses)
    let payload = [
      {
        index: 0,
        methodname: "core_course_get_enrolled_courses_by_timeline_classification",
        args: {
          classification: "inprogress",
          limit: 0,
          offset: 0,
          sort: "fullname"
        }
      }
    ];

    const ajaxEndpoint = `${SPECTRUM_BASE_URL}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=core_course_get_enrolled_courses_by_timeline_classification`;
    let res = await fetch(ajaxEndpoint, {
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
      throw new InvalidSessionError(`SPeCTRUM course API returned HTTP ${res.status}`);
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
          throw new Error(data[0].message || "Moodle course API error");
        }

        if (data[0].data?.courses) {
          return data[0].data.courses.map((c) => {
            const code = extractCourseCode(c.shortname || c.fullname);
            return {
              id: String(c.id),
              code,
              name: c.fullname,
              shortname: c.shortname || code,
              url: c.viewurl || `${SPECTRUM_BASE_URL}/course/view.php?id=${c.id}`
            };
          });
        }
      }
    }
  } catch (err) {
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") {
      throw err;
    }
    console.warn("[Spectra] AJAX course fetch failed, falling back to /my/ HTML:", err);
  }

  // Method 2: DOM scrape of /my/ dashboard
  try {
    const myRes = await fetch(`${SPECTRUM_BASE_URL}/my/`, {
      method: "GET",
      credentials: "include"
    });

    if (myRes.redirected && (
      myRes.url.includes("/login/") ||
      myRes.url.includes("microsoftonline") ||
      myRes.url.includes("sso")
    )) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ sessionStatus: "expired" });
      }
      throw new InvalidSessionError("Session expired while loading enrolled courses. Redirected to login portal.");
    }

    if (myRes.status === 401 || myRes.status === 403) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ sessionStatus: "expired" });
      }
      throw new InvalidSessionError(`SPeCTRUM dashboard returned HTTP ${myRes.status}`);
    }

    if (myRes.ok && !myRes.redirected) {
      const html = await myRes.text();
      if (html.includes("You are not logged in") || html.includes('name="logintoken"')) {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          await chrome.storage.local.set({ sessionStatus: "expired" });
        }
        throw new InvalidSessionError("SPeCTRUM returned unauthenticated state.");
      }
      return parseEnrolledCourses(html);
    }
  } catch (e) {
    if (e instanceof InvalidSessionError || e.name === "INVALID_SESSION") {
      throw e;
    }
    console.warn("[Spectra] Fallback course scraping failed:", e);
  }

  return [];
}

/**
 * Fetch live course materials directly from course page /course/view.php?id=...
 * Throws InvalidSessionError if session is expired or redirected to login.
 */
export async function getLiveCourseMaterials(courseId) {
  if (!courseId) return { slides: [], tutorials: [], labs: [] };

  const courseUrl = `${SPECTRUM_BASE_URL}/course/view.php?id=${encodeURIComponent(courseId)}`;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 7000) : null;
  let res;
  try {
    res = await fetch(courseUrl, {
      method: "GET",
      credentials: "include",
      signal: controller?.signal
    });
  } catch (netErr) {
    if (netErr.name === "AbortError") {
      throw new Error(`Connection timed out loading course materials for ${courseId}`);
    }
    throw new Error(`Failed to connect to course page: ${netErr.message}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (res.redirected && (
    res.url.includes("login") ||
    res.url.includes("microsoftonline") ||
    res.url.includes("sso")
  )) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ sessionStatus: "expired" });
    }
    throw new InvalidSessionError("Session expired while loading course materials. Please update your MoodleSession cookie.");
  }

  if (res.status === 401 || res.status === 403) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ sessionStatus: "expired" });
    }
    throw new InvalidSessionError(`Course page returned HTTP ${res.status}. Session expired.`);
  }

  if (!res.ok) {
    throw new Error(`Failed to load course page (HTTP ${res.status})`);
  }

  const html = await res.text();
  if (html.includes("You are not logged in") || html.includes('name="logintoken"')) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ sessionStatus: "expired" });
    }
    throw new InvalidSessionError("SPeCTRUM returned unauthenticated state for course materials.");
  }

  return parseCoursePage(html);
}

// Aliases
export const fetchLiveEnrolledCourses = getLiveEnrolledCourses;
export const fetchLiveCourseMaterials = getLiveCourseMaterials;

/**
 * Fetch live forum announcements across enrolled courses.
 * Scans course pages concurrently with timeouts, locates forum view URLs, and parses discussions.
 */
export async function fetchLiveAnnouncements(courses = [], sesskey = null) {
  if (!courses || courses.length === 0) {
    courses = await getLiveEnrolledCourses(sesskey);
  }

  const allAnnouncements = [];

  const coursePromises = (courses || []).map(async (course) => {
    try {
      const courseUrl = course.url || `${SPECTRUM_BASE_URL}/course/view.php?id=${course.id}`;
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const tid = ctrl ? setTimeout(() => ctrl.abort(), 6000) : null;
      let courseRes;
      try {
        courseRes = await fetch(courseUrl, { credentials: "include", signal: ctrl?.signal });
      } finally {
        if (tid) clearTimeout(tid);
      }
      if (!courseRes || !courseRes.ok) return [];

      const courseHtml = await courseRes.text();
      const forumMatches = Array.from(courseHtml.matchAll(/href="([^"]*mod\/forum\/view\.php\?id=\d+[^"]*)"/g));
      const seenForumUrls = new Set();
      const courseAnnouncements = [];

      for (const fMatch of forumMatches) {
        let forumUrl = fMatch[1];
        if (!forumUrl.startsWith("http")) {
          forumUrl = SPECTRUM_BASE_URL + "/" + forumUrl.replace(/^\//, "");
        }
        if (seenForumUrls.has(forumUrl)) continue;
        seenForumUrls.add(forumUrl);

        const fCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const fTid = fCtrl ? setTimeout(() => fCtrl.abort(), 4000) : null;
        let forumRes;
        try {
          forumRes = await fetch(forumUrl, { credentials: "include", signal: fCtrl?.signal });
        } finally {
          if (fTid) clearTimeout(fTid);
        }
        if (!forumRes || !forumRes.ok) continue;

        const forumHtml = await forumRes.text();
        const discussions = parseForumDiscussions(forumHtml, course.code || course.shortname || "Course");

        discussions.forEach((d) => {
          d.courseId = String(course.id);
          d.courseName = course.name;
        });

        courseAnnouncements.push(...discussions);
      }
      return courseAnnouncements;
    } catch (err) {
      console.warn(`[Spectra] Could not load announcements for course ${course.code}:`, err);
      return [];
    }
  });

  const settled = await Promise.allSettled(coursePromises);
  settled.forEach((res) => {
    if (res.status === "fulfilled" && Array.isArray(res.value)) {
      allAnnouncements.push(...res.value);
    }
  });

  // Deduplicate by announcement ID
  const seenIds = new Set();
  const deduped = [];
  for (const item of allAnnouncements) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      deduped.push(item);
    }
  }

  return deduped;
}

