require("dotenv").config();

const express = require("express");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = Number(process.env.PORT || 3000);
const isVercel = Boolean(process.env.VERCEL);
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/jobayer-gk";
const projectRoot = fsSync.existsSync(path.join(__dirname, "index.html")) ? __dirname : process.cwd();
const dataDir = path.join(projectRoot, "data");
const dataFile = path.join(dataDir, "chapters.json");

let db;
let chapters;
let mongoClient;
let databaseError = null;
let storageMode = null;
let connectPromise = null;
let retryTimer = null;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(projectRoot));

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeQuestions(input, options = {}) {
  const allowEmpty = Boolean(options.allowEmpty);
  const source = Array.isArray(input) ? input : input?.questions;

  if (source == null && allowEmpty) {
    return [];
  }

  if (!Array.isArray(source)) {
    throw new Error("JSON অবশ্যই question array অথবা { questions: [...] } হতে হবে।");
  }

  return source.map((item, index) => {
    const options = Array.isArray(item.options) ? item.options.map(normalizeText).filter(Boolean) : [];
    const answer = normalizeText(item.answer ?? item.correctAnswer ?? item.correct);
    const question = normalizeText(item.question ?? item.title);

    if (!question) {
      throw new Error(`Question ${index + 1}: question text পাওয়া যায়নি।`);
    }

    if (options.length < 2) {
      throw new Error(`Question ${index + 1}: অন্তত ২টি option দরকার।`);
    }

    if (!answer) {
      throw new Error(`Question ${index + 1}: answer field দরকার।`);
    }

    if (!options.includes(answer)) {
      throw new Error(`Question ${index + 1}: answer option list-এর সাথে মেলেনি।`);
    }

    return {
      id: item.id ?? index + 1,
      question,
      options,
      answer,
      explanation: normalizeText(item.explanation),
    };
  });
}

function ensureChapterPages(chapter) {
  if (Array.isArray(chapter?.pages) && chapter.pages.length > 0) {
    return chapter.pages.map((page, index) => ({
      id: page.id || `page-${page.pageNo || index + 1}`,
      pageNo: Number(page.pageNo) || index + 1,
      title: normalizeText(page.title) || `Page ${Number(page.pageNo) || index + 1}`,
      questions: Array.isArray(page.questions) ? page.questions : [],
    }));
  }

  const legacyQuestions = Array.isArray(chapter?.questions) ? chapter.questions : [];

  if (legacyQuestions.length > 0) {
    return [{
      id: "page-1",
      pageNo: 1,
      title: "Page 1",
      questions: legacyQuestions,
    }];
  }

  return [];
}

function getChapterQuestions(chapter) {
  return ensureChapterPages(chapter).flatMap((page) => page.questions);
}

function normalizePagesFromBody(body) {
  if (Array.isArray(body.pages)) {
    return body.pages.map((page, index) => {
      const pageNo = Number(page.pageNo) || index + 1;

      return {
        id: normalizeText(page.id) || `page-${pageNo}`,
        pageNo,
        title: normalizeText(page.title) || `Page ${pageNo}`,
        questions: normalizeQuestions(page.questions, { allowEmpty: true }),
      };
    });
  }

  if (body.questions !== undefined) {
    const questions = normalizeQuestions(body.questions, { allowEmpty: true });

    if (!questions.length) {
      return [];
    }

    return [{
      id: "page-1",
      pageNo: 1,
      title: "Page 1",
      questions,
    }];
  }

  return undefined;
}

function chapterSummary(chapter) {
  const pages = ensureChapterPages(chapter);
  const questionCount = pages.reduce((sum, page) => sum + page.questions.length, 0);

  return {
    id: chapter._id.toString(),
    title: chapter.title,
    questionCount,
    pageCount: pages.length,
    pages: pages.map((page) => ({
      id: page.id,
      pageNo: page.pageNo,
      title: page.title,
      questionCount: page.questions.length,
    })),
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
  };
}

function serializeChapter(chapter) {
  const pages = ensureChapterPages(chapter);

  return {
    ...chapterSummary(chapter),
    pages,
    questions: getChapterQuestions(chapter),
  };
}

function parseObjectId(id) {
  if (!ObjectId.isValid(id)) {
    const error = new Error("Chapter id ঠিক নয়।");
    error.status = 400;
    throw error;
  }

  return new ObjectId(id);
}

async function requireDatabase(_req, res, next) {
  try {
    await ensureStorageReady();

    if (!storageMode) {
      return res.status(503).json({
        error: databaseError || "Database এখনও ready হয়নি।",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function readFileChapters() {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeFileChapters(items) {
  await ensureDataDir();
  await fs.writeFile(dataFile, JSON.stringify(items, null, 2), "utf8");
}

async function listChapters() {
  if (storageMode === "mongodb") {
    return chapters.find({}, { sort: { chapterNo: 1, createdAt: 1 } }).toArray();
  }

  const docs = await readFileChapters();
  return docs.sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0));
}

async function findChapterById(id) {
  if (storageMode === "mongodb") {
    return chapters.findOne({ _id: parseObjectId(id) });
  }

  const docs = await readFileChapters();
  return docs.find((doc) => doc._id === id) || null;
}

async function createChapter(title, pageItems) {
  const now = new Date().toISOString();
  const pages = pageItems || [];

  if (storageMode === "mongodb") {
    const chapterCount = await chapters.countDocuments();
    const result = await chapters.insertOne({
      title,
      chapterNo: chapterCount + 1,
      pages,
      createdAt: now,
      updatedAt: now,
    });

    return chapters.findOne({ _id: result.insertedId });
  }

  const docs = await readFileChapters();
  const chapter = {
    _id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    chapterNo: docs.length + 1,
    pages,
    createdAt: now,
    updatedAt: now,
  };

  docs.push(chapter);
  await writeFileChapters(docs);
  return chapter;
}

async function updateChapter(id, title, pageItems) {
  const now = new Date().toISOString();

  if (storageMode === "mongodb") {
    const _id = parseObjectId(id);
    const update = { title, updatedAt: now };

    if (pageItems !== undefined) {
      update.pages = pageItems;
    }

    const updateOps = { $set: update };

    if (pageItems !== undefined) {
      updateOps.$unset = { questions: "" };
    }

    return chapters.findOneAndUpdate({ _id }, updateOps, { returnDocument: "after" });
  }

  const docs = await readFileChapters();
  const index = docs.findIndex((doc) => doc._id === id);

  if (index === -1) {
    return null;
  }

  const nextChapter = {
    ...docs[index],
    title,
    updatedAt: now,
  };

  if (pageItems !== undefined) {
    nextChapter.pages = pageItems;
    delete nextChapter.questions;
  }

  docs[index] = nextChapter;
  await writeFileChapters(docs);
  return docs[index];
}

async function ensureStorageReady() {
  if (storageMode) {
    return;
  }

  if (!connectPromise) {
    connectPromise = connectDatabase().finally(() => {
      connectPromise = null;
    });
  }

  await connectPromise;

  if (!storageMode && !isVercel) {
    await activateFileStorage(databaseError);
  }
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(projectRoot, "index.html"));
});

app.get("/api/health", async (_req, res) => {
  await ensureStorageReady().catch(() => {});
  res.status(storageMode ? 200 : 503).json({
    ok: Boolean(storageMode),
    storage: storageMode,
    database: storageMode === "mongodb" ? db?.databaseName || null : "local-file",
    error: storageMode ? null : databaseError,
  });
});

app.get("/api/chapters", requireDatabase, async (_req, res, next) => {
  try {
    const docs = await listChapters();
    res.json({ chapters: docs.map(chapterSummary) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/chapters/:id", requireDatabase, async (req, res, next) => {
  try {
    const chapter = await findChapterById(req.params.id);

    if (!chapter) {
      return res.status(404).json({ error: "Chapter পাওয়া যায়নি।" });
    }

    res.json({ chapter: serializeChapter(chapter) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chapters", requireDatabase, async (req, res, next) => {
  try {
    const title = normalizeText(req.body.title);
    const pageItems = normalizePagesFromBody(req.body) ?? [];

    if (!title) {
      return res.status(400).json({ error: "Chapter title দরকার।" });
    }

    const chapter = await createChapter(title, pageItems);

    res.status(201).json({ chapter: serializeChapter(chapter) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/chapters/:id", requireDatabase, async (req, res, next) => {
  try {
    const title = normalizeText(req.body.title);

    if (!title) {
      return res.status(400).json({ error: "Chapter title দরকার।" });
    }

    const pageItems = normalizePagesFromBody(req.body);

    const result = await updateChapter(req.params.id, title, pageItems);

    if (!result) {
      return res.status(404).json({ error: "Chapter পাওয়া যায়নি।" });
    }

    res.json({ chapter: serializeChapter(result) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || 400;
  res.status(status).json({ error: error.message || "Server error" });
});

async function activateFileStorage(reason) {
  if (isVercel) {
    storageMode = null;
    databaseError = reason || "MongoDB connection required in Vercel.";
    return;
  }

  storageMode = "file";
  databaseError = reason || null;
  await ensureDataDir();

  try {
    await readFileChapters();
  } catch (error) {
    await writeFileChapters([]);
  }

  console.log("Using local file storage (data/chapters.json)");
}

async function connectDatabase() {
  try {
    if (storageMode === "mongodb" && chapters) {
      return;
    }

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
    }

    mongoClient = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });

    await mongoClient.connect();
    db = mongoClient.db();
    chapters = db.collection("chapters");
    await chapters.createIndex({ chapterNo: 1 });
    await chapters.createIndex({ title: 1 });

    storageMode = "mongodb";
    databaseError = null;
    console.log(`MongoDB connected: ${db.databaseName}`);
  } catch (error) {
    databaseError = error.message;
    storageMode = null;
    console.error("MongoDB connection failed:", error.message);
  }
}

function scheduleDatabaseRetry() {
  if (isVercel || retryTimer) {
    return;
  }

  retryTimer = setInterval(() => {
    if (storageMode !== "mongodb") {
      ensureStorageReady().catch(() => {});
    }
  }, 30000);
}

async function initializeApplication() {
  await ensureStorageReady();

  if (!storageMode && !isVercel) {
    await activateFileStorage(databaseError);
  }

  scheduleDatabaseRetry();
}

async function startLocalServer() {
  console.log(`Jobayer GK MCQ app running at http://localhost:${port}`);
  await initializeApplication();
  app.listen(port);
}

if (require.main === module) {
  startLocalServer().catch((error) => {
    console.error("App initialization failed:", error.message);
    process.exit(1);
  });
}

module.exports = app;
