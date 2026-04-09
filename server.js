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
const PIN = (process.env.PIN || "9898AF").toUpperCase();

// ── Cookie parser (no extra dependency) ──
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) header.split(";").forEach(c => {
    const [k, ...v] = c.split("=");
    cookies[k.trim()] = decodeURIComponent(v.join("=").trim());
  });
  return cookies;
}

// ── Auth middleware ──
function requirePin(req, res, next) {
  if (req.path === "/auth") return next(); // let the auth endpoint through

  const cookies = parseCookies(req);
  const submitted = (req.query.pin || cookies.auth_pin || "").toUpperCase();

  if (submitted === PIN) {
    // If PIN came in via query param, set cookie so future visits don't need it
    if (req.query.pin && !cookies.auth_pin) {
      res.setHeader("Set-Cookie", `auth_pin=${PIN}; Max-Age=${365 * 24 * 60 * 60}; Path=/; SameSite=Lax`);
    }
    return next();
  }

  res.sendFile(path.join(__dirname, "public", "login.html"));
}

app.use(express.urlencoded({ extended: false }));
app.use(requirePin);

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// ── Auth endpoint ──
app.post("/auth", (req, res) => {
  const submitted = (req.body.pin || "").toUpperCase();
  if (submitted === PIN) {
    res.setHeader("Set-Cookie", `auth_pin=${PIN}; Max-Age=${365 * 24 * 60 * 60}; Path=/; SameSite=Lax`);
    res.redirect("/");
  } else {
    res.redirect("/?error=1");
  }
});

// API endpoint
app.get("/api/trips", (req, res) => tripsHandler(req, res));

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🌍 Where's Jeff? → http://localhost:${PORT}`);
});
