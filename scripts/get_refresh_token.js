import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = 3000;

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.get("/", (req, res) => {
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });
  res.send(`<a href="${url}" target="_blank">Authorize with Google</a>`);
  console.log("\n👉 Open this link in your browser:");
  console.log(url);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("No code found");
  const { tokens } = await oAuth2Client.getToken(code);
  console.log("\n✅ TOKENS RECEIVED:\n", tokens);
  res.send(`<pre>${JSON.stringify(tokens, null, 2)}</pre><p>Copy the "refresh_token" and add to your .env</p>`);
  process.exit(0);
});

app.listen(PORT, () => console.log(`🚀 Visit http://localhost:${PORT}`));
