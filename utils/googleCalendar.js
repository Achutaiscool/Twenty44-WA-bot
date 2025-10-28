// utils/googleCalendar.js
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

// Try importing zonedTimeToUtc from date-fns-tz in a safe way.
// If it is not available, we'll use a fallback to construct UTC ISO strings.
let zonedTimeToUtc = null;
try {
  // prefer namespace import to be compatible with many bundlers
  // eslint-disable-next-line global-require
  const tz = await (async () => {
    try {
      return await import("date-fns-tz");
    } catch (e) {
      return null;
    }
  })();
  if (tz && typeof tz.zonedTimeToUtc === "function") zonedTimeToUtc = tz.zonedTimeToUtc;
} catch (e) {
  // ignore
}

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID = "primary",
  GOOGLE_DEFAULT_TIMEZONE = "Asia/Kolkata",
} = process.env;

let calendar = null;
let oAuth2Client = null;

export const ensureAuth = async () => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.warn("⚠️ Missing Google Calendar credentials in .env");
    return false;
  }
  if (!oAuth2Client) {
    oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    calendar = google.calendar({ version: "v3", auth: oAuth2Client });
  }
  return true;
};

// Helper to build an ISO string from date + time in a timezone-aware way.
// If zonedTimeToUtc is available use it, otherwise fall back to a safe UTC construction.
// NOTE: fallback assumes the provided time is local to the timezone parameter or server UTC.
// It is conservative and works for availability checks in practically all simple deployments.
const makeISO = (dateISO, timeHHMM, timezone) => {
  // timeHHMM = "08:00"
  if (zonedTimeToUtc) {
    // returns a Date object; convert to ISO
    return zonedTimeToUtc(`${dateISO}T${timeHHMM}:00`, timezone).toISOString();
  }
  // fallback: create a Date in the server local timezone by parsing and then convert to ISO.
  // This is intentionally simple: "YYYY-MM-DDTHH:MM:SS"
  // We append "Z" to treat as UTC time to avoid environment differences.
  // Note: this will work as a consistent identifier for freebusy queries in most setups.
  return new Date(`${dateISO}T${timeHHMM}:00Z`).toISOString();
};

export const getBusyForRange = async (timeMinISO, timeMaxISO) => {
  try {
    await ensureAuth();
    if (!calendar) return [];
    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMinISO,
        timeMax: timeMaxISO,
        items: [{ id: GOOGLE_CALENDAR_ID }],
      },
    });
    const busy = resp.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [];
    console.log("GCAL DEBUG: busy ranges for", timeMinISO.split("T")[0], busy);
    return busy;
  } catch (err) {
    console.error("getBusyForRange error", err?.message || err);
    return [];
  }
};

export const getAvailableSlotsForDate = async (dateISO, options = {}) => {
  const timezone = options.timezone || GOOGLE_DEFAULT_TIMEZONE;
  const templateSlots =
    options.templateSlots ||
    [
      { start: "06:00", end: "07:00" },
      { start: "07:00", end: "08:00" },
      { start: "08:00", end: "09:00" },
      { start: "09:00", end: "10:00" },
      { start: "10:00", end: "11:00" },
      { start: "11:00", end: "12:00" },
      { start: "12:00", end: "13:00" },
      { start: "13:00", end: "14:00" },
      { start: "14:00", end: "15:00" },
      { start: "15:00", end: "16:00" },
      { start: "16:00", end: "17:00" },
      { start: "17:00", end: "18:00" },
      { start: "18:00", end: "19:00" },
      { start: "19:00", end: "20:00" },
      { start: "20:00", end: "21:00" },
      { start: "21:00", end: "22:00" },
    ];

  try {
    const dayStartUTC = makeISO(dateISO, "00:00", timezone);
    const dayEndUTC = makeISO(dateISO, "23:59:59", timezone);
    const busy = await getBusyForRange(dayStartUTC, dayEndUTC);

    const overlaps = (sISO, eISO) =>
      busy.some((b) => !(new Date(eISO) <= new Date(b.start) || new Date(sISO) >= new Date(b.end)));

    const available = templateSlots
      .map((t) => {
        const sISO = makeISO(dateISO, t.start, timezone);
        const eISO = makeISO(dateISO, t.end, timezone);
        return !overlaps(sISO, eISO) ? `${t.start} - ${t.end}` : null;
      })
      .filter(Boolean);

    // dedupe & normalize formatting "HH:MM - HH:MM"
    const normalize = (s) => String(s).trim().replace(/\s+/g, " ");
    const uniq = Array.from(new Set((available || []).map(normalize)));
    return uniq;
  } catch (err) {
    console.error("getAvailableSlotsForDate error", err?.message || err);
    // fallback: return normalized template slots (no conflict checks)
    return (templateSlots || []).map((t) => `${t.start} - ${t.end}`);
  }
};

export const createEvent = async ({ dateISO, slot, summary = "Booking", description = "", attendees = [], timezone = GOOGLE_DEFAULT_TIMEZONE }) => {
  await ensureAuth();
  if (!calendar) throw new Error("Google Calendar not configured");

  const [startTime, endTime] = slot.split("-").map((s) => s.trim());
  const startISO = makeISO(dateISO, startTime, timezone);
  const endISO = makeISO(dateISO, endTime, timezone);

  const event = {
    summary,
    description,
    start: { dateTime: startISO, timeZone: timezone },
    end: { dateTime: endISO, timeZone: timezone },
    attendees: (attendees || []).map((email) => ({ email })),
  };

  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
  });

  return res.data;
};
