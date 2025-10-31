// utils/whatsapp.js
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const TOKEN = process.env.ACCESS_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const API_VER = process.env.WHATSAPP_API_VERSION || "v21.0";

const isConfigured = !!TOKEN && !!PHONE_ID;

const sendApi = async (payload) => {
  if (!isConfigured) {
    console.warn("WhatsApp not configured (ACCESS_TOKEN or PHONE_NUMBER_ID missing).");
    return null;
  }
  const url = `https://graph.facebook.com/${API_VER}/${PHONE_ID}/messages`;
  try {
    const resp = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    return resp.data;
  } catch (err) {
    console.error("❌ WhatsApp API error:", err.response?.data || err.message);
    throw err;
  }
};

export const sendMessage = async (to, text) => {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
  return sendApi(payload);
};

export const sendButtonsMessage = async (to, body, buttons) => {
  const actionButtons = buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } }));
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons: actionButtons },
    },
  };
  return sendApi(payload);
};

// Send an interactive message with a single URL button (call-to-action)
export const sendUrlButtonMessage = async (to, body, url, title = 'Pay Now') => {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          {
            type: "url",
            url,
            title,
          },
        ],
      },
    },
  };
  return sendApi(payload);
};

export const sendListMessage = async (to, headerText, sections) => {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: headerText },
      body: { text: "Please select from the list below" },
      action: { button: "View Options", sections },
    },
  };
  return sendApi(payload);
};
