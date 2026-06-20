import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
    optionsSuccessStatus: 204,
    preflightContinue: false,
  })
);
app.options("/*", cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
let db = null;

const createTables = async () => {
  await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS travel_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  destination TEXT NOT NULL,
  description TEXT,
  rating REAL DEFAULT 4.5,
  itinerary_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
  `);
};

const initializeDB = async () => {
  try {
    db = await open({
      filename: "./travel-planner.db",
      driver: sqlite3.Database,
    });

    await createTables();
    console.log("Database Connected");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function generateText(userInput) {
  const {
    destination,
    start_date,
    end_date,
    budget,
    travelers,
    trip_type,
    interests,
    accommodation_type,
    transportation_preference,
  } = userInput;

  const prompt = `
You are an AI Travel Planner API.

Return ONLY valid JSON.

User Input:
{
  "destination": "${destination}",
  "start_date": "${start_date}",
  "end_date": "${end_date}",
  "budget": "${budget}",
  "travelers": "${travelers}",
  "trip_type": "${trip_type}",
  "interests": ${JSON.stringify(interests)},
  "accommodation_type": "${accommodation_type}",
  "transportation_preference": "${transportation_preference}"
}

Generate a complete travel itinerary JSON.
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  return response.text;
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header missing" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Token missing" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (error, payload) => {
    if (error) {
      return res.status(403).json({ error: "Invalid token" });
    }

    req.user = payload;
    next();
  });
};

app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const existingUser = await db.get(`SELECT * FROM users WHERE username = ?`, [username]);
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.run(
      `INSERT INTO users(username, password) VALUES(?, ?)`,
      [username, hashedPassword]
    );

    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const user = await db.get(
      `SELECT * FROM users WHERE username = ?`,
      [username]
    );

    if (!user) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

    const payload = { userId: user.id, username: user.username };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });

    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/generate-itinerary", authenticateToken, async (req, res) => {
  try {
    const result = await generateText(req.body);
    let itinerary;

    try {
      itinerary = JSON.parse(result);
    } catch (parseError) {
      return res.status(500).json({
        error: "Invalid JSON returned by Gemini",
        details: parseError.message,
        rawResult: result,
      });
    }

    await db.run(
      `INSERT INTO travel_history(user_id, destination, description, rating, itinerary_json) VALUES(?,?,?,?,?)`,
      [
        req.user.userId,
        itinerary.trip_summary?.destination || req.body.destination || "",
        itinerary.trip_summary?.summary || "Travel Plan",
        itinerary.rating || 4.5,
        JSON.stringify(itinerary),
      ]
    );

    res.json({ success: true, itinerary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/history", authenticateToken, async (req, res) => {
  try {
    const history = await db.all(
      `SELECT id, destination, description, rating, created_at FROM travel_history WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.userId]
    );

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/itinerary/:id", authenticateToken, async (req, res) => {
  try {
    const itinerary = await db.get(
      `SELECT * FROM travel_history WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.userId]
    );

    if (!itinerary) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(JSON.parse(itinerary.itinerary_json));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/suggestions/:destination", authenticateToken, async (req, res) => {
  try {
    const { destination } = req.params;
    const suggestions = await db.all(
      `SELECT id, destination, description, rating FROM travel_history WHERE destination LIKE ? ORDER BY rating DESC LIMIT 10`,
      [`%${destination}%`]
    );

    res.json(suggestions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error("Express error:", err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const payload = {
    error: err.message || "Internal Server Error",
  };

  if (process.env.NODE_ENV !== "production") {
    payload.stack = err.stack;
  }

  res.status(err.status || 500).json(payload);
});

app.get("/", (req, res) => {
  res.json({ success: true, message: "Travel planner API is running" });
});

initializeDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server Running: http://localhost:${PORT}`);
  });
});
