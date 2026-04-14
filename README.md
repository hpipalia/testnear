# TestNear — HIV & STI Testing Locator

A free, fully bilingual (English/Spanish) public health web app for finding nearby HIV and STI testing sites. Powered by CDC NPIN and HRSA Health Center data.

---

## Features

- 🗺 Interactive Map — Leaflet.js with color-coded pins, popups, directions
- 🇪🇸 Bilingual — Full English + Spanish including quiz, modals, and footer
- 📱 PWA — Installable, offline-capable, service worker caching
- 📅 Booking Detection — Detects online scheduling at Planned Parenthood, Quest, LabCorp, etc.
- ⏰ SMS Reminders — 3/6/12-month reminders via Twilio
- 🔗 Share Clinic — Web Share API + clipboard fallback
- 🧪 Risk Quiz — 5-question CDC-based HIV risk assessment
- 🔒 Privacy-first — No accounts, no tracking, no data stored

## Tech Stack

Backend: Node.js + Express | Frontend: Vanilla HTML/CSS/JS | Map: Leaflet + OpenStreetMap | Data: CDC NPIN + HRSA | SMS: Twilio | Hosting: Render.com

---

## Local Development

```bash
git clone https://github.com/YOUR_USERNAME/testnear.git
cd testnear
npm install
cp .env.example .env
npm start
# Runs at http://localhost:3000
```

---

## Deploy to Render.com

### Step 1 — Push to GitHub

```bash
cd testnear
git init
git add .
git commit -m "TestNear v3.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/testnear.git
git push -u origin main
```

### Step 2 — Create Render Web Service

1. Go to https://render.com and sign in
2. Click New + then Web Service
3. Connect your GitHub repo

### Step 3 — Configure

| Field | Value |
|-------|-------|
| Name | testnear |
| Region | US East (Ohio) |
| Branch | main |
| Runtime | Node |
| Build Command | npm install |
| Start Command | npm start |
| Instance Type | Free |

### Step 4 — Environment Variables

| Key | Value |
|-----|-------|
| NODE_ENV | production |
| ALLOWED_ORIGINS | https://your-app-name.onrender.com |
| ADMIN_TOKEN | (random 32-char string) |
| TWILIO_SID | (optional, for SMS) |
| TWILIO_AUTH | (optional, for SMS) |
| TWILIO_FROM | (optional, for SMS) |

### Step 5 — Deploy

Click Create Web Service. Deploy takes about 2 minutes.
Your app will be live at: https://your-app-name.onrender.com

### Step 6 — Verify

- Health check: https://your-app-name.onrender.com/api/health
- Test search: https://your-app-name.onrender.com/api/search?zip=30303

---

## API

GET /api/health — Server status
GET /api/search?zip=30303&radius=10 — Search testing sites
POST /api/reminder — Schedule SMS reminder
GET /api/share/:id — Shareable clinic link
GET /api/stats — Server stats
POST /api/cache/clear — Clear cache (requires x-admin-token header)

---

## Data Sources

CDC NPIN: https://gettested.cdc.gov
HRSA: https://findahealthcenter.hrsa.gov
Data errors: NPIN@cdc.gov

## Hotlines

National HIV/AIDS: 1-800-232-4636 (24/7 free)
Linea VIH/SIDA: 1-800-344-7432 (24/7 gratis)
SAMHSA: 1-800-662-4357

## License

MIT — free for public health use.
