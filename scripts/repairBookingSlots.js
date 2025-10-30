import mongoose from "mongoose";
import Booking from "../models/Booking.js";
import { normalizeSlotString } from "../utils/normalizeSlot.js";
import dotenv from "dotenv";
dotenv.config();

const { MONGO_URI, DB_NAME } = process.env;
(async () => {
  await mongoose.connect(MONGO_URI, { dbName: DB_NAME || "booking_bot" });
  const bookings = await Booking.find();
  let fixed = 0;
  let unchanged = 0;
  for (const b of bookings) {
    const norm = normalizeSlotString(b.time_slot);
    if (norm !== b.time_slot) {
      b.time_slot = norm;
      await b.save();
      console.log(`Fixed booking ${b._id} => ${norm}`);
      fixed++;
    } else {
      unchanged++;
    }
  }
  console.log(`Done! Updated ${fixed}, left ${unchanged} unchanged.`);
  mongoose.disconnect();
})();
