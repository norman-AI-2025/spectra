/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Zero-Mock Popup Controller
 * Connects directly to SPeCTRUM Moodle API, session cookies, and live calendar
 */

import {
  getSessionContext,
  getLiveEnrolledCourses,
  getLiveCourseMaterials,
  fetchLiveAnnouncements,
  fetchCourseAttendance,
  fetchLiveAllAttendance,
  autoSubmitAttendance,
  scanAndAutoRecordAttendance,
  getStoredMoodleCookie,
  saveManualSession,
  autoDetectSession,
  injectAndScrapeSpectrum,
  InvalidSessionError,
  AuthRequiredError,
  AuthExpiredError
} from "./utils/moodleApi.js";

import { fetchLiveDeadlines } from "./utils/calendar.js";

import {
  formatTimeRemaining,
  calculateAcademicWeek,
  cleanMoodleTitle,
  extractCourseCode,
  calculateUrgency,
  isRespectiveOccurrence,
  isAttendanceSessionPastOrCurrent
} from "./utils/parser.js";

import {
  sendTelegramTestMessage,
  sanitizeTelegramToken,
  sanitizeTelegramChatId
} from "./utils/telegram.js";

// Global Application State
const state = {
  currentTab: "deadlines",
  activeFilter: "all",
  searchQuery: "",
  sesskey: null,
  userName: "UM Student",
  userAvatarUrl: "",
  isAuthenticated: false,
  isDemoMode: false,
  deadlines: [],
  completedIds: new Set(),
  courses: [],
  selectedCourse: null,
  selectedWeek: 1,
  currentAcademicWeek: 1,
  weekMaterials: { slides: [], tutorials: [], labs: [] },
  announcements: [],
  selectedAnnouncementSubject: "all",
  attendance: null,
  courseOccurrences: {},
  selectedAttendanceSubject: "all",
  autoAttendanceEnabled: true,
  telegramSentAnnouncementIds: new Set(),
  telegramSentDeadlineIds: new Set(),
  countdownIntervalId: null,
  loginTabId: null
};

// ===================================================================
// Helper to Open External URLs safely in a Chrome Tab
// ===================================================================
function openExternalUrl(url) {
  if (!url) return;
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
}

// ===================================================================
// Initialization
// ===================================================================
document.addEventListener("DOMContentLoaded", async () => {
  initDOMListeners();
  await loadStoredPreferences();
  await syncLiveSession();
  startLiveCountdowns();
});

// ===================================================================
// DOM Event Listeners & Tab Switching
// ===================================================================
function initDOMListeners() {
  // Tab Switching
  document.querySelectorAll(".nav-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      const targetTab = tabBtn.dataset.tab;
      switchTab(targetTab);
    });
  });

  // Top Bar Refresh Button
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.classList.add("spinning");
      await syncLiveSession();
      refreshBtn.classList.remove("spinning");
      showToast("SPeCTRUM data refreshed!", "info");
    });
  }

  // SPeCTRUM Session Authentication Card Handlers
  const saveSessionBtn = document.getElementById("save-session-btn");
  if (saveSessionBtn) {
    saveSessionBtn.addEventListener("click", handleSaveAndTestSession);
  }

  const autoDetectBtn = document.getElementById("auto-detect-btn");
  if (autoDetectBtn) {
    autoDetectBtn.addEventListener("click", handleAutoDetectSession);
  }

  const toggleSessionVisBtn = document.getElementById("toggle-moodle-session-visibility");
  if (toggleSessionVisBtn) {
    toggleSessionVisBtn.addEventListener("click", handleToggleSessionVisibility);
  }

  const sessionInput = document.getElementById("moodle-session-input");
  if (sessionInput) {
    sessionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSaveAndTestSession();
      }
    });
  }

  // Quick Jump to Settings Links / Buttons
  document.querySelectorAll(".jump-to-settings-btn, #jump-to-settings-btn").forEach((btn) => {
    btn.addEventListener("click", jumpToSettingsTab);
  });

  // Open SPeCTRUM Login Tab with Auto-Watcher
  const openLoginBtn = document.getElementById("openLoginTabBtn");
  if (openLoginBtn) {
    openLoginBtn.addEventListener("click", handleOpenLoginPortal);
  }

  // Recheck Session Button in Disconnected State
  const recheckBtn = document.getElementById("recheckSessionBtn");
  if (recheckBtn) {
    recheckBtn.addEventListener("click", async () => {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Verifying live connection...";
      await syncLiveSession();
      recheckBtn.disabled = false;
      recheckBtn.textContent = "Recheck Live Connection";
    });
  }

  // Toggle Manual Cookie Fields in Disconnected View
  const toggleCookieBtn = document.getElementById("toggleManualCookieBtn");
  const cookieFields = document.getElementById("manualCookieFields");
  if (toggleCookieBtn && cookieFields) {
    toggleCookieBtn.addEventListener("click", () => {
      cookieFields.classList.toggle("hidden");
    });
  }

  // Save Manual Cookie Value in Disconnected View
  const saveCookieBtn = document.getElementById("saveManualCookieBtn");
  const cookieInput = document.getElementById("manualCookieInput");
  if (saveCookieBtn && cookieInput) {
    saveCookieBtn.addEventListener("click", async () => {
      const val = cookieInput.value.trim();
      if (!val) {
        showToast("Please enter a valid cookie token", "error");
        return;
      }
      const sessionField = document.getElementById("moodle-session-input");
      if (sessionField) sessionField.value = val;
      await handleSaveAndTestSession();
    });
  }

  // Demo Preview Fallback
  const enableDemoBtn = document.getElementById("enableDemoPreviewBtn");
  if (enableDemoBtn) {
    enableDemoBtn.addEventListener("click", enableDemoPreview);
  }

  // Search & Filter
  const searchInput = document.getElementById("deadlineSearch");
  const clearBtn = document.getElementById("clearSearchBtn");

  searchInput.addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim().toLowerCase();
    clearBtn.classList.toggle("hidden", !state.searchQuery);
    renderDeadlines();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    state.searchQuery = "";
    clearBtn.classList.add("hidden");
    renderDeadlines();
  });

  document.querySelectorAll(".pill-btn").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".pill-btn").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.activeFilter = pill.dataset.filter;
      renderDeadlines();
    });
  });

  // Course Selector in Class Prep
  const courseSelect = document.getElementById("courseSelect");
  courseSelect.addEventListener("change", async (e) => {
    const selectedId = e.target.value;
    const found = state.courses.find((c) => c.id === selectedId);
    if (found) {
      state.selectedCourse = found;
      updateFolderPreview();
      await loadLiveWeekMaterials();
    }
  });

  // Subject Dropdown Filter in Announcements Tab
  const announcementSelect = document.getElementById("announcementSubjectSelect");
  if (announcementSelect) {
    announcementSelect.addEventListener("change", (e) => {
      state.selectedAnnouncementSubject = e.target.value;
      renderAnnouncements();
    });
  }

  // Refresh Announcements Button
  const refreshAnnouncementsBtn = document.getElementById("refreshAnnouncementsBtn");
  if (refreshAnnouncementsBtn) {
    refreshAnnouncementsBtn.addEventListener("click", async () => {
      refreshAnnouncementsBtn.disabled = true;
      refreshAnnouncementsBtn.textContent = "Querying forums...";
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.remove(["cached_announcements"]);
      }
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          await chrome.runtime.sendMessage({ action: "MANUAL_SYNC_ANNOUNCEMENTS" });
        } catch (e) {
          console.warn("[Spectra] Could not trigger background announcement sync:", e);
        }
      }
      await loadLiveAnnouncements();
      refreshAnnouncementsBtn.disabled = false;
      refreshAnnouncementsBtn.textContent = "Check SPeCTRUM Forums";
      showToast("Announcements updated!", "info");
    });
  }

  // Attendance Tab Handlers
  const autoAttendanceToggle = document.getElementById("autoAttendanceToggle");
  if (autoAttendanceToggle) {
    autoAttendanceToggle.addEventListener("change", async (e) => {
      state.autoAttendanceEnabled = e.target.checked;
      const lbl = document.getElementById("autoAttendanceToggleLabel");
      if (lbl) lbl.textContent = e.target.checked ? "Auto-Checkin Active" : "Auto-Checkin Paused";
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ pref_auto_attendance: e.target.checked });
      }
      showToast(`Auto-Attendance ${e.target.checked ? "enabled" : "paused"}.`, "info");
    });
  }

  const scanAttendanceBtn = document.getElementById("scanAttendanceBtn");
  if (scanAttendanceBtn) {
    scanAttendanceBtn.addEventListener("click", handleScanAttendanceNow);
  }

  const toggleOccBtn = document.getElementById("toggleOccurrenceSetupBtn");
  const occForm = document.getElementById("occurrenceConfigForm");
  if (toggleOccBtn && occForm) {
    toggleOccBtn.addEventListener("click", () => {
      const isHidden = occForm.classList.toggle("hidden");
      const textEl = document.getElementById("occurrenceSetupToggleText");
      if (textEl) textEl.textContent = isHidden ? "Show Setup ⚙️" : "Hide Setup ✕";
    });
  }

  const occCourseSelect = document.getElementById("occurrenceCourseSelect");
  if (occCourseSelect) {
    occCourseSelect.addEventListener("change", updateOccurrenceInputField);
  }

  const saveOccBtn = document.getElementById("saveOccurrenceBtn");
  if (saveOccBtn) {
    saveOccBtn.addEventListener("click", handleSaveCourseOccurrence);
  }

  document.querySelectorAll(".occ-pill-btn").forEach((pill) => {
    pill.addEventListener("click", () => {
      const occInput = document.getElementById("occurrenceInput");
      if (occInput) {
        occInput.value = pill.dataset.occ || "";
        document.querySelectorAll(".occ-pill-btn").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
      }
    });
  });

  const attendanceSubjSelect = document.getElementById("attendanceSubjectSelect");
  if (attendanceSubjSelect) {
    attendanceSubjSelect.addEventListener("change", (e) => {
      state.selectedAttendanceSubject = e.target.value;
      renderAttendanceRecords();
    });
  }

  const submitOpenAttBtn = document.getElementById("submitOpenAttendanceBtn");
  if (submitOpenAttBtn) {
    submitOpenAttBtn.addEventListener("click", handleSubmitOpenAttendance);
  }

  // Open Attendance Page Links
  const openAttendancePageLink = document.getElementById("openAttendancePageLink");
  if (openAttendancePageLink) {
    openAttendancePageLink.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openAttendancePageLink.dataset.url || openAttendancePageLink.getAttribute("href");
      if (url) openExternalUrl(url);
    });
  }

  const openCourseAttBtn = document.getElementById("openCourseAttendancePageBtn");
  if (openCourseAttBtn) {
    openCourseAttBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openCourseAttBtn.dataset.url || openCourseAttBtn.getAttribute("href");
      if (url) openExternalUrl(url);
    });
  }

  const openSpectrumHeaderBtn = document.getElementById("openSpectrumHeaderBtn");
  if (openSpectrumHeaderBtn) {
    openSpectrumHeaderBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openSpectrumHeaderBtn.dataset.url || openSpectrumHeaderBtn.getAttribute("href") || "https://spectrum.um.edu.my/my/";
      openExternalUrl(url);
    });
  }

  const attSessionsContainer = document.getElementById("attendanceSessionsList");
  if (attSessionsContainer) {
    attSessionsContainer.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (link) {
        const url = link.dataset.url || link.getAttribute("href");
        if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
          e.preventDefault();
          openExternalUrl(url);
        }
      }
    });
  }

  const refreshAttBtn = document.getElementById("refreshAttendanceBtn");
  if (refreshAttBtn) {
    refreshAttBtn.addEventListener("click", async () => {
      refreshAttBtn.disabled = true;
      refreshAttBtn.textContent = "Scanning...";
      await loadLiveAttendanceData(true);
      refreshAttBtn.disabled = false;
      refreshAttBtn.textContent = "Check SPeCTRUM Attendance";
      showToast("Attendance updated!", "info");
    });
  }

  // Download Week Pack Button
  const downloadPackBtn = document.getElementById("downloadWeekPackBtn");
  downloadPackBtn.addEventListener("click", handleDownloadWeekPack);

  // Settings: Password Visibility Toggle
  const toggleTokenBtn = document.getElementById("toggleTokenVisibility");
  const tokenInput = document.getElementById("telegramToken");
  toggleTokenBtn.addEventListener("click", () => {
    if (tokenInput.type === "password") {
      tokenInput.type = "text";
      toggleTokenBtn.textContent = "🔒";
    } else {
      tokenInput.type = "password";
      toggleTokenBtn.textContent = "👁️";
    }
  });

  // Settings: Cloud Relay Toggle
  const cloudToggle = document.getElementById("cloudRelayToggle");
  const cloudFields = document.getElementById("cloudRelayFields");
  cloudToggle.addEventListener("change", (e) => {
    cloudFields.classList.toggle("hidden", !e.target.checked);
  });

  // Settings: Test Buttons
  document.getElementById("testTelegramBtn").addEventListener("click", handleTestTelegram);
  const testNtfyBtn = document.getElementById("testNtfyBtn");
  if (testNtfyBtn) testNtfyBtn.addEventListener("click", handleTestNtfy);
  document.getElementById("syncCloudNowBtn").addEventListener("click", handleManualCloudSync);
  document.getElementById("saveSettingsBtn").addEventListener("click", handleSaveSettings);
}

function switchTab(tabName) {
  state.currentTab = tabName;

  document.querySelectorAll(".nav-tab").forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.querySelectorAll(".tab-content").forEach((panel) => {
    panel.classList.remove("active");
  });

  const activePanel = document.getElementById(`section${capitalize(tabName)}`);
  if (activePanel) {
    activePanel.classList.add("active");
  }

  if (tabName === "announcements") {
    populateAnnouncementSubjectDropdown();
    renderAnnouncements();
    if (state.announcements.length === 0 && state.isAuthenticated) {
      loadLiveAnnouncements();
    }
  }

  if (tabName === "attendance") {
    populateAttendanceCourseDropdowns();
    renderActiveOccurrenceBadges();
    renderAttendanceSummaryMetrics();
    renderOpenAttendanceBanner();
    renderAttendanceRecords();
    if (!state.attendance && state.isAuthenticated) {
      loadLiveAttendanceData();
    }
  }
}

// ===================================================================
// Auto-Login Tab Handler & Watcher
// ===================================================================
async function handleOpenLoginPortal() {
  const loginUrl = "https://spectrum.um.edu.my/login/index.php";

  const waitingBox = document.getElementById("loginWaitingBox");
  if (waitingBox) waitingBox.classList.remove("hidden");

  if (typeof chrome !== "undefined" && chrome.tabs) {
    chrome.tabs.create({ url: loginUrl }, (tab) => {
      state.loginTabId = tab.id;

      // Watch for tab updates (e.g. landing on /my/ or /auth/oidc/)
      const tabListener = (tabId, changeInfo) => {
        if (tabId === state.loginTabId && changeInfo.status === "complete") {
          // Check if tab has returned to SPeCTRUM
          chrome.tabs.get(tabId, async (updatedTab) => {
            if (updatedTab && updatedTab.url && updatedTab.url.includes("spectrum.um.edu.my") && !updatedTab.url.includes("login")) {
              console.log("[Spectra] SPeCTRUM login detected! Auto-reconnecting...");
              chrome.tabs.onUpdated.removeListener(tabListener);
              await syncLiveSession();
            }
          });
        }
      };

      chrome.tabs.onUpdated.addListener(tabListener);
    });
  } else {
    window.open(loginUrl, "_blank");
  }
}

// ===================================================================
// Live Session & Authentication Pipeline
// ===================================================================

/**
 * Update the explicit Settings status badge:
 * 🟢 Connected (Active session, verified against SPeCTRUM)
 * 🔴 Invalid / Expired (Redirected or unauthenticated)
 * ⚪ Unset (No session token configured)
 */
function updateAuthStatusBadge(status) {
  const badge = document.getElementById("session-status-badge");
  if (!badge) return;

  badge.className = "session-status-badge";
  if (status === "connected") {
    badge.classList.add("status-connected");
    badge.textContent = "🟢 Connected";
  } else if (status === "invalid" || status === "expired") {
    badge.classList.add("status-invalid");
    badge.textContent = "🔴 Invalid / Expired";
  } else {
    badge.classList.add("status-unset");
    badge.textContent = "⚪ Unset";
  }
}

/**
 * Toggle the inline notice cards on Deadlines and Class Prep tabs:
 * "Please provide your MoodleSession cookie in Settings to load courses."
 */
function updateInlineNoticeCards(isAuthenticated) {
  const noticeDeadlines = document.getElementById("sessionNoticeDeadlines");
  const noticeAnnouncements = document.getElementById("sessionNoticeAnnouncements");
  const noticeAttendance = document.getElementById("sessionNoticeAttendance");
  const noticeClassPrep = document.getElementById("sessionNoticeClassPrep");

  if (noticeDeadlines) {
    noticeDeadlines.classList.toggle("hidden", isAuthenticated);
  }
  if (noticeAnnouncements) {
    noticeAnnouncements.classList.toggle("hidden", isAuthenticated);
  }
  if (noticeAttendance) {
    noticeAttendance.classList.toggle("hidden", isAuthenticated);
  }
  if (noticeClassPrep) {
    noticeClassPrep.classList.toggle("hidden", isAuthenticated);
  }
}

/**
 * Render graceful unauthenticated empty states in Deadlines, Announcements, Attendance, and Class Prep
 */
function renderUnauthenticatedStates(isUnset) {
  const deadlinesList = document.getElementById("deadlinesList");
  const emptyState = document.getElementById("deadlinesEmptyState");
  const emptyMsg = document.getElementById("emptyStateMessage");

  if (deadlinesList) deadlinesList.innerHTML = "";
  if (emptyState && emptyMsg) {
    emptyMsg.textContent = isUnset
      ? "Please provide your MoodleSession cookie in Settings to load courses."
      : "Your SPeCTRUM session has expired. Please update your MoodleSession cookie in Settings.";
    emptyState.classList.remove("hidden");
  }

  const annList = document.getElementById("announcementsList");
  const annEmpty = document.getElementById("announcementsEmptyState");
  const annEmptyMsg = document.getElementById("emptyAnnouncementsMsg");
  if (annList) annList.innerHTML = "";
  if (annEmpty && annEmptyMsg) {
    annEmptyMsg.textContent = isUnset
      ? "Please connect your SPeCTRUM account in Settings to view course notices."
      : "Your SPeCTRUM session has expired. Please update your MoodleSession cookie in Settings.";
    annEmpty.classList.remove("hidden");
  }

  const attList = document.getElementById("attendanceSessionsList");
  const attEmpty = document.getElementById("attendanceEmptyState");
  const attEmptyMsg = document.getElementById("emptyAttendanceMsg");
  if (attList) attList.innerHTML = "";
  if (attEmpty && attEmptyMsg) {
    attEmptyMsg.textContent = isUnset
      ? "Please connect your SPeCTRUM account in Settings to view attendance records."
      : "Your SPeCTRUM session has expired. Please update your MoodleSession cookie in Settings.";
    attEmpty.classList.remove("hidden");
  }

  const courseSelect = document.getElementById("courseSelect");
  const coursesBadge = document.getElementById("detectedCoursesBadge");
  if (courseSelect) {
    courseSelect.innerHTML = `<option value="">${
      isUnset ? "Session required - configure in Settings" : "Session expired - please update in Settings"
    }</option>`;
  }
  if (coursesBadge) coursesBadge.textContent = "0 Courses";
}

/**
 * Quick jump link to the Settings tab and focus on the session input
 */
function jumpToSettingsTab() {
  switchTab("settings");
  const sessionInput = document.getElementById("moodle-session-input");
  if (sessionInput) {
    setTimeout(() => {
      sessionInput.focus();
      sessionInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }
}

/**
 * Toggle password masking on the MoodleSession input field
 */
function handleToggleSessionVisibility() {
  const input = document.getElementById("moodle-session-input");
  const btn = document.getElementById("toggle-moodle-session-visibility");
  if (!input || !btn) return;

  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "🔒";
    btn.setAttribute("title", "Hide token");
  } else {
    input.type = "password";
    btn.textContent = "👁️";
    btn.setAttribute("title", "Show token");
  }
}

/**
 * Hydrates state.deadlines from scraped calendar events and renders the Deadlines tab UI.
 * Supports both raw Moodle events (rawCalendarEvents) and formatted table items (events).
 */
function hydrateDeadlinesFromScrape(events = [], rawCalendarEvents = []) {
  if (Array.isArray(rawCalendarEvents) && rawCalendarEvents.length > 0) {
    state.deadlines = rawCalendarEvents.map((evt) => {
      const timestamp = (evt.timesort || evt.timestart) * 1000;
      const courseCode = extractCourseCode(evt.course?.shortname || evt.course?.fullname || "");
      const eventUrl = evt.action?.url || evt.url || `https://spectrum.um.edu.my/mod/${evt.modulename || "assign"}/view.php?id=${evt.instance || evt.id}`;
      const eventId = String(evt.id);
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
        isCompleted: isSubmittedOnSpectrum || state.completedIds.has(eventId),
        weight: ""
      };
    });
  } else if (Array.isArray(events) && events.length > 0) {
    state.deadlines = events.map((ev, idx) => {
      const dueTs = Date.parse(ev["Due Date"]) || (Date.now() + 86400000);
      const isSubmitted = ev["Submitted?"] === "Submitted";
      const id = `scraped-${idx}-${ev["Assignment / Task"]}`;
      const code = extractCourseCode(ev["Course Code"]) || ev["Course Code"];

      return {
        id,
        title: cleanMoodleTitle(ev["Assignment / Task"]),
        courseCode: code || "N/A",
        courseName: ev["Course Code"] || code,
        dueDate: new Date(dueTs).toISOString(),
        dueTimestamp: dueTs,
        formattedTime: ev["Due Date"] || new Date(dueTs).toLocaleString(),
        url: ev["Direct Link"] || "https://spectrum.um.edu.my/calendar/view.php",
        type: "assign",
        urgency: calculateUrgency(dueTs),
        isSubmittedOnSpectrum: isSubmitted,
        isCompleted: isSubmitted || state.completedIds.has(id),
        weight: ""
      };
    });
  } else {
    state.deadlines = [];
  }

  // Sort deadlines: pending first, then by urgency / due timestamp
  state.deadlines.sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    return a.dueTimestamp - b.dueTimestamp;
  });

  updateUrgentCountBadge();
  renderDeadlines();
}

/**
 * Hydrates state.courses from scraped course data and renders the course selector / week pills.
 * Supports both raw Moodle course items (rawCourses) and formatted table items (courses).
 */
async function hydrateCoursesFromScrape(courses = [], rawCourses = []) {
  const select = document.getElementById("courseSelect");
  const badge = document.getElementById("detectedCoursesBadge");

  if (Array.isArray(rawCourses) && rawCourses.length > 0) {
    state.courses = rawCourses.map((c) => {
      const code = extractCourseCode(c.shortname || c.fullname);
      return {
        id: String(c.id),
        code,
        name: c.fullname,
        shortname: c.shortname || code,
        url: c.viewurl || `https://spectrum.um.edu.my/course/view.php?id=${c.id}`
      };
    });
  } else if (Array.isArray(courses) && courses.length > 0) {
    state.courses = courses.map((c) => {
      const code = extractCourseCode(c["Code"] || c["Course Name"]);
      return {
        id: String(c["ID"] || ""),
        code: code || c["Code"],
        name: c["Course Name"] || c["Code"],
        shortname: c["Code"] || code,
        url: c["URL"] || `https://spectrum.um.edu.my/course/view.php?id=${c["ID"]}`
      };
    });
  } else {
    state.courses = [];
  }

  if (badge) badge.textContent = `${state.courses.length} Courses`;
  if (!select) return;
  select.innerHTML = "";

  if (state.courses.length === 0) {
    select.innerHTML = `<option value="">No enrolled courses detected on SPeCTRUM</option>`;
    return;
  }

  state.courses.forEach((c, idx) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.code} - ${c.name}`;
    if (idx === 0) {
      opt.selected = true;
      state.selectedCourse = c;
    }
    select.appendChild(opt);
  });

  updateFolderPreview();
  renderWeekPills();
  populateAnnouncementSubjectDropdown();
  await loadLiveWeekMaterials();
}

/**
 * Save & Test Connection handler:
 * - Validate string (non-empty alphanumeric, ~26 characters)
 * - Injects testSpectrumScraper directly into SPeCTRUM page tab
 * - Logs the user's 4-step scraping test into console
 * - Hydrates Deadlines and Enrolled Courses directly into the UI
 */
async function handleSaveAndTestSession() {
  const input = document.getElementById("moodle-session-input");
  const saveBtn = document.getElementById("save-session-btn");
  if (!input || !saveBtn) return;

  const rawToken = input.value.trim();

  // Validate non-empty
  if (!rawToken) {
    showToast("Please enter a MoodleSession cookie token", "error");
    updateAuthStatusBadge("unset");
    input.focus();
    return;
  }

  // Validate alphanumeric ~26 characters (15 to 45 chars)
  if (!/^[a-zA-Z0-9_-]{15,45}$/.test(rawToken)) {
    showToast("Invalid format. MoodleSession cookie is typically 26 alphanumeric characters.", "error");
    updateAuthStatusBadge("invalid");
    return;
  }

  const origHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span>Injecting & Scraping...</span>`;

  try {
    const verified = await saveManualSession(rawToken);

    // Update global state
    state.isAuthenticated = true;
    state.isDemoMode = false;
    state.sesskey = verified.sesskey;
    state.userName = verified.userName;
    state.userAvatarUrl = verified.userAvatarUrl || "";

    // Log the user's requested 4-step scraper outputs into popup console
    console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
    console.log("%c[2/4] Testing dashboard access & extracting sesskey...", "color: #3b82f6; font-weight: bold;");
    console.log(`%c✔ Session Active! Welcome, ${verified.userName}`, "color: #10b981; font-weight: bold;");
    console.log(`%c✔ Extracted sesskey: ${verified.sesskey}`, "color: #10b981;");
    console.log("%c[3/4] Fetching live upcoming deadlines...", "color: #3b82f6; font-weight: bold;");
    if (verified.events && verified.events.length > 0) {
      console.log("%cUpcoming Deadlines:", "color: #10b981; font-weight: bold;");
      console.table(verified.events);
    } else {
      console.log("%cNo upcoming deadlines found.", "color: #f59e0b;");
    }
    console.log("%c[4/4] Fetching enrolled courses...", "color: #3b82f6; font-weight: bold;");
    if (verified.courses && verified.courses.length > 0) {
      console.log("%cEnrolled Courses:", "color: #10b981; font-weight: bold;");
      console.table(verified.courses);
    }
    console.log("%c✔ Scraping logic test complete.", "color: #10b981; font-weight: bold;");

    // Update UI Badges & Indicators
    updateAuthStatusBadge("connected");
    updateSessionIndicator("connected", "Connected");
    updateUserIdentityUI(verified.userName, verified.userAvatarUrl);
    updateInlineNoticeCards(true);
    setDisconnectedViewState(false);

    const studentDisplay = document.getElementById("studentNameDisplay");
    if (studentDisplay) studentDisplay.textContent = verified.userName;

    const sesskeyEl = document.getElementById("sesskeyDisplay");
    if (sesskeyEl) sesskeyEl.textContent = `${verified.sesskey.substring(0, 5)}••••••`;

    showToast("Session Injected & Scraping Complete!", "success");

    // Connect scraped data directly to frontend UI
    if ((verified.rawCalendarEvents && verified.rawCalendarEvents.length > 0) || (verified.events && verified.events.length > 0)) {
      hydrateDeadlinesFromScrape(verified.events, verified.rawCalendarEvents);
    } else {
      await loadLiveDeadlines();
    }

    if ((verified.rawCourses && verified.rawCourses.length > 0) || (verified.courses && verified.courses.length > 0)) {
      await hydrateCoursesFromScrape(verified.courses, verified.rawCourses);
    } else {
      await loadLiveEnrolledCourses();
    }

    // Load announcements
    await loadLiveAnnouncements();

  } catch (err) {
    console.error("%c✖ Session Handshake Failed:", "color: #ef4444; font-weight: bold;", err.message || err);
    state.isAuthenticated = false;
    state.sesskey = null;

    updateAuthStatusBadge("invalid");
    updateSessionIndicator("disconnected", "Disconnected");
    updateInlineNoticeCards(false);

    showToast("Invalid Cookie, please re-check DevTools", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = origHtml;
  }
}

/**
 * Auto-detect session from browser cookie store handler
 */
async function handleAutoDetectSession() {
  const autoBtn = document.getElementById("auto-detect-btn");
  const input = document.getElementById("moodle-session-input");
  if (!autoBtn) return;

  const origHtml = autoBtn.innerHTML;
  autoBtn.disabled = true;
  autoBtn.innerHTML = `<span>Auto-detecting...</span>`;

  try {
    const verified = await autoDetectSession();

    // Populate input field with detected cookie value
    if (input) {
      const stored = await chrome.storage.local.get(["manualMoodleSession"]);
      if (stored.manualMoodleSession) {
        input.value = stored.manualMoodleSession;
      }
    }

    // Update global state
    state.isAuthenticated = true;
    state.isDemoMode = false;
    state.sesskey = verified.sesskey;
    state.userName = verified.userName;
    state.userAvatarUrl = verified.userAvatarUrl || "";

    // Console logs matching scraper
    console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
    console.log("%c[2/4] Testing dashboard access & extracting sesskey...", "color: #3b82f6; font-weight: bold;");
    console.log(`%c✔ Session Active! Welcome, ${verified.userName}`, "color: #10b981; font-weight: bold;");
    console.log(`%c✔ Extracted sesskey: ${verified.sesskey}`, "color: #10b981;");
    console.log("%c[3/4] Fetching live upcoming deadlines...", "color: #3b82f6; font-weight: bold;");
    if (verified.events && verified.events.length > 0) {
      console.log("%cUpcoming Deadlines:", "color: #10b981; font-weight: bold;");
      console.table(verified.events);
    } else {
      console.log("%cNo upcoming deadlines found.", "color: #f59e0b;");
    }
    console.log("%c[4/4] Fetching enrolled courses...", "color: #3b82f6; font-weight: bold;");
    if (verified.courses && verified.courses.length > 0) {
      console.log("%cEnrolled Courses:", "color: #10b981; font-weight: bold;");
      console.table(verified.courses);
    }
    console.log("%c✔ Scraping logic test complete.", "color: #10b981; font-weight: bold;");

    // Update UI Badges & Indicators
    updateAuthStatusBadge("connected");
    updateSessionIndicator("connected", "Connected");
    updateUserIdentityUI(verified.userName, verified.userAvatarUrl);
    updateInlineNoticeCards(true);
    setDisconnectedViewState(false);

    const studentDisplay = document.getElementById("studentNameDisplay");
    if (studentDisplay) studentDisplay.textContent = verified.userName;

    const sesskeyEl = document.getElementById("sesskeyDisplay");
    if (sesskeyEl) sesskeyEl.textContent = `${verified.sesskey.substring(0, 5)}••••••`;

    showToast("Session Auto-Detected Successfully!", "success");

    // Connect scraped data directly to frontend UI
    if ((verified.rawCalendarEvents && verified.rawCalendarEvents.length > 0) || (verified.events && verified.events.length > 0)) {
      hydrateDeadlinesFromScrape(verified.events, verified.rawCalendarEvents);
    } else {
      await loadLiveDeadlines();
    }

    if ((verified.rawCourses && verified.rawCourses.length > 0) || (verified.courses && verified.courses.length > 0)) {
      await hydrateCoursesFromScrape(verified.courses, verified.rawCourses);
    } else {
      await loadLiveEnrolledCourses();
    }

    // Load announcements
    await loadLiveAnnouncements();
  } catch (err) {
    console.warn("[Spectra] Auto-detect session failed:", err);
    state.isAuthenticated = false;
    state.sesskey = null;

    const msg = err.message || "";
    if (msg.includes("No MoodleSession cookie found")) {
      updateAuthStatusBadge("unset");
      showToast("No active SPeCTRUM cookie in browser. Please sign in or paste cookie manually.", "error");
    } else {
      updateAuthStatusBadge("invalid");
      showToast("Invalid Cookie, please re-check DevTools", "error");
    }
  } finally {
    autoBtn.disabled = false;
    autoBtn.innerHTML = origHtml;
  }
}

/**
 * Live Session Discovery & Lightweight Verification Ping on Load
 */
async function syncLiveSession() {
  updateSessionIndicator("loading", "Connecting...");

  // 1. Check chrome.storage.local for manualMoodleSession and cached scraped data
  let manualToken = "";
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get([
        "manualMoodleSession",
        "manual_moodle_session",
        "cached_deadlines",
        "cached_courses",
        "cached_raw_events",
        "cached_raw_courses",
        "verifiedSesskey",
        "userName"
      ]);
      manualToken = (stored.manualMoodleSession || stored.manual_moodle_session || "").trim();

      // If we have cached scraped data, pre-hydrate the UI immediately for instant responsiveness!
      if (stored.userName) {
        state.userName = stored.userName;
        updateUserIdentityUI(stored.userName, "");
        const studentDisplay = document.getElementById("studentNameDisplay");
        if (studentDisplay) studentDisplay.textContent = stored.userName;
      }
      if (stored.verifiedSesskey) {
        state.sesskey = stored.verifiedSesskey;
        const sesskeyEl = document.getElementById("sesskeyDisplay");
        if (sesskeyEl) sesskeyEl.textContent = `${stored.verifiedSesskey.substring(0, 5)}••••••`;
      }
      if ((stored.cached_raw_events && stored.cached_raw_events.length > 0) || (stored.cached_deadlines && stored.cached_deadlines.length > 0)) {
        hydrateDeadlinesFromScrape(stored.cached_deadlines, stored.cached_raw_events);
      }
      if ((stored.cached_raw_courses && stored.cached_raw_courses.length > 0) || (stored.cached_courses && stored.cached_courses.length > 0)) {
        hydrateCoursesFromScrape(stored.cached_courses, stored.cached_raw_courses);
      }
    } catch (e) {}
  }

  // Populate input field if present in storage
  const inputEl = document.getElementById("moodle-session-input");
  if (inputEl && manualToken) {
    inputEl.value = manualToken;
  }

  // Update diagnostic box
  const diagSession = document.getElementById("diagSessionStatus");
  const storedCookie = manualToken || (await getStoredMoodleCookie());
  if (diagSession) {
    if (storedCookie) {
      diagSession.textContent = `Cookie Found (${storedCookie.substring(0, 5)}•••••)`;
      diagSession.className = "diag-val diag-ok";
    } else {
      diagSession.textContent = "No SPeCTRUM cookie configured";
      diagSession.className = "diag-val diag-warn";
    }
  }

  try {
    let sessionContext;
    if (manualToken) {
      // Use the injected scraper backend with the manual token!
      sessionContext = await injectAndScrapeSpectrum(manualToken);
    } else {
      sessionContext = await getSessionContext();
    }

    state.isAuthenticated = true;
    state.isDemoMode = false;
    state.sesskey = sessionContext.sesskey;
    state.userName = sessionContext.userName;
    state.userAvatarUrl = sessionContext.userAvatarUrl || "";

    // Update UI Elements
    updateAuthStatusBadge("connected");
    updateSessionIndicator("connected", "Connected");
    updateUserIdentityUI(sessionContext.userName, sessionContext.userAvatarUrl);
    updateInlineNoticeCards(true);
    setDisconnectedViewState(false);

    // Update Settings displays
    const studentDisplay = document.getElementById("studentNameDisplay");
    if (studentDisplay) studentDisplay.textContent = sessionContext.userName;

    const sesskeyEl = document.getElementById("sesskeyDisplay");
    if (sesskeyEl) sesskeyEl.textContent = `${sessionContext.sesskey.substring(0, 5)}••••••`;

    // Connect scraped data directly to frontend UI
    if ((sessionContext.rawCalendarEvents && sessionContext.rawCalendarEvents.length > 0) || (sessionContext.events && sessionContext.events.length > 0)) {
      hydrateDeadlinesFromScrape(sessionContext.events, sessionContext.rawCalendarEvents);
    } else {
      await loadLiveDeadlines();
    }

    if ((sessionContext.rawCourses && sessionContext.rawCourses.length > 0) || (sessionContext.courses && sessionContext.courses.length > 0)) {
      await hydrateCoursesFromScrape(sessionContext.courses, sessionContext.rawCourses);
    } else {
      await loadLiveEnrolledCourses();
    }

    // Load announcements
    await loadLiveAnnouncements();

  } catch (err) {
    console.warn("[Spectra] Live session authentication check:", err);
    state.isAuthenticated = false;
    state.sesskey = null;

    if (!state.isDemoMode) {
      const isUnset = err instanceof AuthRequiredError || err.name === "AUTH_REQUIRED" || !storedCookie;
      updateAuthStatusBadge(isUnset ? "unset" : "invalid");
      updateSessionIndicator("disconnected", isUnset ? "Unset" : "Session Expired");
      updateUserIdentityUI(isUnset ? "SPeCTRUM Unconnected" : "Session Expired", "");
      updateInlineNoticeCards(false);
      setDisconnectedViewState(false);
      renderUnauthenticatedStates(isUnset);
    }
  }
}

function updateSessionIndicator(status, label) {
  const sessionPill = document.getElementById("sessionPill");
  const sessionStatusText = document.getElementById("sessionStatusText");
  const cookieStatusLabel = document.getElementById("cookieStatusLabel");

  if (!sessionPill || !sessionStatusText) return;
  sessionPill.className = "session-pill";

  if (status === "connected") {
    sessionPill.classList.add("session-active");
    sessionStatusText.textContent = label;
    if (cookieStatusLabel) {
      cookieStatusLabel.textContent = "Live Moodle Active";
      cookieStatusLabel.className = "status-indicator-badge status-connected";
    }
  } else if (status === "loading") {
    sessionPill.classList.add("session-loading");
    sessionStatusText.textContent = label;
    if (cookieStatusLabel) {
      cookieStatusLabel.textContent = "Detecting...";
      cookieStatusLabel.className = "status-indicator-badge";
    }
  } else {
    sessionPill.classList.add("session-offline");
    sessionStatusText.textContent = label;
    if (cookieStatusLabel) {
      cookieStatusLabel.textContent = "Unauthenticated";
      cookieStatusLabel.className = "status-indicator-badge status-disconnected";
    }
  }
}

function updateUserIdentityUI(userName, avatarUrl) {
  const nameEl = document.getElementById("userName");
  const avatarEl = document.getElementById("userAvatar");

  if (nameEl) nameEl.textContent = userName;

  if (avatarEl) {
    if (avatarUrl) {
      avatarEl.src = avatarUrl;
      avatarEl.classList.remove("hidden");
    } else {
      avatarEl.classList.add("hidden");
    }
  }
}

function setDisconnectedViewState(isDisconnected) {
  const disconnectedView = document.getElementById("sessionDisconnectedView");
  const mainContent = document.getElementById("mainContentContainer");

  if (!disconnectedView || !mainContent) return;

  // Always keep main content container visible so tabs and Settings are accessible
  mainContent.classList.remove("hidden");
  disconnectedView.classList.add("hidden");
}

// ===================================================================
// TAB 1: LIVE DEADLINES RADAR
// ===================================================================
async function loadLiveDeadlines() {
  const loadingEl = document.getElementById("deadlinesLoading");
  const listEl = document.getElementById("deadlinesList");
  const emptyEl = document.getElementById("deadlinesEmptyState");

  if (loadingEl) loadingEl.classList.remove("hidden");
  if (listEl) listEl.innerHTML = "";
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    const liveEvents = await fetchLiveDeadlines(state.sesskey);
    state.deadlines = liveEvents;

    state.deadlines.sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
      return a.dueTimestamp - b.dueTimestamp;
    });

    updateUrgentCountBadge();
    renderDeadlines();
  } catch (err) {
    console.error("[Spectra] Failed loading live deadlines:", err);
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION" || err.message?.includes("SESSION_EXPIRED")) {
      updateAuthStatusBadge("invalid");
      updateSessionIndicator("disconnected", "Session Expired");
      updateInlineNoticeCards(false);
      renderUnauthenticatedStates(false);
      showToast("Session Expired. Please update your MoodleSession cookie in Settings.", "error");
    } else {
      showToast(`Error querying calendar: ${err.message}`, "error");
    }
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
  }
}

function updateUrgentCountBadge() {
  const urgentCount = state.deadlines.filter((d) => !d.isCompleted && d.urgency === "urgent").length;
  const urgentBadge = document.getElementById("urgentBadge");
  const urgentBanner = document.getElementById("urgentDeadlineBanner");
  const urgentBannerDetail = document.getElementById("urgentBannerDetail");

  if (urgentCount > 0) {
    if (urgentBadge) {
      urgentBadge.textContent = String(urgentCount);
      urgentBadge.classList.remove("hidden");
    }
    if (urgentBanner) {
      urgentBanner.classList.remove("hidden");
      urgentBannerDetail.textContent = `You have ${urgentCount} impending submission${urgentCount === 1 ? "" : "s"} due in less than 24 hours.`;
    }
  } else {
    if (urgentBadge) urgentBadge.classList.add("hidden");
    if (urgentBanner) urgentBanner.classList.add("hidden");
  }

  // Update filter pill counters
  const total = state.deadlines.length;
  const countUrgent = state.deadlines.filter((d) => !d.isCompleted && d.urgency === "urgent").length;
  const countWeek = state.deadlines.filter((d) => !d.isCompleted && d.urgency === "this_week").length;
  const countLater = state.deadlines.filter((d) => !d.isCompleted && d.urgency === "upcoming").length;
  const countDone = state.deadlines.filter((d) => d.isCompleted).length;

  document.getElementById("countAll").textContent = total;
  document.getElementById("countUrgent").textContent = countUrgent;
  document.getElementById("countWeek").textContent = countWeek;
  document.getElementById("countLater").textContent = countLater;
  document.getElementById("countDone").textContent = countDone;
}

function renderDeadlines() {
  const container = document.getElementById("deadlinesList");
  const emptyState = document.getElementById("deadlinesEmptyState");
  if (!container) return;
  container.innerHTML = "";

  const filtered = state.deadlines.filter((item) => {
    if (state.searchQuery) {
      const matchTitle = item.title.toLowerCase().includes(state.searchQuery);
      const matchCourse = item.courseCode.toLowerCase().includes(state.searchQuery);
      if (!matchTitle && !matchCourse) return false;
    }

    if (state.activeFilter === "urgent") return !item.isCompleted && item.urgency === "urgent";
    if (state.activeFilter === "this_week") return !item.isCompleted && item.urgency === "this_week";
    if (state.activeFilter === "upcoming") return !item.isCompleted && item.urgency === "upcoming";
    if (state.activeFilter === "completed") return item.isCompleted;

    return true;
  });

  if (filtered.length === 0) {
    if (emptyState) {
      emptyState.classList.remove("hidden");
      const emptyMsg = document.getElementById("emptyStateMessage");
      if (state.deadlines.length === 0) {
        emptyMsg.textContent = "No upcoming assignments or submission dropboxes found on SPeCTRUM.";
      } else {
        emptyMsg.textContent = "No deadlines matching this filter criteria.";
      }
    }
    return;
  }
  if (emptyState) emptyState.classList.add("hidden");

  filtered.forEach((item) => {
    const card = document.createElement("div");
    card.className = `deadline-card tier-${item.urgency} ${item.isCompleted ? "is-completed" : ""}`;
    card.id = `card_${item.id}`;

    let badgeHtml = "";
    if (item.urgency === "urgent") {
      badgeHtml = `<span class="urgency-badge badge-urgent"><span class="pulse-ring" style="width:10px;height:10px;position:static;"></span> &lt; 24h</span>`;
    } else if (item.urgency === "this_week") {
      badgeHtml = `<span class="urgency-badge badge-week">This Week</span>`;
    } else {
      badgeHtml = `<span class="urgency-badge badge-upcoming">Upcoming</span>`;
    }

    const timeRemainingStr = formatTimeRemaining(item.dueTimestamp);
    const isTgSent = state.telegramSentDeadlineIds.has(String(item.id)) || item.telegramSent;
    const tgSentBadge = isTgSent ? `<span class="telegram-sent-tag" title="Alert flagged as sent to Telegram">✈️ Telegram Sent</span>` : "";

    card.innerHTML = `
      <div class="deadline-card-header">
        <div class="course-badge-row">
          <span class="course-tag">${escapeHtml(item.courseCode)}</span>
          ${item.weight ? `<span class="weight-tag">${escapeHtml(item.weight)}</span>` : ""}
          ${tgSentBadge}
        </div>
        ${badgeHtml}
      </div>

      <div class="assignment-title">${escapeHtml(item.title)}</div>

      <div class="deadline-card-footer">
        <div class="deadline-time-info">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor" style="opacity:0.6;">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/>
          </svg>
          <span class="${item.urgency === "urgent" && !item.isCompleted ? "countdown-text" : ""}" data-timestamp="${item.dueTimestamp}">
            ${escapeHtml(timeRemainingStr)}
          </span>
        </div>

        <div class="card-actions">
          <a href="${escapeHtml(item.url)}" target="_blank" class="link-launch-btn" title="Open in SPeCTRUM">
            <span>Dropbox</span>
            <svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor">
              <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/>
              <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/>
            </svg>
          </a>

          <label class="custom-checkbox-wrap" title="Mark as submitted/completed">
            <input type="checkbox" class="deadline-checkbox" data-id="${escapeHtml(item.id)}" ${item.isCompleted ? "checked" : ""}>
            <span class="checkbox-visual"></span>
          </label>
        </div>
      </div>
    `;

    const checkbox = card.querySelector(".deadline-checkbox");
    checkbox.addEventListener("change", async (e) => {
      const isChecked = e.target.checked;
      const targetId = e.target.dataset.id;
      if (isChecked) {
        state.completedIds.add(targetId);
      } else {
        state.completedIds.delete(targetId);
      }

      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          completed_assignment_ids: Array.from(state.completedIds)
        });
      }

      const found = state.deadlines.find((d) => d.id === targetId);
      if (found) found.isCompleted = isChecked;

      updateUrgentCountBadge();
      renderDeadlines();
      showToast(isChecked ? "Marked as completed!" : "Marked as pending", "info");
    });

    container.appendChild(card);
  });
}

function startLiveCountdowns() {
  if (state.countdownIntervalId) clearInterval(state.countdownIntervalId);

  state.countdownIntervalId = setInterval(() => {
    document.querySelectorAll(".countdown-text").forEach((el) => {
      const ts = parseInt(el.dataset.timestamp, 10);
      if (!isNaN(ts)) {
        el.textContent = formatTimeRemaining(ts);
      }
    });
  }, 30000);
}

// ===================================================================
// TAB 2: LIVE COURSE ANNOUNCEMENTS
// ===================================================================

/**
 * Loads live forum announcements for all enrolled courses
 */
async function loadLiveAnnouncements() {
  const loadingEl = document.getElementById("announcementsLoading");
  const listEl = document.getElementById("announcementsList");
  const emptyEl = document.getElementById("announcementsEmptyState");

  if (loadingEl) loadingEl.classList.remove("hidden");
  if (listEl) listEl.innerHTML = "";
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    let announcements = [];

    // 1. Check if cached_announcements exists in storage
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(["cached_announcements", "telegram_sent_announcement_ids"]);
      if (Array.isArray(stored.telegram_sent_announcement_ids)) {
        state.telegramSentAnnouncementIds = new Set(stored.telegram_sent_announcement_ids.map(String));
      }
      if (Array.isArray(stored.cached_announcements) && stored.cached_announcements.length > 0) {
        announcements = stored.cached_announcements;
      }
    }

    // 2. If no cached announcements or on demand, fetch live
    if (announcements.length === 0) {
      if (state.courses && state.courses.length > 0) {
        announcements = await fetchLiveAnnouncements(state.courses, state.sesskey);
      } else {
        const courses = await getLiveEnrolledCourses(state.sesskey);
        state.courses = courses;
        announcements = await fetchLiveAnnouncements(courses, state.sesskey);
      }

      announcements = announcements.map((a) => ({
        ...a,
        telegramSent: state.telegramSentAnnouncementIds.has(String(a.id))
      }));

      if (typeof chrome !== "undefined" && chrome.storage?.local && announcements.length > 0) {
        await chrome.storage.local.set({ cached_announcements: announcements });
      }
    }

    state.announcements = announcements;
    populateAnnouncementSubjectDropdown();
    renderAnnouncements();
  } catch (err) {
    console.error("[Spectra] Error loading live announcements:", err);
    if (listEl) listEl.innerHTML = "";
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      const emptyMsg = document.getElementById("emptyAnnouncementsMsg");
      if (emptyMsg) emptyMsg.textContent = "Could not fetch announcements from SPeCTRUM forums.";
    }
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
  }
}

/**
 * Populate the course subject dropdown for filtering announcements
 */
function populateAnnouncementSubjectDropdown() {
  const select = document.getElementById("announcementSubjectSelect");
  if (!select) return;

  const currentVal = state.selectedAnnouncementSubject || "all";
  select.innerHTML = `<option value="all">📚 All Enrolled Subjects</option>`;

  const courseMap = new Map();
  if (Array.isArray(state.courses)) {
    state.courses.forEach((c) => {
      const code = c.code || c.shortname;
      if (code && !courseMap.has(code)) {
        courseMap.set(code, c.name || code);
      }
    });
  }

  if (Array.isArray(state.announcements)) {
    state.announcements.forEach((a) => {
      if (a.courseCode && !courseMap.has(a.courseCode)) {
        courseMap.set(a.courseCode, a.courseCode);
      }
    });
  }

  courseMap.forEach((name, code) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `🎓 ${code} - ${name}`;
    if (code === currentVal) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  const hintEl = document.getElementById("announcementSubjectHint");
  if (hintEl) {
    hintEl.textContent = currentVal === "all" ? `${courseMap.size} Courses` : currentVal;
  }
}

/**
 * Render filtered course announcements list
 */
function renderAnnouncements() {
  const container = document.getElementById("announcementsList");
  const emptyState = document.getElementById("announcementsEmptyState");
  const countBadge = document.getElementById("announcementsTotalCountBadge");
  const navBadge = document.getElementById("announcementsBadge");
  const hintEl = document.getElementById("announcementSubjectHint");

  if (!container) return;
  container.innerHTML = "";

  const selectedSubject = state.selectedAnnouncementSubject || "all";
  if (hintEl) {
    hintEl.textContent = selectedSubject === "all" ? "All Subjects" : selectedSubject;
  }

  const filtered = state.announcements.filter((item) => {
    if (selectedSubject === "all") return true;
    return item.courseCode === selectedSubject;
  });

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Notice${filtered.length === 1 ? "" : "s"}`;
  }
  if (navBadge) {
    if (state.announcements.length > 0) {
      navBadge.textContent = String(state.announcements.length);
      navBadge.classList.remove("hidden");
    } else {
      navBadge.classList.add("hidden");
    }
  }

  if (filtered.length === 0) {
    if (emptyState) {
      emptyState.classList.remove("hidden");
      const emptyMsg = document.getElementById("emptyAnnouncementsMsg");
      if (emptyMsg) {
        emptyMsg.textContent = selectedSubject === "all"
          ? "No forum announcements found on SPeCTRUM for your courses."
          : `No forum announcements found for ${selectedSubject}.`;
      }
    }
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");

  filtered.forEach((item) => {
    const card = document.createElement("article");
    card.className = "announcement-card";

    const isTgSent = state.telegramSentAnnouncementIds.has(String(item.id)) || item.telegramSent;
    const tgSentBadge = isTgSent ? `<span class="telegram-sent-tag" title="Notice flagged as sent to Telegram">✈️ Telegram Sent</span>` : "";

    card.innerHTML = `
      <div class="announcement-card-header">
        <div class="flex-align-center" style="gap: 6px;">
          <span class="announcement-course-pill">${item.courseCode || "UM"}</span>
          ${tgSentBadge}
        </div>
        <span class="announcement-date-text">🕒 ${item.date || "Recent"}</span>
      </div>
      <h4 class="announcement-subject-title">${item.subject}</h4>
      <div class="announcement-footer">
        <span class="announcement-author-info">👤 ${item.author || "Course Instructor"}</span>
        <a href="${item.url || 'https://spectrum.um.edu.my/'}" target="_blank" rel="noopener noreferrer" class="announcement-link-btn">
          Open Notice &rarr;
        </a>
      </div>
    `;

    container.appendChild(card);
  });
}

// ===================================================================
// TAB 3: LIVE ATTENDANCE TRACKER & AUTO-CHECKIN
// ===================================================================

/**
 * Loads live attendance records for all enrolled courses
 */
async function loadLiveAttendanceData(force = false) {
  const loadingEl = document.getElementById("attendanceLoading");
  const listEl = document.getElementById("attendanceSessionsList");
  const emptyEl = document.getElementById("attendanceEmptyState");

  if (loadingEl) loadingEl.classList.remove("hidden");
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    let attendanceData = null;

    // 1. Check cached_attendance if not forcing refresh
    if (!force && typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(["cached_attendance"]);
      if (stored.cached_attendance && stored.cached_attendance.courses?.length > 0) {
        attendanceData = stored.cached_attendance;
      }
    }

    // 2. Fetch live if not in cache or forced
    if (!attendanceData) {
      if (!state.courses || state.courses.length === 0) {
        state.courses = await getLiveEnrolledCourses(state.sesskey);
      }

      attendanceData = await fetchLiveAllAttendance(state.courses, state.sesskey, state.courseOccurrences);

      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ cached_attendance: attendanceData });
      }
    }

    state.attendance = attendanceData;
    populateAttendanceCourseDropdowns();
    renderAttendanceSummaryMetrics();
    renderActiveOccurrenceBadges();
    renderOpenAttendanceBanner();
    renderAttendanceRecords();

  } catch (err) {
    console.error("[Spectra] Error loading live attendance:", err);
    if (listEl) listEl.innerHTML = "";
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      const emptyMsg = document.getElementById("emptyAttendanceMsg");
      if (emptyMsg) emptyMsg.textContent = "Could not fetch attendance from SPeCTRUM.";
    }
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
  }
}

/**
 * Populates occurrence course select & attendance view filter select
 */
function populateAttendanceCourseDropdowns() {
  const occSelect = document.getElementById("occurrenceCourseSelect");
  const viewSelect = document.getElementById("attendanceSubjectSelect");

  if (occSelect && Array.isArray(state.courses)) {
    const prevVal = occSelect.value;
    occSelect.innerHTML = `<option value="">-- Choose Course to Set Occurrence --</option>`;
    state.courses.forEach((c) => {
      const code = c.code || c.shortname;
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `🎓 ${code} - ${c.name}`;
      if (c.id === prevVal) opt.selected = true;
      occSelect.appendChild(opt);
    });

    if (!occSelect.value && state.courses.length > 0) {
      occSelect.value = state.courses[0].id;
    }
    updateOccurrenceInputField();
  }

  if (viewSelect) {
    const prevSubject = state.selectedAttendanceSubject || "all";
    viewSelect.innerHTML = `<option value="all">📚 All Enrolled Subjects</option>`;

    if (Array.isArray(state.courses)) {
      state.courses.forEach((c) => {
        const code = c.code || c.shortname;
        const occ = state.courseOccurrences[c.id] || state.courseOccurrences[code] || "";
        const occTag = occ ? ` (${occ})` : " (Occ not set)";
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `🎓 ${code}${occTag} - ${c.name}`;
        if (c.id === prevSubject) opt.selected = true;
        viewSelect.appendChild(opt);
      });
    }
  }
}

/**
 * Update occurrence input and hint label based on selected course
 */
function updateOccurrenceInputField() {
  const occSelect = document.getElementById("occurrenceCourseSelect");
  const occInput = document.getElementById("occurrenceInput");
  const occLabel = document.getElementById("currentCourseOccLabel");
  if (!occSelect || !occInput) return;

  const courseId = occSelect.value;
  const course = state.courses.find((c) => String(c.id) === String(courseId));
  const code = course?.code || "";
  const existingOcc = state.courseOccurrences[courseId] || state.courseOccurrences[code] || "";

  occInput.value = existingOcc;
  if (occLabel) {
    occLabel.textContent = existingOcc ? `Current: ${existingOcc}` : "Not Set";
  }
}

/**
 * Render chips for configured course occurrences
 */
function renderActiveOccurrenceBadges() {
  const container = document.getElementById("activeOccurrencesList");
  if (!container) return;
  container.innerHTML = "";

  if (!Array.isArray(state.courses) || state.courses.length === 0) {
    container.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">No enrolled courses detected.</span>`;
    return;
  }

  state.courses.forEach((c) => {
    const code = c.code || c.shortname;
    const occ = state.courseOccurrences[c.id] || state.courseOccurrences[code];

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `occ-chip ${occ ? "occ-set" : ""}`;
    chip.innerHTML = `
      <span class="occ-chip-code">${code}</span>
      <span>${occ ? `🏷️ ${occ}` : "⚠️ Set Occ"}</span>
    `;

    chip.addEventListener("click", () => {
      const occSelect = document.getElementById("occurrenceCourseSelect");
      if (occSelect) {
        occSelect.value = c.id;
        updateOccurrenceInputField();
        const occInput = document.getElementById("occurrenceInput");
        if (occInput) occInput.focus();
      }
    });

    container.appendChild(chip);
  });
}

/**
 * Render overall attendance metrics grid & rate badge
 */
function renderAttendanceSummaryMetrics() {
  const rateBadge = document.getElementById("attendanceOverallRateBadge");
  const overallRateEl = document.getElementById("attendanceOverallRate");
  const presentEl = document.getElementById("attendancePresentCount");
  const lateEl = document.getElementById("attendanceLateCount");
  const absentEl = document.getElementById("attendanceAbsentCount");
  const navBadge = document.getElementById("attendanceBadge");

  const summary = state.attendance?.summary || {
    overallPercentage: "100.0%",
    totalPresent: 0,
    totalLate: 0,
    totalAbsent: 0,
    openSessionsCount: 0
  };

  const pct = summary.overallPercentage || "100.0%";
  if (rateBadge) rateBadge.textContent = `${pct} Rate`;
  if (overallRateEl) overallRateEl.textContent = pct;
  if (presentEl) presentEl.textContent = summary.totalPresent ?? 0;
  if (lateEl) lateEl.textContent = summary.totalLate ?? 0;
  if (absentEl) absentEl.textContent = summary.totalAbsent ?? 0;

  if (navBadge) {
    if (summary.openSessionsCount > 0) {
      navBadge.textContent = "OPEN";
      navBadge.classList.remove("hidden");
    } else {
      navBadge.classList.add("hidden");
    }
  }
}

/**
 * Render open attendance check-in banner if a session is currently active
 */
function renderOpenAttendanceBanner() {
  const banner = document.getElementById("openAttendanceBanner");
  if (!banner) return;

  const openList = state.attendance?.openSessions || [];
  if (openList.length === 0) {
    banner.classList.add("hidden");
    return;
  }

  const firstOpen = openList[0];
  const courseCodeEl = document.getElementById("openAttendanceCourseCode");
  const timeBadge = document.getElementById("openAttendanceTimeBadge");
  const titleEl = document.getElementById("openAttendanceTitle");
  const descEl = document.getElementById("openAttendanceDesc");
  const openLink = document.getElementById("openAttendancePageLink");

  if (courseCodeEl) courseCodeEl.textContent = firstOpen.courseCode || "UM Course";
  if (timeBadge) timeBadge.textContent = firstOpen.session?.time || "OPEN NOW";
  if (titleEl) titleEl.textContent = firstOpen.session?.description || "Lecture Session Check-In Open";
  if (descEl) {
    descEl.textContent = `Occurrence: ${firstOpen.occurrence || "All"} • Self-recording is currently active on SPeCTRUM.`;
  }

  const targetUrl = firstOpen.session?.submitUrl || firstOpen.viewUrl || (firstOpen.cmid ? `https://spectrum.um.edu.my/mod/attendance/view.php?id=${firstOpen.cmid}` : "https://spectrum.um.edu.my/mod/attendance/view.php");
  if (openLink) {
    openLink.href = targetUrl;
    openLink.dataset.url = targetUrl;
  }

  banner.classList.remove("hidden");
}

/**
 * Render filtered attendance session history records
 */
function renderAttendanceRecords() {
  const container = document.getElementById("attendanceSessionsList");
  const emptyState = document.getElementById("attendanceEmptyState");
  const countBadge = document.getElementById("attendanceSessionsCountBadge");
  const statsBar = document.getElementById("subjectAttendanceStatsBar");
  const occBadge = document.getElementById("selectedSubjectOccBadge");
  const openCourseAttBtn = document.getElementById("openCourseAttendancePageBtn");

  if (!container) return;
  container.innerHTML = "";

  const selected = state.selectedAttendanceSubject || "all";
  let targetCourses = state.attendance?.courses || [];

  if (selected !== "all") {
    targetCourses = targetCourses.filter((c) => String(c.courseId) === String(selected));
  }

  // Update Occurrence badge & Open Attendance Page button
  if (occBadge) {
    if (selected === "all") {
      occBadge.textContent = "All Enrolled Subjects";
    } else {
      const c = state.courses.find((x) => String(x.id) === String(selected));
      const code = c?.code || "";
      const occ = state.courseOccurrences[selected] || state.courseOccurrences[code];
      occBadge.textContent = occ ? `Occurrence: ${occ}` : "Occ not set";
    }
  }

  if (openCourseAttBtn) {
    if (selected !== "all" && targetCourses.length > 0) {
      const targetC = targetCourses[0];
      const courseViewUrl = targetC.viewUrl || (targetC.cmid ? `https://spectrum.um.edu.my/mod/attendance/view.php?id=${targetC.cmid}` : `https://spectrum.um.edu.my/course/view.php?id=${targetC.courseId}`);
      openCourseAttBtn.href = courseViewUrl;
      openCourseAttBtn.dataset.url = courseViewUrl;
      openCourseAttBtn.textContent = `Open ${targetC.courseCode} Attendance ↗`;
    } else {
      const firstCourseWithUrl = targetCourses.find((c) => c.viewUrl);
      const defaultUrl = firstCourseWithUrl?.viewUrl || "https://spectrum.um.edu.my/my/";
      openCourseAttBtn.href = defaultUrl;
      openCourseAttBtn.dataset.url = defaultUrl;
      openCourseAttBtn.textContent = "Open Attendance Page ↗";
    }
  }

  // Handle selected subject stats bar
  if (selected !== "all" && targetCourses.length > 0) {
    const courseRecord = targetCourses[0];
    if (statsBar) {
      statsBar.classList.remove("hidden");
      const nameEl = document.getElementById("subjectStatsCourseName");
      const rateEl = document.getElementById("subjectStatsRate");
      const barFill = document.getElementById("subjectStatsProgressBar");
      const detailEl = document.getElementById("subjectStatsDetail");
      const ptsEl = document.getElementById("subjectStatsPoints");

      const pctStr = courseRecord.summary?.percentage || "100.0%";
      const numPct = parseFloat(pctStr) || 100;

      if (nameEl) nameEl.textContent = courseRecord.courseCode || "Course";
      if (rateEl) rateEl.textContent = pctStr;
      if (barFill) barFill.style.width = `${Math.min(100, Math.max(0, numPct))}%`;
      if (detailEl) detailEl.textContent = `${courseRecord.summary?.takenSessions || 0} Sessions Recorded`;
      if (ptsEl) ptsEl.textContent = `${courseRecord.summary?.points || "0 / 0"} pts`;
    }
  } else {
    if (statsBar) statsBar.classList.add("hidden");
  }

  // Flatten sessions with courseViewUrl (STRICT: only show attendance according to occurrence for each subject)
  const allSessions = [];
  targetCourses.forEach((c) => {
    const configuredOcc = state.courseOccurrences[c.courseId] || state.courseOccurrences[c.courseCode] || c.occurrence || "";
    const hasConfiguredOcc = Boolean(configuredOcc && configuredOcc.trim().toLowerCase() !== "all");
    const cViewUrl = c.viewUrl || (c.cmid ? `https://spectrum.um.edu.my/mod/attendance/view.php?id=${c.cmid}` : `https://spectrum.um.edu.my/course/view.php?id=${c.courseId}`);
    (c.sessions || []).forEach((s) => {
      // STRICT REQUIREMENT: Only show attendance according to occurrence for each subject
      if (hasConfiguredOcc && !isRespectiveOccurrence(s.group, configuredOcc, s.description)) {
        return;
      }
      if (s.isPastOrCurrent !== false && isAttendanceSessionPastOrCurrent(s.date, s.time, s.status)) {
        allSessions.push({
          ...s,
          courseCode: c.courseCode,
          courseId: c.courseId,
          courseViewUrl: cViewUrl
        });
      }
    });
  });

  if (countBadge) {
    countBadge.textContent = `${allSessions.length} Session${allSessions.length === 1 ? "" : "s"}`;
  }

  if (allSessions.length === 0) {
    if (emptyState) emptyState.classList.remove("hidden");
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");

  allSessions.forEach((s) => {
    const card = document.createElement("div");
    card.className = `attendance-session-card ${s.status === "open" ? "session-open" : ""}`;

    let badgeClass = "badge-unrecorded";
    let statusText = s.statusLabel || "Unrecorded";

    if (s.status === "present") badgeClass = "badge-present";
    else if (s.status === "late") badgeClass = "badge-late";
    else if (s.status === "absent") badgeClass = "badge-absent";
    else if (s.status === "excused") badgeClass = "badge-excused";
    else if (s.status === "open") badgeClass = "badge-open";

    card.innerHTML = `
      <div class="attendance-session-header">
        <div class="flex-align-center" style="gap: 5px;">
          <span class="announcement-course-pill">${s.courseCode}</span>
          <span class="session-group-pill">${s.group || "All students"}</span>
        </div>
        <span class="session-date-time">${s.date} ${s.time ? `• ${s.time}` : ""}</span>
      </div>
      <div class="attendance-session-desc">${s.description || "Class Session"}</div>
      <div class="attendance-session-footer">
        <span class="session-status-badge ${badgeClass}">${statusText}</span>
        <div class="flex-align-center" style="gap: 6px;">
          ${s.points ? `<span class="session-points-text">${s.points}</span>` : ""}
          ${s.status === "open" && s.submitUrl ? `
            <a href="${s.submitUrl}" data-url="${s.submitUrl}" class="btn-primary-action btn-xs" style="text-decoration: none; padding: 3px 8px;">
              Check In ↗
            </a>
          ` : ""}
          <a href="${s.courseViewUrl}" data-url="${s.courseViewUrl}" class="btn-secondary-action btn-xs" style="text-decoration: none; padding: 3px 8px;" title="Open attendance page on SPeCTRUM">
            Open Page ↗
          </a>
        </div>
      </div>
    `;

    container.appendChild(card);
  });
}

/**
 * Save user occurrence for selected course
 */
async function handleSaveCourseOccurrence() {
  const occSelect = document.getElementById("occurrenceCourseSelect");
  const occInput = document.getElementById("occurrenceInput");
  const btn = document.getElementById("saveOccurrenceBtn");

  if (!occSelect || !occInput) return;

  const courseId = occSelect.value;
  const occurrence = occInput.value.trim();

  if (!courseId) {
    showToast("Please choose a course first", "error");
    return;
  }

  const course = state.courses.find((c) => String(c.id) === String(courseId));
  const courseCode = course?.code || courseId;

  btn.disabled = true;
  btn.textContent = "Saving...";

  state.courseOccurrences[courseId] = occurrence;
  if (courseCode) state.courseOccurrences[courseCode] = occurrence;

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ course_occurrences: state.courseOccurrences });
  }

  btn.disabled = false;
  btn.textContent = "Save Occurrence";

  showToast(`Saved ${courseCode} Occurrence: ${occurrence || "All"}!`, "success");
  updateOccurrenceInputField();
  renderActiveOccurrenceBadges();
  populateAttendanceCourseDropdowns();

  // Reload live attendance with new occurrence applied
  await loadLiveAttendanceData(true);
}

/**
 * Handle instant scan & auto-checkin
 */
async function handleScanAttendanceNow() {
  const btn = document.getElementById("scanAttendanceBtn");
  if (!btn) return;

  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Scanning SPeCTRUM...</span>`;

  try {
    const scanRes = await scanAndAutoRecordAttendance({
      courses: state.courses,
      sesskey: state.sesskey,
      occurrencesMap: state.courseOccurrences,
      autoSubmit: true
    });

    state.attendance = scanRes.attendance;
    renderAttendanceSummaryMetrics();
    renderOpenAttendanceBanner();
    renderAttendanceRecords();

    const recordedCount = (scanRes.actions || []).filter((a) => a.result?.success).length;
    if (recordedCount > 0) {
      showToast(`Auto-Attendance: Marked Present for ${recordedCount} session(s)!`, "success");
    } else {
      showToast("Scan finished: All records up to date.", "info");
    }
  } catch (err) {
    console.error("[Spectra] Manual scan error:", err);
    showToast(`Scan error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
}

/**
 * Submit open attendance check-in
 */
async function handleSubmitOpenAttendance() {
  const btn = document.getElementById("submitOpenAttendanceBtn");
  const pwdInput = document.getElementById("openAttendancePasswordInput");
  const openList = state.attendance?.openSessions || [];

  if (openList.length === 0) {
    showToast("No active open session detected.", "error");
    return;
  }
  const firstOpen = openList[0];
  const session = firstOpen.session;
  const occ = firstOpen.occurrence || state.courseOccurrences[firstOpen.courseId] || state.courseOccurrences[firstOpen.courseCode] || "";

  // STRICT REQUIREMENT: Only fill attendance for respective occ AND when open
  const isOpen = session && session.status === "open" && Boolean(session.submitUrl);
  const matchesOcc = session && isRespectiveOccurrence(session.group, occ);

  if (!isOpen) {
    showToast("This session is not currently open for check-in on SPeCTRUM.", "error");
    return;
  }

  if (!matchesOcc) {
    showToast(`Session is for "${session.group || "Specific Group"}", which does not match your configured occurrence ("${occ || "Not configured"}").`, "error");
    return;
  }

  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Submitting check-in...";

  try {
    const password = pwdInput ? pwdInput.value.trim() : "";
    const result = await autoSubmitAttendance({
      sessid: session?.sessid,
      sesskey: state.sesskey,
      attendanceUrl: session?.submitUrl,
      password,
      sessionGroup: session?.group,
      studentOccurrence: occ,
      isOpen
    });

    if (result.success) {
      showToast(`Success! Marked Present for ${firstOpen.courseCode}`, "success");
      await loadLiveAttendanceData(true);
    } else if (result.requiresPassword) {
      const pwdWrap = document.getElementById("openAttendancePasswordWrap");
      if (pwdWrap) pwdWrap.classList.remove("hidden");
      if (pwdInput) pwdInput.focus();
      showToast(result.message || "Password required to check in.", "error");
    } else {
      showToast(result.error || "Attendance submission failed.", "error");
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ===================================================================
// TAB 4: LIVE CLASS PREP & MATERIAL BUNDLER
// ===================================================================
async function loadLiveEnrolledCourses() {
  const select = document.getElementById("courseSelect");
  const badge = document.getElementById("detectedCoursesBadge");

  try {
    const courses = await getLiveEnrolledCourses(state.sesskey);
    state.courses = courses;
    if (badge) badge.textContent = `${courses.length} Courses`;
    if (!select) return;
    select.innerHTML = "";

    if (courses.length === 0) {
      select.innerHTML = `<option value="">No enrolled courses detected on SPeCTRUM</option>`;
      return;
    }

    courses.forEach((c, idx) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.code} - ${c.name}`;
      if (idx === 0) {
        opt.selected = true;
        state.selectedCourse = c;
      }
      select.appendChild(opt);
    });

    updateFolderPreview();
    renderWeekPills();
    await loadLiveWeekMaterials();
  } catch (err) {
    console.error("[Spectra] Failed loading enrolled courses:", err);
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION" || err.message?.includes("SESSION_EXPIRED")) {
      updateAuthStatusBadge("invalid");
      updateSessionIndicator("disconnected", "Session Expired");
      updateInlineNoticeCards(false);
      renderUnauthenticatedStates(false);
    }
  }
}

function renderWeekPills() {
  const row = document.getElementById("weekPillsRow");
  if (!row) return;
  row.innerHTML = "";

  for (let w = 1; w <= 14; w++) {
    const pill = document.createElement("button");
    const isCurrent = w === state.currentAcademicWeek;
    const isSelected = w === state.selectedWeek;

    pill.className = `week-pill ${isSelected ? "active" : ""} ${isCurrent ? "is-current" : ""}`;
    pill.textContent = `W${w}`;
    pill.title = isCurrent ? `Week ${w} (Active Semester Week)` : `Week ${w}`;

    pill.addEventListener("click", async () => {
      state.selectedWeek = w;
      document.querySelectorAll(".week-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      document.getElementById("currentWeekTitle").textContent = `Week ${w} Materials`;
      document.getElementById("academicWeekTag").textContent = w === state.currentAcademicWeek ? "Active Week" : `Week ${w}`;
      updateFolderPreview();
      await loadLiveWeekMaterials();
    });

    row.appendChild(pill);
  }
}

function updateFolderPreview() {
  const preview = document.getElementById("packFolderPreview");
  if (!preview) return;
  const courseCode = state.selectedCourse ? state.selectedCourse.code : "Course";
  preview.textContent = `Downloads/Spectra/${courseCode}/Week_${state.selectedWeek}/`;
}

async function loadLiveWeekMaterials() {
  if (!state.selectedCourse) return;

  const loading = document.getElementById("materialsLoading");
  if (loading) loading.classList.remove("hidden");

  try {
    let selectedData = { slides: [], tutorials: [], labs: [] };

    if (!state.isDemoMode) {
      const weeksMap = await getLiveCourseMaterials(state.selectedCourse.id);
      selectedData = weeksMap[state.selectedWeek] || { slides: [], tutorials: [], labs: [] };
    } else {
      // Demo mock week data
      selectedData = getDemoWeekMaterials(state.selectedCourse.code, state.selectedWeek);
    }

    state.weekMaterials = {
      slides: selectedData.slides || [],
      tutorials: selectedData.tutorials || [],
      labs: selectedData.labs || []
    };

    renderMaterialGroup("slidesList", "slidesCountBadge", state.weekMaterials.slides);
    renderMaterialGroup("tutorialsList", "tutCountBadge", state.weekMaterials.tutorials);
    renderMaterialGroup("labsList", "labsCountBadge", state.weekMaterials.labs);

    const totalSlides = state.weekMaterials.slides.length;
    const totalTut = state.weekMaterials.tutorials.length;
    const totalLabs = state.weekMaterials.labs.length;
    const totalFiles = totalSlides + totalTut + totalLabs;

    document.getElementById("packSlidesCount").textContent = `📖 ${totalSlides} Slide${totalSlides === 1 ? "" : "s"}`;
    document.getElementById("packTutCount").textContent = `📝 ${totalTut} Tutorial${totalTut === 1 ? "" : "s"}`;
    document.getElementById("packLabCount").textContent = `💻 ${totalLabs} Lab${totalLabs === 1 ? "" : "s"}`;
    const totalFilesEl = document.getElementById("packTotalFiles");
    if (totalFilesEl) totalFilesEl.textContent = totalFiles;
  } catch (err) {
    console.error("[Spectra] Failed loading live course materials:", err);
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") {
      updateAuthStatusBadge("invalid");
      updateSessionIndicator("disconnected", "Session Expired");
      updateInlineNoticeCards(false);
      showToast("Session expired while loading materials. Please update MoodleSession cookie.", "error");
    }
  } finally {
    if (loading) loading.classList.add("hidden");
  }
}

function renderMaterialGroup(containerId, badgeId, items) {
  const container = document.getElementById(containerId);
  const badge = document.getElementById(badgeId);
  if (!container) return;
  container.innerHTML = "";
  if (badge) badge.textContent = items.length;

  if (items.length === 0) {
    container.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">No items posted for this section on SPeCTRUM.</div>`;
    return;
  }

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "material-item";

    const extClass = `ext-${item.ext || "default"}`;

    el.innerHTML = `
      <div class="file-left-group">
        <span class="ext-badge ${extClass}">${escapeHtml(item.ext || "file")}</span>
        <div class="file-name-size">
          <span class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <span class="file-size">${escapeHtml(item.size || "SPeCTRUM File")}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="single-dl-btn" data-url="${escapeHtml(item.url)}" data-name="${escapeHtml(item.name)}" title="Download file">
          <svg viewBox="0 0 20 20" width="12" height="12" fill="currentColor">
            <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
          </svg>
        </button>
      </div>
    `;

    el.querySelector(".single-dl-btn").addEventListener("click", () => {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: "DOWNLOAD_WEEK_PACK",
          payload: {
            files: [{ name: item.name, url: item.url }],
            courseCode: state.selectedCourse ? state.selectedCourse.code : "Course",
            weekNumber: state.selectedWeek
          }
        }, () => {
          showToast(`Downloading: ${item.name}`, "info");
        });
      } else {
        showToast(`Download started: ${item.name}`, "info");
      }
    });

    container.appendChild(el);
  });
}

async function handleDownloadWeekPack() {
  const mats = state.weekMaterials;
  const allFiles = [
    ...(mats.slides || []),
    ...(mats.tutorials || []),
    ...(mats.labs || [])
  ];

  if (allFiles.length === 0) {
    showToast("No files uploaded for this week on SPeCTRUM.", "error");
    return;
  }

  const btn = document.getElementById("downloadWeekPackBtn");
  const progressBox = document.getElementById("downloadProgressContainer");
  const progressBar = document.getElementById("downloadProgressBar");
  const progressPercent = document.getElementById("downloadProgressPercent");
  const progressStatus = document.getElementById("downloadProgressStatus");

  btn.disabled = true;
  progressBox.classList.remove("hidden");
  progressBar.style.width = "25%";
  progressPercent.textContent = "25%";
  progressStatus.textContent = `Dispatching ${allFiles.length} downloads...`;

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      action: "DOWNLOAD_WEEK_PACK",
      payload: {
        files: allFiles,
        courseCode: state.selectedCourse ? state.selectedCourse.code : "Course",
        weekNumber: state.selectedWeek
      }
    }, (response) => {
      progressBar.style.width = "100%";
      progressPercent.textContent = "100%";
      progressStatus.textContent = "Saved to Downloads/Spectra!";

      btn.disabled = false;
      progressBox.classList.add("hidden");
      progressBar.style.width = "0%";
      if (response && response.success) {
        showToast(`Saved ${response.downloaded} files to Downloads/${response.folder}`, "success");
      } else {
        showToast("Download batch started.", "success");
      }
    });
  } else {
    progressBar.style.width = "100%";
    progressPercent.textContent = "100%";
    setTimeout(() => {
      btn.disabled = false;
      progressBox.classList.add("hidden");
      showToast(`Simulated download of ${allFiles.length} files.`, "success");
    }, 500);
  }
}

// ===================================================================
// TAB 3: SETTINGS LOGIC
// ===================================================================
async function handleTestTelegram() {
  const tokenInput = document.getElementById("telegramToken");
  const chatInput = document.getElementById("telegramChatId");
  if (!tokenInput || !chatInput) return;

  const rawBotToken = tokenInput.value;
  const rawChatId = chatInput.value;

  const botToken = sanitizeTelegramToken(rawBotToken);
  const chatId = sanitizeTelegramChatId(rawChatId);

  // Reflect sanitized values back to inputs
  if (botToken) tokenInput.value = botToken;
  if (chatId) chatInput.value = chatId;

  if (!botToken || !chatId) {
    showToast("Please enter both Bot Token and Chat ID", "error");
    return;
  }

  const btn = document.getElementById("testTelegramBtn");
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Sending test alert...</span>`;

  try {
    // 1. Direct dispatch from popup with native host_permissions
    let result = null;
    let directError = null;

    try {
      result = await sendTelegramTestMessage(botToken, chatId);
    } catch (err) {
      directError = err;
      console.warn("[Spectra Popup] Direct Telegram dispatch notice:", err);
    }

    // 2. Fallback to background service worker if direct call errored
    if (!result && directError) {
      try {
        result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "SEND_TEST_TELEGRAM",
            payload: { botToken, chatId }
          }, (response) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message || directError.message));
            }
            if (response && response.success) {
              resolve(response.data || response);
            } else {
              reject(new Error(response?.error || response?.message || directError.message));
            }
          });
        });
      } catch (bgErr) {
        throw directError || bgErr;
      }
    }

    // Auto-save verified Telegram settings to chrome.storage.local
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        telegram_bot_token: botToken,
        telegram_chat_id: chatId
      });
    }

    showToast("Telegram message sent successfully! Check your phone.", "success");
  } catch (err) {
    console.error("[Spectra Popup] Telegram test failed:", err);
    showToast(`Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

async function handleTestNtfy() {
  const topic = document.getElementById("ntfyTopic").value.trim();
  if (!topic) {
    showToast("Please enter an ntfy topic name", "error");
    return;
  }

  const btn = document.getElementById("testNtfyBtn");
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Sending ntfy alert...";

  chrome.runtime.sendMessage({
    action: "SEND_TEST_NTFY",
    payload: { topic }
  }, (response) => {
    btn.disabled = false;
    btn.innerHTML = origText;
    if (response && response.success) {
      showToast("ntfy.sh notification delivered!", "success");
    } else {
      showToast(`ntfy error: ${response?.error || "Failed"}`, "error");
    }
  });
}

async function handleManualCloudSync() {
  const relayUrl = document.getElementById("cloudRelayUrl").value.trim();
  const secretKey = document.getElementById("cloudRelaySecret").value.trim();

  if (!relayUrl) {
    showToast("Please specify a Cloud Relay endpoint URL", "error");
    return;
  }

  // Auto-persist configured relay endpoint and secret to storage
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      cloud_relay_url: relayUrl,
      cloud_relay_secret: secretKey,
      cloud_relay_enabled: true
    });
  }

  const btn = document.getElementById("syncCloudNowBtn");
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Syncing...";

  chrome.runtime.sendMessage({
    action: "SYNC_CLOUD_RELAY_NOW",
    payload: { relayUrl, secretKey }
  }, (response) => {
    btn.disabled = false;
    btn.innerHTML = origText;
    if (response && response.success) {
      const d = new Date();
      document.getElementById("lastCloudSyncLabel").textContent = `Synced: ${d.toLocaleTimeString()}`;
      showToast("MoodleSession synced to Cloud Relay!", "success");
    } else {
      showToast(`Sync failed: ${response?.message || response?.error}`, "error");
    }
  });
}

async function handleSaveSettings() {
  const tokenInput = document.getElementById("telegramToken");
  const chatInput = document.getElementById("telegramChatId");
  const botToken = sanitizeTelegramToken(tokenInput ? tokenInput.value : "");
  const chatId = sanitizeTelegramChatId(chatInput ? chatInput.value : "");

  if (tokenInput && botToken) tokenInput.value = botToken;
  if (chatInput && chatId) chatInput.value = chatId;

  const ntfyInput = document.getElementById("ntfyTopic");
  const ntfyTopic = ntfyInput ? ntfyInput.value.trim() : "";
  const cloudEnabled = document.getElementById("cloudRelayToggle").checked;
  const cloudUrl = document.getElementById("cloudRelayUrl").value.trim();
  const cloudSecret = document.getElementById("cloudRelaySecret").value.trim();
  const pollMins = parseInt(document.getElementById("pollIntervalSelect").value, 10);
  const notifyAnnounce = document.getElementById("prefAnnouncements").checked;
  const notifyDeadlines = document.getElementById("prefDeadlines").checked;

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      telegram_bot_token: botToken,
      telegram_chat_id: chatId,
      ntfy_topic: ntfyTopic,
      cloud_relay_enabled: cloudEnabled,
      cloud_relay_url: cloudUrl,
      cloud_relay_secret: cloudSecret,
      poll_interval_mins: pollMins,
      notify_announcements: notifyAnnounce,
      notify_urgent_deadlines: notifyDeadlines
    });

    chrome.runtime.sendMessage({
      action: "UPDATE_ALARMS",
      payload: { intervalMinutes: pollMins }
    });
  }

  showToast("Settings saved successfully!", "success");
}

// ===================================================================
// Demo Preview Mode Handler (for testing when off campus)
// ===================================================================
function enableDemoPreview() {
  state.isDemoMode = true;
  state.isAuthenticated = true;
  state.userName = "UM Student (Demo Mode)";

  updateSessionIndicator("connected", "Demo Preview");
  updateUserIdentityUI("Demo Student (UM)", "");
  setDisconnectedViewState(false);

  // Sample authentic UM courses
  state.courses = [
    { id: "demo_wix2002", code: "WIX2002", name: "Software Engineering Project Management", url: "https://spectrum.um.edu.my" },
    { id: "demo_wia1001", code: "WIA1001", name: "Information Systems & Digital Economy", url: "https://spectrum.um.edu.my" },
    { id: "demo_wix1002", code: "WIX1002", name: "Data Structures & Algorithms", url: "https://spectrum.um.edu.my" }
  ];

  // Populate course dropdown
  const select = document.getElementById("courseSelect");
  select.innerHTML = "";
  state.courses.forEach((c, idx) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.code} - ${c.name}`;
    if (idx === 0) {
      opt.selected = true;
      state.selectedCourse = c;
    }
    select.appendChild(opt);
  });

  // Sample deadlines
  state.deadlines = [
    {
      id: "demo_assign_1",
      title: "Sprint 1 Retrospective & Jira Board Export",
      courseCode: "WIX2002",
      courseName: "Software Engineering Project Management",
      dueTimestamp: Date.now() + 5.5 * 3600 * 1000,
      dueDate: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString(),
      url: "https://spectrum.um.edu.my/mod/assign/view.php?id=384102",
      type: "assign",
      urgency: "urgent",
      isCompleted: false,
      weight: "15%"
    },
    {
      id: "demo_assign_2",
      title: "Case Study 2: Cloud ERP Architecture Breakdown",
      courseCode: "WIA1001",
      courseName: "Information Systems & Digital Economy",
      dueTimestamp: Date.now() + 18 * 3600 * 1000,
      dueDate: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
      url: "https://spectrum.um.edu.my/mod/assign/view.php?id=384095",
      type: "assign",
      urgency: "urgent",
      isCompleted: false,
      weight: "10%"
    },
    {
      id: "demo_assign_3",
      title: "Lab Assignment 3: Red-Black Trees & Binary Heap",
      courseCode: "WIX1002",
      courseName: "Data Structures & Algorithms",
      dueTimestamp: Date.now() + 72 * 3600 * 1000,
      dueDate: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      url: "https://spectrum.um.edu.my/mod/assign/view.php?id=385200",
      type: "assign",
      urgency: "this_week",
      isCompleted: false,
      weight: "10%"
    }
  ];

  updateUrgentCountBadge();
  renderDeadlines();
  renderWeekPills();
  loadLiveWeekMaterials();

  // Demo announcements
  state.announcements = [
    {
      id: "demo_ann_1",
      courseCode: "WIX2002",
      subject: "Midterm Examination Date & Guidelines Announced",
      author: "Dr. Azman (Lecturer)",
      date: "Today, 10:30 AM",
      url: "https://spectrum.um.edu.my"
    },
    {
      id: "demo_ann_2",
      courseCode: "WIA1001",
      subject: "Tutorial Group Registration Deadline Tomorrow",
      author: "Prof. Sarah",
      date: "Yesterday, 3:15 PM",
      url: "https://spectrum.um.edu.my"
    },
    {
      id: "demo_ann_3",
      courseCode: "WIX1002",
      subject: "Lab 3 Red-Black Trees Starter Code Released",
      author: "En. Faris",
      date: "Oct 17, 2:00 PM",
      url: "https://spectrum.um.edu.my"
    }
  ];
  populateAnnouncementSubjectDropdown();
  renderAnnouncements();

  showToast("Demo preview active. All UI and downloader features unlocked!", "info");
}

function getDemoWeekMaterials(courseCode, weekNum) {
  return {
    slides: [
      { name: `Lecture 0${weekNum} - ${courseCode} Module Slides.pdf`, ext: "pdf", size: "3.4 MB", url: "https://spectrum.um.edu.my" },
      { name: "Course Outline & Assessment Rubrics.pdf", ext: "pdf", size: "840 KB", url: "https://spectrum.um.edu.my" }
    ],
    tutorials: [
      { name: `Tutorial 0${weekNum} - Worksheet & Exercises.docx`, ext: "docx", size: "420 KB", url: "https://spectrum.um.edu.my" }
    ],
    labs: [
      { name: `Lab 0${weekNum} - Starter Code Repository.zip`, ext: "zip", size: "2.1 MB", url: "https://spectrum.um.edu.my" }
    ]
  };
}

// ===================================================================
// Preferences & Storage Helpers
// ===================================================================
async function loadStoredPreferences() {
  let stored = {};
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    stored = await chrome.storage.local.get([
      "telegram_bot_token",
      "telegram_chat_id",
      "ntfy_topic",
      "cloud_relay_enabled",
      "cloud_relay_url",
      "cloud_relay_secret",
      "poll_interval_mins",
      "notify_announcements",
      "notify_urgent_deadlines",
      "completed_assignment_ids",
      "last_cloud_sync_timestamp",
      "semester_start_date",
      "course_occurrences",
      "pref_auto_attendance",
      "telegram_sent_announcement_ids",
      "telegram_sent_deadline_ids"
    ]);
  }

  if (Array.isArray(stored.telegram_sent_announcement_ids)) {
    state.telegramSentAnnouncementIds = new Set(stored.telegram_sent_announcement_ids.map(String));
  }
  if (Array.isArray(stored.telegram_sent_deadline_ids)) {
    state.telegramSentDeadlineIds = new Set(stored.telegram_sent_deadline_ids.map(String));
  }

  const tgNoticesCountEl = document.getElementById("tgSentNoticesCount");
  const tgDeadlinesCountEl = document.getElementById("tgSentDeadlinesCount");
  if (tgNoticesCountEl) tgNoticesCountEl.textContent = String(state.telegramSentAnnouncementIds.size);
  if (tgDeadlinesCountEl) tgDeadlinesCountEl.textContent = String(state.telegramSentDeadlineIds.size);

  if (stored.course_occurrences && typeof stored.course_occurrences === "object") {
    state.courseOccurrences = stored.course_occurrences;
  }
  if (stored.pref_auto_attendance !== undefined) {
    state.autoAttendanceEnabled = stored.pref_auto_attendance;
    const attToggle = document.getElementById("autoAttendanceToggle");
    if (attToggle) attToggle.checked = stored.pref_auto_attendance;
    const lbl = document.getElementById("autoAttendanceToggleLabel");
    if (lbl) lbl.textContent = stored.pref_auto_attendance ? "Auto-Checkin Active" : "Auto-Checkin Paused";
  }

  if (stored.telegram_bot_token) document.getElementById("telegramToken").value = stored.telegram_bot_token;
  if (stored.telegram_chat_id) document.getElementById("telegramChatId").value = stored.telegram_chat_id;
  const ntfyInput = document.getElementById("ntfyTopic");
  if (ntfyInput && stored.ntfy_topic) ntfyInput.value = stored.ntfy_topic;

  const cloudEnabled = Boolean(stored.cloud_relay_enabled);
  document.getElementById("cloudRelayToggle").checked = cloudEnabled;
  document.getElementById("cloudRelayFields").classList.toggle("hidden", !cloudEnabled);
  if (stored.cloud_relay_url) document.getElementById("cloudRelayUrl").value = stored.cloud_relay_url;
  if (stored.cloud_relay_secret) document.getElementById("cloudRelaySecret").value = stored.cloud_relay_secret;
  if (stored.last_cloud_sync_timestamp) {
    const d = new Date(stored.last_cloud_sync_timestamp);
    document.getElementById("lastCloudSyncLabel").textContent = `Synced: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  if (stored.poll_interval_mins) document.getElementById("pollIntervalSelect").value = String(stored.poll_interval_mins);
  if (stored.notify_announcements !== undefined) document.getElementById("prefAnnouncements").checked = stored.notify_announcements;
  if (stored.notify_urgent_deadlines !== undefined) document.getElementById("prefDeadlines").checked = stored.notify_urgent_deadlines;

  if (Array.isArray(stored.completed_assignment_ids)) {
    state.completedIds = new Set(stored.completed_assignment_ids);
  }

  const academic = calculateAcademicWeek(stored.semester_start_date || "2026-10-05");
  state.currentAcademicWeek = academic.week;
  state.selectedWeek = academic.week;
  document.getElementById("weekIndicatorBadge").textContent = `W${academic.week}`;
}

// ===================================================================
// Floating Feedback Toast
// ===================================================================
let toastTimeout = null;
function showToast(message, type = "success") {
  const toast = document.getElementById("feedbackToast");
  const icon = document.getElementById("toastIcon");
  const msg = document.getElementById("toastMsg");
  if (!toast) return;

  clearTimeout(toastTimeout);

  toast.className = `feedback-toast ${type === "error" ? "toast-error" : ""}`;
  icon.textContent = type === "error" ? "✕" : "✓";
  msg.textContent = message;

  toast.classList.remove("hidden");

  toastTimeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3200);
}

// ===================================================================
// Utilities
// ===================================================================
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
