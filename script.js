/* =========================================================
   パラドックス図鑑 - script.js
   - paradox.json を fetch して読み込み、HTMLへは直接埋め込まない
   - 新しい項目は JSON に追加するだけで一覧・検索・詳細へ自動反映される
   - AI検索処理 (aiSearch.js 相当) は独立した関数として実装し、
     将来 Claude API 等の実AIへ差し替えやすい構造にしている
   ========================================================= */

const DATA_URL = "paradox.json";

const CATEGORY_STRUCTURE = {
  "パラドックス": ["哲学", "論理学", "数学", "確率", "物理学", "科学", "言語", "経済学", "ゲーム理論", "倫理学"],
  "現象": ["心理学", "認知科学", "社会学", "行動経済学", "生物学", "医学", "教育", "恋愛", "仕事", "SNS", "日常生活"],
  "ジレンマ": ["倫理", "経済", "政治", "恋愛", "人間関係", "環境", "教育", "医療", "ビジネス"]
};

let ALL_ENTRIES = [];
let currentFilter = { type: null, category: null };

/* ---------- データ取得 ---------- */
async function loadData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error("paradox.json の読み込みに失敗しました");
  return res.json();
}

function findById(id) {
  return ALL_ENTRIES.find((e) => e.id === id);
}

/* =========================================================
   検索処理（独立モジュール的に実装）
   ---------------------------------------------------------
   - keywordSearch: 名前・タグ・検索キーワードへの単純部分一致
   - aiSearch: 文字bigramの重なりから類似度スコアを算出する
     簡易実装。将来的にこの関数の中身だけを
     Claude API / OpenAI API 呼び出しに差し替えれば良い構造にしてある。
   ========================================================= */
function normalize(str) {
  return (str || "").toLowerCase().replace(/[\s　、。・「」『』,.!?！？]/g, "");
}

function toBigrams(str) {
  const s = normalize(str);
  const grams = new Set();
  if (s.length < 2) { if (s.length === 1) grams.add(s); return grams; }
  for (let i = 0; i < s.length - 1; i++) grams.add(s.substring(i, i + 2));
  return grams;
}

function combinedText(entry) {
  return [
    entry.name, entry.englishName, entry.summary, entry.description,
    entry.example, (entry.tags || []).join(" "), (entry.searchKeywords || []).join(" ")
  ].join(" ");
}

function keywordSearch(query, entries) {
  const q = normalize(query);
  if (!q) return entries.slice();
  return entries.filter((e) => {
    const fields = [e.name, e.englishName, ...(e.tags || []), ...(e.searchKeywords || [])];
    return fields.some((f) => normalize(f).includes(q));
  });
}

function aiSearch(query, entries) {
  const qGrams = toBigrams(query);
  if (qGrams.size === 0) return [];

  const results = entries.map((entry) => {
    const tGrams = toBigrams(combinedText(entry));
    let overlap = 0;
    qGrams.forEach((g) => { if (tGrams.has(g)) overlap++; });
    let score = overlap / qGrams.size;

    const qNorm = normalize(query);
    const nameNorm = normalize(entry.name);
    const enNorm = normalize(entry.englishName);
    if (qNorm && (nameNorm.includes(qNorm) || qNorm.includes(nameNorm))) score += 0.45;
    if (qNorm && enNorm && (enNorm.includes(qNorm) || qNorm.includes(enNorm))) score += 0.3;
    (entry.searchKeywords || []).forEach((k) => {
      const kn = normalize(k);
      if (kn && (kn.includes(qNorm) || qNorm.includes(kn))) score += 0.25;
    });

    return { entry, score: Math.min(score, 0.99) };
  });

  return results
    .filter((r) => r.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/* ---------- 一覧ページ ---------- */
function renderCategoryGroups() {
  const container = document.getElementById("categoryGroups");
  if (!container) return;
  container.innerHTML = "";

  Object.entries(CATEGORY_STRUCTURE).forEach(([type, subcats]) => {
    const typeCount = ALL_ENTRIES.filter((e) => e.type === type).length;

    const group = document.createElement("div");
    group.className = "cat-group";

    const toggle = document.createElement("div");
    toggle.className = "cat-toggle";
    toggle.innerHTML = `<span class="chevron"></span><span>${type}</span><span class="count">${typeCount}件</span>`;
    toggle.addEventListener("click", () => {
      group.classList.toggle("open");
      applyFilter(type, null);
    });

    const subList = document.createElement("div");
    subList.className = "subcat-list";
    subcats.forEach((sub) => {
      const count = ALL_ENTRIES.filter((e) => e.type === type && e.category === sub).length;
      const pill = document.createElement("span");
      pill.className = "subcat-pill";
      pill.textContent = `${sub} (${count})`;
      pill.addEventListener("click", (ev) => {
        ev.stopPropagation();
        applyFilter(type, sub);
        subList.querySelectorAll(".subcat-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
      });
      subList.appendChild(pill);
    });

    group.appendChild(toggle);
    group.appendChild(subList);
    container.appendChild(group);
  });
}

function applyFilter(type, category) {
  currentFilter = { type, category };
  document.getElementById("clearFilter").style.display = "block";
  renderEntryList();
}

function clearFilter() {
  currentFilter = { type: null, category: null };
  document.getElementById("clearFilter").style.display = "none";
  document.querySelectorAll(".subcat-pill.active").forEach((p) => p.classList.remove("active"));
  renderEntryList();
}

function renderEntryList() {
  const listEl = document.getElementById("entryList");
  const countEl = document.getElementById("entryCount");
  if (!listEl) return;

  let entries = ALL_ENTRIES;
  if (currentFilter.type) entries = entries.filter((e) => e.type === currentFilter.type);
  if (currentFilter.category) entries = entries.filter((e) => e.category === currentFilter.category);

  countEl.textContent = `${entries.length}件`;
  listEl.innerHTML = "";

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="not-found">この分類にはまだ項目がありません。</div>`;
    return;
  }

  entries.forEach((e) => {
    const card = document.createElement("a");
    card.className = "entry-card";
    card.href = `detail.html?id=${encodeURIComponent(e.id)}`;
    card.innerHTML = `
      <div class="top-row">
        <span class="type-mark">${e.type}</span>
        <span class="name">${e.name}</span>
      </div>
      <div class="en-name">${e.englishName || ""}</div>
      <div class="summary">${e.summary}</div>
      <div class="tags">${(e.tags || []).map((t) => `<span class="tag">#${t}</span>`).join("")}</div>
    `;
    listEl.appendChild(card);
  });
}

function renderAiCandidates(query) {
  const wrap = document.getElementById("aiResults");
  const listEl = document.getElementById("aiCandidateList");
  const candidates = aiSearch(query, ALL_ENTRIES);

  wrap.classList.add("open");

  if (candidates.length === 0) {
    listEl.innerHTML = `
      <div class="ai-empty">
        正式図鑑では見つかりませんでした。<br>みんなのパラドックスを検索しますか？
        <div class="sub">※みんなのパラドックスはVer1.2で実装予定です</div>
      </div>`;
    return;
  }

  listEl.innerHTML = candidates.map((c, i) => `
    <div class="ai-candidate" data-id="${c.entry.id}">
      <span class="ai-rank">${i + 1}</span>
      <span class="name">${c.entry.name}</span>
      <span class="cat-chip">${c.entry.type}・${c.entry.category}</span>
      <span class="ai-confidence">${Math.round(c.score * 100)}%</span>
    </div>
  `).join("");

  listEl.querySelectorAll(".ai-candidate").forEach((el) => {
    el.addEventListener("click", () => {
      window.location.href = `detail.html?id=${encodeURIComponent(el.dataset.id)}`;
    });
  });
}

function setupSearch() {
  const input = document.getElementById("searchInput");
  const aiResults = document.getElementById("aiResults");
  const categorySection = document.getElementById("categorySection");
  const listSection = document.getElementById("listSection");
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (q.length === 0) {
      aiResults.classList.remove("open");
      categorySection.style.display = "";
      listSection.style.display = "";
      return;
    }
    categorySection.style.display = "none";
    listSection.style.display = "none";
    renderAiCandidates(q);
  });
}

function setupNotifications() {
  const btn = document.getElementById("notifBtn");
  const panel = document.getElementById("notifPanel");
  if (!btn) return;
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    panel.classList.toggle("open");
  });
  document.addEventListener("click", (ev) => {
    if (!panel.contains(ev.target) && ev.target !== btn) panel.classList.remove("open");
  });
}

function setupCommunityButton() {
  const btn = document.getElementById("communityBtn");
  const note = document.getElementById("communityNote");
  if (!btn) return;
  btn.addEventListener("click", () => {
    note.textContent = "Ver1.2で公開予定です。";
  });
}

function setupClearFilter() {
  const clear = document.getElementById("clearFilter");
  if (!clear) return;
  clear.addEventListener("click", clearFilter);
}

/* ---------- 詳細ページ ---------- */
function renderDetail() {
  const container = document.getElementById("detailContent");
  if (!container) return;

  const id = new URLSearchParams(window.location.search).get("id");
  const entry = findById(id);

  document.title = entry ? `${entry.name} | パラドックス図鑑` : "見つかりません | パラドックス図鑑";

  if (!entry) {
    container.innerHTML = `<div class="not-found">お探しの項目は見つかりませんでした。</div>`;
    return;
  }

  const relatedHtml = (entry.related || []).map((rid) => {
    const r = findById(rid);
    if (!r) return "";
    return `<a class="related-item" href="detail.html?id=${encodeURIComponent(r.id)}">
      <span>${r.name}</span><span class="cat-chip">${r.type}</span>
    </a>`;
  }).join("");

  container.innerHTML = `
    <div class="detail-card">
      <div class="detail-id">${entry.id}</div>
      <h1 class="detail-title">${entry.name}</h1>
      <div class="detail-en">${entry.englishName || ""}</div>
      <div class="detail-meta">
        <span class="type-mark">${entry.type}</span>
        <span class="type-mark">${entry.category}</span>
        ${(entry.tags || []).map((t) => `<span class="tag">#${t}</span>`).join("")}
      </div>
      <div class="detail-summary">${entry.summary}</div>

      <div class="detail-block">
        <h2>詳細説明</h2>
        <p>${entry.description || ""}</p>
      </div>

      ${entry.example ? `
      <div class="detail-block">
        <h2>具体例</h2>
        <p>${entry.example}</p>
      </div>` : ""}

      ${relatedHtml ? `
      <div class="detail-block">
        <h2>関連項目</h2>
        <div class="related-list">${relatedHtml}</div>
      </div>` : ""}
    </div>
  `;
}

/* ---------- 初期化 ---------- */
async function init() {
  try {
    ALL_ENTRIES = await loadData();
  } catch (err) {
    console.error(err);
    const target = document.getElementById("entryList") || document.getElementById("detailContent");
    if (target) target.innerHTML = `<div class="not-found">データの読み込みに失敗しました。</div>`;
    return;
  }

  if (document.getElementById("entryList")) {
    renderCategoryGroups();
    renderEntryList();
    setupSearch();
    setupNotifications();
    setupCommunityButton();
    setupClearFilter();
  }

  if (document.getElementById("detailContent")) {
    renderDetail();
  }
}

document.addEventListener("DOMContentLoaded", init);
