// models/Booking.js
import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    step: { type: String, default: "sport_selection" },
    sport: String,
    centre: String,
    date: String, // YYYY-MM-DD
    time_slot: String, // e.g. "11:00 - 12:00"
    players: Number,
    addons: [String],
    name: String,
    paid: { type: Boolean, default: false },
    calendarEventId: String,
    totalAmount: Number,
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true, collection: "bookings" }
);

// ensure index on phone (non-unique)
bookingSchema.index({ phone: 1 });

const Booking = mongoose.models.Booking || mongoose.model("Booking", bookingSchema);
export default Booking;
