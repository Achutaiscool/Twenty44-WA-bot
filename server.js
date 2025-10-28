// server.js
import dotenv from "dotenv";
dotenv.config(); // MUST run first

import express from "express";
import mongoose from "mongoose";
import whatsAppRouter from "./routes/whatsapp.js";

const app = express();
app.use(express.json());

// quick debug: print whether critical envs are loaded (remove in production)
console.log("ENV: ACCESS_TOKEN loaded?", !!process.env.ACCESS_TOKEN);
console.log("ENV: PHONE_NUMBER_ID loaded?", !!process.env.PHONE_NUMBER_ID);
console.log("ENV: GOOGLE_REFRESH_TOKEN loaded?", !!process.env.GOOGLE_REFRESH_TOKEN);
console.log("ENV: MONGO_URI loaded?", !!process.env.MONGO_URI);

if (process.env.MONGO_URI) {
  mongoose
    .connect(process.env.MONGO_URI, { autoIndex: true })
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("Mongo connect error:", err.message));
} else {
  console.warn("⚠️ MONGO_URI not set — running without DB (Booking persistence disabled)");
}

app.use("/webhook", whatsAppRouter);

app.get("/", (req, res) => res.send("WhatsApp Booking Bot running 🚀"));

const PORT = parseInt(process.env.PORT || "5000", 10);
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
