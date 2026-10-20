# Spectra (SPeCTRUM Companion for Universiti Malaya)

> **Modern Chrome Extension (Manifest V3) with 24/7 Cloud Relay & Instant Telegram Push Notifications**  
> Tailored specifically for Universiti Malaya students navigating SPeCTRUM (Moodle).

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Universiti Malaya](https://img.shields.io/badge/UM-SPeCTRUM-003366)](https://spectrum.um.edu.my/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Donate: DuitNow](https://img.shields.io/badge/Donate-DuitNow_QR-ED1C24.svg)](#-support--donations)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_KV-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

---

## ⚡ Key Features

1. **📢 24/7 Course Announcements & Forum Radar:**
   - Continuously monitors lecturer announcements across all your enrolled courses.
   - Pushes instant alerts to your phone via **Telegram** so you never miss a cancelled class, venue change, or exam notice.
   - Includes a dedicated **Notices** tab in the extension with instant search and course filters.

2. **⏰ Top-to-Bottom Submission Deadlines & Occurrence Filter:**
   - **Full Course Discovery:** Queries Moodle's Assignment Overview (`/mod/assign/index.php`) and scans each course page top-to-bottom (`/course/view.php`) to catch all dropboxes, online quizzes, workshops, and Turnitin assignments—including bottom project dropboxes in Week 14.
   - **Respective Occurrence Filtering:** Group-specific assignments (e.g. *Lab 1 Occ 2*) are strictly excluded if you are in *Occ 1*, while universal assignments (*All students*) and your group's submissions are included.
   - **Urgency Badges & < 24h Alerts:** Automatically flags submissions due within 24 hours (`urgent`), this week, or upcoming. Dispatches urgent phone alerts via Telegram before deadlines close.
   - **Submission Tracking:** Detects if an assignment has already been submitted on SPeCTRUM, with persistent checkboxes to mark completed work.

3. **📊 Live Attendance & Intelligent Auto-Checkin:**
   - **Full Discovery (Top to Bottom):** Discovers all attendance instances across your courses, whether located in top lecture sections, weekly blocks, or the bottom of the course page.
   - **All Tabs Inspected (`view=5`):** Bypasses Moodle's week/month pagination by querying the universal **All** tab and group tabs.
   - **Past Till Current Date Only:** Automatically displays sessions from the semester start up to the current date. Shows scheduled sessions for today (even if scheduled for later in the day), while excluding unrecorded future sessions.
   - **Strict Occurrence Auto-Checkin:** When check-in opens, Spectra auto-records your attendance as *Present* **strictly for your registered occurrence (e.g. Occ 1, Occ 2)**.
   - **Passcode Support & Telegram Confirmations:** Automatically submits teacher passwords if configured, or sends a Telegram alert requesting the password if required.

4. **📦 One-Click Week Pack Downloader:**
   - Automatically discovers and categorizes lecture slides, lab sheets, and tutorial worksheets by week (Week 1 to Week 14).
   - Generates neatly structured downloads: `Downloads/Spectra/{Course_Code}/Week_{N}/`.

5. **☁️ 24/7 Cloud Relay (Hybrid Architecture):**
   - Works hand-in-hand with the Chrome extension.
   - When your laptop is open, the extension gives you a fast, responsive desktop hub.
   - When your laptop is sleeping, turned off, or you are away from your desk, a lightweight Cloudflare Worker monitors announcements, deadlines, and auto-submits attendance 24/7 in the cloud.

---

## 💻 Setup Guide on a Brand New Laptop

Follow this complete step-by-step walkthrough to get Spectra up and running on a fresh computer in under 5 minutes.

### **Prerequisites**
- Any modern Chromium browser: **Google Chrome** (recommended), Brave, Microsoft Edge, or Arc.
- An active Universiti Malaya student account on [SPeCTRUM](https://spectrum.um.edu.my/).
- A free [Telegram](https://telegram.org/) account on your phone or computer (for push alerts).
- A free [Cloudflare](https://dash.cloudflare.com/) account (for 24/7 background duties when your laptop is off).

---

### **Step 1: Download the Extension Code**

Choose either Option A or Option B:

#### **Option A: Using Git (Fastest & Easiest to Update)**
1. Open your terminal (**Terminal** on macOS, **PowerShell** / **Git Bash** on Windows).
2. Clone the repository and enter the directory:
   ```bash
   git clone https://github.com/norman-AI-2025/spectra.git
   cd spectra
   ```

#### **Option B: Direct ZIP Download (No Git Required)**
1. In your browser, open: [`https://github.com/norman-AI-2025/spectra`](https://github.com/norman-AI-2025/spectra).
2. Click the green **Code** button and select **Download ZIP**.
3. Extract the downloaded ZIP file to a permanent location on your laptop (for example: `Documents/spectra`).

---

### **Step 2: Load Spectra into Chrome**

1. Open **Google Chrome**.
2. In the URL address bar, enter:
   ```
   chrome://extensions/
   ```
   *(Or click Chrome Menu ⋮ → Extensions → Manage Extensions)*.
3. In the top-right corner, switch the **"Developer mode"** toggle to **ON**.
4. In the top-left corner, click the **"Load unpacked"** button.
5. In the file picker, select the `spectra` directory (the folder containing [`manifest.json`](file:///Users/normanlee/Documents/GitHub/spectra/manifest.json)).
6. **Spectra is now installed!**
7. Click the Chrome toolbar **puzzle icon** (Extensions) 🧩 and click the **Pin 📌** icon next to Spectra so it stays visible in your toolbar.

---

### **Step 3: Connect to SPeCTRUM & Configure Your Occurrences**

> [!NOTE]
> You **do NOT need to manually copy or paste your MoodleSession cookie**. Spectra securely discovers your active session automatically through standard Chrome browser cookie permissions.

1. In Chrome, navigate to [SPeCTRUM](https://spectrum.um.edu.my/my/) and log in with your UM student credentials.
2. Click the **Spectra** extension icon in your browser toolbar.
3. Spectra will automatically detect your login, fetch your name, and list all your currently enrolled courses.
4. **Set Your Tutorial / Lab Occurrence:**
   - Click the **Attendance** tab in Spectra.
   - In the **"Choose Course to Set Occurrence"** dropdown, select your course.
   - Enter your registered occurrence number (e.g. `Occ 1`, `Occ 2`, `Group 1`) and click **Save**.
   - Repeat for your other enrolled courses.
5. **What this does:**
   - Filters attendance sessions to strictly reflect your class group.
   - Filters submission deadlines so you only see dropboxes relevant to your occurrence.
   - Configures the auto-attendance bot to strictly check into your class sessions.

---

### **Step 4: Set Up Phone Telegram Alerts**

Receive real-time push notifications on your phone whenever an instructor posts an announcement, when an assignment is due in less than 24 hours, or when an attendance check-in is recorded.

1. **Create Your Telegram Bot:**
   - Open Telegram on your phone or desktop.
   - Search for [`@BotFather`](https://t.me/BotFather) (verified bot with blue checkmark) and send `/newbot`.
   - Choose a display name (e.g. `My Spectra Bot`) and a username ending in `bot` (e.g. `norman_spectra_bot`).
   - BotFather will reply with your **HTTP API Bot Token** (looks like `7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). Copy this token.
2. **Find Your Telegram Chat ID:**
   - Search for [`@userinfobot`](https://t.me/userinfobot) on Telegram and send `/start`.
   - It will reply with your numeric `Id` (e.g. `987654321`). Copy this number.
   - Open your newly created bot in Telegram and click **Start** (or send any message like `hello`).
3. **Save in Spectra:**
   - Open the Spectra extension → click the **Settings** tab.
   - Paste your **Bot Token** and **Chat ID**.
   - Click **"Send Test Telegram"** — you should immediately hear a ping on your phone!
   - Scroll to the bottom and click **"Save Preferences"**.

---

### **Step 5: Set Up 24/7 Cloud Relay on Cloudflare**

To enable attendance auto-filling, deadline alerts, and announcement notifications even when your laptop is turned off or sleeping, set up your free Cloudflare Worker:

1. **Sign Up / Log In to Cloudflare:**
   - Go to [dash.cloudflare.com](https://dash.cloudflare.com/) (free tier).
2. **Create the Worker Application:**
   - **Method A (Recommended - Connected to Git):**
     - Go to **Workers & Pages** → **Create application** → **Workers** tab → **Connect to Git**.
     - Select your `spectra` repository. Cloudflare will read [`wrangler.toml`](file:///Users/normanlee/Documents/GitHub/spectra/wrangler.toml) and deploy the worker automatically.
   - **Method B (Direct Paste / Web Editor):**
     - Go to **Workers & Pages** → **Create application** → **Create Worker**.
     - Name it `spectra-relay` and click **Deploy**.
     - Click **Edit code**, select all text, and paste the code from [`cloud/cloud-relay-worker.js`](file:///Users/normanlee/Documents/GitHub/spectra/cloud/cloud-relay-worker.js).
     - Click **Deploy** / **Save and Deploy**.
3. **Create & Bind KV Storage:**
   - In Cloudflare, navigate to **Workers & Pages** → **KV** → Click **Create namespace**.
   - Namespace Name: `spectra-kv` → click **Add**.
   - Navigate back to **Workers & Pages** → click your worker (`spectra-relay`) → **Settings** → **Bindings** (or **Variables and Bindings**).
   - Under **KV Namespace Bindings**, click **Add**:
     - Variable Name: `SPECTRA_KV` *(must be exact uppercase)*
     - KV Namespace: select `spectra-kv`
   - Click **Save and deploy**.
4. **Configure Worker Environment Secrets:**
   - In your worker's **Settings** → **Variables and Secrets**, click **Add** under **Environment Variables / Secrets**:
     - `RELAY_SECRET_KEY`: any private password of your choice (e.g. `my-spectra-secret-2026`)
     - `TELEGRAM_BOT_TOKEN`: your Telegram bot token from Step 4
     - `TELEGRAM_CHAT_ID`: your numeric Telegram chat ID from Step 4
   - Click **Save and deploy**.
5. **Verify the 15-Minute Cron Trigger:**
   - In worker **Settings** → **Triggers**, verify that a Cron Trigger `*/15 * * * *` is active.
   - *(If missing, click **Add Cron Trigger** and enter `*/15 * * * *`)*.
6. **Connect the Extension to Cloudflare:**
   - Copy your worker URL (e.g. `https://spectra-relay.<your-subdomain>.workers.dev`).
   - Open Spectra → **Settings** → toggle **"Enable Cloud Relay Sync"** to ON.
   - **Worker / Lambda Endpoint:**
     ```
     https://spectra-relay.<your-subdomain>.workers.dev/sync
     ```
     *(Ensure `/sync` is included at the end)*.
   - **Bearer Secret Token:** enter the `RELAY_SECRET_KEY` you created above.
   - Click **"Sync Session Now"**.
   - You will see the confirmation toast: *"MoodleSession synced to Cloud Relay!"*

---

## 🔄 Updating Spectra in the Future

When new features or bug fixes are released on GitHub:

### If You Installed via Git:
```bash
cd spectra
git pull origin main
```
Then open `chrome://extensions/` and click the **Reload ↻** button on the Spectra card.

### If You Installed via ZIP:
1. Download the updated ZIP from GitHub.
2. Extract and replace the files in your `spectra` folder.
3. Open `chrome://extensions/` and click **Reload ↻** on Spectra.

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>1. Will using Cloudflare disable any features in my extension?</b></summary>
<br>
<b>No.</b> All extension features (1-Click slide downloads, popup UI, deadlines radar, dark mode, in-browser check-in) remain 100% functional. Cloudflare acts purely as an additive background companion when your computer is closed.
</details>

<details>
<summary><b>2. What happens when my Moodle session expires?</b></summary>
<br>
Moodle sessions periodically expire after several days of inactivity. When this occurs:
- The Spectra extension badge will indicate <i>Session Expired</i>.
- If Cloudflare is running, it will send a friendly Telegram notice: <i>"Your UM SPeCTRUM session has expired. Please open SPeCTRUM in your browser to renew your login."</i>
- Simply open <a href="https://spectrum.um.edu.my/my/">SPeCTRUM</a> in Chrome and log in. Spectra will automatically capture the renewed session and push it to Cloudflare.
</details>

<details>
<summary><b>3. How does Spectra know which class attendance or deadline belongs to me?</b></summary>
<br>
In Step 3, you configure your occurrence (e.g. <code>Occ 1</code>). Spectra's matching engine isolates group headers, descriptions, and activity titles:
- Sessions matching <code>Occ 1</code> or universal sessions (<code>All students</code>) are included.
- Sessions for other occurrences (e.g. <code>Occ 2</code>) are strictly excluded from metrics, attendance calculations, and auto-submission.
</details>

<details>
<summary><b>4. What if a lecturer sets an attendance password?</b></summary>
<br>
You can save known class attendance passwords per course in the <b>Attendance</b> tab. If a password is required and already configured, Spectra auto-fills it. If no password has been entered, Spectra pauses and sends a Telegram alert informing you that a passcode is required.
</details>

<details>
<summary><b>5. How do I test that my Cloudflare worker is functioning?</b></summary>
<br>
In your browser, visit:
<code>https://spectra-relay.&lt;your-subdomain&gt;.workers.dev/status</code> with your Authorization header, or click <b>"Sync Session Now"</b> in Spectra settings. You can also trigger a test poll via curl:
<pre>curl -X POST https://spectra-relay.&lt;your-subdomain&gt;.workers.dev/poll -H "Authorization: Bearer &lt;your-secret-key&gt;"</pre>
</details>

---

## 📂 Project Architecture

```
spectra/
├── manifest.json              # Chrome Manifest V3 declaration & permission boundaries
├── popup.html                 # Apple Bento-grid dashboard (Deadlines, Notices, Attendance, Prep & Settings)
├── popup.css                  # Curated styling, responsive layouts, micro-animations
├── popup.js                   # Extension frontend controller & reactive state manager
├── background.js              # Service worker, periodic alarms, cookie monitor, notifications
├── wrangler.toml              # Cloudflare Worker configuration & 15-minute cron trigger
├── package.json               # Cloudflare & Node runtime declaration
├── utils/
│   ├── moodleApi.js           # Dynamic CSRF sesskey discovery & live enrolled course scraper
│   ├── calendar.js            # Live Moodle AJAX calendar pipeline & deadline deduplication
│   ├── courses.js             # Live enrolled courses & course announcement forum scrapers
│   ├── attendance.js          # Multi-activity attendance parser, all-tabs reader & auto-submitter
│   ├── telegram.js            # Telegram Bot API dispatcher, formatting & sanitization
│   └── parser.js              # DOM & RegEx parser for calendar, courses, forums, dropboxes, attendance
├── icons/                     # Extension icons (16px, 32px, 48px, 128px)
└── cloud/
    ├── cloud-relay-worker.js  # Production Cloudflare Worker script for 24/7 background polling
    ├── local-dev-server.py    # Local Python relay server for offline testing
    ├── test-deadlines.js      # Unit tests for top-to-bottom dropboxes & occurrence filtering
    ├── test-attendance.js     # Comprehensive test suite for attendance parsing & auto-checkin
    ├── test-worker.js         # Cloudflare Worker endpoint & cron execution test suite
    └── test-telegram.js       # Telegram dispatcher & entity escaping test suite
```

---

## 🛡️ Privacy & Security

- **Direct Communication:** Spectra operates client-side directly between your browser, Universiti Malaya's official SPeCTRUM servers, and the Telegram Bot API.
- **Zero Third-Party Tracking:** No passwords, cookies, or student analytics are sent to external third parties.
- **Least-Privilege MV3 Security:** Uses only the minimal required browser permissions (`cookies` for session discovery on `spectrum.um.edu.my`, `storage` for local preferences, `alarms` for background timers, and `downloads` for class prep packs).
- **Private Cloud Worker:** Your Cloudflare Worker runs entirely inside your personal Cloudflare account, protected by a Bearer secret token.

---

## 🤝 Support & Feedback

Encountering an issue or have a suggestion?
- Open an [Issue](https://github.com/norman-AI-2025/spectra/issues) on GitHub.
- Contributions and Pull Requests are welcome!

---

## ☕ Support & Donations

Spectra is an independent open-source project created with ❤️ to empower Universiti Malaya students to stay on top of coursework, attendance, and deadlines.

If Spectra saved you from an absent mark, helped you organize your semester lecture slides in one click, or alerted you to an urgent midnight submission, consider buying me a coffee or supporting future development!

<div align="center">

<img src="assets/duitnow-qr.png" alt="DuitNow QR - Malaysia National QR" width="260" />

<br>

**Scan to support via DuitNow QR**  
*Compatible with **Touch 'n Go eWallet**, **MAE by Maybank**, **GrabPay**, **ShopeePay**, **CIMB OCTO**, and all Malaysian Banking Apps.*

Every contribution directly helps cover serverless relay hosting and supports ongoing feature development for UM students! ❤️

</div>

---

## 📄 License

This project is licensed

```text
Copyright (c) 2026 Norman Lee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software...
```