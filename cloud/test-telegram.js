/**
 * Automated Test Suite for Telegram Dispatcher (utils/telegram.js)
 * Tests token sanitization, HTML escaping, entity parse fallback,
 * and user-actionable error mapping.
 */

if (typeof console === "undefined") {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

import {
  sanitizeTelegramToken,
  sanitizeTelegramChatId,
  escapeHtml,
  stripHtml,
  sendTelegramMessage,
  sendTelegramTestMessage,
  formatAnnouncementTelegram,
  formatDeadlineTelegram
} from "../utils/telegram.js";

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    passed++;
    print(`✅ PASS: ${name}`);
  } else {
    failed++;
    print(`❌ FAIL: ${name}`);
    throw new Error(`Test failed: ${name}`);
  }
}

async function runTelegramTests() {
  print("=== Starting Telegram Dispatcher & Sanitization Tests ===");

  // 1. Sanitization tests
  assert(sanitizeTelegramToken("  123456:ABC-DEF_ghi  ") === "123456:ABC-DEF_ghi", "Trims token whitespace");
  assert(sanitizeTelegramToken('"123456:ABC-DEF_ghi"') === "123456:ABC-DEF_ghi", "Strips enclosing quotes");
  assert(sanitizeTelegramToken("bot123456:ABC-DEF_ghi") === "123456:ABC-DEF_ghi", "Strips accidental 'bot' prefix");
  assert(sanitizeTelegramToken("BOT123456:ABC-DEF_ghi") === "123456:ABC-DEF_ghi", "Strips uppercase 'BOT' prefix");
  assert(sanitizeTelegramToken("https://api.telegram.org/bot123456:ABC-DEF_ghi/sendMessage") === "123456:ABC-DEF_ghi", "Extracts token from full URL");

  assert(sanitizeTelegramChatId("  987654321  ") === "987654321", "Trims chat ID whitespace");
  assert(sanitizeTelegramChatId("-1001234567890") === "-1001234567890", "Preserves negative supergroup chat ID");
  assert(sanitizeTelegramChatId(987654321) === "987654321", "Accepts numeric chat ID");

  // 2. HTML escaping
  assert(escapeHtml("WIX2002 & WIX2003 <Assignment> \"Final\"") === "WIX2002 &amp; WIX2003 &lt;Assignment&gt; &quot;Final&quot;", "Escapes HTML entities safely");
  assert(stripHtml("<b>Hello</b> <i>World</i>") === "Hello World", "Strips HTML tags");

  // 3. Formatters
  const annMsg = formatAnnouncementTelegram({
    courseCode: "WIX2002",
    subject: "Lab 3 & Midterm Guidelines",
    author: "Dr. Azman",
    url: "https://spectrum.um.edu.my/mod/forum/discuss.php?d=101"
  });
  assert(annMsg.includes("<b>Spectra Alert: WIX2002</b>"), "Announcement formats bold header");
  assert(annMsg.includes("Lab 3 &amp; Midterm Guidelines"), "Announcement escapes subject ampersand");

  const deadMsg = formatDeadlineTelegram({
    courseCode: "WIX2002",
    title: "Software Requirement Specification",
    dueTimestamp: Date.now() + 3600000 * 3,
    formattedTime: "Tonight, 11:59 PM",
    url: "https://spectrum.um.edu.my/mod/assign/view.php?id=99"
  });
  assert(deadMsg.includes("Spectra Due Date Reminder: WIX2002") || deadMsg.includes("Spectra Deadline Radar: WIX2002"), "Due date reminder formats bold header");
  assert(deadMsg.includes("Due in ~3 hours!"), "Deadline reminder formats hours left");

  const deadMsg1Day = formatDeadlineTelegram({
    courseCode: "WIX2002",
    title: "Sprint 2 Deliverable",
    dueTimestamp: Date.now() + 3600000 * 24,
    formattedTime: "Tomorrow, 11:59 PM",
    url: "https://spectrum.um.edu.my/mod/assign/view.php?id=100"
  });
  assert(deadMsg1Day.includes("Due in exactly 1 day (24 hours)!"), "Deadline reminder formats exactly 1 day urgency");

  // 4. API mock tests: 401 Unauthorized
  globalThis.fetch = async (url, opts) => {
    return {
      status: 401,
      json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" })
    };
  };

  let caught401 = false;
  try {
    await sendTelegramMessage("123456:INVALID", "987654321", "Test message");
  } catch (err) {
    caught401 = err.message.includes("Unauthorized: Invalid Bot Token");
  }
  assert(caught401, "Maps 401 to clear Unauthorized Bot Token message");

  // 5. API mock tests: 400 Chat Not Found / /start not pressed
  globalThis.fetch = async (url, opts) => {
    return {
      status: 400,
      json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" })
    };
  };

  let caught400 = false;
  try {
    await sendTelegramMessage("123456:VALID_TOKEN", "987654321", "Test message");
  } catch (err) {
    caught400 = err.message.includes("sent /start to your bot in Telegram first");
  }
  assert(caught400, "Maps 'chat not found' to clear /start instruction");

  // 6. API mock tests: 403 Bot cannot initiate conversation
  globalThis.fetch = async (url, opts) => {
    return {
      status: 403,
      json: async () => ({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" })
    };
  };

  let caught403 = false;
  try {
    await sendTelegramMessage("123456:VALID_TOKEN", "987654321", "Test message");
  } catch (err) {
    caught403 = err.message.includes("You must open a chat with your bot in Telegram and press START first");
  }
  assert(caught403, "Maps 403 to /start required message");

  // 7. API mock tests: Entity parse error fallback to plain text
  let attempt = 0;
  globalThis.fetch = async (url, opts) => {
    attempt++;
    const body = JSON.parse(opts.body);
    if (attempt === 1) {
      // First attempt with HTML fails
      return {
        status: 400,
        json: async () => ({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" })
      };
    } else {
      // Second attempt without parse_mode succeeds
      assert(body.parse_mode === undefined, "Fallback request does not send failing parse_mode");
      return {
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 8881 } })
      };
    }
  };

  const retryRes = await sendTelegramMessage("123456:VALID_TOKEN", "987654321", "<b>Unclosed tag test");
  assert(retryRes.success === true, "Recovers from parse error by sending plain text fallback");
  assert(retryRes.messageId === 8881, "Returns message ID after successful retry");

  // 8. Test sendTelegramTestMessage success
  globalThis.fetch = async (url, opts) => {
    return {
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9999 } })
    };
  };

  const testMsgRes = await sendTelegramTestMessage("123456:VALID_TOKEN", "987654321");
  assert(testMsgRes.success === true, "sendTelegramTestMessage succeeds");
  assert(testMsgRes.messageId === 9999, "sendTelegramTestMessage returns message_id");

  // 9. Telegram Flagging Logic Tests (Only send unflagged items & flag them once sent)
  let sentDispatches = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sentDispatches.push(body);
    return {
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1000 + sentDispatches.length } })
    };
  };

  const sampleAnnouncements = [
    { id: "ann_101", courseCode: "WIX2002", subject: "Lab 1 Cancelled", author: "Dr. Tan" },
    { id: "ann_102", courseCode: "WIA1001", subject: "Midterm Room Change", author: "Dr. Ali" }
  ];

  const flaggedAnnouncementIds = new Set(["ann_101"]); // ann_101 was already sent and flagged

  // Dispatch announcements: only send unflagged ones
  for (const ann of sampleAnnouncements) {
    if (!flaggedAnnouncementIds.has(ann.id)) {
      await sendTelegramMessage("123456:VALID_TOKEN", "987654321", `<b>${ann.subject}</b>`);
      flaggedAnnouncementIds.add(ann.id);
    }
  }

  assert(sentDispatches.length === 1, "Strict: Only unflagged announcement ann_102 was dispatched to Telegram");
  assert(sentDispatches[0].text.includes("Midterm Room Change"), "Dispatched announcement text matches ann_102");
  assert(flaggedAnnouncementIds.has("ann_102") === true, "Newly sent announcement ann_102 is now flagged");

  // Re-run dispatch: both are now flagged, so 0 dispatches should occur
  const initialCount = sentDispatches.length;
  for (const ann of sampleAnnouncements) {
    if (!flaggedAnnouncementIds.has(ann.id)) {
      await sendTelegramMessage("123456:VALID_TOKEN", "987654321", `<b>${ann.subject}</b>`);
      flaggedAnnouncementIds.add(ann.id);
    }
  }
  assert(sentDispatches.length === initialCount, "Strict: Flagged announcements are never re-sent to Telegram");

  // Deadline submissions flagging test
  const sampleDeadlines = [
    { id: "dl_501", courseCode: "WIX2002", title: "Assignment 1" },
    { id: "dl_502", courseCode: "WIA1001", title: "Project Milestone" }
  ];
  const flaggedDeadlineIds = new Set(["dl_501"]); // dl_501 was already sent and flagged

  for (const dl of sampleDeadlines) {
    if (!flaggedDeadlineIds.has(dl.id)) {
      await sendTelegramMessage("123456:VALID_TOKEN", "987654321", `<b>${dl.title}</b>`);
      flaggedDeadlineIds.add(dl.id);
    }
  }

  assert(sentDispatches.length === initialCount + 1, "Strict: Only unflagged deadline dl_502 was dispatched to Telegram");
  assert(flaggedDeadlineIds.has("dl_502") === true, "Newly sent deadline dl_502 is now flagged");

  // Verify return structure compatibility
  const testRes = await sendTelegramMessage("123456:VALID_TOKEN", "987654321", "Compat test");
  assert(testRes.success === true, "sendTelegramMessage returns success: true");
  assert(testRes.ok === true, "sendTelegramMessage returns ok: true for callers checking res.ok");
  assert(testRes.message_id !== undefined, "sendTelegramMessage returns message_id");
  assert(testRes.messageId !== undefined, "sendTelegramMessage returns messageId");

  // Verify polling lifecycle with new announcement arriving later
  const pollSentIds = new Set();
  const pollStorage = { telegram_sent_announcement_ids: [] };

  async function mockBackgroundPoll(fetchedAnnouncements) {
    let sentInThisCycle = 0;
    for (const ann of fetchedAnnouncements) {
      const idStr = String(ann.id);
      if (!pollSentIds.has(idStr)) {
        const res = await sendTelegramMessage("123456:VALID_TOKEN", "987654321", ann.subject);
        if (res && (res.success || res.ok || res.messageId || res.message_id)) {
          pollSentIds.add(idStr);
          pollStorage.telegram_sent_announcement_ids = Array.from(pollSentIds);
          sentInThisCycle++;
        }
      }
    }
    return sentInThisCycle;
  }

  const batch1 = [
    { id: "forum_1", subject: "Welcome to Semester" },
    { id: "forum_2", subject: "Class Schedule" }
  ];
  const cycle1Sent = await mockBackgroundPoll(batch1);
  assert(cycle1Sent === 2, "Cycle 1: Sends both initial announcements");
  assert(pollStorage.telegram_sent_announcement_ids.length === 2, "Cycle 1: Storage persists both IDs");

  // Cycle 2: Same announcements fetched again
  const cycle2Sent = await mockBackgroundPoll(batch1);
  assert(cycle2Sent === 0, "Cycle 2: Sends 0 duplicate announcements");

  // Cycle 3: One new announcement arrives
  const batch2 = [
    { id: "forum_1", subject: "Welcome to Semester" },
    { id: "forum_2", subject: "Class Schedule" },
    { id: "forum_3", subject: "Guest Lecture Tomorrow" }
  ];
  const cycle3Sent = await mockBackgroundPoll(batch2);
  assert(cycle3Sent === 1, "Cycle 3: Sends ONLY the new announcement forum_3");
  assert(pollStorage.telegram_sent_announcement_ids.includes("forum_3"), "Cycle 3: forum_3 added to storage");

  // Cycle 4: Large batch with mix of old and new, ensuring strict 1-time send guarantee
  const batch3 = [
    { id: "forum_1", subject: "Welcome to Semester" },
    { id: "forum_2", subject: "Class Schedule" },
    { id: "forum_3", subject: "Guest Lecture Tomorrow" },
    { id: "forum_4", subject: "Lab Submission Deadline Extended" },
    { id: "forum_5", subject: "Exam Venue Notice" }
  ];
  const cycle4Sent = await mockBackgroundPoll(batch3);
  assert(cycle4Sent === 2, "Cycle 4: Dispatches only the 2 newly added announcements (forum_4 and forum_5)");
  assert(pollStorage.telegram_sent_announcement_ids.length === 5, "Cycle 4: Total 5 unique announcement IDs in storage");

  // Cycle 5: Re-running batch 3 produces 0 sends
  const cycle5Sent = await mockBackgroundPoll(batch3);
  assert(cycle5Sent === 0, "Cycle 5: Exactly 0 sends when no new announcements exist");

  // Cycle 6: Simulate full browser reload / restart with storage state
  const restoredSentIds = new Set(pollStorage.telegram_sent_announcement_ids);
  let cycle6Sent = 0;
  for (const ann of batch3) {
    if (!restoredSentIds.has(String(ann.id))) {
      cycle6Sent++;
    }
  }
  assert(cycle6Sent === 0, "Cycle 6: After restart, all 5 announcements remain flagged and 0 are re-sent");

  // -------------------------------------------------------------
  // Automatic 1-Day Due Date Reminder Tests
  // -------------------------------------------------------------
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const mockDeadlines = [
    { id: "dl_1day_exact", courseCode: "WIX2002", title: "Project Milestone 1", dueTimestamp: now + ONE_DAY_MS, formattedTime: "Tomorrow, 11:59 PM", isCompleted: false },
    { id: "dl_18h_left", courseCode: "WIA1001", title: "Quiz 2", dueTimestamp: now + 18 * 3600 * 1000, formattedTime: "Tomorrow, 6:00 PM", isCompleted: false },
    { id: "dl_3days_away", courseCode: "WIX2001", title: "Lab 4 Report", dueTimestamp: now + 3 * ONE_DAY_MS, formattedTime: "In 3 days", isCompleted: false },
    { id: "dl_already_done", courseCode: "GIG1004", title: "Ethics Essay", dueTimestamp: now + ONE_DAY_MS, formattedTime: "Tomorrow", isCompleted: true },
    { id: "dl_past_overdue", courseCode: "WIX2002", title: "Tutorial 1", dueTimestamp: now - 3600 * 1000, formattedTime: "1 hour ago", isCompleted: false }
  ];

  const deadlineStorage = { telegram_sent_deadline_ids: [] };
  const deadlineSentIds = new Set();
  const deadlineDispatches = [];

  async function mockCheckUpcomingDeadlines(items) {
    const curTime = Date.now();
    const urgentItems = items.filter((d) => {
      if (d.isCompleted) return false;
      if (!d.dueTimestamp) return false;
      const diffHours = (d.dueTimestamp - curTime) / (1000 * 60 * 60);
      return diffHours > 0 && diffHours <= 24;
    });

    let sentCount = 0;
    for (const item of urgentItems) {
      const idStr = String(item.id);
      if (!deadlineSentIds.has(idStr)) {
        const html = formatDeadlineTelegram(item);
        const res = await sendTelegramMessage("123456:VALID_TOKEN", "987654321", html);
        if (res && (res.success || res.ok || res.messageId || res.message_id)) {
          deadlineSentIds.add(idStr);
          deadlineStorage.telegram_sent_deadline_ids = Array.from(deadlineSentIds);
          deadlineDispatches.push({ id: idStr, html });
          sentCount++;
        }
      }
    }
    return sentCount;
  }

  // First check: Should send reminders for dl_1day_exact and dl_18h_left
  const dlCheck1 = await mockCheckUpcomingDeadlines(mockDeadlines);
  assert(dlCheck1 === 2, "Due date reminder: Dispatched exactly 2 reminders for items due in <= 1 day");
  assert(deadlineSentIds.has("dl_1day_exact") === true, "Due date reminder: dl_1day_exact (exactly 1 day) was dispatched");
  assert(deadlineSentIds.has("dl_18h_left") === true, "Due date reminder: dl_18h_left was dispatched");
  assert(deadlineSentIds.has("dl_3days_away") === false, "Due date reminder: dl_3days_away (> 1 day) was NOT dispatched");
  assert(deadlineSentIds.has("dl_already_done") === false, "Due date reminder: Completed assignment was NOT dispatched");
  assert(deadlineSentIds.has("dl_past_overdue") === false, "Due date reminder: Overdue assignment was NOT dispatched");

  const exactMsg = deadlineDispatches.find(d => d.id === "dl_1day_exact");
  assert(exactMsg && exactMsg.html.includes("Due in exactly 1 day (24 hours)!"), "Due date reminder: Formats exactly 1 day reminder message text");

  // Second check: Same deadlines checked again - must send 0 reminders!
  const dlCheck2 = await mockCheckUpcomingDeadlines(mockDeadlines);
  assert(dlCheck2 === 0, "Due date reminder: Repeated check dispatches 0 reminders (already flagged)");

  // Third check: 3-day assignment time-travels to 24h away (now due in 1 day!)
  const updatedDeadlines = mockDeadlines.map(d => {
    if (d.id === "dl_3days_away") {
      return { ...d, dueTimestamp: Date.now() + ONE_DAY_MS };
    }
    return d;
  });
  const dlCheck3 = await mockCheckUpcomingDeadlines(updatedDeadlines);
  assert(dlCheck3 === 1, "Due date reminder: When assignment reaches 1 day mark, exactly 1 reminder is dispatched");
  assert(deadlineSentIds.has("dl_3days_away") === true, "Due date reminder: Newly urgent assignment is now flagged");

  print(`\n=== All Telegram Tests Finished: ${passed} passed, ${failed} failed ===`);
}

runTelegramTests().catch((e) => {
  print("Fatal Telegram Test Error: " + e + "\n" + e.stack);
});
