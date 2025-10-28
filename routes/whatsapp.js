// routes/whatsApp.js
import express from "express";
import Booking from "../models/Booking.js";
import { sendMessage, sendButtonsMessage, sendListMessage } from "../utils/whatsapp.js";
import { getAvailableSlotsForDate, createEvent, ensureAuth } from "../utils/googleCalendar.js";
import { formatUserDate } from "../utils/dateHelpers.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

// webhook verification
router.get("/", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// main webhook handler
router.post("/", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];
    if (!message) return res.sendStatus(200);

    // ---- EARLY FILTER: ignore non-message webhooks ----
    const messageId = message?.id || null;
    const interactiveRaw = message?.interactive || null;
    const hasButton = !!interactiveRaw?.button_reply;
    const hasList = !!interactiveRaw?.list_reply;
    const hasText = !!message?.text?.body;
    if (!hasButton && !hasList && !hasText) return res.sendStatus(200);

    // ----- robust parsing of interactive replies -----
    const incomingText = message.text?.body?.trim();
    const interactive = interactiveRaw || {};
    if (interactive && Object.keys(interactive).length) console.log("DEBUG incoming interactive payload:", interactive);

    const buttonReply = interactive?.button_reply || null;
    const listReply = interactive?.list_reply || null;

    // prefer ids first then titles then plain text
    const buttonReplyId = buttonReply?.id ?? null;
    const buttonReplyTitle = buttonReply?.title ?? null;
    const listReplyId = listReply?.id ?? null;
    const listReplyTitle = listReply?.title ?? null;

    const msgRaw = listReplyId || buttonReplyId || listReplyTitle || buttonReplyTitle || incomingText || "";
    const msg = String(msgRaw || "").trim();
    const msgLower = msg.toLowerCase();
    const from = message.from;

    // get or create booking
    let booking = await Booking.findOne({ phone: from });
    if (!booking) {
      booking = await Booking.findOneAndUpdate(
        { phone: from },
        { phone: from, step: "sport_selection", meta: {} },
        { upsert: true, new: true }
      );
      await sendButtonsMessage(from, "🏓 Welcome to Sports Booking Bot!\nLet's get started. Which sport would you like to play?", [
        { id: "sport_pickleball", title: "Pickleball" },
        { id: "sport_padel", title: "Padel" },
      ]);
      return res.sendStatus(200);
    }

    // --- dedupe duplicate webhook deliveries using WhatsApp message.id ---
    if (messageId) {
      booking.meta = booking.meta || {};
      if (booking.meta.lastMessageId && booking.meta.lastMessageId === messageId) {
        console.log("DEBUG: duplicate webhook delivery ignored, messageId:", messageId);
        return res.sendStatus(200);
      }
      booking.meta.lastMessageId = messageId;
      // persist quickly so other deliveries of same id skip
      await Booking.findOneAndUpdate({ phone: from }, { $set: { "meta.lastMessageId": messageId } }, { new: true, upsert: false });
    }

    // universal exit
    if (msgLower === "exit" || msgLower === "cancel") {
      await Booking.deleteOne({ phone: from });
      await sendMessage(from, "❌ Booking cancelled. Type '1' or 'Start' anytime to start again.");
      return res.sendStatus(200);
    }

    // helper normalizers
    const normalizeSlot = (s) => String(s || "").replace(/\s+/g, " ").replace(/–|—|−/g, "-").trim();
    const extractTimes = (slotStr) => {
      const m = String(slotStr || "").match(/(\d{1,2}:\d{2}).*?(\d{1,2}:\d{2})/);
      if (!m) return null;
      return { start: m[1].padStart(5, "0"), end: m[2].padStart(5, "0") };
    };

    // ROUTE FLOW
    switch (booking.step) {
      /* 1. SPORT */
      case "sport_selection": {
        if (msg === "sport_pickleball" || msg === "sport_padel" || msgLower.includes("pickle") || msgLower.includes("padel")) {
          booking.sport = msg === "sport_padel" || msgLower.includes("padel") ? "Padel" : "Pickleball";
          booking.step = "centre_selection";
          await booking.save();
          await sendButtonsMessage(from, `Great choice! You've selected ${booking.sport}.\nWhich center would you like to book at?`, [
            { id: "centre_jw", title: "JW Marriott" },
            { id: "centre_taj", title: "Taj West End" },
            { id: "centre_itc", title: "ITC Gardenia" },
          ]);
        } else {
          await sendMessage(from, "Please choose a sport by tapping a button (Pickleball / Padel).");
        }
        break;
      }

      /* 2. CENTRE */
      case "centre_selection": {
        if (["centre_jw", "centre_taj", "centre_itc"].includes(msg)) {
          booking.centre = msg === "centre_jw" ? "JW Marriott" : msg === "centre_taj" ? "Taj West End" : "ITC Gardenia";
          booking.step = "date_selection";
          await booking.save();
          await sendButtonsMessage(from, `Perfect! You've selected ${booking.centre}.\nWhen would you like to play?`, [
            { id: "date_today", title: "Today" },
            { id: "date_this_week", title: "This Week" },
            { id: "date_other", title: "Other Dates" },
          ]);
        } else {
          await sendMessage(from, "Please choose a center using the buttons.");
        }
        break;
      }

      /* 3. DATE SELECTION */
      case "date_selection": {
        if (msg === "date_today") {
          const todayIso = new Date().toISOString().slice(0, 10);
          const slots = await getAvailableSlotsForDate(todayIso);
          if (!slots || !slots.length) {
            await sendMessage(from, "❗ Sorry, no slots available today. Please choose another option.");
            await sendButtonsMessage(from, "Choose a date:", [
              { id: "date_this_week", title: "This Week" },
              { id: "date_other", title: "Other Dates" },
            ]);
            return res.sendStatus(200);
          }
          booking.date = todayIso;
          booking.step = "time_selection";
          booking.meta = booking.meta || {};
          booking.meta.lastDateRows = [{ id: `date_${todayIso}`, iso: todayIso }];
          await Booking.findOneAndUpdate({ phone: from }, { $set: { date: booking.date, step: booking.step, meta: booking.meta } }, { new: true });
          await sendButtonsMessage(from, `Great! You've selected ${formatUserDate(todayIso)}.\nChoose time of day:`, [
            { id: "tod_morning", title: "Morning" },
            { id: "tod_afternoon", title: "Afternoon" },
            { id: "tod_evening", title: "Evening" },
          ]);
        } else if (msg === "date_this_week") {
          const dates = [];
          for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            dates.push(d.toISOString().slice(0, 10));
          }
          const rows = dates.slice(0, 10).map((iso) => ({ id: `date_${iso}`, title: formatUserDate(iso), description: iso }));
          booking.meta = booking.meta || {};
          booking.meta.lastDateRows = rows.map((r) => ({ id: r.id, iso: r.description }));
          await Booking.findOneAndUpdate({ phone: from }, { $set: { meta: booking.meta } }, { new: true });
          await sendListMessage(from, "Select a date this week:", [{ title: "Available dates", rows }]);
        } else if (msg === "date_other") {
          const now = new Date();
          const weeks = [];
          for (let wk = 1; wk <= 3; wk++) {
            const start = new Date();
            start.setDate(now.getDate() + wk * 7);
            const label = `Week ${wk} starting ${start.toISOString().slice(0, 10)}`;
            weeks.push({ id: `week_${wk}`, title: label, startIso: start.toISOString().slice(0, 10) });
          }
          booking.meta = booking.meta || {};
          booking.meta.otherWeeks = weeks;
          await Booking.findOneAndUpdate({ phone: from }, { $set: { meta: booking.meta } }, { new: true });
          const buttons = weeks.map((w, i) => ({ id: w.id, title: `Week ${i + 1}` }));
          await sendButtonsMessage(from, "Select which week (other dates):", buttons);
        } else if (msg.startsWith("date_")) {
          const iso = msg.replace("date_", "");
          booking.date = iso;
          booking.step = "time_selection";
          await Booking.findOneAndUpdate({ phone: from }, { $set: { date: booking.date, step: booking.step } }, { new: true });
          await sendButtonsMessage(from, `Great! You've selected ${formatUserDate(iso)}.\nChoose time of day:`, [
            { id: "tod_morning", title: "Morning" },
            { id: "tod_afternoon", title: "Afternoon" },
            { id: "tod_evening", title: "Evening" },
          ]);
        } else if (msg.startsWith("week_")) {
          const weekIndex = Number(msg.split("_")[1]);
          const week = (booking.meta?.otherWeeks || [])[weekIndex - 1];
          if (!week) {
            await sendMessage(from, "Invalid week selection. Please pick again.");
            return res.sendStatus(200);
          }
          const start = new Date(week.startIso);
          const dayList = [];
          for (let i = 0; i < 7; i++) {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            const iso = d.toISOString().slice(0, 10);
            dayList.push({ id: `date_${iso}`, title: formatUserDate(iso), description: iso });
          }
          booking.meta = booking.meta || {};
          booking.meta.lastDateRows = dayList.map((r) => ({ id: r.id, iso: r.description }));
          booking.step = "date_selection";
          await Booking.findOneAndUpdate({ phone: from }, { $set: { meta: booking.meta, step: booking.step } }, { new: true });
          await sendListMessage(from, "Select a date from the week:", [{ title: "Week dates", rows: dayList }]);
        } else {
          if (booking.meta?.lastDateRows && /^\d+$/.test(msg)) {
            const idx = Number(msg) - 1;
            const target = booking.meta.lastDateRows[idx];
            if (target) {
              booking.date = target.iso;
              booking.step = "time_selection";
              await Booking.findOneAndUpdate({ phone: from }, { $set: { date: booking.date, step: booking.step } }, { new: true });
              await sendButtonsMessage(from, `Great! You've selected ${formatUserDate(target.iso)}.\nChoose time of day:`, [
                { id: "tod_morning", title: "Morning" },
                { id: "tod_afternoon", title: "Afternoon" },
                { id: "tod_evening", title: "Evening" },
              ]);
            } else {
              await sendMessage(from, "Please choose a valid option from the list.");
            }
          } else {
            await sendMessage(from, "Please choose 'Today', 'This Week' or 'Other Dates' using the buttons.");
          }
        }
        break;
      }

      /* 4. TIME SELECTION (robust dedupe + slotMap for list replies) */
      case "time_selection": {
        // Debug: log current booking.meta
        console.log("DEBUG booking.meta before time_selection:", booking.meta || null);

        // 1) If user chooses a time-of-day button
        if (["tod_morning", "tod_afternoon", "tod_evening"].includes(msg)) {
          let templateSlots = [];
          if (msg === "tod_morning") {
            templateSlots = [
              "06:00 - 07:00",
              "07:00 - 08:00",
              "08:00 - 09:00",
              "09:00 - 10:00",
              "10:00 - 11:00",
              "11:00 - 12:00",
            ];
          } else if (msg === "tod_afternoon") {
            templateSlots = ["12:00 - 13:00", "13:00 - 14:00", "14:00 - 15:00", "15:00 - 16:00", "16:00 - 17:00"];
          } else {
            templateSlots = ["17:00 - 18:00", "18:00 - 19:00", "19:00 - 20:00", "20:00 - 21:00", "21:00 - 22:00"];
          }

          // fetch availability
          let slotsAvail = [];
          try {
            slotsAvail = await getAvailableSlotsForDate(booking.date);
            if (!Array.isArray(slotsAvail)) slotsAvail = [];
          } catch (err) {
            console.warn("getAvailableSlotsForDate error:", err?.message || err);
            slotsAvail = [];
          }

          console.log("DEBUG: templateSlots:", templateSlots);
          console.log("DEBUG: slotsAvail (raw):", slotsAvail);

          // Normalize and dedupe availability
          const normalizedAvail = slotsAvail.map(normalizeSlot);
          const uniqAvail = Array.from(new Set(normalizedAvail)); // dedupe

          // First try intersection with template
          let available = templateSlots.filter((t) => uniqAvail.includes(normalizeSlot(t)));

          // fallback: match by extracted times
          if (!available.length && uniqAvail.length) {
            const availRanges = uniqAvail.map(extractTimes).filter(Boolean);
            if (availRanges.length) {
              available = templateSlots.filter((t) => {
                const tt = extractTimes(t);
                if (!tt) return false;
                return availRanges.some((a) => a.start === tt.start && a.end === tt.end);
              });
            }
          }

          // If TOD had no slots but day has other slots, show day slots (deduped)
          if (!available.length && uniqAvail.length) {
            // build slotMap and currentSlots
            const slotMap = {};
            const currentSlots = [];
            uniqAvail.forEach((s, i) => {
              const id = `slot_${i}`;
              slotMap[id] = s;
              currentSlots.push(s);
            });

            // persist using findOneAndUpdate so other requests see it immediately
            booking = await Booking.findOneAndUpdate(
              { phone: from },
              { $set: { "meta.slotMap": slotMap, "meta.currentSlots": currentSlots } },
              { new: true, upsert: false }
            );

            console.log("DEBUG saved slotMap to DB:", booking?.meta?.slotMap);
            console.log("DEBUG saved currentSlots to DB:", booking?.meta?.currentSlots);

            await sendMessage(from, `No available slots in that time of day. Here are other slots available on ${formatUserDate(booking.date)}:`);

            const rows = Object.entries(booking.meta.slotMap).map(([id, title]) => ({ id, title, description: title }));
            await sendListMessage(from, `Available time slots for ${formatUserDate(booking.date)}:`, [{ title: "Slots", rows }]);
            return res.sendStatus(200);
          }

          // If still no available slots at all that day
          if (!available.length) {
            await sendMessage(from, "Sorry, no available slots in that time of day. Please pick another time or date.");
            await sendButtonsMessage(from, "Choose time of day:", [
              { id: "tod_morning", title: "Morning" },
              { id: "tod_afternoon", title: "Afternoon" },
              { id: "tod_evening", title: "Evening" },
            ]);
            return res.sendStatus(200);
          }

          // Build unique slot map for the template-matched slots
          booking.meta = booking.meta || {};
          booking.meta.slotMap = {};
          booking.meta.currentSlots = [];
          const uniqAvailable = Array.from(new Set(available.map(normalizeSlot)));
          uniqAvailable.forEach((s, i) => {
            const id = `slot_${i}`;
            booking.meta.slotMap[id] = s;
            booking.meta.currentSlots.push(s);
          });

          // persist the template-matched slotMap to DB as well
          booking = await Booking.findOneAndUpdate(
            { phone: from },
            { $set: { "meta.slotMap": booking.meta.slotMap, "meta.currentSlots": booking.meta.currentSlots } },
            { new: true, upsert: false }
          );

          console.log("DEBUG saved template slotMap to DB:", booking?.meta?.slotMap);

          // Send as buttons if <=3 else as list
          if (booking.meta.currentSlots.length <= 3) {
            const btns = Object.entries(booking.meta.slotMap).map(([id, title]) => ({ id, title }));
            await sendButtonsMessage(from, `Available time slots for ${formatUserDate(booking.date)}:`, btns);
          } else {
            const rows = Object.entries(booking.meta.slotMap).map(([id, title]) => ({ id, title, description: title }));
            await sendListMessage(from, `Available time slots for ${formatUserDate(booking.date)}:`, [{ title: "Slots", rows }]);
          }
          return res.sendStatus(200);
        }

        // 2) user selected a slot -> resolve robustly using slotMap and other fallbacks

        // Before resolving, re-fetch booking from DB to pick up any saved slotMap
        booking = await Booking.findOne({ phone: from });
        console.log("DEBUG booking reloaded for resolution:", booking?.meta);

        console.log("DEBUG resolving chosen, msg:", msg);
        console.log("DEBUG booking.meta.slotMap:", booking?.meta?.slotMap);
        console.log("DEBUG booking.meta.currentSlots:", booking?.meta?.currentSlots);

        let chosen = null;

        // 1) exact id lookup (slot_1) using saved slotMap
        if (booking?.meta?.slotMap && booking.meta.slotMap[msg]) {
          chosen = booking.meta.slotMap[msg];
          console.log("DEBUG matched by slotMap id =>", chosen);
        }
        // 2) maybe user replied with numeric index (1-based)
        else if (/^\d+$/.test(msg) && booking?.meta?.currentSlots) {
          const idx = Number(msg) - 1;
          chosen = booking.meta.currentSlots?.[idx];
          console.log("DEBUG matched by numeric index =>", chosen);
        }
        // 3) exact title match
        else if (booking?.meta?.currentSlots?.includes(msg)) {
          chosen = msg;
          console.log("DEBUG matched by exact title =>", chosen);
        }
        // 4) normalized/fuzzy match
        else {
          const normMsg = normalizeSlot(msg).toLowerCase();
          chosen = (booking?.meta?.currentSlots || []).find((c) => normalizeSlot(c).toLowerCase() === normMsg) || null;
          console.log("DEBUG matched by normalized =>", chosen);
        }

        if (!chosen) {
          await sendMessage(from, "Please select a valid time slot (reply with number or tap a button).");
          return res.sendStatus(200);
        }

        // final availability check (re-query calendar)
        let slotsNow = [];
        try {
          slotsNow = await getAvailableSlotsForDate(booking.date);
          if (!Array.isArray(slotsNow)) slotsNow = [];
        } catch (err) {
          console.warn("getAvailableSlotsForDate error on final check:", err?.message || err);
          slotsNow = [];
        }

        const normalizedNow = Array.from(new Set(slotsNow.map(normalizeSlot)));
        if (!normalizedNow.includes(normalizeSlot(chosen))) {
          await sendMessage(from, "❌ Sorry that slot was just taken. Please pick another slot.");
          // refresh currentSlots and slotMap to intersection
          booking.meta.currentSlots = (booking.meta.currentSlots || []).filter((s) => normalizedNow.includes(normalizeSlot(s)));
          booking.meta.slotMap = {};
          booking.meta.currentSlots.forEach((s, i) => (booking.meta.slotMap[`slot_${i}`] = s));
          await Booking.findOneAndUpdate({ phone: from }, { $set: { "meta.slotMap": booking.meta.slotMap, "meta.currentSlots": booking.meta.currentSlots } });
          return res.sendStatus(200);
        }

        // success: set time_slot and move forward
        booking.time_slot = chosen;
        booking.step = "player_count";
        await booking.save();
        console.log(`✅ Booking updated for ${booking.phone}: ${booking.date} ${booking.time_slot}`);

        await sendButtonsMessage(from, `Perfect! You've chosen ${chosen}.\nHow many players?`, [
          { id: "players_2", title: "2 players" },
          { id: "players_3", title: "3 players" },
          { id: "players_4", title: "4 players" },
        ]);

        return res.sendStatus(200);
      }

      /* 5. PLAYER COUNT */
      case "player_count": {
        if (["players_2", "players_3", "players_4"].includes(msg) || /^\d+$/.test(msg)) {
          const num = msg.startsWith("players_") ? Number(msg.split("_")[1]) : Number(msg);
          booking.players = num;
          booking.step = "addons_selection";
          await booking.save();

          await sendMessage(from, "Would you like to add any additional services?\n1. Spa (₹2000)\n2. Gym Access (₹500)\n3. Sauna (₹800)\n4. No thanks, proceed to payment\n\nPlease reply with the number of your choice.");
        } else {
          await sendMessage(from, "Please choose player count using the buttons (2/3/4) or send a number.");
        }
        break;
      }

      /* 6. ADDONS */
      case "addons_selection": {
        if (/^[1-4]$/.test(msg)) {
          const map = { "1": "spa", "2": "gym", "3": "sauna", "4": "none" };
          const choice = map[msg];
          booking.addons = choice === "none" ? [] : [choice];
          let total = 0;
          total += (booking.players || 1) * 300;
          if (booking.addons.includes("spa")) total += 2000;
          if (booking.addons.includes("gym")) total += 500;
          if (booking.addons.includes("sauna")) total += 800;
          booking.totalAmount = total;
          booking.step = "collect_contact";
          await booking.save();

          await sendMessage(from, `Please provide your full name:`);
        } else {
          await sendMessage(from, "Please reply 1,2,3 or 4 to choose add-ons.");
        }
        break;
      }

      /* 7. COLLECT CONTACT (name) */
      case "collect_contact": {
        if (!msg || msg.length < 2) {
          await sendMessage(from, "Please provide a valid full name.");
        } else {
          booking.name = msg;
          booking.step = "payment";
          await booking.save();

          const paymentLink = `https://example-payments.local/pay?ref=${booking._id}`;
          await sendMessage(from, `Please complete your payment using this link:\n\n${paymentLink}`);
          await sendMessage(from, `Final Booking Summary:\n\n• Sport: ${booking.sport}\n• Center: ${booking.centre}\n• Date: ${formatUserDate(booking.date)}\n• Time: ${booking.time_slot}\n• Players: ${booking.players}\n• Add-ons: ${booking.addons.length ? booking.addons.join(", ") : "None"}\n• Total Amount: ₹${booking.totalAmount}\n\nPress 'Done' when payment completed.`);

          await sendMessage(from, "Please complete payment using this link. We'll confirm automatically once payment is received.");

        }
        break;
      }

      /* 8. PAYMENT & CONFIRMATION */
      case "payment": {
        if (msg === "payment_done" || msgLower === "paid" || msgLower === "done") {
          const available = await getAvailableSlotsForDate(booking.date);
          if (!available.includes(booking.time_slot)) {
            await sendMessage(from, "Sorry, the slot was taken before payment completed. Please choose another slot.");
            booking.step = "date_selection";
            await booking.save();
            await sendButtonsMessage(from, "Pick a new date:", [
              { id: "date_this_week", title: "This Week" },
              { id: "date_other", title: "Other Dates" },
            ]);
            return res.sendStatus(200);
          }

          try {
            await ensureAuth();
            const event = await createEvent({
              dateISO: booking.date,
              slot: booking.time_slot,
              summary: `${booking.sport} booking - ${booking.name}`,
              description: `Booked by ${booking.name} (${booking.phone})`,
            });
            booking.calendarEventId = event?.id;
          } catch (err) {
            console.warn("Warning: Google Calendar event not created:", err?.message || err);
          }

          booking.paid = true;
          booking.step = "completed";
          await booking.save();

          await sendMessage(from, `✅ Booking Confirmed!\n\nSport: ${booking.sport}\nCenter: ${booking.centre}\nDate: ${formatUserDate(booking.date)}\nTime: ${booking.time_slot}\nPlayers: ${booking.players}\nAdd-ons: ${booking.addons.length ? booking.addons.join(", ") : "None"}\nTotal: ₹${booking.totalAmount}\n\nThank you — we'll see you then!`);
        } else if (msg === "payment_cancel" || msgLower === "cancel") {
          await Booking.deleteOne({ phone: from });
          await sendMessage(from, "❌ Booking cancelled. Type '1' to start again.");
        } else {
          await sendMessage(from, "Press 'Done' after payment or 'Cancel' to abort.");
        }
        break;
      }

      default:
        await Booking.findOneAndUpdate({ phone: from }, { $set: { step: "sport_selection" } }, { new: true, upsert: false });
        await sendButtonsMessage(from, "🏓 Welcome back! Which sport would you like to play?", [
          { id: "sport_pickleball", title: "Pickleball" },
          { id: "sport_padel", title: "Padel" },
        ]);
        break;
    }

    // persist any last-minute changes
    await booking.save().catch(() => {});
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.sendStatus(500);
  }
});

export default router;
