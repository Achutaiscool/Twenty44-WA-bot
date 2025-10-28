// testInsert.js
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Booking from "./models/Booking.js";

async function main() {
  const user = process.env.DB_USER;
  const pass = encodeURIComponent(process.env.DB_PASS || "");
  const cluster = process.env.DB_CLUSTER;
  const dbName = process.env.DB_NAME || "booking_bot";
  const uri = `mongodb+srv://${user}:${pass}@${cluster}/${dbName}?retryWrites=true&w=majority`;

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const doc = new Booking({
    phone: "9999999999",
    sport: "Padel",
    centre: "JW Marriott",
    date: "2025-11-01",
    time_slot: "09:00 - 10:00",
    players: 2,
    addons: ["spa"],
    name: "Test User",
    paid: true,
    totalAmount: 2500,
  });

  await doc.save();
  console.log("✅ Test booking inserted!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
