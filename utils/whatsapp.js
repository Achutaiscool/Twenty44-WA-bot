// utils/whatsapp.js
import axios from "axios";

/**
 * Read configuration at call time to avoid import-order issues.
 * Trims values to avoid invisible whitespace/newline problems.
 */
const getConfig = () => {
  const TOKEN = (process.env.ACCESS_TOKEN || "").trim();
  const PHONE_ID = (process.env.PHONE_NUMBER_ID || "").trim();
  // Optional: allow overriding API version via .env; fallback to v21.0
  const API_VERSION = (process.env.WHATSAPP_API_VERSION || "v21.0").trim();
  const BASE_URL = PHONE_ID ? `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages` : null;
  return { TOKEN, PHONE_ID, API_VERSION, BASE_URL };
};

const safeLog = (...args) => {
  // lightweight wrapper in case you want to swap to a proper logger later
  console.log(...args);
};

/**
 * sendMessage(to, text)
 * - to: phone number string including country code (e.g. "9199....")
 * - text: message body (string)
 */
export const sendMessage = async (to, text) => {
  const { TOKEN, BASE_URL } = getConfig();
  if (!TOKEN || !BASE_URL) {
    return console.error("WhatsApp not configured (ACCESS_TOKEN or PHONE_NUMBER_ID missing).");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "text",
    text: { body: String(text) },
  };

  try {
    await axios.post(BASE_URL, payload, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    safeLog("✅ Message sent to", to);
  } catch (err) {
    console.error("❌ sendMessage error:", err.response?.data || err.message);
  }
};

/**
 * sendButtonsMessage(to, body, buttons)
 * - buttons: array of { id: string, title: string } — up to 3 items will be used
 */
export const sendButtonsMessage = async (to, body, buttons = []) => {
  const { TOKEN, BASE_URL } = getConfig();
  if (!TOKEN || !BASE_URL) {
    return console.error("WhatsApp not configured, not sending buttons.");
  }

  // WhatsApp Cloud API supports up to 3 reply buttons
  const trimmed = (buttons || []).slice(0, 3).map((b, i) => ({
    type: "reply",
    reply: { id: String(b.id ?? `b_${i}`), title: String(b.title ?? `Option ${i + 1}`) },
  }));

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body) },
      action: { buttons: trimmed },
    },
  };

  try {
    await axios.post(BASE_URL, payload, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    safeLog("✅ Buttons sent to", to);
  } catch (err) {
    console.error("❌ sendButtonsMessage error:", err.response?.data || err.message);
  }
};

/**
 * sendListMessage(to, body, buttonText = "Select", sections = [], footer = "")
 * - sections: [{ title: string, rows: [{ id, title, description? }, ...] }, ...]
 * - The Cloud API limits total rows to 10. This function caps rows to 10 total.
 */
export const sendListMessage = async (to, body, buttonText = "Select", sections = [], footer = "") => {
  const { TOKEN, BASE_URL } = getConfig();
  if (!TOKEN || !BASE_URL) {
    return console.error("WhatsApp not configured, not sending list.");
  }

  // Build capped sections (max 10 rows total)
  const cappedSections = [];
  let total = 0;
  for (const sec of (sections || [])) {
    const rows = (sec.rows || []).slice(0, Math.max(0, 10 - total)).map((r, idx) => ({
      id: String(r.id ?? `r_${total + idx}`),
      title: String(r.title ?? `Option ${total + idx + 1}`),
      description: r.description ? String(r.description) : undefined,
    }));
    if (rows.length) {
      cappedSections.push({ title: sec.title ? String(sec.title) : undefined, rows });
      total += rows.length;
    }
    if (total >= 10) break;
  }

  if (total === 0) {
    return console.error("sendListMessage: no rows to send (empty sections or slots).");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(body) },
      action: { button: String(buttonText).slice(0, 20), sections: cappedSections },
      footer: footer ? { text: String(footer).slice(0, 60) } : undefined,
    },
  };

  try {
    await axios.post(BASE_URL, payload, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    safeLog("✅ List sent to", to);
  } catch (err) {
    console.error("❌ sendListMessage error:", err.response?.data || err.message);
  }
};

/**
 * Optional helper: simple phone normalization (not required, but useful)
 */
export const normalizePhone = (phone) => {
  if (!phone) return phone;
  // remove spaces, plus signs, dashes, parentheses
  return String(phone).replace(/[+\s()-]/g, "");
};
