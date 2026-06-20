import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors());
app.use(express.json());

/* -------------------- ENV CHECK -------------------- */
const JWT_SECRET = process.env.JWT_SECRET?.trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();

if (!JWT_SECRET || !GEMINI_API_KEY) {
  console.error("Missing ENV variables");
  process.exit(1);
}

/* -------------------- DATABASE -------------------- */
let db;

const initDB = async () => {
  db = await open({
    filename: "./travel-planner.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    );

    CREATE TABLE IF NOT EXISTS travel_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      destination TEXT,
      description TEXT,
      rating REAL,
      itinerary_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("✅ Database ready");
};

/* -------------------- GEMINI -------------------- */
const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

async function generateItinerary(input) {
  const prompt = `
Return ONLY valid JSON.

User:
destination: ${input.destination}
start_date: ${input.start_date}
end_date: ${input.end_date}
budget: ${input.budget}
travelers: ${input.travelers}
trip_type: ${input.trip_type}
interests: ${JSON.stringify(input.interests)}

Create travel itinerary JSON with:
- trip_summary
- day_wise_plan
- budget_breakdown
- tips
`;

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  return result.text;
}

/* -------------------- AUTH MIDDLEWARE -------------------- */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
  }
}

/* -------------------- ROUTES -------------------- */

/* Health */
app.get("/", (req, res) => {
  res.json({ status: "OK", message: "Travel Planner API running" });
});

/* Register */
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: "Missing fields" });

    const exists = await db.get(
      "SELECT * FROM users WHERE username = ?",
      username
    );

    if (exists)
      return res.status(400).json({ error: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);

    await db.run(
      "INSERT INTO users(username, password) VALUES(?, ?)",
      username,
      hashed
    );

    res.json({ message: "User created" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Login */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await db.get(
      "SELECT * FROM users WHERE username = ?",
      username
    );

    if (!user)
      return res.status(400).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Generate itinerary */
app.post("/generate-itinerary", auth, async (req, res) => {
  try {
    const text = await generateItinerary(req.body);
    const itinerary = JSON.parse(text);

    await db.run(
      `INSERT INTO travel_history
      (user_id, destination, description, rating, itinerary_json)
      VALUES (?, ?, ?, ?, ?)`,
      req.user.userId,
      req.body.destination,
      itinerary.trip_summary?.summary || "Trip",
      itinerary.rating || 4.5,
      JSON.stringify(itinerary)
    );

    res.json({ success: true, itinerary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* History */
app.get("/history", auth, async (req, res) => {
  const data = await db.all(
    "SELECT * FROM travel_history WHERE user_id = ? ORDER BY created_at DESC",
    req.user.userId
  );

  res.json(data);
});

/* Single itinerary */
app.get("/itinerary/:id", auth, async (req, res) => {
  const item = await db.get(
    "SELECT * FROM travel_history WHERE id = ? AND user_id = ?",
    req.params.id,
    req.user.userId
  );

  if (!item) return res.status(404).json({ error: "Not found" });

  res.json(JSON.parse(item.itinerary_json));
});

/* Suggestions */
app.get("/suggestions/:destination", auth, async (req, res) => {
  const data = await db.all(
    `SELECT * FROM travel_history
     WHERE destination LIKE ?
     ORDER BY rating DESC
     LIMIT 10`,
    `%${req.params.destination}%`
  );

  res.json(data);
});

/* -------------------- START SERVER -------------------- */
initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});