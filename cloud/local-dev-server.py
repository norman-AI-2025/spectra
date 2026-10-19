#!/usr/bin/env python3
"""
Spectra - Universiti Malaya SPeCTRUM Companion
Local Cloud Relay Development Server (Port 8787)
Emulates Cloudflare Worker runtime & KV for local testing with the Chrome extension.
"""

import sys
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

PORT = 8787
DEFAULT_SECRET = "worker-auth-secret-key"

# In-memory KV Store
KV_STORE = {}

class CloudRelayHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def _verify_auth(self):
        auth_header = self.headers.get("Authorization", "")
        if auth_header != f"Bearer {DEFAULT_SECRET}":
            self.send_response(401)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized: Invalid or missing Bearer token"}).encode("utf-8"))
            return False
        return True

    def do_GET(self):
        parsed = urlparse(self.path)

        if not self._verify_auth():
            return

        if parsed.path == "/status":
            record = KV_STORE.get("moodle_session")
            has_session = record is not None and bool(record.get("sessionToken"))
            updated_at = record.get("updatedAt") if record else None

            payload = {
                "status": "online",
                "hasSession": has_session,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(updated_at / 1000)) if updated_at else None,
                "cronSchedule": "Every 15 minutes",
                "server": "Spectra Local Relay Dev Server"
            }

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload, indent=2).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def do_POST(self):
        parsed = urlparse(self.path)

        if not self._verify_auth():
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        try:
            body = json.loads(raw_body.decode("utf-8"))
        except Exception:
            body = {}

        if parsed.path == "/sync":
            session_token = body.get("sessionToken")
            if not session_token:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing sessionToken"}).encode("utf-8"))
                return

            # Store in KV
            KV_STORE["moodle_session"] = {
                "sessionToken": session_token,
                "domain": body.get("domain", "spectrum.um.edu.my"),
                "expires": body.get("expires"),
                "updatedAt": int(time.time() * 1000)
            }

            print(f"[LOCAL RELAY] ✅ Successfully synced MoodleSession: {session_token[:6]}••••••")

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "success": True,
                "message": "MoodleSession synchronized to Cloud Relay KV.",
                "timestamp": int(time.time() * 1000)
            }).encode("utf-8"))
            return

        if parsed.path == "/poll":
            print("[LOCAL RELAY] 🔄 Executing manual SPeCTRUM polling job...")
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "timestamp": int(time.time() * 1000),
                "message": "Manual polling simulated successfully."
            }).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def log_message(self, format, *args):
        # Clean custom logging
        sys.stderr.write(f"[RELAY LOG] {args[0]} - {args[1]} {args[2]}\n")

def run_server():
    server = HTTPServer(("127.0.0.1", PORT), CloudRelayHandler)
    print("=" * 60)
    print(f"🚀 Spectra Cloud Relay Local Server running on http://127.0.0.1:{PORT}")
    print(f"🔑 Expected Bearer Secret: {DEFAULT_SECRET}")
    print(f"📡 Sync Endpoint: http://127.0.0.1:{PORT}/sync")
    print(f"📊 Status Endpoint: http://127.0.0.1:{PORT}/status")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local relay server...")
        server.server_close()

if __name__ == "__main__":
    run_server()
