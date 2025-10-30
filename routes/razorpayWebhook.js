// FILE: routes/razorpayWebhook.js
import express from "express";
import crypto from "crypto";
import axios from "axios";
import { sendMessage } from "../utils/whatsapp.js";
import Booking from "../models/Booking.js";
import { formatUserDate } from "../utils/dateHelpers.js";
import { normalizeSlotString } from "../utils/normalizeSlot.js";

const router = express.Router();

// Razorpay webhook secret from .env
const RAZORPAY_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "replace_with_your_secret";

// ✅ Health check route
router.get("/webhook", (req, res) => {
  res.status(200).send("✅ Razorpay webhook endpoint is active (POST only)");
});

function computeSignatures(rawBody, secret) {
  if (!rawBody) return { hex: null, base64: null };
  const hex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const base64 = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return { hex, base64 };
}

function safeCompare(a, b) {
  try {
    const ab = Buffer.from(a || "", "utf8");
    const bb = Buffer.from(b || "", "utf8");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ✅ Razorpay webhook handler
router.post("/webhook", async (req, res) => {
  try {
    const signature = (req.headers["x-razorpay-signature"] || "").trim();
    const { hex, base64 } = computeSignatures(req.rawBody, RAZORPAY_SECRET);

    const verified = safeCompare(signature, hex) || safeCompare(signature, base64);
    if (!verified) {
      console.warn("❌ Invalid Razorpay signature", { signature, hex, base64 });
      return res.status(400).send("Invalid signature");
    }

    console.log("✅ Razorpay webhook verified");
    console.log("Payload:", req.body);

    const event = req.body.event;
    const payload = req.body.payload || {};

    const successEvents = ["payment.captured", "order.paid", "payment_link.paid"];
    if (successEvents.includes(event)) {
      // Try to identify the booking related to the payment
      let booking = null;
      let foundBy = null;
      let bookingId = null;
      if (payload.payment_link?.entity?.reference_id) {
        bookingId = payload.payment_link.entity.reference_id;
        booking = await Booking.findById(bookingId);
        foundBy = 'payment_link.reference_id';
      } else if (payload.payment?.entity?.notes?.bookingId) {
        bookingId = payload.payment.entity.notes.bookingId;
        booking = await Booking.findById(bookingId);
        foundBy = 'payment.entity.notes.bookingId';
      } else if (payload.payment?.entity?.order_id) {
        booking = await Booking.findOne({ "meta.razorpay.orderId": payload.payment.entity.order_id });
        foundBy = 'meta.razorpay.orderId';
      }
      if (!booking) {
        console.warn(`No booking found to mark as paid for payment event. Lookup method: ${foundBy}`);
        return res.status(200).send({ ok: false, msg: "Booking not found" });
      }
      if (booking.paid) {
        console.log(`Booking already marked as paid (id: ${booking._id}). No action taken.`);
        return res.status(200).send({ ok: true, alreadyPaid: true });
      }
      // Check for booking conflicts before allowing confirmation
      const conflict = await Booking.findOne({
        centre: booking.centre,
        date: booking.date,
        time_slot: normalizeSlotString(booking.time_slot),
        paid: true,
        _id: { $ne: booking._id },
      });
      if (conflict) {
        booking.step = "conflict";
        await booking.save();
        try {
          await sendMessage(booking.phone, `⚠️ Sorry, this slot was just booked by someone else and is no longer available. Please choose another.`);
        } catch (err) {
          console.error("⚠️ Failed to send WhatsApp conflict warning:", err.message || err);
        }
        console.warn(`Booking conflict: cannot confirm ${booking._id} because of existing paid booking for slot (${booking.centre}, ${booking.date}, ${booking.time_slot})`);
        return res.status(200).send({ ok: false, conflict: true });
      }
      // Mark booking as paid & completed and message only once
      booking.paid = true;
      booking.step = "completed";
      await booking.save();
      const phone = booking.phone;
      const text = `✅ Booking Confirmed!\n\nSport: ${booking.sport}\nCenter: ${booking.centre}\nDate: ${formatUserDate(booking.date)}\nTime: ${booking.time_slot}\nPlayers: ${booking.players || "-"}\nTotal: ₹${booking.totalAmount || 0}\n\nThank you!`;
      try {
        await sendMessage(phone, text);
        console.log("📩 Booking confirmation sent successfully");
      } catch (err) {
        console.error("⚠️ Failed to send WhatsApp confirmation:", err.message || err);
      }
      return res.status(200).send({ ok: true });
    }

    // Always respond quickly to Razorpay
    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("🔥 Webhook processing error:", err);
    return res.status(500).send("Server error");
  }
});

export default router;
