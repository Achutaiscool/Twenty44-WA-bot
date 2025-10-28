// watchBookings.js
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Booking from "./models/Booking.js";

const uri = process.env.MONGO_URI;

async function watchBookings() {
  await mongoose.connect(uri, { dbName: "booking_bot" });
  console.log("👀 Watching for new bookings...");

  const collection = mongoose.connection.db.collection("bookings");
  const changeStream = collection.watch([{ $match: { operationType: "insert" } }]);

  changeStream.on("change", (change) => {
    console.log("📥 New booking added:");
    console.log(JSON.stringify(change.fullDocument, null, 2));
  });
}

watchBookings().catch((err) => console.error(err));
