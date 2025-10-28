// routes/whatsapp.js
import express from "express";
import Booking from "../models/Booking.js";
import { sendMessage, sendButtonsMessage, sendListMessage } from "../utils/whatsapp.js";
import { getAvailableSlotsForDate, createEvent } from "../utils/googleCalendar.js";

const router = express.Router();

const STEPS = {
  SPORT: "sport_selection",
  CENTRE: "centre_selection",
  DATE_CAT: "date_category",
  WEEK: "week_selection",
  DATE: "date_selection",
  TIME: "time_selection",
  PLAYERS: "player_count",
  PAYMENT: "payment",
  CONFIRM: "confirmation",
  DONE: "completed",
};

const isDateId = (s) => /^date_\d{4}-\d{2}-\d{2}$/.test(s);
const isSlotId = (s) => /^slot_/.test(s);

router.get("/", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

router.post("/", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const incomingText = message.text?.body?.trim();
    const buttonReplyId = message.interactive?.button_reply?.id;
    const listReplyId = message.interactive?.list_reply?.id;
    const msgRaw = buttonReplyId || listReplyId || incomingText || "";
    const msg = String(msgRaw).trim();
    const msgLower = msg.toLowerCase();

    if (!from || !msg) return res.sendStatus(200);

    // cancel
    if (["exit", "cancel"].includes(msgLower)) {
      await Booking.deleteOne({ phone: from });
      await sendMessage(from, "❌ Booking cancelled. Type '1' to start again.");
      return res.sendStatus(200);
    }

    // start
    if (msg === "1" || msgLower === "start") {
      await Booking.deleteOne({ phone: from });
      await Booking.create({ phone: from, step: STEPS.SPORT });
      await sendButtonsMessage(from, "Welcome! Choose your sport:", [
        { id: "sport_pickleball", title: "Pickleball" },
        { id: "sport_padel", title: "Padel" },
      ]);
      return res.sendStatus(200);
    }

    // fetch booking
    let booking = await Booking.findOne({ phone: from });
    if (!booking) {
      booking = await Booking.create({ phone: from, step: STEPS.SPORT });
      await sendButtonsMessage(from, "Hi! Choose your sport:", [
        { id: "sport_pickleball", title: "Pickleball" },
        { id: "sport_padel", title: "Padel" },
      ]);
      return res.sendStatus(200);
    }

    switch (booking.step) {
      case STEPS.SPORT:
        if (msg === "sport_pickleball" || msg === "sport_padel") {
          booking.sport = msg === "sport_pickleball" ? "Pickleball" : "Padel";
          booking.step = STEPS.CENTRE;
          await booking.save();
          await sendButtonsMessage(from, `Selected: ${booking.sport}\nChoose centre:`, [
            { id: "centre_jw", title: "JW Marriott" },
            { id: "centre_other", title: "Other Centre" },
          ]);
        } else {
          await sendMessage(from, "Please tap one of the sport buttons.");
        }
        break;

      case STEPS.CENTRE:
        if (msg === "centre_jw" || msg === "centre_other") {
          booking.centre = msg === "centre_jw" ? "JW Marriott" : "Other";
          booking.step = STEPS.DATE_CAT;
          await booking.save();
          await sendButtonsMessage(from, "Choose a date option:", [
            { id: "date_today", title: "Today" },
            { id: "date_tomorrow", title: "Tomorrow" },
            { id: "date_other", title: "Other Dates" },
          ]);
        } else {
          await sendMessage(from, "Please choose a centre using the buttons.");
        }
        break;

      case STEPS.DATE_CAT:
        if (msg === "date_today" || msg === "date_tomorrow") {
          const d = new Date();
          if (msg === "date_tomorrow") d.setDate(d.getDate() + 1);
          booking.date = d.toISOString().split("T")[0];
          booking.step = STEPS.TIME;
          await booking.save();
          await sendMessage(from, `Date set: ${booking.date}\nPlease choose a time slot (we'll show available slots next).`);
        } else if (msg === "date_other") {
          booking.step = STEPS.WEEK;
          await booking.save();
          await sendButtonsMessage(from, "Select a week of this month:", [
            { id: "week_1", title: "Week 1 (1st–7th)" },
            { id: "week_2", title: "Week 2 (8th–14th)" },
            { id: "week_3", title: "Week 3 (15th–21st)" },
            { id: "week_4", title: "Week 4 (22nd–end)" },
          ]);
        } else {
          await sendMessage(from, "Please tap Today / Tomorrow / Other Dates.");
        }
        break;

      case STEPS.WEEK:
        if (/^week_[1-4]$/.test(msg)) {
          const weekNum = parseInt(msg.split("_")[1], 10);
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth() + 1;
          const daysInMonth = new Date(year, month, 0).getDate();
          const startDay = (weekNum - 1) * 7 + 1;
          const endDay = Math.min(startDay + 6, daysInMonth);

          const rows = [];
          for (let d = startDay; d <= endDay; d++) {
            const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            try {
              const slots = await getAvailableSlotsForDate(dateStr);
              if (slots && slots.length > 0) {
                rows.push({ id: `date_${dateStr}`, title: dateStr, description: `${slots.length} slots` });
              }
            } catch (err) {
              console.error("getAvailableSlotsForDate error", err?.message || err);
            }
          }

          if (!rows.length) {
            await sendMessage(from, `No available slots found in that week. Please choose another week or reply 'manual' to enter a date.`);
            booking.step = STEPS.WEEK;
            await booking.save();
            break;
          }

          booking.candidateDates = rows.map((r) => r.title);
          booking.step = STEPS.DATE;
          await booking.save();

          await sendListMessage(from, `Available dates (Week ${weekNum}):`, "Select date", [{ title: `Week ${weekNum}`, rows }], "Reply 'exit' to cancel");
        } else {
          await sendMessage(from, "Please choose one of the week buttons.");
        }
        break;

      case STEPS.DATE:
        if (isDateId(msg)) {
          const chosen = msg.replace(/^date_/, "");
          booking.date = chosen;
          booking.step = STEPS.TIME;
          await booking.save();

          const slots = await getAvailableSlotsForDate(chosen);
          if (!slots || slots.length === 0) {
            await sendMessage(from, `No slots available on ${chosen}. Reply 'other' to pick another week.`);
            booking.step = STEPS.WEEK;
            await booking.save();
            break;
          }

          if (slots.length <= 3) {
            await sendButtonsMessage(from, `Available slots on ${chosen}:`, slots.map((s) => ({ id: `slot_${s}`, title: s })));
          } else {
            const rows = slots.map((s) => ({ id: `slot_${s}`, title: s }));
            await sendListMessage(from, `Select a slot on ${chosen}:`, "Choose slot", [{ title: `Slots`, rows }]);
          }
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(msg)) {
          booking.date = msg;
          booking.step = STEPS.TIME;
          await booking.save();
          await sendMessage(from, `Date set to ${msg}. Please enter or pick a time slot.`);
        } else {
          await sendMessage(from, "Please select a date or send a date in YYYY-MM-DD format.");
        }
        break;

      case STEPS.TIME:
        if (isSlotId(msg)) {
          booking.time_slot = msg.replace(/^slot_/, "");
          booking.step = STEPS.PLAYERS;
          await booking.save();
          await sendButtonsMessage(from, "How many players?", [
            { id: "players_1", title: "1" },
            { id: "players_2", title: "2" },
            { id: "players_3", title: "3" },
          ]);
        } else if (/^[0-2]?\d:[0-5]\d/.test(msg) || msg.includes("-")) {
          booking.time_slot = msg;
          booking.step = STEPS.PLAYERS;
          await booking.save();
          await sendButtonsMessage(from, "How many players?", [
            { id: "players_1", title: "1" },
            { id: "players_2", title: "2" },
            { id: "players_3", title: "3" },
          ]);
        } else {
          await sendMessage(from, "Please choose a slot or send a time slot (e.g., 18:00 - 19:00).");
        }
        break;

      case STEPS.PLAYERS:
        {
          const n = parseInt(msg.replace(/\D/g, ""), 10) || 1;
          booking.players = n;
          booking.step = STEPS.PAYMENT;
          await booking.save();
          await sendButtonsMessage(from, "Proceed to payment?", [
            { id: "payment_done", title: "Done ✅" },
            { id: "exit", title: "Cancel ❌" },
          ]);
        }
        break;

      case STEPS.PAYMENT:
        if (msg === "payment_done") {
          booking.paid = true;
          booking.step = STEPS.CONFIRM;
          await booking.save();
          await sendMessage(from, `Payment noted. Reply 'confirm' to create the booking, or 'exit' to cancel.`);
        } else {
          await sendMessage(from, "Please tap 'Done' after payment or 'exit' to cancel.");
        }
        break;

      case STEPS.CONFIRM:
        if (msg.toLowerCase() === "confirm") {
          try {
            // re-check availability and create event
            const available = await getAvailableSlotsForDate(booking.date);
            if (!available.includes(booking.time_slot)) {
              await sendMessage(from, "Sorry — that slot is no longer available. Please pick another slot.");
              booking.step = STEPS.DATE;
              await booking.save();
              break;
            }
            const event = await createEvent({
              dateISO: booking.date,
              slot: booking.time_slot,
              summary: `${booking.sport} booking`,
              description: `Booked via WhatsApp by ${from}`,
            });
            booking.calendarEventId = event.id;
            booking.confirmedAt = new Date();
            booking.step = STEPS.DONE;
            await booking.save();
            await sendMessage(from, `✅ Booking confirmed for ${booking.date} at ${booking.time_slot}.`);
          } catch (err) {
            console.error("Create event error:", err?.message || err);
            await sendMessage(from, "❌ Could not create calendar event; please try again later.");
          }
        } else {
          await sendMessage(from, "Reply 'confirm' to finalise booking or 'exit' to cancel.");
        }
        break;

      case STEPS.DONE:
      default:
        await sendButtonsMessage(from, "Start a new booking?", [
          { id: "start", title: "Start Booking" },
          { id: "exit", title: "Cancel" },
        ]);
        break;
    }

    // ensure saved
    try { await booking.save(); } catch (e) { /* ignore */ }
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.sendStatus(500);
  }
});

export default router;
