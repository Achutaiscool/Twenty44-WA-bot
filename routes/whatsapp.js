// routes/whatsApp.js

import express from "express";
import Booking from "../models/Booking.js";
import { sendMessage, sendButtonsMessage, sendListMessage, sendUrlButtonMessage } from "../utils/whatsapp.js";
import { getAvailableSlots, createEvent } from "../utils/googleCalendar.js";
import { createPaymentLink } from "../utils/payments.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

// Helper function to check if a slot is available in DB
const isSlotAvailable = async (centre, sport, date, timeSlot) => {
  try {
    const existing = await Booking.findOne({
      centre,
      sport,
      date,
      time_slot: timeSlot,
    });
    return !existing; // true if available, false if taken
  } catch (err) {
    console.error("Error checking slot availability:", err);
    return false; // Fail safe - assume not available if error
  }
};

// Verification endpoint for webhook
router.get("/", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  if (mode && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  console.error("Webhook verification failed");
  res.sendStatus(403);
});

// Main webhook handler
router.post("/", async (req, res) => {
  console.log('=== NEW WEBHOOK REQUEST ===');
  
  try {
    // Extract message details
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];
    
    if (!message) {
      console.log('No message found in webhook');
      return res.sendStatus(200);
    }

    // Process message
    const messageId = message?.id;
    const interactive = message?.interactive || {};
    const buttonReply = interactive?.button_reply || null;
    const listReply = interactive?.list_reply || null;
    const incomingText = message.text?.body?.trim() || '';
    
    // Determine the message content
    const msgRaw = listReply?.id || buttonReply?.id || 
                  listReply?.title || buttonReply?.title || 
                  incomingText || "";
    
    const msg = String(msgRaw).trim();
    const msgLower = msg.toLowerCase();
    const from = message.from;

    console.log(`Processing message from ${from}: ${msg}`)
    console.log('Message details:', { listReply, buttonReply, incomingText });

    // Find or create booking
    let booking = await Booking.findOne({ phone: from });
    if (!booking) {
      booking = new Booking({
        phone: from,
        step: 'welcome',
        meta: {}
      });
      await booking.save();
      console.log('Created new booking record:', { id: booking._id?.toString(), phone: booking.phone });
      
      await sendWelcomeMessage(from);
      return res.sendStatus(200);
    }

    // Dedupe by messageId
    if (messageId) {
      if (!booking.meta) booking.meta = {};
      if (booking.meta.lastMessageId === messageId) {
        console.log("Duplicate webhook ignored", messageId);
        return res.sendStatus(200);
      }
      booking.meta.lastMessageId = messageId;
      booking.markModified('meta');
    }

    // Handle sport selection
    if (msg.startsWith('sport_')) {
      const selectedSport = msg.split('_')[1];
      if (!booking.meta) booking.meta = {};
      booking.meta.selectedSport = selectedSport;
      booking.step = 'selecting_location';
      booking.markModified('meta');
      await booking.save();
      
      console.log('✅ Selected sport:', selectedSport);
      
      // Send location selection
      await sendLocationSelection(from);
      return res.sendStatus(200);
    }

    // Handle location selection
    if (msg.startsWith('location_')) {
      const selectedLocation = msg.split('_')[1];
      if (!booking.meta) booking.meta = {};
      booking.meta.selectedLocation = selectedLocation;
      booking.step = 'selecting_date';
      booking.markModified('meta');
      await booking.save();
      
      console.log('✅ Selected location:', selectedLocation);
      
      // Get dates with available slots
      let datesWithSlots = await getAvailableDates();
      
      // Fallback: if calendar check fails, show all dates
      if (datesWithSlots.length === 0) {
        console.warn('⚠️ Calendar API unavailable, showing all dates as fallback');
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        datesWithSlots = [];
        for (let i = 0; i < 7; i++) {
          const date = new Date();
          date.setDate(date.getDate() + i);
          const dayName = days[date.getDay()];
          const day = String(date.getDate()).padStart(2, '0');
          const month = months[date.getMonth()];
          const dateStr = date.toISOString().split('T')[0];
          
          datesWithSlots.push({
            dateStr,
            title: `${dayName}, ${day} ${month}`,
            availableCount: 16 // Show estimated slots
          });
        }
      }
      
      // Send date selection list (shorten IDs for WhatsApp)
      const dateRows = datesWithSlots.map((d, idx) => ({
        id: `dt${idx}`, // Short ID format
        title: d.title,
        description: `${d.availableCount} slots`
      }));
      
      // Store date mapping for later
      if (!booking.meta) booking.meta = {};
      booking.meta.dateMapping = datesWithSlots.reduce((acc, d, idx) => {
        acc[`dt${idx}`] = d.dateStr;
        return acc;
      }, {});
      booking.markModified('meta'); // Mark meta as modified for MongoDB
      await booking.save();
      
      console.log('✅ Saved date mapping:', booking.meta.dateMapping);
      
      await sendListMessage(from, '📅 Select a Date', [{
        title: 'Available Dates',
        rows: dateRows
      }]);
      
      return res.sendStatus(200);
    }

    // Handle date selection
    if (msg.startsWith('dt')) {
      console.log('Date selection detected:', msg);
      console.log('Date mapping:', booking.meta?.dateMapping);
      
      if (!booking.meta?.dateMapping) {
        await sendMessage(from, '❌ Session expired. Please type "start" to begin again.');
        return res.sendStatus(200);
      }
      
      const selectedDate = booking.meta.dateMapping[msg];
      
      if (!selectedDate) {
        await sendMessage(from, '❌ Invalid date selection. Please type "start" to try again.');
        return res.sendStatus(200);
      }
      
      booking.meta.selectedDate = selectedDate;
      booking.step = 'selecting_time_period';
      booking.markModified('meta');
      await booking.save();
      
      console.log('✅ Saved selected date:', selectedDate);
      
      // Format date for display
      const date = new Date(selectedDate);
      const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      const formattedDate = date.toLocaleDateString('en-US', options);
      
      // Store selected date for time period buttons
      booking.meta.currentDate = selectedDate;
      booking.markModified('meta');
      await booking.save();
      
      // Send time period selection (Morning and Evening only)
      const timePeriodButtons = [
        {
          id: 'period_morning',
          title: '🌅 Morning'
        },
        {
          id: 'period_evening',
          title: '🌃 Evening'
        }
      ];
      
      await sendButtonsMessage(
        from,
        `⏰ Select a time period for ${formattedDate}:`,
        timePeriodButtons
      );
      
      return res.sendStatus(200);
    }

    // Handle time period selection (morning/evening)
    if (msg.startsWith('period_')) {
      const period = msg.replace('period_', '');
      const selectedDate = booking.meta.currentDate;
      
      if (!selectedDate) {
        await sendMessage(from, '❌ Session expired. Please type "start" to begin again.');
        return res.sendStatus(200);
      }
      
      booking.meta.selectedDate = selectedDate;
      booking.meta.selectedPeriod = period;
      booking.step = 'selecting_time_slot';
      booking.markModified('meta');
      await booking.save();
      
      // Define time ranges for each period
      let startHour, endHour;
      // We split the full day (6:00 - 22:00) into two equal periods of 8 slots each:
      // Morning: 06:00 - 14:00 (8 one-hour slots)
      // Evening: 14:00 - 22:00 (8 one-hour slots)
      if (period === 'morning') {
        startHour = 6;
        endHour = 14;
      } else { // evening
        startHour = 14; // 2 PM
        endHour = 22; // 10 PM
      }
      
      // Get available slots from Google Calendar
      let availableSlots = [];
      try {
        availableSlots = await getAvailableSlots(selectedDate);
      } catch (error) {
        console.warn('⚠️ Calendar API unavailable, generating fallback slots');
        // Generate fallback slots if API fails
        for (let hour = startHour; hour < endHour; hour++) {
          const startTimeStr = hour.toString().padStart(2, '0') + ':00';
          const endTimeStr = (hour + 1).toString().padStart(2, '0') + ':00';
          availableSlots.push({
            start: new Date(),
            end: new Date(),
            formatted: `${startTimeStr} - ${endTimeStr}`
          });
        }
      }
      
      // Filter slots for the selected period
      const periodSlots = availableSlots.filter(slot => {
        const slotHour = slot.start ? slot.start.getHours() : parseInt(slot.formatted.split(':')[0]);
        return slotHour >= startHour && slotHour < endHour;
      });
      
      if (periodSlots.length === 0) {
        await sendMessage(from, `❌ No available slots for ${period} on this date. Please choose another time period or date.`);
        return res.sendStatus(200);
      }
      
      // Generate time slot rows with short IDs
      const slotRows = periodSlots.map((slot, idx) => ({
        id: `sl${idx}`,
        title: slot.formatted,
        description: 'Available'
      }));
      
      // Store slot mapping
      booking.meta.slotMapping = periodSlots.reduce((acc, slot, idx) => {
        acc[`sl${idx}`] = slot.formatted;
        return acc;
      }, {});
      booking.markModified('meta');
      await booking.save();
      
      console.log('✅ Saved slot mapping:', booking.meta.slotMapping);
      
      // Send time slot selection as a list
      await sendListMessage(from, '🕒 Select a Time Slot', [{
        title: `${period === 'morning' ? '🌅 Morning' : '🌃 Evening'} Slots`,
        rows: slotRows
      }]);
      
      return res.sendStatus(200);
    }

    // Handle cancel booking
    if (msg === 'cancel_booking') {
      await Booking.deleteOne({ phone: from });
      await sendMessage(from, "❌ Booking cancelled. Type 'start' to begin a new booking.");
      return res.sendStatus(200);
    }

    // Handle calendar/book command
    if (msgLower === 'calendar' || msgLower === 'check calendar' || msgLower === 'book') {
      booking.step = 'selecting_sport';
      await booking.save();
      
      await sendSportSelection(from);
      return res.sendStatus(200);
    }
    
    // Handle slot selection
    if (msg.startsWith('sl') && /^sl\d+$/.test(msg)) {
      await handleSlotSelection(from, booking, msg);
      return res.sendStatus(200);
    }
    
    // Handle booking confirmation
    if (msg.startsWith('confirm_')) {
      await handleBookingConfirmation(from, booking, msg);
      return res.sendStatus(200);
    }

    // Handle start/restart
    if (msgLower === "start" || msgLower === "hi" || msgLower === "hello" || msgLower === "1") {
      await Booking.deleteOne({ phone: from });
      await sendWelcomeMessage(from);
      return res.sendStatus(200);
    }

    // Handle exit/cancel
    if (msgLower === "exit" || msgLower === "cancel") {
      await Booking.deleteOne({ phone: from });
      await sendMessage(from, "❌ Booking cancelled. Type 'start' anytime to begin again.");
      return res.sendStatus(200);
    }

    // Fallback: Unknown command
    await sendMessage(from, "❓ I didn't understand that. Type 'start' to begin or 'help' for assistance.");

    await booking.save();
    return res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook Error:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body
    });
    
    // Try to send error message to user
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await sendMessage(from, '❌ An error occurred. Please try again.');
      }
    } catch (e) {
      console.error('Failed to send error message to user:', e);
    }
    
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
});

// Helper function to get dates with available slots
const getAvailableDates = async () => {
  const datesWithSlots = [];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    const dayName = days[date.getDay()];
    const day = String(date.getDate()).padStart(2, '0');
    const month = months[date.getMonth()];
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    
    try {
      // Check if this date has any available slots
      const slots = await getAvailableSlots(dateStr);
      
      if (slots.length > 0) {
        datesWithSlots.push({
          dateStr,
          title: `${dayName}, ${day} ${month}`,
          availableCount: slots.length
        });
      }
    } catch (error) {
      console.error(`Error checking availability for ${dateStr}:`, error);
    }
  }
  
  return datesWithSlots;
};

// Helper function to send sport selection
const sendSportSelection = async (to) => {
  const sportButtons = [
    {
      id: 'sport_pickleball',
      title: '🏓 Pickleball'
    },
    {
      id: 'sport_paddle',
      title: '🎾 Paddle'
    }
  ];
  
  await sendButtonsMessage(
    to,
    '🏃 Welcome! Which sport would you like to play?',
    sportButtons
  );
};

// Helper function to send location selection
const sendLocationSelection = async (to) => {
  const locationButtons = [
    {
      id: 'location_jw',
      title: '🏨 JW Marriott'
    },
    {
      id: 'location_taj',
      title: '🏨 Taj West End'
    },
    {
      id: 'location_itc',
      title: '🏨 ITC Gardenia'
    }
  ];
  
  await sendButtonsMessage(
    to,
    '📍 Select your preferred location:',
    locationButtons
  );
};


// Helper function to send welcome message with sport selection
const sendWelcomeMessage = async (to) => {
  await sendSportSelection(to);
};

// Handle slot selection
async function handleSlotSelection(phone, booking, msg) {
  try {
    // Extract slot information from mapping
    const timeRange = booking.meta?.slotMapping?.[msg];
    const date = booking.meta?.selectedDate;
    
    if (!timeRange || !date) {
      await sendMessage(phone, '❌ Session expired. Please type "start" to begin again.');
      return;
    }

    // Prepare location and sport details for conflict check and DB persistence
    const locationMap = {
      'jw': 'JW Marriott',
      'taj': 'Taj West End',
      'itc': 'ITC Gardenia'
    };
    const sportName = booking.meta.selectedSport === 'pickleball' ? 'Pickleball' : 'Paddle';
    const centre = locationMap[booking.meta.selectedLocation] || booking.meta.selectedLocation;

    // Check if slot is available before proceeding
    const available = await isSlotAvailable(centre, sportName, date, timeRange);
    if (!available) {
      await sendMessage(phone, '❌ Sorry, this slot is no longer available. Please select a different time slot.');
      return;
    }
    
    // Store selection in meta
    booking.meta.selectedTimeSlot = timeRange;
    booking.meta.confirmDate = date;
    booking.meta.confirmTime = timeRange;
    booking.markModified('meta');
    // Prepare update payload for persistent booking record
    const amount = booking.meta?.price || Number(process.env.DEFAULT_BOOKING_AMOUNT) || 1;
    const updatePayload = {
      sport: sportName,
      centre,
      date,
      time_slot: timeRange,
      totalAmount: Number(amount),
      meta: booking.meta,
      step: booking.step || 'payment_pending',
    };

    try {
      console.log('Persisting booking to DB (findByIdAndUpdate)', { bookingId: booking._id?.toString(), updatePayload });
      // Use findByIdAndUpdate to ensure DB update even if model instance is out-of-sync
      const updated = await Booking.findByIdAndUpdate(booking._id, updatePayload, { new: true, upsert: false });
      if (!updated) {
        console.warn('Failed to update booking record (not found):', booking._id);
        await sendMessage(phone, '⚠️ Could not persist booking. Please try again.');
        return;
      }
      // Replace local booking object with the one from DB
      booking = updated;
      console.log('Persisted booking to DB:', booking._id.toString());
    } catch (err) {
      // Handle duplicate slot (unique index on centre+sport+date+time_slot)
      if (err?.code === 11000) {
        console.warn('Slot already booked while trying to persist booking:', { centre, date, timeRange });
        await sendMessage(phone, '⚠️ Sorry, this slot was just booked by someone else. Please choose another slot or date.');
        return;
      }
      console.error('Error persisting booking:', err);
      throw err;
    }

    // Send booking summary to user before payment
    const slotDate = new Date(date);
    const formattedDate = slotDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const summary = `📋 Booking Summary\n\nSport: ${sportName}\nLocation: ${centre}\nDate: ${formattedDate}\nTime: ${timeRange}\nAmount: ₹${booking.totalAmount}`;
    await sendMessage(phone, summary);
    
    // Create a Razorpay payment link and send to the user as a tappable URL button
    // Amount precedence: booking.meta.price -> DEFAULT_BOOKING_AMOUNT env -> 1
    try {
  // Use stored booking.totalAmount as authoritative amount
  const paymentUrl = await createPaymentLink(booking, booking.totalAmount || 1);
      if (paymentUrl) {
        const body = `💳 Please complete payment to confirm your booking.\nAmount: ₹${amount}\nTap the button below to pay.\n\nWe'll confirm automatically after successful payment.`;
        // Use interactive URL button when available
        try {
          await sendUrlButtonMessage(phone, body, paymentUrl, 'Pay Now');
        } catch (e) {
          // Fallback to plain URL text if interactive URL button fails
          console.warn('URL button failed, falling back to text link:', e?.message || e);
          await sendMessage(phone, `${body}\n${paymentUrl}\nAfter payment, tap "✅ Confirm".`);
        }
      }
    } catch (err) {
      console.error('Failed to create/send payment link:', err?.message || err);
      await sendMessage(phone, '⚠️ Unable to create a payment link right now. You can still confirm and we will follow up for payment.');
    }
    
    // We no longer ask for manual confirmation. The webhook will auto-confirm the booking
    // and send the final confirmation message to the user after payment is captured.
    await sendMessage(phone, `📩 Payment sent. We'll confirm your booking automatically once payment is received.`);
  } catch (error) {
    console.error('Slot selection error:', error);
    await sendMessage(phone, '❌ Failed to process your selection. Please try again.');
  }
}

// Handle booking confirmation
async function handleBookingConfirmation(phone, booking, msg) {
  try {
    if (msg === 'confirm_no') {
      await Booking.deleteOne({ phone });
      await sendMessage(phone, "❌ Booking cancelled. Type 'start' to begin a new booking.");
      return;
    }
    
    const date = booking.meta?.confirmDate;
    const timeRange = booking.meta?.confirmTime;
    
    if (!date || !timeRange) {
      await sendMessage(phone, '❌ Session expired. Please type "start" to begin again.');
      return;
    }
    
    const [startTime, endTime] = timeRange.split('-');
    const sport = booking.meta.selectedSport === 'pickleball' ? 'Pickleball' : 'Paddle';
    const sportEmoji = booking.meta.selectedSport === 'pickleball' ? '🏓' : '🎾';
    
    const locationMap = {
      'jw': 'JW Marriott',
      'taj': 'Taj West End',
      'itc': 'ITC Gardenia'
    };
    const location = locationMap[booking.meta.selectedLocation] || booking.meta.selectedLocation;
    
    // If payment is pending, block confirmation until webhook marks booking as paid
    if (booking.step === 'payment_pending' && !booking.paid) {
      const paymentUrl = booking.meta?.razorpay?.paymentLinkUrl;
      const amount = booking.meta?.price || Number(process.env.DEFAULT_BOOKING_AMOUNT) || 300;
      const body = `🔒 Payment required to confirm booking.\nAmount: ₹${amount}\nPlease complete payment and wait for confirmation.`;
      try {
        if (paymentUrl) {
          await sendUrlButtonMessage(phone, body, paymentUrl, 'Pay Now');
        } else {
          await sendMessage(phone, `${body}\nWe couldn't find a payment link. Please try slot selection again or contact support.`);
        }
      } catch (e) {
        console.warn('Failed to send payment reminder button:', e?.message || e);
        if (paymentUrl) await sendMessage(phone, `${body}\n${paymentUrl}`);
      }
      return;
    }
    
    // Try to create Google Calendar event
    let calendarCreated = false;
    try {
      await createEvent({
        dateISO: date,
        slot: timeRange,
        summary: `${sport} Court Booking`,
        description: `${sport} court booking via WhatsApp by ${phone}`,
        timezone: process.env.GOOGLE_DEFAULT_TIMEZONE || 'Asia/Kolkata'
      });
      calendarCreated = true;
    } catch (error) {
      console.error('⚠️ Failed to create calendar event:', error.message);
      // Continue with booking even if calendar creation fails
    }
    
    // Send confirmation message
    const slotDate = new Date(date);
    const formattedDate = slotDate.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    const calendarNote = calendarCreated 
      ? '\n📆 Calendar event created!' 
      : '\n⚠️ Note: Calendar sync unavailable';
    
    await sendMessage(
      phone,
      `✅ Booking Confirmed!\n\n${sportEmoji} ${sport}\n📍 ${location}\n📅 ${formattedDate}\n🕒 ${timeRange}${calendarNote}\n\nSee you at the court! 🎉`
    );
    
    // Reset booking state
    await Booking.deleteOne({ phone });
    
  } catch (error) {
    console.error('Booking confirmation error:', error);
    await sendMessage(phone, '❌ Failed to confirm booking. Please try again.');
  }
}

export default router;
