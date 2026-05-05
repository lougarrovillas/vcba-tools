# vcba-tools

Tools to help the VCBA (Victory Christian Baptist Academy) tech and worship team manage Sunday services through Planning Center Online (PCO) and ProPresenter 7.

---

## 📁 Project Structure

```
vcba-tools/
├── index.html              — Main landing page / service playbook
├── pco-tools/
│   ├── pco-checker.js      — Automated Sunday readiness checker
│   ├── pco-inspector.js    — Manual PCO plan inspector
│   └── workflow.html       — Visual workflow reference guide
├── pp7-guide/
│   └── index.html          — ProPresenter 7 how-to guide
├── pp7-looks/
│   └── index.html          — PP7 looks and styling reference
└── .github/workflows/
    ├── pco-checker.yml     — Scheduled automation for readiness checks
    └── pco-inspector.yml   — Manual trigger for plan inspection
```

---

## 🔧 Tools

### 📋 PCO Sunday Readiness Checker (`pco-checker.js`)
Automatically checks Planning Center Online throughout the week to make sure all Sunday service content is submitted on time. Sends alerts via Discord and email to the Service Coordinator (SC).

**Check Schedule:**
| Day | What it checks |
|---|---|
| Wednesday 9PM PT | Bible verses (Call to Worship, Tithes & Offerings, Benediction) |
| Thursday 9PM PT | Songs (checks for 4 songs entered) |
| Friday 8PM PT | Full status — verses + songs |
| Saturday 2PM PT | Final sweep — verses, songs, announcements, sermon notes/slides |
| Anytime | All-clear notification when everything is complete |

**Required GitHub Secrets:**
- `PCO_APP_ID` — Planning Center API App ID
- `PCO_SECRET` — Planning Center API Secret
- `DISCORD_WEBHOOK` — Discord channel webhook URL
- `GMAIL_APP_PASSWORD` — Gmail app password for email alerts

---

### 🔍 PCO Plan Inspector (`pco-inspector.js`)
A manual tool to inspect any PCO plan and see all its items in detail. Useful for troubleshooting or reviewing a specific Sunday's plan.

**How to run:**
Go to **Actions** → **VCBA PCO Item Inspector** → **Run workflow** → enter a Plan ID (or leave blank for default plans).

---

### 🖥️ ProPresenter 7 Guide (`pp7-guide/`)
Step-by-step video guides for common PP7 tasks including:
- Setting up remote access
- Syncing with Google Drive
- Creating sermon series themes
- Building the Sunday playlist
- Adding Bible verses and song lyrics
- Setting up macros and actions

---

### 🎨 PP7 Looks (`pp7-looks/`)
Visual reference for PP7 looks and slide styling used in services.

---

### 📖 Workflow Guide (`pco-tools/workflow.html`)
A visual reference guide for the full Sunday service workflow from content submission to ProPresenter build.

---

## 🚀 GitHub Pages

This repo is hosted via GitHub Pages. Visit the live site to access all tools from any device.

---

## 🔑 Setup

1. Add the required secrets under **Settings → Secrets and variables → Actions**
2. The PCO checker will run automatically on schedule
3. The PCO inspector can be triggered manually under **Actions**
