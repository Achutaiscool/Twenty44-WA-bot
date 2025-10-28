// utils/googleCalendar.js
import dotenv from "dotenv";
dotenv.config();

import { google } from "googleapis";

/**
 * Google Calendar helper
 * - Loads env at runtime (dotenv.config() above)
 * - Exports: ensureAuth, getBusyForRange, getAvailableSlotsForDate, createEvent
 */

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID = "primary",
  GOOGLE_DEFAULT_TIMEZONE = "Asia/Kolkata",
} = process.env;

const required = [];
if (!GOOGLE_CLIENT_ID) required.push("GOOGLE_CLIENT_ID");
if (!GOOGLE_CLIENT_SECRET) required.push("GOOGLE_CLIENT_SECRET");
if (!GOOGLE_REFRESH_TOKEN) required.push("GOOGLE_REFRESH_TOKEN");
if (required.length) {
  console.warn("⚠️ Missing Google Calendar credentials in .env:", required.join(", "));
}

function createOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
}

/**
 * Ensure we have an authenticated OAuth2 client (refresh access token using refresh token)
 */
export async function ensureAuth() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth credentials (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env).");
  }

  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  try {
    // Attempt to obtain an access token via refresh token
    const res = await oAuth2Client.getAccessToken();
    // res can be an object { token: '...' } or a string in some versions
    if (!res || (!res.token && !oAuth2Client.credentials?.access_token)) {
      // try explicit refresh (older client versions)
      if (typeof oAuth2Client.refreshToken === "function") {
        await oAuth2Client.refreshToken(GOOGLE_REFRESH_TOKEN);
      }
    }
    return oAuth2Client;
  } catch (err) {
    const info = err?.response?.data || err?.message || err;
    throw new Error(`Failed to refresh Google access token: ${JSON.stringify(info)}`);
  }
}

/** convert local date/time (YYYY-MM-DD and HH:MM) to UTC ISO string using timezone offset map */
function getTimezoneOffsetMinutes(tz = GOOGLE_DEFAULT_TIMEZONE) {
  const map = { "Asia/Kolkata": 330, UTC: 0 };
  return map[tz] ?? 0;
}
function localDateTimeToUTCISO(dateISO, timeHHMM, tz = GOOGLE_DEFAULT_TIMEZONE) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const [hh, mm] = timeHHMM.split(":").map(Number);
  // build as if local, then subtract offset minutes to get UTC instant
  const localMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = getTimezoneOffsetMinutes(tz);
  const utcMs = localMs - offset * 60 * 1000;
  return new Date(utcMs).toISOString();
}

export async function getBusyForRange(timeMinISO, timeMaxISO) {
  const auth = await ensureAuth();
  const calendar = google.calendar({ version: "v3", auth });
  try {
    const resp = await calendar.freebusy.query({
      requestBody: { timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: GOOGLE_CALENDAR_ID }] },
    });
    return resp.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [];
  } catch (err) {
    console.error("Google freebusy error:", err?.response?.data || err?.message || err);
    throw err;
  }
}

/**
 * Returns array of available slots for given date (YYYY-MM-DD)
 * Default template slots can be overridden via options.templateSlots
 */
export async function getAvailableSlotsForDate(dateISO, options = {}) {
  const timezone = options.timezone || GOOGLE_DEFAULT_TIMEZONE;
  const templateSlots = options.templateSlots || [
    { start: "18:00", end: "19:00" },
    { start: "19:00", end: "20:00" },
    { start: "20:00", end: "21:00" },
  ];

  try {
    const dayStart = localDateTimeToUTCISO(dateISO, "00:00", timezone);
    const dayEnd = localDateTimeToUTCISO(dateISO, "23:59", timezone);

    const busy = await getBusyForRange(dayStart, dayEnd);
    const overlaps = (sISO, eISO) =>
      busy.some((b) => !(new Date(eISO) <= new Date(b.start) || new Date(sISO) >= new Date(b.end)));

    const available = templateSlots
      .map((t) => {
        const sISO = localDateTimeToUTCISO(dateISO, t.start, timezone);
        const eISO = localDateTimeToUTCISO(dateISO, t.end, timezone);
        return overlaps(sISO, eISO) ? null : `${t.start} - ${t.end}`;
      })
      .filter(Boolean);

    return available;
  } catch (err) {
    console.error("getAvailableSlotsForDate error", err?.message || err);
    throw err;
  }
}

/**
 * Create an event and return the API response
 * slot: string "HH:MM - HH:MM" or "HH:MM-HH:MM"
 */
export async function createEvent({ dateISO, slot, summary = "Booking", description = "", attendees = [] }) {
  const auth = await ensureAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const [startTime, endTime] = slot.split("-").map((s) => s.trim());
  const startISO = localDateTimeToUTCISO(dateISO, startTime);
  const endISO = localDateTimeToUTCISO(dateISO, endTime);

  const event = {
    summary,
    description,
    start: { dateTime: startISO, timeZone: GOOGLE_DEFAULT_TIMEZONE },
    end: { dateTime: endISO, timeZone: GOOGLE_DEFAULT_TIMEZONE },
    attendees: (attendees || []).map((e) => ({ email: e })),
  };

  try {
    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: event,
    });
    return res.data;
  } catch (err) {
    console.error("createEvent error:", err?.response?.data || err?.message || err);
    throw err;
  }
}

// default export optional (not required)
export default { ensureAuth, getBusyForRange, getAvailableSlotsForDate, createEvent };
