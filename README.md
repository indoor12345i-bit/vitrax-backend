# Vitrax Backend — Setup Guide

This runs the gold signal analysis 24/7, independent of any browser being open.
It generates 5 scheduled signals per day, checks for emergency signals every
10 minutes, and manages open trades (breakeven + trailing stop) every 30 seconds.

## What this fixes

Before this backend, signals only generated while someone's browser tab was
open and active. If no tab was open at 9:36am, no signal happened — nothing
was calculated, nothing was saved, nothing was sent anywhere. This backend
runs independently on a server, so signals generate on schedule no matter what.

## Files in this folder

| File | What it does |
|---|---|
| `server.js` | Main entry point — scheduler, API endpoints |
| `calculations.js` | All 16 analysis layers (identical logic to the dashboard) |
| `priceFetcher.js` | The 9-API fallback chain for gold prices |
| `database.js` | Stores signals, prices, trade outcomes in PostgreSQL |
| `tradeManager.js` | Breakeven + trailing stop logic for open trades |
| `package.json` | Dependencies Railway needs to install |
| `railway.json` | Railway deployment config |
| `.env.example` | Template for environment variables (don't commit real `.env`) |

## Setup steps

### 1. Push this code to GitHub

Create a new repository on GitHub (e.g. `vitrax-backend`), then upload all
files in this folder to it. Easiest way if you're not familiar with git:
on GitHub, click "Add file" → "Upload files" → drag all these files in →
commit.

### 2. Create a Railway project

1. Go to railway.app, log in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select the `vitrax-backend` repository you just created
4. Railway will detect it's a Node.js project automatically and start building

### 3. Add a PostgreSQL database

1. In your Railway project, click "New" → "Database" → "Add PostgreSQL"
2. Railway automatically creates a `DATABASE_URL` environment variable and
   makes it available to your backend service — no manual connection string
   needed

### 4. Set environment variables (optional)

The API keys already have defaults baked into `priceFetcher.js`, so this step
is optional unless you want to rotate keys later without redeploying code.
If you want to set them: in Railway, click your service → "Variables" → add
each key from `.env.example`.

### 5. Deploy

Railway deploys automatically after step 2. Check the "Deployments" tab —
once it shows "Success", click "View Logs" and you should see:

```
✅ Database tables ready
========================================
SCHEDULED SIGNAL CHECK — [timestamp]
========================================
✅ Price fetched from gold-api.com: $XXXX.XX
Signal generated: BUY (MODERATE) at $XXXX.XX — confidence XX%
Saved as signal #1

✅ Vitrax backend running on port 3000
Scheduled signals: 00:00, 04:48, 09:36, 14:24, 19:12 daily
Emergency checks: every 10 minutes
Live price + trade management: every 30 seconds
```

### 6. Get your backend's public URL

In Railway, click your service → "Settings" → "Networking" → "Generate Domain".
This gives you a public URL like `vitrax-backend-production.up.railway.app`.

**Send this URL back** — the dashboard needs it to fetch real signals instead
of calculating fresh in-browser.

## Testing it manually

Once deployed, you can test these in your browser or with curl:

```
GET  https://your-url.railway.app/                          → confirms server is alive
GET  https://your-url.railway.app/api/latest-signal          → most recent signal
GET  https://your-url.railway.app/api/signal-history?limit=10 → last 10 signals
GET  https://your-url.railway.app/api/open-trades            → currently open trades
GET  https://your-url.railway.app/api/win-rate               → real win rate once trades close
GET  https://your-url.railway.app/api/live-price             → current gold price
POST https://your-url.railway.app/api/trigger/signal         → force-generate a signal now (for testing)
```

## What's NOT done yet

- The dashboard (`vitrax_final.html`) still calculates signals in-browser —
  it needs to be updated to fetch from `/api/latest-signal` instead. That's
  the next step once this backend is confirmed running.
- Telegram bot delivery (you said skip this for now)
- The win rate won't show real numbers until trades actually open and close
  over the following days — that's expected, not a bug.
