import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cors from "cors";


dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
let db;

// Database
db = await open({
  filename: "./travel.db",
  driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT
);

CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  destination TEXT,
  response TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: "Token Missing",
    });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(
    token,
    process.env.JWT_SECRET,
    (err, payload) => {
      if (err) {
        return res.status(401).json({
          error: "Invalid Token",
        });
      }

      req.user = payload;
      next();
    }
  );
};

// Register
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  const hashedPassword = await bcrypt.hash(
    password,
    10
  );

  await db.run(
    "INSERT INTO users(username,password) VALUES(?,?)",
    [username, hashedPassword]
  );

  res.json({
    message: "User Created",
  });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = await db.get(
    "SELECT * FROM users WHERE username=?",
    [username]
  );

  if (!user) {
    return res.status(400).json({
      error: "User Not Found",
    });
  }

  const isValid = await bcrypt.compare(
    password,
    user.password
  );

  if (!isValid) {
    return res.status(400).json({
      error: "Wrong Password",
    });
  }

  const token = jwt.sign(
    {
      userId: user.id,
    },
    process.env.JWT_SECRET
  );

  res.json({ token });
});

// Generate Itinerary
app.post(
  "/generate-itinerary",
  authenticateToken,
  async (req, res) => {
    const { destination } = req.body;

    const response =
      await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Create a 3 day travel plan for ${destination}`,
      });

    const result = response.text;

    await db.run(
      `
      INSERT INTO history
      (user_id,destination,response)
      VALUES(?,?,?)
      `,
      [
        req.user.userId,
        destination,
        result,
      ]
    );

    res.send(result);
  }
);

// History
app.get(
  "/history",
  authenticateToken,
  async (req, res) => {
    const history = await db.all(
      `
      SELECT id,destination,created_at
      FROM history
      WHERE user_id=?
      ORDER BY created_at DESC
      `,
      [req.user.userId]
    );

    res.json(history);
  }
);

app.get("/", (req, res) => {
  res.send(
    "Welcome to Travel Planner API"
  );
});
app.listen(3000, () => {
  console.log(
    "Server Running http://localhost:3000"
  );
});
