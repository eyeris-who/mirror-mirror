# Smart Mirror — starter

Minimal, production-shaped starting point for the smart-mirror project.

## Stack (and why)

| Layer | Choice | Reason |
|---|---|---|
| UI | **React + Vite** | Fast dev server, trivial fullscreen build, easy to grow into a portfolio-quality UI. Renders in Chromium kiosk mode on the laptop. |
| Backend | **Node + Express** | One small process that (a) hides API keys, (b) normalizes weather data, (c) will later host the voice/tool-calling layer. Keeps the browser dumb. |
| Weather | **Open-Meteo** | Free, **no API key**, has current conditions + hourly forecast (so "what's it like at 6pm" is a real query, not a guess). |
| Schedule | **Local `schedule.json`** now → Google Calendar later | Lets you build and style the UI today without OAuth. The server endpoint shape won't change when you swap the source. |

The browser only ever talks to your Express server (`/api/*`). Swapping weather providers or calendar sources is a server-only change.

## Run it

```bash
cd smart-mirror
npm install
npm run dev
```

- Web UI: http://localhost:5173
- API: http://localhost:3001/api/weather , /api/schedule

Set your location in `server/.env` (copy from `server/.env.example`). Defaults to NYC.

## What the starter shows

- **Date + time** — live, updates every second (client-side, no network).
- **Weather** — current temperature + condition, plus the forecast for `FORECAST_HOUR` (default 18:00) so you see "sunny / rain at 6pm".
- **Today's schedule** — today's events from `server/data/schedule.json`, sorted by start time.

## Next steps (wired for, not built)

- `server/index.js` is where the voice command router / tool-calling layer plugs in — add `POST /api/command`.
- Replace `getSchedule()` in `server/schedule.js` with a Google Calendar client; keep the return shape.
- Kiosk: `chrome --kiosk --app=http://localhost:5173` on laptop login.
