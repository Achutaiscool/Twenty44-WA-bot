// FILE: server.js
import express from "express";
import dotenv from "dotenv";
dotenv.config();


import mongoose from "mongoose";
import whatsappRoutes from "./routes/whatsApp.js";
import razorpayWebhookRoutes from "./routes/razorpayWebhook.js";


const app = express();


const {
MONGO_URI,
DB_USER,
DB_PASS,
DB_CLUSTER,
DB_NAME,
PORT = 5000,
} = process.env;


/**
* IMPORTANT: Register JSON/body parsers BEFORE mounting the webhook route
* so req.rawBody is captured correctly for signature verification.
*/
app.use(
express.json({
verify: (req, res, buf) => {
// keep raw buffer available for signature verification
req.rawBody = buf;
},
})
);


// support urlencoded payloads
app.use(express.urlencoded({ extended: true }));


// Basic health
app.get("/", (req, res) => res.send("Booking bot running"));


// Mount WhatsApp routes (if present)
if (whatsappRoutes) {
app.use("/whatsapp", whatsappRoutes);
} else {
console.warn("⚠️ whatsappRoutes not found - /whatsapp not mounted");
}


// Mount Razorpay webhook router at /razorpay (router defines /webhook)
if (razorpayWebhookRoutes) {
app.use("/razorpay", razorpayWebhookRoutes);
console.log("Mounted /razorpay routes");
} else {
console.warn("⚠️ razorpayWebhookRoutes not found - /razorpay not mounted");
}


// static (optional)
app.use(express.static("public"));


// Build/Connect MongoDB only if env variables present
let mongoConnectUri = MONGO_URI || null;
if (!mongoConnectUri) {
if (DB_USER && DB_PASS && DB_CLUSTER && DB_NAME) {
const encPass = encodeURIComponent(DB_PASS);
mongoConnectUri = `mongodb+srv://${DB_USER}:${encPass}@${DB_CLUSTER}/${DB_NAME}?retryWrites=true&w=majority`;
console.log("Built MONGO_URI from DB_* env vars");
} else {
console.warn("⚠️ MONGO_URI not set and DB_* parts incomplete — DB features disabled.");
}
}


if (!mongoConnectUri) {
console.warn("⚠️ MongoDB connection URI not available — DB features disabled.");
} else {
  // Configure mongoose connection
  const mongooseOptions = {
    dbName: DB_NAME || "booking_bot",
    serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 10s
    socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
    family: 4, // Use IPv4, skip trying IPv6
    retryWrites: true,
    w: 'majority'
  };

  // Function to connect with retry logic
  const connectWithRetry = () => {
    console.log('Attempting MongoDB connection...');
    mongoose.connect(mongoConnectUri, mongooseOptions)
      .then(() => console.log("✅ MongoDB connected to database:", DB_NAME || "booking_bot"))
      .catch(err => {
        console.error('MongoDB connection error:', err.message);
        console.log('Retrying connection in 5 seconds...');
        setTimeout(connectWithRetry, 5000);
      });
  };

  // Handle connection events
  mongoose.connection.on('error', err => {
    console.error('MongoDB connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.log('MongoDB disconnected. Attempting to reconnect...');
    connectWithRetry();
  });

  // Initial connection
  connectWithRetry();
}


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));