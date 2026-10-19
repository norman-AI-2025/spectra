# Spectra (SPeCTRUM Companion for Universiti Malaya)

> **Chrome Extension (Manifest V3) with Cloud Relay & Telegram Notification Pipeline**  
> Tailored specifically for Universiti Malaya students navigating SPeCTRUM (Moodle).

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Universiti Malaya](https://img.shields.io/badge/UM-SPeCTRUM-003366)](https://spectrum.um.edu.my/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![ntfy.sh](https://img.shields.io/badge/Push-ntfy.sh-059669)](https://ntfy.sh/)

---

## ⚡ Core Pain Points Solved

1. **Missed Announcements & Dedicated Tab:** SPeCTRUM course forum announcements are often buried. Spectra monitors course announcement forums in the background and sends instant push alerts to your phone via **Telegram Bot API** or **ntfy.sh** for every new announcement. Plus, a dedicated **Notices (Announcements)** tab in the popup allows you to browse and filter official notices across all enrolled courses using an interactive subject dropdown bar. Announcements sent to Telegram are permanently flagged (`✈️ Telegram Sent`), ensuring only unflagged notices are sent.
2. **Impending Deadline Reminders (1 Day Before):** Submissions due within 24 hours trigger instant high-priority **Telegram Deadline Radar** alerts to ensure you never miss a submission cutoff. Deadlines sent to Telegram are permanently flagged (`✈️ Telegram Sent`) so you never get spammed with duplicate reminders. In the UI, deadlines are categorized into three urgency tiers:
   - 🔴 **Due in < 24 Hours (1 Day Before):** Pulse badge with dynamic countdown timer (e.g., `5h 42m left`) and automatic Telegram alert.
   - 🟡 **Due This Week:** Amber badge with explicit date and time.
   - 🟢 **Later / Upcoming:** Slate badge.
   - Checkboxes persistently track completed and submitted coursework in `chrome.storage.local`.
3. **Live Attendance & Auto-Checkin (Per-Occurrence Tracking):** A dedicated **Attendance** tab tracks attendance history, taken sessions, and overall attendance rate for every enrolled course on SPeCTRUM.
   - **First Till Current Date Only:** Attendance sessions are strictly filtered from the first semester session up to the current date. Future unrecorded sessions are excluded from the timeline and statistics so metrics accurately reflect coursework taken to date.
   - **Occurrence Setup:** Allows students to specify their registered Occurrence (e.g., `Occ 1`, `Occ 2`, `Group 1`) per subject to filter irrelevant tutorial sessions.
   - **Direct "Open Attendance Page" Deep-Links:** Quick-access buttons in the top action bar, active check-in banner, attendance records header, and individual session cards bring you directly to the live SPeCTRUM attendance view or check-in form in a new browser tab with one click.
   - **Strict Respective Occurrence Auto-Attendance:** Automatically discovers active attendance check-in sessions and **strictly fills attendance ONLY when the session is genuinely OPEN and matches your respective enrolled occurrence**. Sessions belonging to other occurrences (or when occurrence is unconfigured for group-specific classes) are strictly excluded from auto-filling. Instant Telegram confirmations and password alerts are dispatched when attendance is recorded or requires a lecturer passcode.
4. **Pre-Class Rush:** Slide decks, tutorial sheets, and lab files are organized by academic week (Week 1 to Week 14). With the **"Download Week Pack"** button, Spectra automatically downloads and categorizes all materials into structured directories:
   ```
   Downloads/Spectra/{Course_Code}/Week_{N}/
   ```
5. **24/7 Cloud Relay:** When your laptop is shut down or sleeping, Spectra can synchronize your active `MoodleSession` token to a lightweight external serverless worker (e.g. Cloudflare Worker or AWS Lambda) so you never miss an announcement even over the weekend.

---

## 🎨 UI & Design Aesthetics

- **Aesthetic:** Apple-inspired Bento-grid layout with a light, refined academic aesthetic.
- **Color Palette:**
  - Base: Slate-50 background (`#F8FAFC`), crisp white surface cards (`#FFFFFF`), Slate-200 borders (`#E2E8F0`).
  - Text: Slate-900 primary, Slate-500 secondary.
  - Accents: Deep Indigo/Violet (`#6366F1`) for active tabs, Emerald-600 (`#059669`) for completed/submitted tasks, Rose-500 (`#F43F5E`) for urgent deadlines (< 24h), Amber-500 (`#F59E0B`) for week deadlines (< 7d).
- **Typography:** `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif`.
- **Dimensions:** Fixed popup `width: 450px`, `min-height: 580px`, `rounded-2xl` container styling.

---

## 📂 Project Architecture

```
spectra/
├── manifest.json              # Manifest V3 configuration & permissions
├── popup.html                 # Apple Bento-grid UI with Deadlines, Notices, Attendance, Class Prep & Settings tabs
├── popup.css                  # Custom styling, transitions, urgency pulse animations, attendance cards
├── popup.js                   # Live zero-mock controller, week selector, occurrence setup, auto-attendance
├── background.js              # Service worker, alarms, cookie listener, attendance checker, Telegram/ntfy dispatch
├── utils/
│   ├── moodleApi.js           # Dynamic CSRF sesskey discovery & live enrolled course scraper
│   ├── calendar.js            # Live Moodle AJAX calendar pipeline (core_calendar_get_action_events_by_timesort)
│   ├── courses.js             # Live enrolled courses & course announcement forum scrapers
│   ├── attendance.js          # Live mod_attendance parser, occurrence filter, auto-attendance submitter
│   ├── telegram.js            # Robust Telegram API dispatcher, HTML/plain fallback, token sanitizer
│   └── parser.js              # Resilient DOM & RegEx parser for SPeCTRUM calendar, courses, forums, attendance
├── icons/                     # Extension icons (16, 32, 48, 128px & SVG vector)
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   ├── icon128.png
│   └── icon.svg
└── cloud/
    ├── cloud-relay-worker.js  # Production Cloudflare Worker script for 24/7 cloud polling
    ├── test-telegram.js       # Test suite for Telegram dispatcher & sanitization
    ├── test-worker.js         # Test suite for cloud relay endpoints
    └── test-attendance.js     # Test suite for attendance parsing, occurrence matching, & form submission
```

---

## 🚀 Installation Guide

### 1. Load Extension in Chrome

1. Clone or download this repository:
   ```bash
   git clone https://github.com/norman-AI-2025/spectra.git
   ```
2. Open Google Chrome (or any Chromium browser such as Brave, Edge, or Arc).
3. Navigate to `chrome://extensions/`.
4. Enable **Developer mode** toggle in the top-right corner.
5. Click **"Load unpacked"** and select the `/Users/normanlee/Documents/GitHub/spectra` directory.
6. Spectra is now installed! Pin it to your Chrome toolbar for one-click access.

---

## 📱 Setting Up Phone Notifications

### Option A: Telegram Bot API (Recommended)

1. **Create a Bot:**
   - Open Telegram and search for [`@BotFather`](https://t.me/BotFather).
   - Send `/newbot`, choose a name (e.g. `MySpectraBot`) and username.
   - Copy the HTTP API token provided (format: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
2. **Find Your Chat ID:**
   - Search for [`@userinfobot`](https://t.me/userinfobot) on Telegram and send `/start`.
   - It will reply with your numeric `Id` (e.g., `987654321`).
   - Send at least one message or `/start` to your new bot.
3. **Configure Spectra:**
   - Open Spectra -> Navigate to the **Settings** tab.
   - Paste your **Bot Token** and **Chat ID**.
   - Click **"Send Test Telegram"** to verify instant delivery!

---

## ☁️ 24/7 Cloud Relay Setup (Optional)

When your laptop is asleep, Spectra's local background alarms pause. To enable 24/7 polling from the cloud:

1. Create a free account at [Cloudflare Workers](https://workers.cloudflare.com/).
2. Create a new Worker using the provided script at [`cloud/cloud-relay-worker.js`](file:///Users/normanlee/Documents/GitHub/spectra/cloud/cloud-relay-worker.js).
3. Bind a KV namespace named `SPECTRA_KV`.
4. Set Worker Secrets:
   - `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
   - `TELEGRAM_CHAT_ID`: Your Telegram chat ID
   - `RELAY_SECRET_KEY`: A custom passphrase for Bearer authentication
5. Add a Cron Trigger for `*/15 * * * *` (every 15 minutes).
6. In Spectra -> **Settings** -> Toggle **"Enable Cloud Relay Sync"**, paste your worker URL (`https://your-worker.workers.dev/sync`) and secret key, then click **"Sync Session Now"**.
7. Spectra will now automatically keep the cloud worker synchronized with your active `MoodleSession` cookie whenever you browse SPeCTRUM!

---

## 🔒 Zero-Mock Live Production Architecture

Spectra operates on a **zero-mock architecture**:
- **No Dummy Data:** Zero static arrays, hardcoded courses, or simulated timeouts.
- **Dynamic Session Discovery:** Automatically discovers the active CSRF `sesskey`, student name, and avatar directly from `https://spectrum.um.edu.my/my/` using `credentials: 'include'`.
- **Live AJAX Calendar:** Direct calls to Moodle's native `core_calendar_get_action_events_by_timesort` service for millisecond-accurate submission deadlines.
- **Session Disconnected State:** If your session expires or redirects to SSO, Spectra immediately presents a dedicated login prompt with a direct link to re-authenticate.

---

## 🛡️ Privacy & Security

- **Direct Connections:** All communication with Universiti Malaya SPeCTRUM and Telegram/ntfy occurs directly from your browser client or your own private serverless worker.
- **Zero Third-Party Tracking:** Spectra does not transmit credentials, passwords, or course materials to any centralized server.
- **Standard Chrome Permissions:** Adheres strictly to Manifest V3 least-privilege standards (`cookies`, `storage`, `alarms`, `downloads`).