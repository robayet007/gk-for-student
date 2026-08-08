require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const port = Number(process.env.PORT || 3000);
const isVercel = Boolean(process.env.VERCEL);
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/jobayer-gk";
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "chapters.json");

let db;
let chapters;
let mongoClient;
let databaseError = null;
let storageMode = null;
let connectPromise = null;
let retryTimer = null;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname));

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

function getChapterQuestions(chapter) {
  return Array.isArray(chapter?.questions) ? chapter.questions : [];
}

function chapterSummary(chapter) {
  return {
    id: chapter._id.toString(),
    title: chapter.title,
    questionCount: getChapterQuestions(chapter).length,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
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

async function createChapter(title, questionItems) {
  const now = new Date().toISOString();

  if (storageMode === "mongodb") {
    const chapterCount = await chapters.countDocuments();
    const result = await chapters.insertOne({
      title,
      chapterNo: chapterCount + 1,
      questions: questionItems,
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
    questions: questionItems,
    createdAt: now,
    updatedAt: now,
  };

  docs.push(chapter);
  await writeFileChapters(docs);
  return chapter;
}

async function updateChapter(id, title, questionItems) {
  const now = new Date().toISOString();

  if (storageMode === "mongodb") {
    const _id = parseObjectId(id);
    const update = { title, updatedAt: now };

    if (questionItems !== undefined) {
      update.questions = questionItems;
    }

    return chapters.findOneAndUpdate({ _id }, { $set: update }, { returnDocument: "after" });
  }

  const docs = await readFileChapters();
  const index = docs.findIndex((doc) => doc._id === id);

  if (index === -1) {
    return null;
  }

  docs[index] = {
    ...docs[index],
    title,
    updatedAt: now,
    ...(questionItems !== undefined ? { questions: questionItems } : {}),
  };

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

    res.json({
      chapter: {
        ...chapterSummary(chapter),
        questions: getChapterQuestions(chapter),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chapters", requireDatabase, async (req, res, next) => {
  try {
    const title = normalizeText(req.body.title);
    const questionItems = normalizeQuestions(req.body.questions, { allowEmpty: true });

    if (!title) {
      return res.status(400).json({ error: "Chapter title দরকার।" });
    }

    const chapter = await createChapter(title, questionItems);

    res.status(201).json({
      chapter: {
        ...chapterSummary(chapter),
        questions: getChapterQuestions(chapter),
      },
    });
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

    let questionItems;

    if (req.body.questions !== undefined) {
      questionItems = normalizeQuestions(req.body.questions, { allowEmpty: true });
    }

    const result = await updateChapter(req.params.id, title, questionItems);

    if (!result) {
      return res.status(404).json({ error: "Chapter পাওয়া যায়নি।" });
    }

    res.json({
      chapter: {
        ...chapterSummary(result),
        questions: getChapterQuestions(result),
      },
    });
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
