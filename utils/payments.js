// utils/payments.js
import Razorpay from "razorpay";
import dotenv from "dotenv";
import Booking from "../models/Booking.js";

dotenv.config();

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, BASE_URL } = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn("⚠️ Razorpay keys missing in .env (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
}

const razor = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

/**
 * Create Razorpay payment link and persist meta on booking.
 * amount in rupees (default 1 — checkout set to ₹1).
 */
export async function createPaymentLink(booking, amount = 1) {
  try {
    if (!booking || !booking._id) throw new Error("Booking required to create payment link");

  // Ensure minimum checkout amount is 1 rupee. Convert rupees -> paise
  const amountPaise = Math.max(1, Number(amount)) * 100;

    const opts = {
      amount: amountPaise,
      currency: "INR",
      description: `Sports Booking - ${booking.sport || "Sport"} at ${booking.centre || "Centre"}`,
      reference_id: String(booking._id),
      notes: { bookingId: String(booking._id) }, // crucial: copied into payment entity
      customer: {
        name: booking.name || "Guest",
        contact: booking.phone,
        email: `${booking.phone || "noone"}@example.com`,
      },
      notify: { sms: true, email: false },
      reminder_enable: true,
      callback_url: `${BASE_URL || "http://localhost:5000"}/razorpay/webhook`,
      callback_method: "get",
    };

    console.log("Creating Razorpay payment link:", { bookingId: booking._id, amountPaise });
    const resp = await razor.paymentLink.create(opts);

    // persist meta into booking
    booking.meta = booking.meta || {};
    booking.meta.razorpay = booking.meta.razorpay || {};
    booking.meta.razorpay.paymentLinkId = resp.id || booking.meta.razorpay.paymentLinkId;
    booking.meta.razorpay.paymentLinkUrl = resp.short_url || booking.meta.razorpay.paymentLinkUrl;
    booking.meta.razorpay.lastCreatedAt = new Date().toISOString();
    booking.step = "payment_pending";
    await booking.save();

    console.log(`✅ Payment link created for booking ${booking._id}: ${resp.short_url}`);
    return resp.short_url;
  } catch (err) {
    console.error("Error creating payment link:", err?.message || err);
    throw err;
  }
}
