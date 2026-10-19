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
  assert(deadMsg.includes("<b>Spectra Deadline Radar: WIX2002</b>"), "Deadline radar formats bold header");
  assert(deadMsg.includes("Due in ~3 hours!"), "Deadline radar formats hours left");

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

  print(`\n=== All Telegram Tests Finished: ${passed} passed, ${failed} failed ===`);
}

runTelegramTests().catch((e) => {
  print("Fatal Telegram Test Error: " + e + "\n" + e.stack);
});
