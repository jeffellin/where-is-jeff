/**
 * server.js — Standalone Express server
 *
 * Use this if you're NOT deploying to Vercel/Netlify.
 * Serves the static frontend + the /api/trips endpoint.
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const tripsHandler = require("./api/trips");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// API endpoint
app.get("/api/trips", (req, res) => tripsHandler(req, res));

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🌍 Where's Jeff? → http://localhost:${PORT}`);
});
