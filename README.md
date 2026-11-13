# Contest Proctoring System

A cross-platform OS-level proctoring system designed for programming contests. The system enforces contest integrity by monitoring active processes and windows, reporting violations, and securely delivering the contest password only to participants who are actively running the proctoring daemon.

## Architecture

This monorepo consists of three main components:

1. **Daemon (`/daemon`)**: A Go-based desktop client that participants run locally. It monitors processes and active windows against a blacklist (e.g., VS Code, Cursor, ChatGPT). It generates a secure Session Token and sends a telemetry heartbeat to the backend every 10 seconds.
2. **Backend (`/backend`)**: A Node.js/Express server that acts as a registry. It receives heartbeats and handles the pairing between a Codeforces handle and an active Session Token.
3. **Frontend (`/frontend`)**: A lightweight web portal where participants input their Codeforces handle and Session Token to receive the secret contest password.

## Setup Instructions

### 1. Backend Server
```bash
cd backend
npm install
npm start
```
*Runs by default on `http://localhost:8080`.*

### 2. Frontend Portal
```bash
cd frontend
npx serve .
```
*Navigate to the provided local URL to access the pairing portal.*

### 3. Desktop Daemon
To build the daemon, you can use the provided bash script:
```bash
chmod +x comp.sh
./comp.sh
```
Or build manually:
```bash
cd daemon
go mod tidy
go build -o monitor .
```

## How to Participate

1. Run the `monitor-win.exe` (Windows) or `monitor-linux` (Linux) binary on your machine.
2. Leave the terminal window open. Note the **Session Token** displayed in cyan.
3. Navigate to the Frontend Portal.
4. Enter your Codeforces handle and the Session Token.
5. Click "Get Contest Password" to receive the contest access code.

> **⚠️ Note to Windows Users:** Because this application uses `user32.dll` to read active window titles and scans running processes, Windows Defender or other antivirus software may falsely flag it as suspicious. If this occurs, please add an exclusion for the binary in your antivirus settings during the contest duration.
