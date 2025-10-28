// routes/razorpayWebhook.js
import express from "express";
import rawBody from "raw-body";
import crypto from "crypto";
import dotenv from "dotenv";
import Booking from "../models/Booking.js";
import { sendMessage } from "../utils/whatsapp.js";
import { createEvent, ensureAuth } from "../utils/googleCalendar.js";
import { formatUserDate } from "../utils/dateHelpers.js";

dotenv.config();
const router = express.Router();

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

const verifySignature = (rawBodyString, signatureHeader, secret) => {
  const expected = crypto.createHmac("sha256", secret).update(rawBodyString).digest("hex");
  return expected === signatureHeader;
};

/**
 * Webhook endpoint (POST /razorpay/webhook)
 * Configure this URL in Razorpay dashboard and set the same secret.
 */
router.post("/webhook", async (req, res) => {
  try {
    // read raw body for correct signature verification
    const buf = await rawBody(req);
    const bodyStr = buf.toString();
    const signature = (req.headers["x-razorpay-signature"] || "").toString();

    if (!verifySignature(bodyStr, signature, RAZORPAY_WEBHOOK_SECRET)) {
      console.warn("Razorpay webhook signature mismatch");
      return res.status(400).send("invalid signature");
    }

    const payload = JSON.parse(bodyStr);
    const event = payload.event;
    console.log("Razorpay webhook event:", event);

    // --- handle payment link paid event (payment_link.paid) ---
    if (event === "payment_link.paid" || event === "payment_link.paid_and_credited") {
      const linkEntity = payload.payload?.payment_link?.entity;
      const referenceId = linkEntity?.reference_id; // you should set this to booking._id when creating link
      const linkId = linkEntity?.id;
      const paymentId = payload.payload?.payment?.entity?.id || null;

      if (!referenceId) {
        console.warn("No reference_id on payment link event — cannot map to booking.");
        return res.status(200).send({ ok: true });
      }

      // Mark booking paid & completed and save razorpay meta
      const booking = await Booking.findByIdAndUpdate(
        referenceId,
        {
          $set: {
            paid: true,
            step: "completed",
            "meta.razorpay.paymentLink": linkEntity,
            "meta.razorpay.lastPaymentId": paymentId || null,
            "meta.razorpay.paymentLinkId": linkId || null,
          },
        },
        { new: true }
      );

      if (!booking) {
        console.warn("Booking not found for reference_id:", referenceId);
        return res.status(200).send({ ok: true });
      }

      // Optionally create a Google Calendar event (if calendar configured)
      try {
        await ensureAuth();
        const eventRes = await createEvent({
          dateISO: booking.date,
          slot: booking.time_slot,
          summary: `${booking.sport} booking - ${booking.name || booking.phone}`,
          description: `Booked by ${booking.name || booking.phone}`,
        });
        booking.calendarEventId = eventRes?.id;
        await booking.save();
      } catch (err) {
        console.warn("Calendar event not created (non-fatal):", err?.message || err);
      }

      // Send WhatsApp confirmation automatically
      const phone = booking.phone;
      const text = `✅ Payment received — Booking Confirmed!\n\nSport: ${booking.sport}\nCenter: ${booking.centre}\nDate: ${formatUserDate(booking.date)}\nTime: ${booking.time_slot}\nPlayers: ${booking.players || "-"}\nAdd-ons: ${booking.addons?.length ? booking.addons.join(", ") : "None"}\nTotal: ₹${booking.totalAmount || 0}\n\nThank you!`;
      try {
        await sendMessage(phone, text);
        console.log("Sent confirmation message to", phone);
      } catch (err) {
        console.warn("Failed to send WhatsApp confirmation:", err?.message || err);
      }

      return res.status(200).send({ ok: true });
    }

    // --- handle payment captured/paid events for orders/payments if you use Orders API ---
    if (event === "payment.captured" || event === "payment.authorized" || event === "order.paid") {
      // try to locate booking by order id or payment notes or meta saved earlier
      const paymentEntity = payload.payload?.payment?.entity || null;
      const orderId = paymentEntity?.order_id || payload.payload?.order?.entity?.id || null;
      const paymentId = paymentEntity?.id || null;

      // Try to find booking by orderId or payment link id stored earlier in meta
      let booking = null;
      if (orderId) booking = await Booking.findOne({ "meta.razorpay.orderId": orderId });
      if (!booking && paymentEntity?.notes?.bookingId) booking = await Booking.findById(paymentEntity.notes.bookingId);

      if (booking) {
        booking.paid = true;
        booking.step = "completed";
        booking.meta = booking.meta || {};
        booking.meta.razorpay = booking.meta.razorpay || {};
        booking.meta.razorpay.lastPayment = paymentEntity;
        await booking.save();

        // create calendar event & send WA confirmation (same as above)
        try {
          await ensureAuth();
          const eventRes = await createEvent({
            dateISO: booking.date,
            slot: booking.time_slot,
            summary: `${booking.sport} booking - ${booking.name || booking.phone}`,
            description: `Booked by ${booking.name || booking.phone}`,
          });
          booking.calendarEventId = eventRes?.id;
          await booking.save();
        } catch (err) {}

        try {
          await sendMessage(booking.phone, `✅ Payment received — Booking Confirmed!\n\nSport: ${booking.sport}\nCenter: ${booking.centre}\nDate: ${formatUserDate(booking.date)}\nTime: ${booking.time_slot}\nTotal: ₹${booking.totalAmount || 0}`);
        } catch (err) {
          console.warn("Failed to send confirmation message:", err?.message || err);
        }
      } else {
        console.log("No booking found for payment/order event (orderId/payment notes):", orderId, paymentEntity?.notes);
      }

      return res.status(200).send({ ok: true });
    }

    // For other events - acknowledge
    res.status(200).send({ ok: true });
  } catch (err) {
    console.error("Razorpay webhook processing error:", err);
    return res.status(500).send("error");
  }
});

export default router;
