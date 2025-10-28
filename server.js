// server.js
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import bodyParser from "body-parser";
import whatsappRoutes from "./routes/whatsApp.js";
import razorpayWebhookRoutes from "./routes/razorpayWebhook.js";
app.use("/razorpay", razorpayWebhookRoutes);


const app = express();
app.use(bodyParser.json());

// health check
app.get("/", (req, res) => res.send("🏓 Booking bot running!"));

app.use("/whatsapp", whatsappRoutes);

// Build Mongo URI using components (safe for special chars)
const DB_USER = process.env.DB_USER;
const DB_PASS = encodeURIComponent(process.env.DB_PASS || "");
const DB_CLUSTER = process.env.DB_CLUSTER;
const DB_NAME = process.env.DB_NAME || "booking_bot";

if (!DB_USER || !DB_PASS || !DB_CLUSTER) {
  console.warn("⚠️ Missing DB env vars. Please set DB_USER, DB_PASS, DB_CLUSTER in .env");
} else {
  const uri = `mongodb+srv://${DB_USER}:${DB_PASS}@${DB_CLUSTER}/${DB_NAME}?retryWrites=true&w=majority`;
  mongoose
    .connect(uri)
    .then(() => console.log(`✅ MongoDB connected to database: ${DB_NAME}`))
    .catch((err) => console.error("❌ MongoDB connection error:", err));
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
