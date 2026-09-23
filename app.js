(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    subject: null,
    subjectInfo: [],
    chapters: [],
    chapter: null,
    page: "all",
    mode: "practice",
    questions: [],
    answers: new Map(),
    submitted: false,
    reviewed: false,
    editingChapterId: null,
    theme: localStorage.getItem("gk-theme") || "light",
  };

  const subjectNames = {
    bangla: { name: "বাংলা", icon: "📖" },
    english: { name: "English", icon: "📝" },
    gk: { name: "GK", icon: "🌍" },
  };

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  const shuffle = (items) => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Request failed");
    return payload;
  }

  function showOnly(viewId) {
    ["subjectView", "quizView", "adminView"].forEach((id) => $(id)?.classList.toggle("hidden", id !== viewId));
  }

  function setLoading(visible) {
    $("loadingScreen")?.classList.toggle("hidden", !visible);
  }

  function notify(message, type = "info") {
    const target = $("jsonStatus");
    if (target) {
      target.textContent = message;
      target.dataset.type = type;
    } else {
      window.alert(message);
    }
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    localStorage.setItem("gk-theme", state.theme);
    document.querySelectorAll(".theme-icon-light").forEach((el) => el.classList.toggle("hidden", theme === "dark"));
    document.querySelectorAll(".theme-icon-dark").forEach((el) => el.classList.toggle("hidden", theme !== "dark"));
  }

  function toggleTheme() { setTheme(state.theme === "dark" ? "light" : "dark"); }

  function renderSubjects() {
    const grid = $("subjectGrid");
    if (!grid) return;
    grid.innerHTML = state.subjectInfo.map((subject) => `
      <button class="subject-card" type="button" data-subject="${escapeHtml(subject.id)}">
        <span class="subject-card-icon">${subjectNames[subject.id]?.icon || "📚"}</span>
        <span class="subject-card-body"><strong>${escapeHtml(subject.name || subjectNames[subject.id]?.name || subject.id)}</strong><span>${escapeHtml(subject.nameEn || "Subject-wise MCQ")}</span></span>
        <span class="subject-card-meta">${Number(subject.chapterCount || 0)} chapters<br>${Number(subject.questionCount || 0)} MCQ</span>
      </button>`).join("") || `<div class="empty-state"><h2>কোনো subject পাওয়া যায়নি</h2></div>`;
    grid.querySelectorAll("[data-subject]").forEach((button) => button.addEventListener("click", () => openSubject(button.dataset.subject)));
  }

  async function loadSubjects() {
    const data = await api("/api/subjects");
    state.subjectInfo = data.subjects || [];
    renderSubjects();
  }

  async function openSubject(subject) {
    state.subject = subject;
    state.chapter = null;
    state.questions = [];
    state.answers.clear();
    state.submitted = false;
    state.reviewed = false;
    showOnly("quizView");
    $("currentSubjectLabel").textContent = subjectNames[subject]?.name || subject;
    await loadChapters();
    resetQuizView();
  }

  async function loadChapters() {
    const data = await api(`/api/chapters?subject=${encodeURIComponent(state.subject)}`);
    state.chapters = data.chapters || [];
    const select = $("chapterSelect");
    select.innerHTML = `<option value="">Chapter বেছে নিন</option>` + state.chapters.map((chapter) => `<option value="${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)} (${chapter.questionCount || 0})</option>`).join("");
    $("chapterCount").textContent = `${state.chapters.length} chapters`;
    renderChapterList();
  }

  async function loadChapter(chapterId) {
    if (!chapterId) {
      resetQuizView();
      return;
    }
    setLoading(true);
    try {
      const data = await api(`/api/chapters/${encodeURIComponent(chapterId)}`);
      state.chapter = data.chapter;
      state.page = "all";
      state.answers.clear();
      state.submitted = false;
      state.reviewed = false;
      populatePages();
      buildQuestionSet();
      renderQuestions();
    } catch (error) {
      notify(error.message, "error");
    } finally { setLoading(false); }
  }

  function populatePages() {
    const select = $("pageSelect");
    const pages = state.chapter?.pages || [];
    select.innerHTML = `<option value="all">সব Page</option>` + pages.map((page) => `<option value="${escapeHtml(page.id)}">${escapeHtml(page.title || `Page ${page.pageNo}`)}</option>`).join("");
    select.classList.toggle("hidden", pages.length <= 1);
  }

  function buildQuestionSet() {
    const pages = state.chapter?.pages || [];
    const selectedPages = state.page === "all" ? pages : pages.filter((page) => page.id === state.page);
    const questions = selectedPages.flatMap((page) => page.questions || []);
    state.questions = questions.map((question, index) => ({ ...question, _index: index + 1, options: shuffle(question.options || []) }));
    state.answers.clear();
    state.submitted = false;
    state.reviewed = false;
  }

  function resetQuizView() {
    state.questions = [];
    state.answers.clear();
    state.submitted = false;
    state.reviewed = false;
    $("pageSelect").classList.add("hidden");
    $("questionList").innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><h2>Chapter বেছে নিন</h2><p>উপরে থেকে chapter select করলেই MCQ শুরু হবে।</p></div>`;
    $("quizFooter").classList.add("hidden");
    $("resultPanel").classList.add("hidden");
    updateScore();
  }

  function currentScore() {
    let correct = 0; let wrong = 0; let skipped = 0;
    state.questions.forEach((question) => {
      const answer = state.answers.get(String(question.id));
      if (!answer) skipped += 1;
      else if (answer === question.answer) correct += 1;
      else wrong += 1;
    });
    return { correct, wrong, skipped, answered: correct + wrong, total: state.questions.length, score: correct - wrong * 0.25 };
  }

  function updateScore() {
    const score = currentScore();
    $("totalCount").textContent = score.total;
    $("answeredCount").textContent = score.answered;
    $("liveScore").textContent = score.score.toFixed(2).replace(/\.00$/, "");
    $("totalLabel").textContent = "মোট";
    $("answeredLabel").textContent = "উত্তর";
    $("scoreLabel").textContent = state.mode === "exam" ? "স্কোর" : "লাইভ স্কোর";
  }

  function renderQuestions() {
    const list = $("questionList");
    if (!state.questions.length) {
      list.innerHTML = `<div class="empty-state"><h2>এই chapter-এ প্রশ্ন নেই</h2><p>Admin panel থেকে question যোগ করুন।</p></div>`;
      $("quizFooter").classList.add("hidden");
      updateScore();
      return;
    }
    list.innerHTML = state.questions.map((question, index) => {
      const selected = state.answers.get(String(question.id));
      const locked = state.mode === "exam" ? state.submitted : state.reviewed;
      const options = (question.options || []).map((option, optionIndex) => {
        const isSelected = selected === option;
        const isCorrect = locked && option === question.answer;
        const isWrong = locked && isSelected && option !== question.answer;
        const className = ["option-btn", isSelected ? "selected" : "", isCorrect ? "correct" : "", isWrong ? "wrong" : ""].filter(Boolean).join(" ");
        return `<button type="button" class="${className}" data-question="${escapeHtml(question.id)}" data-answer="${escapeHtml(option)}" ${locked ? "disabled" : ""}><span class="option-key">${String.fromCharCode(65 + optionIndex)}</span><span>${escapeHtml(option)}</span></button>`;
      }).join("");
      const feedback = locked ? `<div class="question-feedback ${selected === question.answer ? "correct" : "wrong"}"><strong>${selected === question.answer ? "সঠিক উত্তর" : selected ? "ভুল উত্তর" : "উত্তর দেওয়া হয়নি"}</strong><span>সঠিক উত্তর: ${escapeHtml(question.answer)}</span>${question.explanation ? `<p>${escapeHtml(question.explanation)}</p>` : ""}</div>` : "";
      return `<article class="question-card" data-card="${escapeHtml(question.id)}"><div class="question-number">Question ${index + 1}</div><h3>${escapeHtml(question.question)}</h3><div class="options-grid">${options}</div>${feedback}</article>`;
    }).join("");
    list.querySelectorAll("[data-question]").forEach((button) => button.addEventListener("click", () => chooseAnswer(button.dataset.question, button.dataset.answer)));
    $("quizFooter").classList.remove("hidden");
    $("submitBtn").textContent = state.mode === "exam" ? (state.submitted ? "Review Complete" : "Submit Exam") : "Practice Summary";
    updateScore();
  }

  function chooseAnswer(questionId, answer) {
    if (state.submitted || state.reviewed) return;
    state.answers.set(String(questionId), answer);
    renderQuestions();
  }

  function renderResult() {
    const score = currentScore();
    const percent = score.total ? Math.round((score.correct / score.total) * 100) : 0;
    $("resultPanel").innerHTML = `<div class="result-summary-head"><div><strong>${state.mode === "exam" ? "Exam Result" : "Practice Summary"}</strong><p>সঠিক: ${score.correct} · ভুল: ${score.wrong} · বাদ: ${score.skipped}</p></div><div class="result-summary-score"><strong>${score.score.toFixed(2)}</strong><span>${percent}% correct</span></div></div>`;
    $("resultPanel").classList.remove("hidden");
    $("examResultContent").innerHTML = `<h2 id="examResultTitle">${state.mode === "exam" ? "Exam Completed" : "Practice Completed"}</h2><p>মোট প্রশ্ন: ${score.total}</p><p>সঠিক: ${score.correct} | ভুল: ${score.wrong} | বাদ: ${score.skipped}</p><h3>Score: ${score.score.toFixed(2)}</h3><button id="resultRetryBtn" class="primary-btn" type="button">আবার চেষ্টা করুন</button>`;
    $("examResultModal").classList.remove("hidden");
    $("resultRetryBtn")?.addEventListener("click", closeResultAndReset);
  }

  function submitQuiz() {
    if (!state.questions.length) return;
    if (state.mode === "exam" && !state.submitted) {
      state.submitted = true;
      renderQuestions();
      renderResult();
      return;
    }
    if (state.mode === "practice" && !state.reviewed) {
      state.reviewed = true;
      renderQuestions();
      renderResult();
      return;
    }
    renderResult();
  }

  function closeResultAndReset() {
    $("examResultModal").classList.add("hidden");
    state.answers.clear();
    state.submitted = false;
    state.reviewed = false;
    renderQuestions();
  }

  function resetQuiz() {
    state.answers.clear();
    state.submitted = false;
    state.reviewed = false;
    $("examResultModal").classList.add("hidden");
    $("resultPanel").classList.add("hidden");
    renderQuestions();
  }

  function setMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;
    document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    resetQuiz();
  }

  function renderChapterList() {
    const list = $("chapterList");
    if (!list) return;
    list.innerHTML = state.chapters.map((chapter) => `<button class="chapter-list-item" type="button" data-admin-chapter="${escapeHtml(chapter.id)}"><strong>${escapeHtml(chapter.title)}</strong><span>${chapter.questionCount || 0} questions · ${chapter.pageCount || 0} pages</span></button>`).join("") || `<p>কোনো chapter নেই।</p>`;
    list.querySelectorAll("[data-admin-chapter]").forEach((button) => button.addEventListener("click", () => editChapter(button.dataset.adminChapter)));
  }

  async function openAdmin() {
    if (!state.subject) return;
    showOnly("adminView");
    $("adminSubjectLabel").textContent = subjectNames[state.subject]?.name || state.subject;
    await loadChapters();
    $("storageBadge").textContent = "API storage";
    clearEditor();
  }

  async function editChapter(id) {
    try {
      const data = await api(`/api/chapters/${encodeURIComponent(id)}`);
      const chapter = data.chapter;
      state.editingChapterId = chapter.id;
      $("chapterTitle").value = chapter.title || "";
      $("jsonInput").value = JSON.stringify(chapter.pages || [], null, 2);
      $("saveChapterBtn").textContent = "Update Chapter";
      $("jsonStatus").textContent = "Chapter edit mode চালু হয়েছে।";
    } catch (error) { notify(error.message, "error"); }
  }

  function clearEditor() {
    state.editingChapterId = null;
    $("chapterTitle").value = "";
    $("jsonInput").value = "";
    $("saveChapterBtn").textContent = "Create Chapter";
    $("jsonStatus").textContent = "Chapter title লিখে save করুন।";
  }

  function parseEditorPages() {
    const raw = $("jsonInput").value.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => item.questions)) return parsed;
    if (Array.isArray(parsed)) return [{ id: "page-1", pageNo: 1, title: "Page 1", questions: parsed }];
    if (Array.isArray(parsed.questions)) return [{ id: "page-1", pageNo: 1, title: "Page 1", questions: parsed.questions }];
    throw new Error("JSON format সঠিক নয়। Question array বা pages array দিন।");
  }

  async function saveChapter() {
    const title = $("chapterTitle").value.trim();
    if (!title) return notify("Chapter title দিন।", "error");
    try {
      const pages = parseEditorPages();
      const body = { title, subject: state.subject, pages };
      if (state.editingChapterId) await api(`/api/chapters/${encodeURIComponent(state.editingChapterId)}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/api/chapters", { method: "POST", body: JSON.stringify(body) });
      notify("Chapter successfully saved.", "success");
      clearEditor();
      await loadChapters();
      await loadSubjects();
    } catch (error) { notify(error.message, "error"); }
  }

  function bindEvents() {
    [$("themeToggleBtn"), $("themeToggleBtnSubject")].forEach((button) => button?.addEventListener("click", toggleTheme));
    $("backToSubjectsBtn")?.addEventListener("click", () => { showOnly("subjectView"); loadSubjects().catch((error) => notify(error.message)); });
    $("backToQuizBtn")?.addEventListener("click", () => { showOnly("quizView"); loadChapters().catch((error) => notify(error.message)); });
    $("chapterSelect")?.addEventListener("change", (event) => loadChapter(event.target.value));
    $("pageSelect")?.addEventListener("change", (event) => { state.page = event.target.value; buildQuestionSet(); renderQuestions(); });
    document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $("submitBtn")?.addEventListener("click", submitQuiz);
    $("resetBtn")?.addEventListener("click", resetQuiz);
    $("openAdminBtn")?.addEventListener("click", () => openAdmin().catch((error) => notify(error.message)));
    $("addChapterBtn")?.addEventListener("click", clearEditor);
    $("clearDraftBtn")?.addEventListener("click", clearEditor);
    $("saveChapterBtn")?.addEventListener("click", saveChapter);
    $("closeExamResultBtn")?.addEventListener("click", () => $("examResultModal").classList.add("hidden"));
    $("examResultModal")?.querySelector(".exam-result-backdrop")?.addEventListener("click", () => $("examResultModal").classList.add("hidden"));
  }

  async function init() {
    setTheme(state.theme);
    bindEvents();
    try {
      await loadSubjects();
    } catch (error) {
      console.error(error);
      $("subjectGrid").innerHTML = `<div class="empty-state"><h2>ডাটা লোড করা যাচ্ছে না</h2><p>${escapeHtml(error.message)}</p><button class="primary-btn" id="retryLoadBtn" type="button">Retry</button></div>`;
      $("retryLoadBtn")?.addEventListener("click", () => init());
    } finally {
      setLoading(false);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
