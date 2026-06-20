import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

/* ---------------- DB ---------------- */
let db;

const initDB = async () => {
  db = await open({
    filename: "./travel.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      destination TEXT,
      response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("DB Connected");
};

/* ---------------- GEMINI ---------------- */
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function generatePlan(destination) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Create a simple 3-day travel plan for ${destination}`,
  });

  return response.text;
}

/* ---------------- JWT MIDDLEWARE ---------------- */
const auth = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: "No token" });
  }

  const token = header.split(" ")[1];

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });

    req.user = user;
    next();
  });
};

/* ---------------- REGISTER ---------------- */
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    await db.run(
      "INSERT INTO users(username,password) VALUES (?,?)",
      [username, hash]
    );

    res.json({ message: "User registered" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- LOGIN ---------------- */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await db.get(
      "SELECT * FROM users WHERE username=?",
      [username]
    );

    if (!user) {
      return res.status(400).json({
        error: "User not found",
      });
    }

    const isValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isValid) {
      return res.status(400).json({
        error: "Wrong password",
      });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET
    );

    return res.json({ token });

  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({
      error: err.message,
    });
  }
});
async function generatePlan(destination) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
You are a travel planner.

Return ONLY valid JSON in this format:

{
  "destination": "${destination}",
  "places": [
    {
      "day": 1,
      "title": "Place name",
      "description": "short description"
    }
  ]
}

Rules:
- Only JSON
- No text
- No markdown
- Minimum 5 places
`
  });

  return response.text;
}

/* ---------------- GENERATE + SAVE ---------------- */
app.post("/generate-itinerary", auth, async (req, res) => {
  try {
    const result = await generatePlan(req.body.destination);

    const json = JSON.parse(result); // convert to JSON

    await db.run(
      `INSERT INTO history(user_id,destination,response)
       VALUES(?,?,?)`,
      [req.user.userId, req.body.destination, result]
    );

    res.json(json); // send JSON directly
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- HISTORY ---------------- */
app.get("/history", auth, async (req, res) => {
  const data = await db.all(
    "SELECT * FROM history WHERE user_id=? ORDER BY created_at DESC",
    [req.user.userId]
  );

  res.json(data);
});

/* ---------------- ROOT ---------------- */
app.get("/", (req, res) => {
  res.send("Travel API Running");
});

/* ---------------- START ---------------- */
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
});
