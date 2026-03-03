// ============================================
// StudyFox Backend - Project 2 (RELEASE BUILD)
// Powered by ARION
// Owner: Oderinu Marvelous
// ============================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const fs = require("fs");
const { execSync } = require("child_process");

// ✅ REPLACED pdf-parse (Render crash) with pdf2json (Render-safe)
const PDFParser = require("pdf2json");

const tesseract = require("node-tesseract-ocr");
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const { db, initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 5050;

app.set("trust proxy", 1);

// ✅ Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // keep simple for local/static frontend
  })
);

// ✅ Basic request limit (anti brute-force)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120, // 120 requests/min per IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.json({ limit: "2mb" }));

// Serve frontend
const FRONTEND_PATH = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_PATH));

// Ensure uploads folder
const uploadRoot = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });
app.use("/uploads", express.static(uploadRoot));

// Init DB
initDb();

// =====================
// AUTH SYSTEM (token sessions in memory)
// =====================
const sessions = new Map(); // token -> { user, exp }
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.replace("Bearer ", "").trim();
}

function authMiddleware(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const sess = sessions.get(token);
  if (!sess) return res.status(401).json({ error: "Unauthorized" });

  if (Date.now() > sess.exp) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expired" });
  }

  req.user = sess.user;
  req.token = token;
  next();
}

// cleanup expired sessions occasionally
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions.entries()) {
    if (now > s.exp) sessions.delete(t);
  }
}, 60 * 1000).unref();

// =====================
// PER-USER UPLOAD FOLDERS
// =====================
function ensureUserUploadDir(userId) {
  const dir = path.join(uploadRoot, `user_${userId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// =====================
// PDF TEXT EXTRACTOR (Render-safe)
// =====================
function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(null, 1);

    pdfParser.on("pdfParser_dataError", (err) => {
      reject(err?.parserError || err);
    });

    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      try {
        const pages = pdfData?.Pages || [];
        const text = pages
          .map((p) =>
            (p.Texts || [])
              .map((t) => {
                const raw = t?.R?.[0]?.T || "";
                // pdf2json stores text URL-encoded, plus signs may appear
                return decodeURIComponent(String(raw).replace(/\+/g, "%20"));
              })
              .join(" ")
          )
          .join("\n");

        resolve(String(text || "").trim());
      } catch (e) {
        reject(e);
      }
    });

    pdfParser.parseBuffer(buffer);
  });
}

// =====================
// OCR HELPER (LIMITED PAGES FOR SPEED)
// =====================
async function ocrPdfToText(pdfPath) {
  const tempDir = path.join(__dirname, "tmp_ocr_" + Date.now());
  fs.mkdirSync(tempDir);

  const outputPrefix = path.join(tempDir, "page");
  // ✅ limit OCR to first 8 pages for speed
  execSync(`pdftoppm -png -r 180 -f 1 -l 8 "${pdfPath}" "${outputPrefix}"`);

  const images = fs
    .readdirSync(tempDir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => path.join(tempDir, f));

  let fullText = "";
  for (const img of images) {
    try {
      const text = await tesseract.recognize(img, {
        lang: "eng",
        oem: 1,
        psm: 3,
      });
      fullText += "\n" + text;
    } catch (e) {
      console.error("OCR PAGE ERROR:", e.message);
    }
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  return fullText.trim();
}

// =====================
// QUIZ GENERATOR (OFFLINE)
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

  return raw.filter((s) => {
    if (s.length < 55) return false;
    if (s.length > 260) return false;
    if (/^page\s+\d+$/i.test(s)) return false;
    if (/copyright|all rights reserved|www\.|http/i.test(s)) return false;
    if (/^\s*(describe|explain|discuss|outline)\b/i.test(s)) return false;
    return true;
  });
}

function createMcqFromSentence(sentence) {
  const cleaned = sentence.replace(/[^\w\s-]/g, " ");
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 5 && /^[a-zA-Z-]+$/.test(w));

  if (words.length < 6) return null;

  const stop = new Set([
    "which",
    "their",
    "there",
    "where",
    "about",
    "these",
    "those",
    "because",
    "before",
    "after",
    "between",
    "within",
    "without",
    "under",
    "other",
    "using",
    "used",
    "useful",
    "system",
    "systems",
    "process",
    "processing",
    "information",
    "database",
    "management",
    "design",
    "define",
    "definition",
    "describe",
    "example",
    "examples",
  ]);

  const candidates = words.filter((w) => !stop.has(w.toLowerCase()));
  const pool = candidates.length >= 4 ? candidates : words;

  const answer = pool[Math.floor(Math.random() * pool.length)];
  const question = sentence.replace(new RegExp("\\b" + answer + "\\b"), "_____");

  const distractorPool = pool.filter((w) => w.toLowerCase() !== answer.toLowerCase());
  const distractors = [];
  const mixed = shuffle(distractorPool);

  for (const w of mixed) {
    if (distractors.length >= 3) break;
    if (!distractors.some((x) => x.toLowerCase() === w.toLowerCase())) distractors.push(w);
  }
  while (distractors.length < 3) distractors.push("None of the above");

  const options = shuffle([answer, ...distractors]);
  const correctIndex = options.findIndex((o) => o.toLowerCase() === answer.toLowerCase());

  return { type: "mcq", question, options, correctIndex };
}

function generateQuizFromText(text, count = 5) {
  const sentences = splitToSentences(text);
  if (!sentences.length) return [];

  const sents = shuffle(sentences);
  const items = [];
  const seenQ = new Set();

  for (const s of sents) {
    if (items.length >= count) break;
    const mcq = createMcqFromSentence(s);
    if (!mcq) continue;

    const key = mcq.question.toLowerCase();
    if (seenQ.has(key)) continue;

    seenQ.add(key);
    items.push(mcq);
  }

  let guard = 0;
  while (items.length < count && guard < count * 50) {
    const s = sents[Math.floor(Math.random() * sents.length)];
    const mcq = createMcqFromSentence(s);
    guard++;
    if (!mcq) continue;

    const key = mcq.question.toLowerCase();
    if (seenQ.has(key)) continue;

    seenQ.add(key);
    items.push(mcq);
  }

  return items;
}

// =====================
// OFFLINE TUTOR (BETTER ANSWERS)
// =====================
function cleanLine(s) {
  return String(s || "")
    .replace(/^[•\-\–\—\*]+\s*/g, "")
    .replace(/^[¢§»]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function isGarbageLine(s) {
  const t = cleanLine(s).toLowerCase();
  if (!t) return true;
  if (t.length < 25) return true;
  if (/^\s*(describe|discuss|outline|explain|list|state|identify)\b/.test(t)) return true;
  if (t.includes("learning outcomes")) return true;
  if (t.includes("focus:")) return true;
  if (t.includes("module")) return true;
  if (t.includes("course")) return true;
  if (/^page\s+\d+/.test(t)) return true;
  if (t.includes("copyright")) return true;
  return false;
}
function wordsFromQuestion(q) {
  return cleanLine(q)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(
      (w) =>
        w.length >= 3 &&
        ![
          "what",
          "when",
          "where",
          "which",
          "that",
          "this",
          "with",
          "from",
          "into",
          "your",
          "their",
          "they",
          "them",
          "have",
          "has",
          "had",
          "will",
          "would",
          "should",
          "could",
          "about",
          "also",
          "very",
          "like",
          "give",
          "tell",
          "define",
          "definition",
          "explain",
        ].includes(w)
    );
}
function splitParagraphs(text) {
  return normalizeText(text)
    .split(/\n{2,}/g)
    .map((p) => cleanLine(p))
    .filter(Boolean);
}
function scoreParagraph(p, keys) {
  const lower = p.toLowerCase();
  let score = 0;
  for (const k of keys) if (lower.includes(k)) score += 3;
  if (/(is defined as|refers to|means|can be defined as|is a|are a)/i.test(p)) score += 4;
  if (/^\s*(describe|explain|discuss|outline)\b/i.test(p)) score -= 4;
  if (p.includes("Focus:")) score -= 3;
  if (p.length >= 80 && p.length <= 650) score += 2;
  return score;
}
function pickBestText(content, question) {
  const keys = wordsFromQuestion(question);
  const paras = splitParagraphs(content).filter((p) => !isGarbageLine(p));
  if (!paras.length) return { keys, picks: [] };

  const ranked = paras
    .map((p) => ({ p, s: scoreParagraph(p, keys) }))
    .sort((a, b) => b.s - a.s);

  const best = ranked.filter((x) => x.s > 0).slice(0, 4).map((x) => x.p);
  return { keys, picks: best.length ? best : paras.slice(0, 3) };
}
function pickSentences(block) {
  const sentences = cleanLine(block)
    .split(/(?<=[.?!])\s+/)
    .map(cleanLine)
    .filter((s) => s.length >= 30 && s.length <= 260)
    .filter((s) => !isGarbageLine(s));

  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
function buildHumanAnswer(question, picks, keys) {
  if (!picks.length) {
    return { answer: "I couldn't find readable text in this document to answer that.", evidence: "" };
  }

  const combined = picks.join("\n\n");
  const sentences = pickSentences(combined);

  const defLine =
    sentences.find((s) => /(is defined as|refers to|means|can be defined as|is a|are a)/i.test(s) && s.length <= 240) ||
    sentences[0] ||
    combined.slice(0, 220);

  const scored = sentences
    .map((s) => {
      const l = s.toLowerCase();
      let sc = 0;
      for (const k of keys) if (l.includes(k)) sc += 2;
      if (/(important|key|feature|used for|supports|enables|helps|allows)/i.test(s)) sc += 1;
      return { s, sc };
    })
    .sort((a, b) => b.sc - a.sc);

  const points = scored.filter((x) => x.sc > 0).slice(0, 4).map((x) => x.s);
  const usePoints = points.length ? points : sentences.slice(1, 5);

  const lines = [];
  lines.push(`**${cleanLine(question)}**\n`);
  lines.push(`${cleanLine(defLine)}\n`);
  lines.push(`**Key points:**`);
  usePoints.slice(0, 4).forEach((p) => lines.push(`• ${cleanLine(p)}`));
  lines.push(`\n**In short:** ${cleanLine(defLine).slice(0, 220)}`);

  return { answer: lines.join("\n"), evidence: combined.slice(0, 900) };
}

// =====================
// FILE UPLOAD (PDF only, size limit)
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
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    if (!ok) return cb(new Error("Only PDF files are allowed"));
    cb(null, true);
  },
});

// =====================
// ROUTES
// =====================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "StudyFox",
    poweredBy: "ARION",
    owner: "Oderinu Marvelous",
    frontendPath: FRONTEND_PATH,
  });
});

// ---- Signup ----
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

      const password_hash = await bcrypt.hash(password, 10);

      db.run(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
        [name, email, password_hash],
        function (err2) {
          if (err2) return res.status(500).json({ error: "Signup failed: " + err2.message });

          const user = { id: this.lastID, name, email };
          const token = makeToken();
          sessions.set(token, { user, exp: Date.now() + SESSION_TTL_MS });

          ensureUserUploadDir(user.id);
          res.json({ ok: true, token, user });
        }
      );
    });
  }
);

// ---- Login ----
app.post(
  "/api/auth/login",
  [body("email").isEmail().withMessage("Invalid email"), body("password").isLength({ min: 1 }).withMessage("Password required")],
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
      sessions.set(token, { user, exp: Date.now() + SESSION_TTL_MS });

      ensureUserUploadDir(user.id);
      res.json({ ok: true, token, user });
    });
  }
);

app.post("/api/auth/logout", authMiddleware, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json(req.user);
});

// ---- Dashboard stats ----
app.get("/api/stats", authMiddleware, (req, res) => {
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

// ---- Library list ----
app.get("/api/library", authMiddleware, (req, res) => {
  db.all(
    "SELECT id, title, filename, created_at FROM documents WHERE user_id = ? ORDER BY id DESC",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error: " + err.message });
      res.json({ ok: true, documents: rows || [] });
    }
  );
});

// ---- Delete document (also delete file) ----
app.delete("/api/documents/:id", authMiddleware, (req, res) => {
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

// ---- Analytics summary ----
app.get("/api/analytics/summary", authMiddleware, (req, res) => {
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

app.get("/api/analytics/attempts", authMiddleware, (req, res) => {
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

// ---- Export analytics PDF ----
app.get("/api/analytics/export", authMiddleware, (req, res) => {
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

// ---- Save attempt ----
app.post("/api/attempts", authMiddleware, (req, res) => {
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

// ---- Generate quiz ----
app.post("/api/quiz/generate", authMiddleware, (req, res) => {
  const docId = Number(req.body.docId);
  const count = Math.max(1, parseInt(req.body.count || 5, 10));

  db.get(
    "SELECT title, content FROM documents WHERE id = ? AND user_id = ?",
    [docId, req.user.id],
    (err, row) => {
      if (!row) return res.status(404).json({ error: "Document not found" });
      const quiz = generateQuizFromText(row.content || "", count);
      res.json({ ok: true, poweredBy: "ARION", owner: "Oderinu Marvelous", docTitle: row.title, quiz });
    }
  );
});

// ---- Tutor Q&A ----
app.post("/api/qa", authMiddleware, (req, res) => {
  const docId = Number(req.body.docId);
  const question = String(req.body.question || "").trim();
  if (!docId || !question) return res.status(400).json({ error: "docId and question required" });

  db.get("SELECT content FROM documents WHERE id = ? AND user_id = ?", [docId, req.user.id], (err, row) => {
    if (!row) return res.status(404).json({ error: "Document not found" });
    const { keys, picks } = pickBestText(row.content || "", question);
    res.json(buildHumanAnswer(question, picks, keys));
  });
});

// ---- Upload + extract ----
app.post("/api/upload", authMiddleware, upload.single("pdf"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = file.path;
    const buffer = fs.readFileSync(filePath);

    let extractedText = "";
    try {
      extractedText = await extractPdfText(buffer);
    } catch (e) {
      console.log("PDF TEXT EXTRACT ERROR:", e?.message || e);
      extractedText = "";
    }

    if (!extractedText || extractedText.length < 20) {
      console.log("⚠️ No readable text found. Running OCR fallback...");
      extractedText = await ocrPdfToText(filePath);
    }

    db.run(
      "INSERT INTO documents (user_id, title, filename, content) VALUES (?, ?, ?, ?)",
      [req.user.id, file.originalname, file.filename, extractedText],
      function (err) {
        if (err) return res.status(500).json({ error: "DB insert error: " + err.message });
        res.json({ ok: true, docId: this.lastID });
      }
    );
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
});

// Global error handler (multer + others)
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);
  res.status(400).json({ error: err.message || "Request failed" });
});

app.listen(PORT, () => {
  console.log(`✅ StudyFox running on http://127.0.0.1:${PORT}`);
  console.log(`⚡ Powered by ARION`);
});