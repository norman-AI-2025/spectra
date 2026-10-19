/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Robust Telegram Bot API Dispatcher & Validation Engine
 *
 * Supports HTML parse mode, automatic markdown/entity failure fallback,
 * token sanitization (strips "bot" prefix, quotes, whitespace),
 * and clear user-actionable error diagnostics (401, 403, 400).
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Sanitize and clean raw user-entered Bot Token:
 * - Trims whitespace and quotes
 * - Removes leading "bot" prefix if accidentally included
 * - Extracts token from full URLs if pasted from docs
 */
export function sanitizeTelegramToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return "";
  let token = rawToken.trim().replace(/^["']|["']$/g, "").trim();

  // If user pasted a full URL e.g. https://api.telegram.org/bot123456:ABC...
  const urlMatch = token.match(/bot(\d+:[a-zA-Z0-9_-]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  // Strip leading "bot" prefix if entered as "bot123456:ABC..."
  if (token.toLowerCase().startsWith("bot")) {
    token = token.slice(3).trim();
  }

  return token;
}

/**
 * Sanitize user-entered Chat ID:
 * - Trims whitespace and quotes
 * - Preserves negative signs for group/channel IDs (e.g. -1001234567890)
 * - Preserves @username for public channels
 */
export function sanitizeTelegramChatId(rawChatId) {
  if (!rawChatId || (typeof rawChatId !== "string" && typeof rawChatId !== "number")) return "";
  let chatId = String(rawChatId).trim().replace(/^["']|["']$/g, "").trim();
  return chatId;
}

/**
 * Escape HTML special characters for Telegram HTML parse_mode
 */
export function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Strip HTML tags for fallback plain text delivery
 */
export function stripHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]+>/g, "");
}

/**
 * Core Telegram sendMessage API dispatcher with HTML mode & plain-text fallback
 */
export async function sendTelegramMessage(botToken, chatId, messageHtml, options = {}) {
  const cleanToken = sanitizeTelegramToken(botToken);
  const cleanChatId = sanitizeTelegramChatId(chatId);

  if (!cleanToken) {
    throw new Error("Missing or invalid Telegram Bot Token. Obtain one from @BotFather.");
  }
  if (!cleanChatId) {
    throw new Error("Missing or invalid Telegram Chat ID. Check your ID with @userinfobot.");
  }

  // Basic token format sanity check: numbers, colon, alphanumeric
  if (!/^\d+:[a-zA-Z0-9_-]+$/.test(cleanToken)) {
    throw new Error("Invalid Bot Token format. Tokens look like: 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ");
  }

  const endpoint = `${TELEGRAM_API_BASE}/bot${cleanToken}/sendMessage`;
  const disableWebPagePreview = options.disableWebPagePreview !== undefined ? options.disableWebPagePreview : false;

  // Attempt 1: Send with parse_mode: "HTML"
  try {
    const payload = {
      chat_id: cleanChatId,
      text: messageHtml,
      parse_mode: "HTML",
      disable_web_page_preview: disableWebPagePreview
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (data.ok) {
      return {
        success: true,
        ok: true,
        messageId: data.result?.message_id,
        message_id: data.result?.message_id,
        data
      };
    }

    // Inspect error response
    const errDesc = data.description || "";
    const errCode = data.error_code || res.status;

    // Check if error is due to HTML parse failure -> retry with plain text!
    if (errDesc.includes("can't parse entities") || errDesc.includes("entity") || errDesc.includes("tag")) {
      console.warn("[Spectra Telegram] HTML parse failed, falling back to plain text:", errDesc);
      const fallbackRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cleanChatId,
          text: stripHtml(messageHtml),
          disable_web_page_preview: disableWebPagePreview
        })
      });
      const fallbackData = await fallbackRes.json();
      if (fallbackData.ok) {
        return {
          success: true,
          ok: true,
          messageId: fallbackData.result?.message_id,
          message_id: fallbackData.result?.message_id,
          data: fallbackData
        };
      }
    }

    // Map common Telegram API errors to user-friendly messages
    if (errCode === 401 || errDesc.includes("Unauthorized")) {
      throw new Error("Unauthorized: Invalid Bot Token. Please copy the token exactly from @BotFather.");
    }
    if (errCode === 400 && (errDesc.includes("chat not found") || errDesc.includes("chat_id is empty"))) {
      throw new Error("Chat not found: Please ensure your Chat ID is correct and you have sent /start to your bot in Telegram first!");
    }
    if (errCode === 403) {
      if (errDesc.includes("bot can't initiate conversation") || errDesc.includes("not started")) {
        throw new Error("Bot cannot initiate conversation: You must open a chat with your bot in Telegram and press START first!");
      }
      if (errDesc.includes("blocked")) {
        throw new Error("Bot was blocked: Please unblock your bot in Telegram and send /start.");
      }
      throw new Error(`Telegram Forbidden (403): ${errDesc}`);
    }

    throw new Error(`Telegram error (${errCode}): ${errDesc}`);

  } catch (netErr) {
    if (netErr.message && (netErr.message.includes("Unauthorized") || netErr.message.includes("Chat not found") || netErr.message.includes("Bot cannot initiate"))) {
      throw netErr;
    }
    throw new Error(`Telegram network request failed: ${netErr.message}`);
  }
}

/**
 * Send interactive test alert to verify Telegram setup
 */
export async function sendTelegramTestMessage(botToken, chatId) {
  const timeStr = new Date().toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = new Date().toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  const messageHtml = [
    `🚀 <b>Spectra Pipeline Verified!</b>`,
    ``,
    `Your Universiti Malaya SPeCTRUM Telegram alert pipeline is active and working directly with your live student account.`,
    ``,
    `📅 <b>Date:</b> ${dateStr}`,
    `⏰ <b>Time:</b> ${timeStr}`,
    `🟢 <b>Status:</b> Connected &amp; Ready`,
    `🎓 <b>Portal:</b> <a href="https://spectrum.um.edu.my/">SPeCTRUM UM</a>`
  ].join("\n");

  return await sendTelegramMessage(botToken, chatId, messageHtml);
}

/**
 * Format course announcement for Telegram push alert
 */
export function formatAnnouncementTelegram(announcement) {
  const code = escapeHtml(announcement.courseCode || "Course");
  const title = escapeHtml(announcement.subject || "New Announcement");
  const author = escapeHtml(announcement.author || "Instructor");
  const url = announcement.url || "https://spectrum.um.edu.my/";

  return [
    `📢 <b>Spectra Alert: ${code}</b>`,
    `<b>Title:</b> ${title}`,
    `<b>By:</b> ${author}`,
    ``,
    `<a href="${url}">👉 Open Announcement on SPeCTRUM</a>`
  ].join("\n");
}

/**
 * Format submission due date reminder for Telegram push alert (due in 1 day / <24h)
 */
export function formatDeadlineTelegram(deadline) {
  const code = escapeHtml(deadline.courseCode || "Course");
  const title = escapeHtml(deadline.title || "Impending Submission");
  const hoursLeft = Math.max(1, Math.round((deadline.dueTimestamp - Date.now()) / (1000 * 60 * 60)));
  const formattedTime = escapeHtml(deadline.formattedTime || "Soon");
  const url = deadline.url || "https://spectrum.um.edu.my/calendar/view.php";

  const isOneDayExact = hoursLeft >= 23 && hoursLeft <= 25;
  const urgencyText = isOneDayExact
    ? "🔴 Due in exactly 1 day (24 hours)!"
    : `🔴 Due in ~${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}!`;

  return [
    `⏰ <b>Spectra Due Date Reminder: ${code}</b>`,
    `<b>Assignment:</b> ${title}`,
    `<b>Urgency:</b> ${urgencyText}`,
    `<b>Due Date:</b> ${formattedTime}`,
    ``,
    `<a href="${url}">👉 Open Submission Dropbox on SPeCTRUM</a>`
  ].join("\n");
}
