const loadingScreen = document.querySelector("#loadingScreen");
const quizView = document.querySelector("#quizView");
const adminView = document.querySelector("#adminView");
const chapterSelect = document.querySelector("#chapterSelect");
const chapterTitle = document.querySelector("#chapterTitle");
const jsonInput = document.querySelector("#jsonInput");
const jsonStatus = document.querySelector("#jsonStatus");
const questionList = document.querySelector("#questionList");
const resultPanel = document.querySelector("#resultPanel");
const totalCount = document.querySelector("#totalCount");
const answeredCount = document.querySelector("#answeredCount");
const liveScore = document.querySelector("#liveScore");
const totalLabel = document.querySelector("#totalLabel");
const answeredLabel = document.querySelector("#answeredLabel");
const addChapterBtn = document.querySelector("#addChapterBtn");
const saveChapterBtn = document.querySelector("#saveChapterBtn");
const clearDraftBtn = document.querySelector("#clearDraftBtn");
const resetBtn = document.querySelector("#resetBtn");
const submitBtn = document.querySelector("#submitBtn");
const chapterList = document.querySelector("#chapterList");
const chapterCount = document.querySelector("#chapterCount");
const storageBadge = document.querySelector("#storageBadge");
const quizFooter = document.querySelector("#quizFooter");
const openAdminBtn = document.querySelector("#openAdminBtn");
const backToQuizBtn = document.querySelector("#backToQuizBtn");
const themeToggleBtn = document.querySelector("#themeToggleBtn");
const modeButtons = document.querySelectorAll("[data-mode]");
const controlRow = document.querySelector(".control-row");

const optionLetters = ["A", "B", "C", "D", "E", "F"];
const THEME_KEY = "gk-theme";

let chapters = [];
let currentChapterId = null;
let storedQuestions = [];
let questions = [];
let selectedAnswers = new Map();
let submitted = false;
let mode = "practice";
let examPhase = null;
let examNegativeMark = true;
let examShuffle = false;
let examStoredQuestions = [];
let examSetup = {
  chapterId: null,
  questionCount: 1,
  availableCount: 0,
};
let parseTimer = null;
let draftQuestionCount = 0;
let draftJsonValid = false;
let storageInfo = null;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeQuestions(input, options = {}) {
  const source = Array.isArray(input) ? input : input?.questions;
  const shouldShuffle = Boolean(options.shuffle);

  if (!Array.isArray(source)) {
    throw new Error("JSON অবশ্যই question array অথবা { questions: [...] } হতে হবে।");
  }

  return source.map((item, index) => {
    const optionValues = Array.isArray(item.options) ? item.options.map(normalizeText).filter(Boolean) : [];
    const answer = normalizeText(item.answer ?? item.correctAnswer ?? item.correct);
    const question = normalizeText(item.question ?? item.title);

    if (!question) {
      throw new Error(`Question ${index + 1}: question text পাওয়া যায়নি।`);
    }

    if (optionValues.length < 2) {
      throw new Error(`Question ${index + 1}: অন্তত ২টি option দরকার।`);
    }

    if (!answer) {
      throw new Error(`Question ${index + 1}: answer field দরকার।`);
    }

    if (!optionValues.includes(answer)) {
      throw new Error(`Question ${index + 1}: answer option list-এর সাথে মেলেনি।`);
    }

    return {
      id: item.id ?? index + 1,
      uid: `${item.id ?? "q"}-${index}`,
      question,
      options: shouldShuffle ? shuffle(optionValues) : optionValues,
      answer,
      explanation: normalizeText(item.explanation),
    };
  });
}

function questionsForDatabase(items) {
  return items.map((item, index) => ({
    id: item.id ?? index + 1,
    question: item.question,
    options: item.options,
    answer: item.answer,
    explanation: item.explanation || "",
  }));
}

function mergeQuestionsForSave(existingQuestions, newQuestions) {
  const maxId = existingQuestions.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);

  return [
    ...existingQuestions,
    ...newQuestions.map((item, index) => ({
      ...item,
      id: maxId + index + 1,
    })),
  ];
}

function clearJsonDraft() {
  jsonInput.value = "";
  draftQuestionCount = 0;
  draftJsonValid = false;
}

function shuffle(items) {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function pickRandomQuestions(source, count) {
  return shuffle(source).slice(0, Math.min(count, source.length));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function setStatus(message, type = "") {
  jsonStatus.textContent = message;
  jsonStatus.className = `json-status ${type}`.trim();
}

function setView(nextView) {
  document.body.dataset.view = nextView;
  quizView.classList.toggle("hidden", nextView !== "quiz");
  adminView.classList.toggle("hidden", nextView !== "admin");
}

function hideLoading() {
  loadingScreen.classList.add("hidden");
}

function currentChapterSummary() {
  return chapters.find((chapter) => chapter.id === currentChapterId) || null;
}

function hydrateQuestionsFromStored(options = {}) {
  const shouldShuffle = options.shuffle ?? (mode === "practice" ? false : examShuffle);
  questions = storedQuestions.length ? normalizeQuestions(storedQuestions, { shuffle: shouldShuffle }) : [];
  selectedAnswers.clear();
  submitted = false;
}

function updateDraftStatusFromSaved() {
  draftQuestionCount = storedQuestions.length;
  draftJsonValid = storedQuestions.length > 0;
}

function updateStorageBadge() {
  if (!storageInfo?.ok) {
    storageBadge.textContent = "Offline mode";
    storageBadge.className = "storage-badge warn";
    return;
  }

  if (storageInfo.storage === "mongodb") {
    storageBadge.textContent = "MongoDB connected";
    storageBadge.className = "storage-badge ok";
    return;
  }

  storageBadge.textContent = "Local file storage";
  storageBadge.className = "storage-badge warn";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;

  const lightIcon = themeToggleBtn.querySelector(".theme-icon-light");
  const darkIcon = themeToggleBtn.querySelector(".theme-icon-dark");
  lightIcon.classList.toggle("hidden", nextTheme === "dark");
  darkIcon.classList.toggle("hidden", nextTheme === "dark");

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.content = nextTheme === "dark" ? "#0f1419" : "#116b5f";
  }

  localStorage.setItem(THEME_KEY, nextTheme);
}

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme || (prefersDark ? "dark" : "light"));
}

function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  applyTheme(currentTheme === "dark" ? "light" : "dark");
}

function resetExamState() {
  examPhase = null;
  examNegativeMark = true;
  examShuffle = false;
  examStoredQuestions = [];
  examSetup = {
    chapterId: null,
    questionCount: 1,
    availableCount: 0,
  };
  questions = [];
  selectedAnswers.clear();
  submitted = false;
}

function beginExamSetup() {
  resetExamState();
  examPhase = "setup";

  if (currentChapterId) {
    examSetup.chapterId = currentChapterId;
    examSetup.availableCount = storedQuestions.length;
    examSetup.questionCount = storedQuestions.length || 1;
    examStoredQuestions = [...storedQuestions];
  }

  renderQuiz();
}

async function bootstrap() {
  initTheme();

  try {
    storageInfo = await requestJson("/api/health");
    updateStorageBadge();
    await loadChapterSummaries();
  } catch (error) {
    storageInfo = { ok: false };
    updateStorageBadge();
    chapters = [];
    renderChapters();
    renderChapterSelect();
    renderQuiz();
    setStatus("Server চালু নেই। npm start দিয়ে app চালান।", "error");
  } finally {
    hideLoading();
  }
}

async function loadChapterSummaries() {
  const data = await requestJson("/api/chapters");
  chapters = data.chapters || [];
  const currentExists = currentChapterId && chapters.some((chapter) => chapter.id === currentChapterId);

  renderChapters();
  renderChapterSelect();

  if (chapters.length && !currentExists && mode === "practice") {
    await loadChapter(chapters[0].id, false);
    return;
  }

  if (!chapters.length) {
    createChapterDraft(false);
    setStatus("নতুন chapter তৈরি করুন।");
  }

  renderQuiz();
}

async function loadChapter(id, shouldRenderQuiz = true) {
  const data = await requestJson(`/api/chapters/${id}`);
  const chapter = data.chapter;

  currentChapterId = chapter.id;
  chapterTitle.value = chapter.title;
  storedQuestions = Array.isArray(chapter.questions) ? chapter.questions : [];
  clearJsonDraft();

  if (mode === "practice") {
    hydrateQuestionsFromStored({ shuffle: false });
  }

  updateDraftStatusFromSaved();

  if (storedQuestions.length) {
    setStatus(`${chapter.title} — ${storedQuestions.length}টি MCQ saved। নতুন JSON paste করে save করুন।`, "ok");
  } else {
    setStatus(`${chapter.title} — এখনো MCQ নেই। JSON paste করে save করুন।`);
  }

  renderChapters();
  renderChapterSelect();

  if (shouldRenderQuiz) {
    renderQuiz();
  }
}

async function loadExamSetupChapter(id) {
  if (!id) {
    examSetup.chapterId = null;
    examSetup.availableCount = 0;
    examSetup.questionCount = 1;
    examStoredQuestions = [];
    renderQuiz();
    return;
  }

  const data = await requestJson(`/api/chapters/${id}`);
  const chapter = data.chapter;
  const chapterQuestions = Array.isArray(chapter.questions) ? chapter.questions : [];

  examSetup.chapterId = chapter.id;
  examSetup.availableCount = chapterQuestions.length;
  examSetup.questionCount = chapterQuestions.length ? Math.min(examSetup.questionCount, chapterQuestions.length) : 1;
  examStoredQuestions = chapterQuestions;
  renderQuiz();
}

function createChapterDraft(shouldRender = true) {
  currentChapterId = null;
  storedQuestions = [];
  questions = [];
  chapterTitle.value = "";
  clearJsonDraft();
  selectedAnswers.clear();
  submitted = false;
  draftQuestionCount = 0;
  draftJsonValid = false;

  if (shouldRender) {
    setStatus("নতুন chapter draft ready।");
    renderChapters();
    renderChapterSelect();
    renderQuiz();
  }
}

function loadFromInput() {
  const raw = jsonInput.value.trim();

  if (!raw) {
    updateDraftStatusFromSaved();

    if (currentChapterId && storedQuestions.length) {
      setStatus(`${storedQuestions.length}টি saved MCQ আছে। নতুন JSON paste করে save করুন।`, "ok");
    } else if (currentChapterId) {
      setStatus("JSON paste করে save করুন।");
    } else {
      setStatus("Title লিখে chapter save করুন।");
    }

    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeQuestions(parsed, { shuffle: false });
    draftQuestionCount = normalized.length;
    draftJsonValid = true;
    setStatus(`${draftQuestionCount}টি question valid। Save চাপুন।`, "ok");
  } catch (error) {
    draftQuestionCount = 0;
    draftJsonValid = false;
    setStatus(error.message, "error");
  }
}

function scheduleLoad() {
  window.clearTimeout(parseTimer);
  parseTimer = window.setTimeout(loadFromInput, 180);
}

async function saveChapter() {
  const title = normalizeText(chapterTitle.value);
  const raw = jsonInput.value.trim();

  if (!title) {
    setStatus("Chapter শিরোনাম লিখুন।", "error");
    chapterTitle.focus();
    return;
  }

  try {
    let normalized = null;
    let newQuestions = [];

    if (raw) {
      const parsed = JSON.parse(raw);
      normalized = normalizeQuestions(parsed, { shuffle: false });
      newQuestions = questionsForDatabase(normalized);
    }

    const payload = { title };

    if (normalized) {
      payload.questions = currentChapterId && storedQuestions.length
        ? mergeQuestionsForSave(storedQuestions, newQuestions)
        : newQuestions;
    } else if (!currentChapterId || !storedQuestions.length) {
      payload.questions = [];
    }

    const url = currentChapterId ? `/api/chapters/${currentChapterId}` : "/api/chapters";
    const method = currentChapterId ? "PUT" : "POST";
    const addedCount = newQuestions.length;

    saveChapterBtn.disabled = true;
    setStatus("Save হচ্ছে...");

    const data = await requestJson(url, { method, body: JSON.stringify(payload) });
    currentChapterId = data.chapter.id;
    storedQuestions = Array.isArray(data.chapter.questions) ? data.chapter.questions : [];

    if (mode === "practice") {
      hydrateQuestionsFromStored({ shuffle: false });
    }

    updateDraftStatusFromSaved();
    clearJsonDraft();

    if (storedQuestions.length) {
      if (addedCount && method === "PUT") {
        setStatus(`${data.chapter.title} — ${addedCount}টি নতুন MCQ যোগ হয়েছে। মোট ${storedQuestions.length}টি।`, "ok");
      } else {
        setStatus(`${data.chapter.title} — ${storedQuestions.length}টি MCQ saved।`, "ok");
      }
    } else {
      setStatus(`${data.chapter.title} saved। এখন JSON add করুন।`, "ok");
    }

    await loadChapterSummaries();
    renderQuiz();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    saveChapterBtn.disabled = false;
  }
}

function switchMode(nextMode) {
  if (nextMode === mode) {
    return;
  }

  mode = nextMode;
  submitted = false;
  selectedAnswers.clear();

  if (mode === "exam") {
    beginExamSetup();
    return;
  }

  resetExamState();

  if (currentChapterId) {
    hydrateQuestionsFromStored({ shuffle: false });
  } else {
    questions = [];
  }

  renderQuiz();
}

function startExam() {
  if (!examSetup.chapterId || !examSetup.availableCount) {
    return;
  }

  const picked = pickRandomQuestions(examStoredQuestions, examSetup.questionCount);
  questions = normalizeQuestions(picked, { shuffle: examShuffle });
  examPhase = "running";
  selectedAnswers.clear();
  submitted = false;
  renderQuiz();
}

function chooseAnswer(questionKey, option) {
  selectedAnswers.set(questionKey, option);

  if (mode === "practice") {
    submitted = false;
  }

  renderQuiz();
}

function calculateScore(forceMarking = false) {
  let correct = 0;
  let wrong = 0;
  let skipped = 0;

  questions.forEach((question) => {
    const selected = selectedAnswers.get(question.uid);

    if (!selected) {
      skipped += 1;
    } else if (selected === question.answer) {
      correct += 1;
    } else {
      wrong += 1;
    }
  });

  const shouldUseNegative = mode === "exam" && examNegativeMark && (submitted || forceMarking);
  const score = correct - (shouldUseNegative ? wrong * 0.25 : 0);

  return {
    correct,
    wrong,
    skipped,
    answered: correct + wrong,
    score: Number(score.toFixed(2)),
    total: questions.length,
    negativeApplied: shouldUseNegative,
  };
}

function submitExam() {
  if (!questions.length || examPhase !== "running") {
    return;
  }

  submitted = true;
  renderQuiz();
  resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetState() {
  selectedAnswers.clear();
  submitted = false;
  renderQuiz();
}

function renderChapterSelect() {
  const options = ['<option value="">Chapter বেছে নিন</option>'];

  chapters.forEach((chapter, index) => {
    const label = `${index + 1}. ${chapter.title}${chapter.questionCount ? ` (${chapter.questionCount})` : ""}`;
    options.push(`<option value="${escapeHtml(chapter.id)}" ${chapter.id === currentChapterId ? "selected" : ""}>${escapeHtml(label)}</option>`);
  });

  chapterSelect.innerHTML = options.join("");
}

function renderQuiz() {
  const isExam = mode === "exam";
  const isExamSetup = isExam && examPhase === "setup";
  const isExamRunning = isExam && examPhase === "running";
  const hasData = isExamSetup ? Boolean(examSetup.chapterId && examSetup.availableCount) : questions.length > 0;
  const score = hasData && !isExamSetup ? calculateScore() : { total: 0, answered: 0, score: 0 };

  document.body.dataset.mode = mode;
  controlRow.classList.toggle("hidden", isExam);
  totalCount.textContent = isExamSetup ? (examSetup.availableCount || 0) : score.total;
  answeredCount.textContent = isExamSetup ? examSetup.questionCount : score.answered;
  liveScore.textContent = hasData && !isExamSetup ? (isExamRunning && !submitted ? "-" : score.score) : 0;
  totalLabel.textContent = isExamSetup ? "মোট MCQ" : "মোট";
  answeredLabel.textContent = isExamSetup ? "নির্বাচিত" : "উত্তর";

  submitBtn.disabled = !isExamRunning || !questions.length || submitted;
  submitBtn.textContent = submitted ? "Submitted" : "Submit Exam";
  resetBtn.disabled = !isExamRunning || !questions.length;
  quizFooter.classList.toggle("hidden", !isExamRunning || !questions.length);

  modeButtons.forEach((button) => {
    button.disabled = false;
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  saveChapterBtn.textContent = currentChapterId
    ? (draftJsonValid || !currentChapterSummary()?.questionCount ? "Save Chapter Data" : "Update Chapter")
    : "Create Chapter";

  renderResult(isExamSetup ? null : score);
  renderQuestions();
}

function renderChapters() {
  chapterCount.textContent = `${chapters.length} chapters`;

  if (!chapters.length) {
    chapterList.innerHTML = `<div class="chapter-empty">কোনো chapter নেই।</div>`;
    return;
  }

  chapterList.innerHTML = chapters.map((chapter, index) => `
    <button class="chapter-item ${chapter.id === currentChapterId ? "active" : ""}" type="button" data-chapter-id="${escapeHtml(chapter.id)}">
      <strong>${index + 1}. ${escapeHtml(chapter.title)}</strong>
      <span>${chapter.questionCount ? `${chapter.questionCount} MCQ` : "Empty"}</span>
    </button>
  `).join("");
}

function renderResult(score) {
  const showResult = score && questions.length && (mode === "practice" || submitted);

  resultPanel.classList.toggle("hidden", !showResult);

  if (!showResult) {
    resultPanel.innerHTML = "";
    return;
  }

  const headline = mode === "exam" ? "Exam Result" : "Practice Result";

  resultPanel.innerHTML = `
    <strong>${headline}</strong>
    <div class="result-grid">
      ${metric("Score", score.score)}
      ${metric("Correct", score.correct)}
      ${metric("Wrong", score.wrong)}
      ${metric("Skipped", score.skipped)}
    </div>
  `;
}

function metric(label, value) {
  return `
    <div class="result-metric">
      <strong>${value}</strong>
      <span>${label}</span>
    </div>
  `;
}

function renderExamSetup() {
  const chapterOptions = ['<option value="">Chapter বেছে নিন</option>'];

  chapters.forEach((chapter, index) => {
    const label = `${index + 1}. ${chapter.title}${chapter.questionCount ? ` (${chapter.questionCount})` : ""}`;
    chapterOptions.push(
      `<option value="${escapeHtml(chapter.id)}" ${chapter.id === examSetup.chapterId ? "selected" : ""}>${escapeHtml(label)}</option>`,
    );
  });

  const hasChapter = Boolean(examSetup.chapterId);
  const hasQuestions = examSetup.availableCount > 0;
  const canStart = hasChapter && hasQuestions;

  questionList.innerHTML = `
    <div class="exam-setup">
      <div class="exam-setup-head">
        <div class="empty-icon" aria-hidden="true">📝</div>
        <h2>Exam Setup</h2>
        <p>Chapter বেছে নিন, কতটি MCQ দিতে চান সেটা ঠিক করুন, তারপর exam শুরু করুন।</p>
      </div>

      <div class="exam-setup-card">
        <label class="field-label" for="examChapterSelect">Chapter</label>
        <select id="examChapterSelect" class="select-input">
          ${chapterOptions.join("")}
        </select>

        <div class="exam-count-block ${hasQuestions ? "" : "disabled"}">
          <div class="exam-count-head">
            <label class="field-label" for="examCountRange">MCQ সংখ্যা</label>
            <strong id="examCountValue">${examSetup.questionCount}</strong>
          </div>
          <input
            id="examCountRange"
            class="range-input"
            type="range"
            min="1"
            max="${Math.max(examSetup.availableCount, 1)}"
            value="${examSetup.questionCount}"
            ${hasQuestions ? "" : "disabled"}
          />
          <p class="exam-count-note">${hasQuestions ? `এই chapter-এ মোট ${examSetup.availableCount}টি MCQ আছে।` : "Chapter select করলে MCQ count ঠিক করতে পারবেন।"}</p>
        </div>

        <label class="switch-row" for="examNegativeToggle">
          <span>Negative mark (-0.25)</span>
          <input id="examNegativeToggle" type="checkbox" ${examNegativeMark ? "checked" : ""} />
        </label>

        <label class="switch-row" for="examShuffleToggle">
          <span>Option shuffle</span>
          <input id="examShuffleToggle" type="checkbox" ${examShuffle ? "checked" : ""} />
        </label>

        <button id="startExamBtn" class="primary-btn" type="button" ${canStart ? "" : "disabled"}>
          Exam শুরু করুন
        </button>
      </div>
    </div>
  `;

  questionList.querySelector("#examChapterSelect").addEventListener("change", (event) => {
    loadExamSetupChapter(event.target.value);
  });

  const countRange = questionList.querySelector("#examCountRange");
  const countValue = questionList.querySelector("#examCountValue");

  countRange.addEventListener("input", (event) => {
    examSetup.questionCount = Number(event.target.value);
    countValue.textContent = examSetup.questionCount;
    answeredCount.textContent = examSetup.questionCount;
  });

  questionList.querySelector("#examNegativeToggle").addEventListener("change", (event) => {
    examNegativeMark = event.target.checked;
  });

  questionList.querySelector("#examShuffleToggle").addEventListener("change", (event) => {
    examShuffle = event.target.checked;
  });

  questionList.querySelector("#startExamBtn").addEventListener("click", startExam);
}

function renderQuestions() {
  if (mode === "exam" && examPhase === "setup") {
    renderExamSetup();
    return;
  }

  if (!questions.length) {
    const hasSelectedChapter = Boolean(currentChapterId);
    const heading = hasSelectedChapter ? "এই chapter-এ MCQ নেই" : "Chapter বেছে নিন";
    const body = hasSelectedChapter
      ? "Admin panel থেকে MCQ add করুন।"
      : "উপরে থেকে chapter select করুন।";

    questionList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">${hasSelectedChapter ? "📝" : "📚"}</div>
        <h2>${heading}</h2>
        <p>${body}</p>
      </div>
    `;
    return;
  }

  questionList.innerHTML = questions.map(renderQuestion).join("");
}

function renderQuestion(question, index) {
  const selected = selectedAnswers.get(question.uid);
  const canReveal = mode === "practice" ? Boolean(selected) : submitted;
  const isCorrect = selected === question.answer;
  const feedback = canReveal ? renderFeedback(question, selected, isCorrect) : "";

  return `
    <article class="question-card">
      <div class="question-head">
        <div class="question-number">${index + 1}</div>
        <p class="question-text">${escapeHtml(question.question)}</p>
      </div>
      <div class="options">
        ${question.options.map((option, optionIndex) => renderOption(question, option, optionIndex, selected, canReveal)).join("")}
      </div>
      ${feedback}
    </article>
  `;
}

function renderOption(question, option, optionIndex, selected, canReveal) {
  const isSelected = selected === option;
  const isAnswer = question.answer === option;
  const classes = ["option-btn"];

  if (isSelected) {
    classes.push("selected");
  }

  if (canReveal && isAnswer) {
    classes.push("correct");
  }

  if (canReveal && isSelected && !isAnswer) {
    classes.push("wrong");
  }

  return `
    <button
      class="${classes.join(" ")}"
      type="button"
      data-question-key="${escapeHtml(question.uid)}"
      data-option="${escapeHtml(option)}"
      ${mode === "exam" && submitted ? "disabled" : ""}
    >
      <span class="option-key">${optionLetters[optionIndex] ?? optionIndex + 1}</span>
      <span>${escapeHtml(option)}</span>
    </button>
  `;
}

function renderFeedback(question, selected, isCorrect) {
  if (!selected) {
    return `
      <div class="feedback">
        উত্তর: <strong>${escapeHtml(question.answer)}</strong>
      </div>
    `;
  }

  const label = isCorrect ? "সঠিক" : "ভুল";
  const className = isCorrect ? "correct" : "wrong";
  const showExplanation = mode === "exam" && submitted && question.explanation;

  return `
    <div class="feedback ${className}">
      ${label} — উত্তর: <strong>${escapeHtml(question.answer)}</strong>${showExplanation ? `<br>${escapeHtml(question.explanation)}` : ""}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

chapterSelect.addEventListener("change", () => {
  const id = chapterSelect.value;

  if (!id) {
    currentChapterId = null;
    storedQuestions = [];
    questions = [];
    selectedAnswers.clear();
    submitted = false;
    renderQuiz();
    return;
  }

  loadChapter(id);
});

jsonInput.addEventListener("input", scheduleLoad);
chapterTitle.addEventListener("input", () => {
  saveChapterBtn.textContent = currentChapterId ? "Update Chapter" : "Create Chapter";
});
addChapterBtn.addEventListener("click", () => createChapterDraft(true));
saveChapterBtn.addEventListener("click", saveChapter);
clearDraftBtn.addEventListener("click", () => createChapterDraft(true));
resetBtn.addEventListener("click", resetState);
submitBtn.addEventListener("click", submitExam);
openAdminBtn.addEventListener("click", () => setView("admin"));
backToQuizBtn.addEventListener("click", () => setView("quiz"));
themeToggleBtn.addEventListener("click", toggleTheme);

modeButtons.forEach((button) => {
  button.addEventListener("click", () => switchMode(button.dataset.mode));
});

chapterList.addEventListener("click", (event) => {
  const chapterButton = event.target.closest("[data-chapter-id]");

  if (!chapterButton) {
    return;
  }

  loadChapter(chapterButton.dataset.chapterId);
});

questionList.addEventListener("click", (event) => {
  const optionButton = event.target.closest("[data-question-key][data-option]");

  if (!optionButton) {
    return;
  }

  chooseAnswer(optionButton.dataset.questionKey, optionButton.dataset.option);
});

bootstrap();
