// debug_google.js
import dotenv from "dotenv";
dotenv.config();

console.log("GOOGLE_CLIENT_ID ok?", !!process.env.GOOGLE_CLIENT_ID);
console.log("GOOGLE_CLIENT_SECRET ok?", !!process.env.GOOGLE_CLIENT_SECRET);
console.log("GOOGLE_REFRESH_TOKEN ok?", !!process.env.GOOGLE_REFRESH_TOKEN);
console.log(
  "GOOGLE_REFRESH_TOKEN preview:",
  (process.env.GOOGLE_REFRESH_TOKEN || "").slice(0, 10) +
    "..." +
    (process.env.GOOGLE_REFRESH_TOKEN || "").slice(-6)
);
