import { google } from "googleapis";
import { getTokens, setTokens, clearTokens } from "./tokenStore.js";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI = "http://localhost:3001/api/auth/google/callback",
  GOOGLE_CALENDAR_ID = "primary",
} = process.env;

// Read-only access to calendar events.
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

export function isConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function oauthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
}

export function authUrl() {
  return oauthClient().generateAuthUrl({
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh token on re-auth
    scope: SCOPES,
  });
}

export async function handleCallback(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  await setTokens("google", tokens);
}

export async function isConnected() {
  return Boolean(await getTokens("google"));
}

export async function disconnect() {
  await clearTokens("google");
}

async function authedClient() {
  const tokens = await getTokens("google");
  if (!tokens) throw new Error("google_not_connected");
  const client = oauthClient();
  client.setCredentials(tokens);
  // Persist refreshed tokens automatically.
  client.on("tokens", (t) => setTokens("google", t));
  return client;
}

/**
 * Today's events from Google Calendar, normalized to the same shape the
 * frontend already expects:
 *   [{ id, title, start: ISO, end: ISO|null, allDay: bool, location: string|null }]
 */
export async function getTodayEvents() {
  const auth = await authedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const { data } = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true, // expand recurring events
    orderBy: "startTime",
  });

  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      const allDay = Boolean(e.start?.date);
      return {
        id: e.id,
        title: e.summary ?? "(no title)",
        location: e.location ?? null,
        allDay,
        start: allDay
          ? new Date(`${e.start.date}T00:00:00`).toISOString()
          : e.start.dateTime,
        end: e.end?.dateTime ?? null,
      };
    });
}
