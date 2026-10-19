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
  parseAttendanceForm,
  matchesOccurrence,
  isRespectiveOccurrence
} from "./parser.js";
import { InvalidSessionError, getSessionContext } from "./moodleApi.js";
import { escapeHtml } from "./telegram.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Fetch attendance record for a specific enrolled course
 */
export async function fetchCourseAttendance({ courseId, courseCode = "UM", sesskey, occurrence = "", referenceDate }) {
  if (!courseId) {
    throw new Error("Missing courseId for attendance fetch");
  }

  // 1. Discover attendance activity instance (cmid)
  let cmid = null;
  let attendanceUrl = null;

  try {
    const indexRes = await fetch(`${SPECTRUM_BASE_URL}/mod/attendance/index.php?id=${encodeURIComponent(courseId)}`, {
      method: "GET",
      credentials: "include"
    });

    if (indexRes.redirected && indexRes.url.includes("login")) {
      throw new InvalidSessionError("SPeCTRUM session expired while loading attendance index.");
    }

    if (indexRes.ok) {
      const indexHtml = await indexRes.text();
      const instances = parseAttendanceIndex(indexHtml);
      if (instances.length > 0) {
        cmid = instances[0].cmid;
        attendanceUrl = instances[0].url;
      }
    }
  } catch (err) {
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") throw err;
    console.warn(`[Spectra] Could not discover attendance via index for course ${courseId}:`, err);
  }

  // Fallback: If not found in index, scrape course page
  if (!cmid) {
    try {
      const courseRes = await fetch(`${SPECTRUM_BASE_URL}/course/view.php?id=${encodeURIComponent(courseId)}`, {
        method: "GET",
        credentials: "include"
      });

      if (courseRes.redirected && courseRes.url.includes("login")) {
        throw new InvalidSessionError("SPeCTRUM session expired while loading course view.");
      }

      if (courseRes.ok) {
        const courseHtml = await courseRes.text();
        const instances = parseAttendanceIndex(courseHtml);
        if (instances.length > 0) {
          cmid = instances[0].cmid;
          attendanceUrl = instances[0].url;
        }
      }
    } catch (err) {
      if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") throw err;
      console.warn(`[Spectra] Fallback course view scrape failed for course ${courseId}:`, err);
    }
  }

  if (!cmid) {
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

  // 2. Fetch attendance view page
  const viewUrl = attendanceUrl || `${SPECTRUM_BASE_URL}/mod/attendance/view.php?id=${cmid}`;
  const viewRes = await fetch(viewUrl, {
    method: "GET",
    credentials: "include"
  });

  if (viewRes.redirected && viewRes.url.includes("login")) {
    throw new InvalidSessionError("SPeCTRUM session expired while loading attendance view.");
  }

  if (!viewRes.ok) {
    throw new Error(`SPeCTRUM attendance view returned HTTP ${viewRes.status}`);
  }

  const viewHtml = await viewRes.text();
  const parsed = parseAttendanceView(viewHtml, occurrence, referenceDate);

  return {
    courseId,
    courseCode,
    cmid,
    hasModule: true,
    viewUrl,
    occurrence,
    summary: parsed.summary,
    sessions: parsed.sessions,
    hasOpenSession: parsed.hasOpenSession,
    openSession: parsed.openSession
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

  for (const course of courses) {
    const occ = occurrencesMap[course.id] || occurrencesMap[course.code] || "";
    try {
      const record = await fetchCourseAttendance({
        courseId: course.id,
        courseCode: course.code,
        sesskey,
        occurrence: occ,
        referenceDate
      });

      records.push(record);

      if (record.hasModule && record.summary.takenSessions > 0) {
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
          viewUrl: record.viewUrl,
          occurrence: occ,
          session: record.openSession
        });
      }
    } catch (err) {
      console.warn(`[Spectra] Error fetching attendance for ${course.code}:`, err);
      records.push({
        courseId: course.id,
        courseCode: course.code,
        hasModule: false,
        error: err.message,
        occurrence: occ,
        summary: { takenSessions: 0, points: "0 / 0", percentage: "N/A", presentCount: 0, absentCount: 0, lateCount: 0, excusedCount: 0, unrecordedCount: 0 },
        sessions: [],
        hasOpenSession: false,
        openSession: null
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

  if (sessionGroup !== undefined && studentOccurrence !== undefined && !isRespectiveOccurrence(sessionGroup, studentOccurrence)) {
    return {
      success: false,
      error: `Session group (${sessionGroup || "Group"}) does not match your enrolled occurrence (${studentOccurrence || "Not configured"}).`
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

  // 2. Submit attendance POST request
  const postUrl = `${SPECTRUM_BASE_URL}/mod/attendance/attendance.php`;
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

  const postRes = await fetch(postUrl, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
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
export async function scanAndAutoRecordAttendance({ courses = [], sesskey, occurrencesMap = {}, autoSubmit = true, passwordsMap = {} }) {
  const result = await fetchLiveAllAttendance(courses, sesskey, occurrencesMap);
  const actions = [];

  for (const item of result.openSessions) {
    const session = item.session;
    const courseCode = item.courseCode;
    const occ = item.occurrence || "";
    const storedPwd = passwordsMap[item.courseId] || passwordsMap[courseCode] || "";

    // STRICT REQUIREMENT: Only fill attendance for respective occ AND when open
    const isOpen = session.status === "open" && Boolean(session.submitUrl);
    const matchesOcc = isRespectiveOccurrence(session.group, occ);

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
