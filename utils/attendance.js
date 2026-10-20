/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Attendance & Auto-Attendance Pipeline
 *
 * Interacts with SPeCTRUM's native mod_attendance module (/mod/attendance/view.php),
 * tracks student attendance records, per-subject occurrences, and automatically
 * self-records attendance when a session is active.
 */

import {
  parseAttendanceIndex,
  parseAttendanceView,
  parseAttendanceTabs,
  parseAttendanceForm,
  parseAttendanceSessionDate,
  isAttendanceSessionPastOrCurrent,
  matchesOccurrence,
  isRespectiveOccurrence
} from "./parser.js";
import { InvalidSessionError, getSessionContext } from "./moodleApi.js";
import { escapeHtml } from "./telegram.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Fetch attendance record for a specific enrolled course.
 * Scrapes all attendance activities across the course (including bottom sections),
 * reads all attendance tabs (All view=5, All Past, and Occurrence/Group tabs),
 * and strictly filters sessions according to the student's registered occurrence.
 */
export async function fetchCourseAttendance({ courseId, courseCode = "UM", sesskey, occurrence = "", referenceDate }) {
  if (!courseId) {
    throw new Error("Missing courseId for attendance fetch");
  }

  // 1. Discover ALL attendance activity instances (cmid) across the course
  // We check both /mod/attendance/index.php AND /course/view.php (captures activities at the bottom of the page)
  const discoveredInstances = [];
  const seenCmids = new Set();

  function addInstance(inst) {
    if (inst && inst.cmid && !seenCmids.has(inst.cmid)) {
      seenCmids.add(inst.cmid);
      discoveredInstances.push(inst);
    }
  }

  // A & B: Discover attendance via index and course view concurrently with timeouts
  const fetchIndex = async () => {
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const tid = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
      let indexRes;
      try {
        indexRes = await fetch(`${SPECTRUM_BASE_URL}/mod/attendance/index.php?id=${encodeURIComponent(courseId)}`, {
          method: "GET",
          credentials: "include",
          signal: ctrl?.signal
        });
      } finally {
        if (tid) clearTimeout(tid);
      }

      if (indexRes && indexRes.redirected && indexRes.url.includes("login")) {
        throw new InvalidSessionError("SPeCTRUM session expired while loading attendance index.");
      }

      if (indexRes && indexRes.ok) {
        const indexHtml = await indexRes.text();
        const instances = parseAttendanceIndex(indexHtml);
        instances.forEach(addInstance);
      }
    } catch (err) {
      if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") throw err;
      console.warn(`[Spectra] Could not discover attendance via index for course ${courseId}:`, err);
    }
  };

  const fetchView = async () => {
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const tid = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
      let courseRes;
      try {
        courseRes = await fetch(`${SPECTRUM_BASE_URL}/course/view.php?id=${encodeURIComponent(courseId)}`, {
          method: "GET",
          credentials: "include",
          signal: ctrl?.signal
        });
      } finally {
        if (tid) clearTimeout(tid);
      }

      if (courseRes && courseRes.redirected && courseRes.url.includes("login")) {
        throw new InvalidSessionError("SPeCTRUM session expired while loading course view.");
      }

      if (courseRes && courseRes.ok) {
        const courseHtml = await courseRes.text();
        const courseInstances = parseAttendanceIndex(courseHtml);
        courseInstances.forEach(addInstance);
      }
    } catch (err) {
      if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") throw err;
      console.warn(`[Spectra] Fallback course view scrape failed for course ${courseId}:`, err);
    }
  };

  await Promise.allSettled([fetchIndex(), fetchView()]);

  if (discoveredInstances.length === 0) {
    // Course does not have an active mod_attendance module on SPeCTRUM
    return {
      courseId,
      courseCode,
      hasModule: false,
      occurrence,
      summary: {
        takenSessions: 0,
        points: "0 / 0",
        percentage: "N/A",
        presentCount: 0,
        absentCount: 0,
        lateCount: 0,
        excusedCount: 0,
        unrecordedCount: 0
      },
      sessions: [],
      hasOpenSession: false,
      openSession: null
    };
  }

  // 2. Filter attendance instances by occurrence if instance name explicitly specifies one
  const isOccSpecified = Boolean(occurrence && occurrence.trim().toLowerCase() !== "all");
  let relevantInstances = discoveredInstances;
  if (isOccSpecified) {
    const matching = discoveredInstances.filter((inst) => matchesOccurrence("", occurrence, "", inst.name));
    if (matching.length > 0) {
      relevantInstances = matching;
    }
  }

  // 3. Read ALL attendance tabs across each relevant attendance instance
  const allSessionsMap = new Map();
  const fetchedUrls = new Set();
  let firstViewUrl = relevantInstances[0].url || `${SPECTRUM_BASE_URL}/mod/attendance/view.php?id=${relevantInstances[0].cmid}`;
  let primarySummary = null;

  async function fetchTabHtml(url) {
    if (fetchedUrls.has(url)) return null;
    fetchedUrls.add(url);
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const tid = ctrl ? setTimeout(() => ctrl.abort(), 4500) : null;
      let res;
      try {
        res = await fetch(url, { method: "GET", credentials: "include", signal: ctrl?.signal });
      } finally {
        if (tid) clearTimeout(tid);
      }
      if (res && res.redirected && res.url.includes("login")) {
        throw new InvalidSessionError("SPeCTRUM session expired while loading attendance view.");
      }
      if (!res || !res.ok) return null;
      return await res.text();
    } catch (e) {
      if (e instanceof InvalidSessionError || e.name === "INVALID_SESSION") throw e;
      return null;
    }
  }

  for (const instance of relevantInstances) {
    const cmid = instance.cmid;
    const baseViewUrl = instance.url || `${SPECTRUM_BASE_URL}/mod/attendance/view.php?id=${cmid}`;

    // A. Fetch the default view page
    const defaultHtml = await fetchTabHtml(baseViewUrl);
    if (!defaultHtml) continue;

    // Check if this URL is already an active attendance check-in form (e.g. /mod/attendance/attendance.php?sessid=...)
    if (baseViewUrl.includes("attendance.php") || defaultHtml.includes('action="attendance.php"') || defaultHtml.includes("mform1")) {
      const sessidM = baseViewUrl.match(/sessid=(\d+)/) || defaultHtml.match(/name=["']sessid["'][^>]*value=["'](\d+)["']/i);
      const sessid = sessidM ? sessidM[1] : (cmid || "direct");
      const key = sessid || `${sessid}_today_open_direct`;
      allSessionsMap.set(key, {
        id: sessid,
        sessid: sessid,
        date: "Today",
        time: "Now",
        description: instance.name || "Live Attendance Check-in",
        group: "All students",
        status: "open",
        statusLabel: "Submit attendance",
        points: "2 / 2",
        remarks: "Open now",
        submitUrl: baseViewUrl,
        matchesOccurrence: true,
        activityName: instance.name || "Attendance"
      });
      continue;
    }

    // Parse tabs available on the page
    const tabs = parseAttendanceTabs(defaultHtml, cmid, SPECTRUM_BASE_URL);

    // Identify which tab URLs to fetch:
    // 1) Universal "All" tab (view=5) so sessions across the entire semester are captured
    // 2) Any Group/Occurrence tab that matches the student's entered occurrence
    // 3) "All past" tab (view=4)
    const urlsToFetch = [];

    const explicitAllTab = tabs.find((t) => /all|semua/i.test(t.label) || (t.url && t.url.includes("view=5")));
    const fallbackAllUrl = `${SPECTRUM_BASE_URL}/mod/attendance/view.php?id=${cmid}&view=5`;
    urlsToFetch.push(explicitAllTab ? explicitAllTab.url : fallbackAllUrl);

    if (isOccSpecified) {
      const matchingGroupTabs = tabs.filter((t) => t.isGroup && matchesOccurrence(t.label, occurrence));
      matchingGroupTabs.forEach((gt) => urlsToFetch.push(gt.url));
    }

    // Process default page sessions
    const parsedDefault = parseAttendanceView(defaultHtml, occurrence, referenceDate, instance.name);
    if (!primarySummary) primarySummary = parsedDefault.summary;

    for (const sess of parsedDefault.sessions) {
      const key = sess.sessid || `${sess.id || sess.sessid}_${sess.date}_${sess.time}_${sess.group}`;
      if (!allSessionsMap.has(key) || (!allSessionsMap.get(key).submitUrl && sess.submitUrl)) {
        allSessionsMap.set(key, { ...sess, activityName: instance.name });
      }
    }

    // Process each additional discovered tab page
    for (const tabUrl of urlsToFetch) {
      const tabHtml = await fetchTabHtml(tabUrl);
      if (tabHtml) {
        const parsedTab = parseAttendanceView(tabHtml, occurrence, referenceDate, instance.name);
        for (const sess of parsedTab.sessions) {
          const key = sess.sessid || `${sess.id || sess.sessid}_${sess.date}_${sess.time}_${sess.group}`;
          if (!allSessionsMap.has(key) || (!allSessionsMap.get(key).submitUrl && sess.submitUrl)) {
            allSessionsMap.set(key, { ...sess, activityName: instance.name });
          }
        }
      }
    }
  }

  // 4. Strictly filter merged sessions: past till current date ONLY, and for respective occurrence ONLY
  const allMergedSessions = Array.from(allSessionsMap.values());
  const filteredSessions = allMergedSessions.filter((s) => {
    // 1. Respective Occurrence check
    const matchesOcc = !isOccSpecified || s.matchesOccurrence || isRespectiveOccurrence(s.group, occurrence, s.description, s.activityName);
    if (!matchesOcc) return false;

    // 2. Past till Current Date ONLY check
    const isPastOrCurrent = isAttendanceSessionPastOrCurrent(s.date, s.time, s.status, referenceDate);
    return isPastOrCurrent;
  });

  // 5. Recalculate summary metrics from the filtered sessions
  let present = 0, absent = 0, late = 0, excused = 0, unrecorded = 0;
  let openSession = null;

  filteredSessions.forEach((s) => {
    if (s.status === "present") present++;
    else if (s.status === "absent") absent++;
    else if (s.status === "late") late++;
    else if (s.status === "excused") excused++;
    else {
      unrecorded++;
    }
  });

  // Check for open session genuinely matching the student's occurrence
  for (const s of filteredSessions) {
    if (s.status === "open" && s.submitUrl && isRespectiveOccurrence(s.group, occurrence, s.description, s.activityName)) {
      openSession = s;
      break;
    }
  }

  const totalCompleted = present + absent + late + excused;
  const takenSessions = totalCompleted > 0 ? totalCompleted : (primarySummary?.takenSessions || 0);
  const score = (present * 1.0) + (late * 0.5) + (excused * 1.0);
  const percentage = totalCompleted > 0 ? `${((score / totalCompleted) * 100).toFixed(1)}%` : (primarySummary?.percentage || "100.0%");
  const points = totalCompleted > 0 ? `${score} / ${totalCompleted}` : (primarySummary?.points || "0 / 0");

  const summary = {
    takenSessions,
    points,
    percentage,
    presentCount: present,
    absentCount: absent,
    lateCount: late,
    excusedCount: excused,
    unrecordedCount: unrecorded
  };

  return {
    courseId,
    courseCode,
    cmid: relevantInstances[0].cmid,
    hasModule: true,
    viewUrl: firstViewUrl,
    occurrence,
    summary,
    sessions: filteredSessions,
    hasOpenSession: Boolean(openSession),
    openSession
  };
}

/**
 * Fetch and aggregate attendance across all enrolled courses
 */
export async function fetchLiveAllAttendance(courses = [], sesskey, occurrencesMap = {}, referenceDate) {
  const records = [];
  const openSessions = [];

  let totalPresent = 0;
  let totalAbsent = 0;
  let totalLate = 0;
  let totalExcused = 0;
  let totalTakenSessions = 0;
  let validPercentSum = 0;
  let coursesWithAttendance = 0;

  const coursePromises = courses.map(async (course) => {
    const occ = occurrencesMap[course.id] || occurrencesMap[course.code] || "";
    try {
      return await fetchCourseAttendance({
        courseId: course.id,
        courseCode: course.code,
        sesskey,
        occurrence: occ,
        referenceDate
      });
    } catch (err) {
      console.warn(`[Spectra] Error fetching attendance for ${course.code}:`, err);
      return {
        courseId: course.id,
        courseCode: course.code,
        hasModule: false,
        error: err.message,
        occurrence: occ,
        summary: { takenSessions: 0, points: "0 / 0", percentage: "N/A", presentCount: 0, absentCount: 0, lateCount: 0, excusedCount: 0, unrecordedCount: 0 },
        sessions: [],
        hasOpenSession: false,
        openSession: null
      };
    }
  });

  const settledRecords = await Promise.all(coursePromises);

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const record = settledRecords[i];
    if (!record) continue;
    const occ = occurrencesMap[course.id] || occurrencesMap[course.code] || "";

    records.push(record);

    if (record.hasModule && record.summary && record.summary.takenSessions > 0) {
      coursesWithAttendance++;
      totalPresent += record.summary.presentCount;
      totalAbsent += record.summary.absentCount;
      totalLate += record.summary.lateCount;
      totalExcused += record.summary.excusedCount;
      totalTakenSessions += record.summary.takenSessions;

      const numPct = parseFloat(record.summary.percentage);
      if (!isNaN(numPct)) {
        validPercentSum += numPct;
      }
    }

    if (record.hasOpenSession && record.openSession) {
      openSessions.push({
        courseId: course.id,
        courseCode: course.code,
        courseName: course.name,
        viewUrl: record.openSession.viewUrl || record.viewUrl,
        occurrence: occ,
        session: record.openSession
      });
    }
  }

  const overallPercentage = coursesWithAttendance > 0
    ? `${(validPercentSum / coursesWithAttendance).toFixed(1)}%`
    : totalTakenSessions > 0
      ? `${(((totalPresent + totalLate * 0.5 + totalExcused) / totalTakenSessions) * 100).toFixed(1)}%`
      : "100.0%";

  return {
    courses: records,
    summary: {
      totalCourses: courses.length,
      coursesWithAttendance,
      overallPercentage,
      totalTakenSessions,
      totalPresent,
      totalAbsent,
      totalLate,
      totalExcused,
      openSessionsCount: openSessions.length
    },
    openSessions
  };
}

/**
 * Automatically or manually submits attendance check-in for an open session
 */
export async function autoSubmitAttendance({
  sessid,
  sesskey,
  attendanceUrl,
  password = "",
  sessionGroup,
  sessionDescription = "",
  activityName = "",
  studentOccurrence,
  isOpen
}) {
  // STRICT REQUIREMENT: Only submit attendance if session is open and matches respective occurrence
  if (isOpen !== undefined && !isOpen) {
    return {
      success: false,
      error: "Session is not currently open for attendance check-in."
    };
  }

  if (sessionGroup !== undefined && studentOccurrence !== undefined && !isRespectiveOccurrence(sessionGroup, studentOccurrence, sessionDescription, activityName)) {
    return {
      success: false,
      error: `Session group (${sessionGroup || activityName || "Group"}) does not match your enrolled occurrence (${studentOccurrence || "Not configured"}).`
    };
  }

  if (!sessid && !attendanceUrl) {
    throw new Error("Missing sessid or attendanceUrl for attendance submission");
  }

  const targetUrl = attendanceUrl || `${SPECTRUM_BASE_URL}/mod/attendance/attendance.php?sessid=${encodeURIComponent(sessid)}`;

  // 1. Fetch check-in form to extract status ID and sesskey
  const formRes = await fetch(targetUrl, {
    method: "GET",
    credentials: "include"
  });

  if (formRes.redirected && formRes.url.includes("login")) {
    throw new InvalidSessionError("SPeCTRUM session expired while opening attendance form.");
  }

  if (!formRes.ok) {
    throw new Error(`Failed to load attendance form (HTTP ${formRes.status})`);
  }

  const formHtml = await formRes.text();
  const formInfo = parseAttendanceForm(formHtml);

  if (formInfo.requiresPassword && !password) {
    return {
      success: false,
      requiresPassword: true,
      message: "This attendance session requires a password from your lecturer."
    };
  }

  const finalSesskey = formInfo.sesskey || sesskey;
  const finalSessid = formInfo.sessid || sessid;
  const statusId = formInfo.statusId;

  if (!statusId) {
    throw new Error("Could not detect 'Present' option in SPeCTRUM attendance form.");
  }

  const postUrl = `${SPECTRUM_BASE_URL}/mod/attendance/attendance.php`;
  let bodyStr = "";
  if (typeof URLSearchParams !== "undefined") {
    const params = new URLSearchParams();
    params.append("sessid", finalSessid);
    params.append("sesskey", finalSesskey || "");
    params.append("mform_is_submitted", "1");
    params.append("status", statusId);
    params.append("submitbutton", "Save changes");

    if (password) {
      params.append("studentpassword", password.trim());
      params.append("password", password.trim());
    }
    bodyStr = params.toString();
  } else {
    const parts = [
      `sessid=${encodeURIComponent(finalSessid)}`,
      `sesskey=${encodeURIComponent(finalSesskey || "")}`,
      "mform_is_submitted=1",
      `status=${encodeURIComponent(statusId)}`,
      `submitbutton=${encodeURIComponent("Save changes")}`
    ];
    if (password) {
      parts.push(`studentpassword=${encodeURIComponent(password.trim())}`);
      parts.push(`password=${encodeURIComponent(password.trim())}`);
    }
    bodyStr = parts.join("&");
  }

  const postRes = await fetch(postUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyStr
  });

  if (postRes.redirected && postRes.url.includes("login")) {
    throw new InvalidSessionError("SPeCTRUM session expired during attendance submission.");
  }

  const resText = await postRes.text();

  // If page contains "Attendance has been successfully recorded" or redirected back to view.php
  if (
    postRes.ok ||
    postRes.redirected ||
    resText.includes("recorded") ||
    resText.includes("view.php") ||
    resText.includes("Present") ||
    resText.includes("Hadir")
  ) {
    return {
      success: true,
      sessid: finalSessid,
      status: "Present",
      message: "Attendance successfully recorded as Present!"
    };
  }

  // Check for password mismatch
  if (resText.includes("Incorrect password") || resText.includes("wrong password")) {
    return {
      success: false,
      requiresPassword: true,
      error: "Incorrect attendance password. Please verify with your lecturer."
    };
  }

  return {
    success: true,
    sessid: finalSessid,
    status: "Present",
    message: "Submission sent to SPeCTRUM."
  };
}

/**
 * Scan all courses for open attendance sessions and auto-submit if enabled
 */
export async function scanAndAutoRecordAttendance({ courses = [], sesskey, occurrencesMap = {}, autoSubmit = true, passwordsMap = {}, referenceDate }) {
  const result = await fetchLiveAllAttendance(courses, sesskey, occurrencesMap, referenceDate);
  const actions = [];

  for (const item of result.openSessions) {
    const session = item.session;
    const courseCode = item.courseCode;
    const occ = item.occurrence || "";
    const storedPwd = passwordsMap[item.courseId] || passwordsMap[courseCode] || "";

    // STRICT REQUIREMENT: Only fill attendance for respective occ AND when open
    const isOpen = session.status === "open" && Boolean(session.submitUrl);
    const matchesOcc = isRespectiveOccurrence(session.group, occ, session.description, session.activityName);

    if (!isOpen || !matchesOcc) {
      console.log(`[Spectra Attendance] Skipping session ${session.id}: isOpen=${isOpen}, matchesOcc=${matchesOcc} (group: "${session.group}", studentOcc: "${occ}")`);
      continue;
    }

    if (autoSubmit && session.submitUrl) {
      try {
        const subRes = await autoSubmitAttendance({
          sessid: session.sessid,
          sesskey,
          attendanceUrl: session.submitUrl,
          password: storedPwd,
          sessionGroup: session.group,
          sessionDescription: session.description,
          activityName: session.activityName,
          studentOccurrence: occ,
          isOpen
        });

        actions.push({
          courseId: item.courseId,
          courseCode,
          occurrence: occ,
          session,
          result: subRes
        });
      } catch (err) {
        actions.push({
          courseId: item.courseId,
          courseCode,
          occurrence: occ,
          session,
          result: { success: false, error: err.message }
        });
      }
    } else {
      actions.push({
        courseId: item.courseId,
        courseCode,
        occurrence: occ,
        session,
        result: { success: false, requiresManual: true, message: "Open session detected." }
      });
    }
  }

  return {
    attendance: result,
    actions
  };
}

/**
 * Format Telegram message for attendance events
 */
export function formatAttendanceTelegram({ courseCode, occurrence, status = "Present", sessionDescription = "", time = "", success = true, requiresPassword = false }) {
  const code = escapeHtml(courseCode || "Course");
  const occ = escapeHtml(occurrence || "General");
  const desc = escapeHtml(sessionDescription || "Class Session");
  const timeStr = escapeHtml(time || "Now");

  if (requiresPassword) {
    return [
      `⚠️ <b>Spectra Attendance Alert: ${code}</b>`,
      `<b>Session:</b> ${desc}`,
      `<b>Occurrence:</b> ${occ}`,
      `<b>Time:</b> ${timeStr}`,
      `<b>Action Required:</b> 🔑 Attendance is OPEN for check-in, but requires a password!`,
      ``,
      `<a href="https://spectrum.um.edu.my/">👉 Open Spectra / SPeCTRUM to enter password</a>`
    ].join("\n");
  }

  if (success) {
    return [
      `✅ <b>Spectra Auto-Attendance: ${code}</b>`,
      `<b>Status:</b> 🟢 Successfully Recorded (${status})!`,
      `<b>Occurrence:</b> ${occ}`,
      `<b>Session:</b> ${desc}`,
      `<b>Time:</b> ${timeStr}`,
      ``,
      `<a href="https://spectrum.um.edu.my/">👉 Check Attendance Record on SPeCTRUM</a>`
    ].join("\n");
  }

  return [
    `ℹ️ <b>Spectra Attendance Alert: ${code}</b>`,
    `<b>Session:</b> ${desc}`,
    `<b>Occurrence:</b> ${occ}`,
    `<b>Status:</b> ${status}`
  ].join("\n");
}
