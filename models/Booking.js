// models/Booking.js
import mongoose from "mongoose";

const BookingSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  step: { type: String, default: "sport_selection" },
  sport: String,
  centre: String,
  date: String, // YYYY-MM-DD
  time_slot: String, // "18:00 - 19:00"
  players: Number,
  paid: { type: Boolean, default: false },
  confirmedAt: Date,
  candidateDates: [String],
  lastShownMonth: { year: Number, month: Number },
  pageIndex: Number,
  calendarEventId: String,
}, { timestamps: true });

export default mongoose.models.Booking || mongoose.model("Booking", BookingSchema);
