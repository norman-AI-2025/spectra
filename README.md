# Spectra (SPeCTRUM Companion for Universiti Malaya)

> **Chrome Extension (Manifest V3) with 24/7 Cloud Relay & Instant Telegram Alerts**  
> Tailored specifically for Universiti Malaya students navigating SPeCTRUM (Moodle).

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Universiti Malaya](https://img.shields.io/badge/UM-SPeCTRUM-003366)](https://spectrum.um.edu.my/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_KV-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

---

## ⚡ Key Features

1. **📢 Auto-Announcements & Notices:** Monitors course announcement forums in the background and sends instant push alerts to your phone via **Telegram** so you never miss a lecturer notice. Includes a dedicated **Notices** tab with course filter dropdowns.
2. **⏰ Deadline Radar (< 24 Hours Alert):** Tracks calendar submission cutoffs. Deadlines due within 24 hours trigger urgent Telegram alerts and show animated countdown badges. Persistent checkboxes let you track completed coursework.
3. **📊 Live Attendance & Auto-Checkin:**
   - **Full Discovery (Top to Bottom):** Scrapes every attendance module across your courses, including activities located in weekly sections or at the bottom of the page.
   - **All Tabs Inspected:** Reads Moodle's universal **All tab (`view=5`)** and Group tabs so sessions are never hidden by week/month pagination.
   - **Past Till Current Date Only:** Filters sessions strictly from the start of the semester up to today, excluding future unrecorded sessions from metrics.
   - **Strict Respective Occurrence Auto-Checkin:** Automatically checks into open attendance sessions **strictly matching your registered occurrence (e.g. Occ 1, Occ 2)**. Dispatches instant Telegram confirmations and passcode alerts.
4. **📦 One-Click Week Pack Downloader:** Categorizes slide decks, lab sheets, and tutorial files by week (Week 1 to Week 14) into organized directories: `Downloads/Spectra/{Course_Code}/Week_{N}/`.
5. **☁️ 24/7 Cloud Relay:** When your laptop is closed, sleeping, or off, a lightweight Cloudflare Worker monitors announcements and deadlines in the background and alerts your phone.

---

## 💻 Setup Guide on a Brand New Laptop

Follow these steps to set up Spectra on a fresh computer in less than 5 minutes.

### **Prerequisites**
- Any Chromium browser: **Google Chrome** (recommended), Brave, Edge, or Arc.
- An active Universiti Malaya student account on [SPeCTRUM](https://spectrum.um.edu.my/).

---

### **Step 1: Download & Install Extension**

#### **Option A: Using Git (Recommended for Developers)**
1. Open Terminal and clone the repository:
   ```bash
   git clone https://github.com/norman-AI-2025/spectra.git
   cd spectra
   ```

#### **Option B: Direct Download (No Git Required)**
1. Go to [`https://github.com/norman-AI-2025/spectra`](https://github.com/norman-AI-2025/spectra).
2. Click the green **Code** button → select **Download ZIP**.
3. Extract the ZIP file into a folder on your laptop (e.g. `Documents/spectra`).

---

### **Step 2: Load Extension in Chrome**

1. Open **Google Chrome**.
2. In the address bar, type:
   ```
   chrome://extensions/
   ```
   *(or go to Menu ⋮ → Extensions → Manage Extensions)*.
3. In the top-right corner, turn ON the **"Developer mode"** toggle.
4. Click the **"Load unpacked"** button in the top-left.
5. Select the `spectra` project folder (the folder containing `manifest.json`).
6. **Spectra is installed!** Click the puzzle piece icon 🧩 in Chrome's top toolbar and **Pin 📌 Spectra** for one-click access.

---

### **Step 3: Connect to SPeCTRUM & Configure Occurrences**

1. In Chrome, open and log in to [SPeCTRUM](https://spectrum.um.edu.my/my/).
2. Click the **Spectra** icon in your toolbar.
3. Spectra will automatically detect your active login session and list your enrolled courses.
4. **Set Your Tutorial/Lab Occurrence:**
   - Go to the **Attendance** tab in Spectra.
   - Select your course from the **"Choose Course to Set Occurrence"** dropdown.
   - Enter your registered occurrence number (e.g., `Occ 1`, `Occ 2`, `Group 1`) and click **Save**.
   - Your attendance metrics will now display records strictly matching your occurrence.

---

### **Step 4: Set Up Phone Telegram Alerts**

Get instant push notifications on your phone for new announcements, < 24h deadline reminders, and auto-attendance confirmations.

1. **Create a Free Telegram Bot:**
   - Open the Telegram app on your phone or laptop.
   - Search for [`@BotFather`](https://t.me/BotFather) and send `/newbot`.
   - Give your bot a name (e.g. `MySpectraBot`) and username (e.g. `my_spectra_bot`).
   - Copy the **HTTP API Bot Token** provided (format: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
2. **Find Your Numeric Chat ID:**
   - Search for [`@userinfobot`](https://t.me/userinfobot) on Telegram and send `/start`.
   - Note down your numeric `Id` (e.g., `987654321`).
   - Open your new bot and click **Start** (or send it any message like `hi`).
3. **Configure Spectra Settings:**
   - Click the Spectra extension icon → go to the **Settings** tab.
   - Paste your **Bot Token** and **Chat ID**.
   - Click **"Send Test Telegram"** to verify delivery to your phone.
   - Scroll down and click **"Save Preferences"**.

---

### **Step 5: Set Up 24/7 Cloud Relay on Cloudflare**

Spectra uses Cloudflare Workers to monitor SPeCTRUM announcements, deadlines, and attendance 24/7 in the background—even when your laptop is closed, sleeping, or offline. Setting up your Cloudflare Worker is an essential step of the installation:

1. **Sign Up / Log In to Cloudflare:**
   - Visit [dash.cloudflare.com](https://dash.cloudflare.com/) (100% free account).
2. **Connect Git Repository:**
   - Go to **Workers & Pages** → **Create application** → **Workers** tab → **Connect to Git**.
   - Select your `spectra` repository.
   - Cloudflare will automatically detect [`wrangler.toml`](file:///Users/normanlee/Documents/GitHub/spectra/wrangler.toml) and deploy the worker.
3. **Create & Bind KV Storage:**
   - Go to **Workers & Pages** → **KV** → Click **Create namespace**.
   - Name: `spectra-kv`.
   - Go back to **Workers & Pages** → click your Worker (`spectra-relay`) → **Settings** → **Bindings** (or **Variables & Bindings**).
   - Click **Add** → **KV Namespace**:
     - Variable Name: `SPECTRA_KV` *(must be exact uppercase)*
     - KV Namespace: select `spectra-kv`.
   - Click **Save and deploy**.
4. **Set Worker Secrets:**
   - In Worker **Settings** → **Variables and Secrets**, add:
     - `RELAY_SECRET_KEY`: any password you choose (e.g. `worker-auth-secret-key`)
     - `TELEGRAM_BOT_TOKEN`: your Telegram bot token
     - `TELEGRAM_CHAT_ID`: your Telegram chat ID
   - Click **Save and deploy**.
5. **Connect Spectra Extension:**
   - Copy your worker URL (e.g. `https://spectra-relay.<subdomain>.workers.dev`).
   - Open Spectra → **Settings** → Toggle on **"Enable Cloud Relay Sync"**.
   - **Worker / Lambda Endpoint:**
     ```
     https://spectra-relay.<subdomain>.workers.dev/sync
     ```
     *(Make sure `/sync` is at the end)*.
   - **Bearer Secret Token:** enter the same `RELAY_SECRET_KEY` you configured.
   - Click **"Sync Session Now"**.

---

## 🔄 Updating Spectra in the Future

When updates or new features are pushed to GitHub:

### If you installed via Git:
```bash
cd spectra
git pull origin main
```
Then open `chrome://extensions/` and click the **Reload ↻** icon on the Spectra card.

### If you installed via ZIP:
1. Download the updated ZIP from GitHub and extract it into your `spectra` folder.
2. Go to `chrome://extensions/` and click **Reload ↻** on Spectra.

---

## 📂 Project Architecture

```
spectra/
├── manifest.json              # Manifest V3 configuration & least-privilege permissions
├── popup.html                 # Apple Bento-grid UI (Deadlines, Notices, Attendance, Prep & Settings)
├── popup.css                  # Modern UI styles, responsive cards, micro-animations
├── popup.js                   # Extension frontend controller & reactive UI state manager
├── background.js              # Service worker, periodic alarms, cookie monitor, notifications
├── wrangler.toml              # Cloudflare Worker configuration & 15-minute cron trigger
├── package.json               # Cloudflare build environment declaration
├── utils/
│   ├── moodleApi.js           # Dynamic CSRF sesskey discovery & live enrolled course scraper
│   ├── calendar.js            # Live Moodle AJAX calendar pipeline
│   ├── courses.js             # Live enrolled courses & course announcement forum scrapers
│   ├── attendance.js          # Multi-activity attendance parser, all-tabs reader & auto-submitter
│   ├── telegram.js            # Telegram Bot API dispatcher & message formatting
│   └── parser.js              # DOM & RegEx parser for SPeCTRUM calendar, courses, forums, attendance
├── icons/                     # Vector SVG and PNG extension icons (16, 32, 48, 128px)
└── cloud/
    ├── cloud-relay-worker.js  # Production Cloudflare Worker script for 24/7 background polling
    ├── local-dev-server.py    # Local Python relay server with disk persistence for offline testing
    ├── test-attendance.js     # Comprehensive test suite for attendance parsing & auto-checkin
    ├── test-worker.js         # Cloudflare Worker endpoint test suite
    └── test-telegram.js       # Telegram dispatcher test suite
```

---

## 🛡️ Privacy & Security

- **Direct Communication:** Spectra communicates directly from your browser to Universiti Malaya SPeCTRUM servers and Telegram.
- **Zero Third-Party Tracking:** No passwords, cookies, or student data are ever sent to centralized tracking servers.
- **Manifest V3 Least Privilege:** Requires only essential browser permissions (`cookies` for session discovery, `storage` for settings, `alarms` for background checks, and `downloads` for class prep packs).

---

## 🤝 Support & Feedback

Encountering an issue or have a suggestion?
- Open an [Issue](https://github.com/norman-AI-2025/spectra/issues) on GitHub.
- Contributions and Pull Requests are welcome!