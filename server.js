// ============================================
// StudyFox Backend - RELEASE BUILD (FULL API)
// Powered by ARION
// Owner: Oderinu Marvelous
// ============================================

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const PDFParser = require("pdf2json");
const PDFDocument = require("pdfkit");

const { db, initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 5050;

app.set("trust proxy", 1);

// =====================
// SECURITY + CORS
// =====================
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// ✅ Allow Netlify + everyone for testing/review
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// =====================
// FRONTEND SERVE (optional)
// =====================
const FRONTEND_PATH = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_PATH));

// =====================
// UPLOADS
// =====================
const uploadRoot = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });
app.use("/uploads", express.static(uploadRoot));

function ensureUserUploadDir(userId) {
  const dir = path.join(uploadRoot, `user_${userId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// =====================
// DATABASE INIT
// =====================
initDb();

// =====================
// SESSION STORE (Memory tokens)
// =====================
const sessions = new Map(); // token -> { user, exp }
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12 hours

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.replace("Bearer ", "").trim();
}

function auth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (Date.now() > session.exp) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expired" });
  }

  req.user = session.user;
  req.token = token;
  next();
}

// cleanup expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions.entries()) {
    if (now > s.exp) sessions.delete(t);
  }
}, 60 * 1000).unref();

// =====================
// HEALTH
// =====================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "StudyFox",
    poweredBy: "ARION",
    owner: "Oderinu Marvelous",
  });
});

// =====================
// AUTH
// =====================
app.post(
  "/api/auth/signup",
  [
    body("name").trim().isLength({ min: 2 }).withMessage("Name too short"),
    body("email").isEmail().withMessage("Invalid email"),
    body("password").isLength({ min: 4 }).withMessage("Password must be at least 4 characters"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    db.get("SELECT id FROM users WHERE email = ?", [email], async (err, row) => {
      if (row) return res.status(400).json({ error: "Email already exists" });

      const hash = await bcrypt.hash(password, 10);

      db.run(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
        [name, email, hash],
        function (err2) {
          if (err2) return res.status(500).json({ error: "Signup failed: " + err2.message });

          const user = { id: this.lastID, name, email };
          const token = makeToken();

          sessions.set(token, { user, exp: Date.now() + SESSION_TTL });
          ensureUserUploadDir(user.id);

          res.json({ ok: true, token, user });
        }
      );
    });
  }
);

app.post(
  "/api/auth/login",
  [
    body("email").isEmail().withMessage("Invalid email"),
    body("password").isLength({ min: 1 }).withMessage("Password required"),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    db.get("SELECT id, name, email, password_hash FROM users WHERE email = ?", [email], async (err, row) => {
      if (!row) return res.status(401).json({ error: "Invalid login" });

      const ok = await bcrypt.compare(password, row.password_hash || "");
      if (!ok) return res.status(401).json({ error: "Invalid login" });

      const user = { id: row.id, name: row.name, email: row.email };
      const token = makeToken();

      sessions.set(token, { user, exp: Date.now() + SESSION_TTL });
      ensureUserUploadDir(user.id);

      res.json({ ok: true, token, user });
    });
  }
);

app.post("/api/auth/logout", auth, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json(req.user);
});

// =====================
// DASHBOARD STATS
// =====================
app.get("/api/stats", auth, (req, res) => {
  db.get("SELECT COUNT(*) AS documents FROM documents WHERE user_id = ?", [req.user.id], (err, docRow) => {
    db.get(
      "SELECT COUNT(*) AS quizzes, AVG(percent) AS avgPercent FROM quiz_attempts WHERE user_id = ?",
      [req.user.id],
      (err2, qRow) => {
        res.json({
          documents: docRow?.documents || 0,
          quizzes: qRow?.quizzes || 0,
          avgScore: Math.round(qRow?.avgPercent || 0),
        });
      }
    );
  });
});

// =====================
// LIBRARY
// =====================
app.get("/api/library", auth, (req, res) => {
  db.all(
    "SELECT id, title, filename, created_at FROM documents WHERE user_id = ? ORDER BY id DESC",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error: " + err.message });
      res.json({ ok: true, documents: rows || [] });
    }
  );
});

app.delete("/api/documents/:id", auth, (req, res) => {
  const docId = Number(req.params.id);

  db.get("SELECT filename FROM documents WHERE id = ? AND user_id = ?", [docId, req.user.id], (err, row) => {
    if (!row) return res.status(404).json({ error: "Document not found" });

    db.run("DELETE FROM documents WHERE id = ? AND user_id = ?", [docId, req.user.id], (err2) => {
      if (err2) return res.status(500).json({ error: "DB delete error: " + err2.message });

      try {
        const fp = path.join(uploadRoot, `user_${req.user.id}`, row.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch (_) {}

      res.json({ ok: true });
    });
  });
});

// =====================
// PDF UPLOAD (Render-safe) - per user folder
// =====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const userId = req.user?.id;
      if (!userId) return cb(new Error("Unauthorized upload"));
      cb(null, ensureUserUploadDir(userId));
    },
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "document.pdf").replace(/\s+/g, "_");
      cb(null, Date.now() + "-" + safe);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    if (!ok) return cb(new Error("Only PDF files are allowed"));
    cb(null, true);
  },
});

function extractTextWithPdf2json(filePath) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on("pdfParser_dataError", (errData) => reject(new Error(errData?.parserError || "PDF read failed")));
    pdfParser.on("pdfParser_dataReady", () => {
      try {
        const text = String(pdfParser.getRawTextContent() || "").trim();
        resolve(text);
      } catch (e) {
        reject(e);
      }
    });

    pdfParser.loadPDF(filePath);
  });
}

app.post("/api/upload", auth, upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const extractedText = await extractTextWithPdf2json(filePath);

    db.run(
      "INSERT INTO documents (user_id, title, filename, content) VALUES (?, ?, ?, ?)",
      [req.user.id, req.file.originalname, req.file.filename, extractedText],
      function (err) {
        if (err) return res.status(500).json({ error: "DB insert failed: " + err.message });
        res.json({ ok: true, docId: this.lastID });
      }
    );
  } catch (e) {
    res.status(500).json({ error: "Upload failed: " + e.message });
  }
});

// =====================
// QUIZ GENERATOR (simple offline)
// =====================
function normalizeText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function splitToSentences(text) {
  const clean = normalizeText(text);
  const raw = clean
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  return raw.filter((s) => s.length >= 55 && s.length <= 260);
}

function createMcqFromSentence(sentence) {
  const cleaned = sentence.replace(/[^\w\s-]/g, " ");
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 5 && /^[a-zA-Z-]+$/.test(w));

  if (words.length < 6) return null;

  const answer = words[Math.floor(Math.random() * words.length)];
  const question = sentence.replace(new RegExp("\\b" + answer + "\\b"), "_____");

  const distractorPool = words.filter((w) => w.toLowerCase() !== answer.toLowerCase());
  const distractors = shuffle(distractorPool).slice(0, 3);
  while (distractors.length < 3) distractors.push("None of the above");

  const options = shuffle([answer, ...distractors]);
  const correctIndex = options.findIndex((o) => o.toLowerCase() === answer.toLowerCase());

  return { type: "mcq", question, options, correctIndex };
}

function generateQuizFromText(text, count = 5) {
  const sentences = shuffle(splitToSentences(text));
  const items = [];
  const seen = new Set();

  for (const s of sentences) {
    if (items.length >= count) break;
    const q = createMcqFromSentence(s);
    if (!q) continue;
    const key = q.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(q);
  }
  return items;
}

app.post("/api/quiz/generate", auth, (req, res) => {
  const docId = Number(req.body.docId);
  const count = Math.max(1, parseInt(req.body.count || 5, 10));

  db.get("SELECT title, content FROM documents WHERE id = ? AND user_id = ?", [docId, req.user.id], (err, row) => {
    if (!row) return res.status(404).json({ error: "Document not found" });
    const quiz = generateQuizFromText(row.content || "", count);
    res.json({ ok: true, poweredBy: "ARION", owner: "Oderinu Marvelous", docTitle: row.title, quiz });
  });
});

// =====================
// ATTEMPTS + ANALYTICS
// =====================
app.post("/api/attempts", auth, (req, res) => {
  const docId = Number(req.body.docId);
  const score = Number(req.body.score || 0);
  const total = Number(req.body.total || 0);
  if (!docId || !total) return res.status(400).json({ error: "docId, score, total required" });

  const percent = total > 0 ? (score / total) * 100 : 0;

  db.run(
    "INSERT INTO quiz_attempts (user_id, doc_id, score, total, percent) VALUES (?, ?, ?, ?, ?)",
    [req.user.id, docId, score, total, percent],
    function (err) {
      if (err) return res.status(500).json({ error: "DB insert error: " + err.message });
      res.json({ ok: true, attemptId: this.lastID, percent: Math.round(percent) });
    }
  );
});

app.get("/api/analytics/summary", auth, (req, res) => {
  db.get(
    "SELECT COUNT(*) AS totalAttempts, AVG(percent) AS avgPercent, MAX(percent) AS bestPercent FROM quiz_attempts WHERE user_id = ?",
    [req.user.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error: " + err.message });
      res.json({
        totalAttempts: row?.totalAttempts || 0,
        avgPercent: Math.round(row?.avgPercent || 0),
        bestPercent: Math.round(row?.bestPercent || 0),
      });
    }
  );
});

app.get("/api/analytics/attempts", auth, (req, res) => {
  const limit = Math.max(5, Math.min(200, parseInt(req.query.limit || "30", 10)));
  db.all(
    "SELECT score, total, percent, created_at FROM quiz_attempts WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    [req.user.id, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error: " + err.message });
      res.json({ ok: true, attempts: (rows || []).reverse() });
    }
  );
});

app.get("/api/analytics/export", auth, (req, res) => {
  db.all(
    "SELECT percent, score, total, created_at FROM quiz_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 50",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error: " + err.message });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="studyfox-report.pdf"`);

      const doc = new PDFDocument({ margin: 50 });
      doc.pipe(res);

      doc.fontSize(20).text("StudyFox Analytics Report", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(11).text("Powered by ARION", { align: "center" });
      doc.moveDown(1);

      doc.fontSize(12).text(`User: ${req.user.name}`);
      doc.text(`Email: ${req.user.email}`);
      doc.moveDown(1);

      const attempts = rows || [];
      const avg = attempts.length
        ? Math.round(attempts.reduce((a, r) => a + (r.percent || 0), 0) / attempts.length)
        : 0;
      const best = attempts.length ? Math.round(Math.max(...attempts.map((r) => r.percent || 0))) : 0;

      doc.fontSize(12).text(`Total Attempts (last 50): ${attempts.length}`);
      doc.text(`Average Score: ${avg}%`);
      doc.text(`Best Score: ${best}%`);
      doc.moveDown(1);

      doc.fontSize(13).text("Recent Attempts", { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10);

      if (!attempts.length) {
        doc.text("No quiz attempts found yet. Take a quiz in Testing Hub first.");
      } else {
        attempts.forEach((r, i) => {
          doc.text(`${i + 1}. Score ${r.score}/${r.total} (${Math.round(r.percent)}%) — ${r.created_at}`);
        });
      }

      doc.moveDown(2);
      doc.fontSize(9).fillColor("gray").text("StudyFox • Powered by ARION", { align: "center" });
      doc.end();
    }
  );
});

// =====================
// BASIC OFFLINE Q&A (simple paragraph pick)
// =====================
function cleanLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function splitParagraphs(text) {
  return normalizeText(text).split(/\n{2,}/g).map(cleanLine).filter(Boolean);
}
function wordsFromQuestion(q) {
  return cleanLine(q)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((w) => w.length >= 3 && !["what", "when", "where", "which", "that", "this", "with", "from", "into", "your"].includes(w));
}
function scoreParagraph(p, keys) {
  const lower = p.toLowerCase();
  let score = 0;
  for (const k of keys) if (lower.includes(k)) score += 3;
  if (/(is defined as|refers to|means|can be defined as|is a|are a)/i.test(p)) score += 2;
  return score;
}

app.post("/api/qa", auth, (req, res) => {
  const docId = Number(req.body.docId);
  const question = String(req.body.question || "").trim();
  if (!docId || !question) return res.status(400).json({ error: "docId and question required" });

  db.get("SELECT content FROM documents WHERE id = ? AND user_id = ?", [docId, req.user.id], (err, row) => {
    if (!row) return res.status(404).json({ error: "Document not found" });

    const keys = wordsFromQuestion(question);
    const paras = splitParagraphs(row.content || "");
    if (!paras.length) return res.json({ answer: "No readable text found in this document.", evidence: "" });

    const ranked = paras
      .map((p) => ({ p, s: scoreParagraph(p, keys) }))
      .sort((a, b) => b.s - a.s);

    const best = ranked[0]?.p || paras[0];
    res.json({
      answer: `**${cleanLine(question)}**\n\n${best}`,
      evidence: best.slice(0, 900),
    });
  });
});

// =====================
// ROOT fallback (optional)
// =====================
app.get("/", (req, res) => {
  const indexFile = path.join(FRONTEND_PATH, "index.html");
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.send("StudyFox backend is live ✅");
});

// =====================
// ERROR HANDLER
// =====================
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);
  res.status(400).json({ error: err.message || "Request failed" });
});

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log(`✅ StudyFox running on http://127.0.0.1:${PORT}`);
  console.log(`⚡ Powered by ARION`);
});