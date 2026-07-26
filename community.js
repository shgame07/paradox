/* =========================================================
   パラドックス図鑑 - community.js (Ver1.2.0 / スプレッドシート連携版)
   「みんなのパラドックス」機能
   ---------------------------------------------------------
   - 正式図鑑（paradox.json / script.js）とは完全に分離
   - 投稿データは Google スプレッドシート（Apps Script経由）に保存する
   - ニックネーム・管理キーはこれまでどおりブラウザ(localStorage)に保存し、
     次回アクセス時に自動入力する（本人確認はサーバー側で行う）
   ========================================================= */

/* ▼▼▼ ここにデプロイしたApps ScriptウェブアプリのURLを貼り付けてください ▼▼▼ */
const API_URL = "https://script.google.com/macros/s/AKfycbxL99ZTt3GMAfreUIW2BRQR3G9IRpjA6iJkZuPl8HhhczoRNd2syl7HlWV3VLwLkuUA/exec";
/* ▲▲▲ ここまで ▲▲▲ */

const COMMUNITY_TYPES = ["パラドックス", "現象", "ジレンマ"];

const LS_IDENTITY = "mp_identity";
const LS_REPORTS_FALLBACK = "mp_reports_failed"; // 通報送信に失敗した場合の保険

let ALL_COMMUNITY_ENTRIES = [];
let communityFilter = { type: null, tag: null };
const COMMUNITY_PAGE_SIZE = 5;
let communityVisibleCount = COMMUNITY_PAGE_SIZE;

/* ---------- ユーティリティ ---------- */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------------------------------------------------
   API通信
   ---------------------------------------------------------
   - GET  : 一覧取得のみ（?action=list）
   - POST : 投稿 / 本人確認 / 更新 / 削除 / 通報
     Content-Type は text/plain を使う（application/json にすると
     ブラウザがCORSのプリフライトリクエストを送り、
     Apps Script側でエラーになりやすいため）
   ========================================================= */
async function apiList() {
  const res = await fetch(`${API_URL}?action=list`);
  if (!res.ok) throw new Error("一覧の取得に失敗しました");
  return res.json();
}

async function apiPost(action, payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...payload })
  });
  if (!res.ok) throw new Error("通信に失敗しました");
  return res.json();
}

const apiCreate = (post) => apiPost("create", { post });
const apiLookup = (id, managementKey) => apiPost("lookup", { id, managementKey });
const apiUpdate = (id, managementKey, post) => apiPost("update", { id, managementKey, post });
const apiDelete = (id, managementKey) => apiPost("delete", { id, managementKey });
const apiReport = (report) => apiPost("report", report);

/* ---------- ローカルストレージ（ニックネーム・管理キーのみ） ---------- */
function getIdentity() {
  try {
    const raw = localStorage.getItem(LS_IDENTITY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveIdentity(nickname, managementKey) {
  localStorage.setItem(LS_IDENTITY, JSON.stringify({ nickname, managementKey }));
}

function clearIdentity() {
  localStorage.removeItem(LS_IDENTITY);
}

function generateManagementKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字を除外
  let s = "";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

function makeSummary(description) {
  const text = (description || "").replace(/\s+/g, " ").trim();
  const LIMIT = 60;
  return text.length > LIMIT ? text.slice(0, LIMIT) + "…" : text;
}

function findCommunityById(id) {
  return ALL_COMMUNITY_ENTRIES.find((e) => e.id === id);
}

/* =========================================================
   検索処理（正式図鑑と同じ仕様・対象はみんなのパラドックスのみ）
   ========================================================= */
function normalizeText(str) {
  return (str || "").toLowerCase().replace(/[\s　、。・「」『』,.!?！？]/g, "");
}

function toBigramsText(str) {
  const s = normalizeText(str);
  const grams = new Set();
  if (s.length < 2) { if (s.length === 1) grams.add(s); return grams; }
  for (let i = 0; i < s.length - 1; i++) grams.add(s.substring(i, i + 2));
  return grams;
}

function communityCombinedText(entry) {
  return [
    entry.title, entry.summary, entry.description, entry.example,
    (entry.tags || []).join(" ")
  ].join(" ");
}

function communityAiSearch(query, entries) {
  const qGrams = toBigramsText(query);
  if (qGrams.size === 0) return [];

  const results = entries.map((entry) => {
    const tGrams = toBigramsText(communityCombinedText(entry));
    let overlap = 0;
    qGrams.forEach((g) => { if (tGrams.has(g)) overlap++; });
    let score = overlap / qGrams.size;

    const qNorm = normalizeText(query);
    const titleNorm = normalizeText(entry.title);
    if (qNorm && (titleNorm.includes(qNorm) || qNorm.includes(titleNorm))) score += 0.45;
    (entry.tags || []).forEach((t) => {
      const tn = normalizeText(t);
      if (tn && (tn.includes(qNorm) || qNorm.includes(tn))) score += 0.25;
    });

    return { entry, score: Math.min(score, 0.99) };
  });

  return results
    .filter((r) => r.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/* ---------- パンくずリスト ---------- */
function renderBreadcrumb(items) {
  const el = document.getElementById("breadcrumb");
  if (!el) return;
  el.innerHTML = items.map((item, i) => {
    const isLast = i === items.length - 1;
    const label = escapeHtml(item.label);
    const node = item.href && !isLast ? `<a href="${item.href}">${label}</a>` : `<span>${label}</span>`;
    return i === 0 ? node : `<span class="crumb-sep">＞</span>${node}`;
  }).join("");
}

/* ---------- 分類アコーディオン（一覧ページ） ---------- */
function renderCommunityCategoryGroups() {
  const container = document.getElementById("communityCategoryGroups");
  if (!container) return;
  container.innerHTML = "";

  COMMUNITY_TYPES.forEach((type) => {
    const entriesOfType = ALL_COMMUNITY_ENTRIES.filter((e) => e.category === type);
    const tagSet = new Set();
    entriesOfType.forEach((e) => (e.tags || []).forEach((t) => tagSet.add(t)));

    const group = document.createElement("div");
    group.className = "cat-group";

    const toggle = document.createElement("div");
    toggle.className = "cat-toggle";
    toggle.innerHTML = `<span class="chevron"></span><span>${escapeHtml(type)}</span><span class="count">${entriesOfType.length}件</span>`;
    toggle.addEventListener("click", () => {
      group.classList.toggle("open");
      applyCommunityFilter(type, null);
    });

    const subList = document.createElement("div");
    subList.className = "subcat-list";
    if (tagSet.size === 0) {
      const empty = document.createElement("span");
      empty.className = "subcat-empty";
      empty.textContent = "まだタグがありません";
      subList.appendChild(empty);
    } else {
      Array.from(tagSet).forEach((tag) => {
        const count = entriesOfType.filter((e) => (e.tags || []).includes(tag)).length;
        const pill = document.createElement("span");
        pill.className = "subcat-pill";
        pill.textContent = `${tag} (${count})`;
        pill.addEventListener("click", (ev) => {
          ev.stopPropagation();
          applyCommunityFilter(type, tag);
          subList.querySelectorAll(".subcat-pill").forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
        });
        subList.appendChild(pill);
      });
    }

    group.appendChild(toggle);
    group.appendChild(subList);
    container.appendChild(group);
  });
}

function applyCommunityFilter(type, tag) {
  communityFilter = { type, tag };
  communityVisibleCount = COMMUNITY_PAGE_SIZE;
  document.getElementById("communityClearFilter").style.display = "block";
  renderCommunityEntryList();
}

function clearCommunityFilter() {
  communityFilter = { type: null, tag: null };
  communityVisibleCount = COMMUNITY_PAGE_SIZE;
  document.getElementById("communityClearFilter").style.display = "none";
  document.querySelectorAll(".subcat-pill.active").forEach((p) => p.classList.remove("active"));
  renderCommunityEntryList();
}

/* ---------- 投稿一覧 ---------- */
function renderCommunityEntryList() {
  const listEl = document.getElementById("communityEntryList");
  const countEl = document.getElementById("communityEntryCount");
  if (!listEl) return;

  let entries = ALL_COMMUNITY_ENTRIES;
  if (communityFilter.type) entries = entries.filter((e) => e.category === communityFilter.type);
  if (communityFilter.tag) entries = entries.filter((e) => (e.tags || []).includes(communityFilter.tag));

  countEl.textContent = `${entries.length}件`;
  listEl.innerHTML = "";

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="not-found">この分類にはまだ投稿がありません。最初の投稿者になってみませんか？</div>`;
    return;
  }

  const visible = entries.slice(0, communityVisibleCount);

  visible.forEach((e) => {
    const card = document.createElement("a");
    card.className = "entry-card";
    card.href = `community-detail.html?id=${encodeURIComponent(e.id)}`;
    card.innerHTML = `
      <div class="top-row">
        <span class="type-mark">${escapeHtml(e.category)}</span>
        <span class="name">${escapeHtml(e.title)}</span>
      </div>
      <div class="summary">${escapeHtml(e.summary)}</div>
      <div class="tags">${(e.tags || []).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>
      <div class="post-meta-row">
        <span>投稿者：${escapeHtml(e.author || "匿名")}</span>
        <span>${escapeHtml(e.createdAt || "")}</span>
      </div>
    `;
    listEl.appendChild(card);
  });

  if (entries.length > visible.length) {
    const moreBtn = document.createElement("button");
    moreBtn.className = "load-more-btn";
    moreBtn.textContent = `もっと見る（残り${entries.length - visible.length}件）`;
    moreBtn.addEventListener("click", () => {
      communityVisibleCount += COMMUNITY_PAGE_SIZE;
      renderCommunityEntryList();
    });
    listEl.appendChild(moreBtn);
  }
}

/* ---------- AI検索（一覧ページ） ---------- */
function renderCommunityAiCandidates(query) {
  const wrap = document.getElementById("communityAiResults");
  const listEl = document.getElementById("communityAiCandidateList");
  const candidates = communityAiSearch(query, ALL_COMMUNITY_ENTRIES);

  wrap.classList.add("open");

  if (candidates.length === 0) {
    listEl.innerHTML = `
      <div class="ai-empty">
        みんなのパラドックスの中には見つかりませんでした。<br>
        <a href="community-post.html">新しく投稿してみる</a>のはいかがですか？
      </div>`;
    return;
  }

  listEl.innerHTML = candidates.map((c, i) => `
    <div class="ai-candidate" data-id="${c.entry.id}">
      <span class="ai-rank">${i + 1}</span>
      <span class="name">${escapeHtml(c.entry.title)}</span>
      <span class="cat-chip">${escapeHtml(c.entry.category)}</span>
      <span class="ai-confidence">${Math.round(c.score * 100)}%</span>
    </div>
  `).join("");

  listEl.querySelectorAll(".ai-candidate").forEach((el) => {
    el.addEventListener("click", () => {
      window.location.href = `community-detail.html?id=${encodeURIComponent(el.dataset.id)}`;
    });
  });
}

function setupCommunitySearch() {
  const input = document.getElementById("communitySearchInput");
  const aiResults = document.getElementById("communityAiResults");
  const categorySection = document.getElementById("communityCategorySection");
  const listSection = document.getElementById("communityListSection");
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
    renderCommunityAiCandidates(q);
  });
}

function setupCommunityClearFilter() {
  const clear = document.getElementById("communityClearFilter");
  if (!clear) return;
  clear.addEventListener("click", clearCommunityFilter);
}

/* ---------- 投稿者情報ボックス（投稿ページ） ---------- */
function renderIdentityBox() {
  const box = document.getElementById("identityBox");
  if (!box) return;
  const identity = getIdentity();

  if (identity) {
    box.innerHTML = `
      <div class="identity-current">
        <div>投稿者：<b>${escapeHtml(identity.nickname)}</b></div>
        <div class="identity-key">管理キー：<span class="mono">${escapeHtml(identity.managementKey)}</span></div>
        <button type="button" class="link-btn" id="switchIdentityBtn">別のニックネーム・管理キーを使う</button>
      </div>
    `;
    document.getElementById("switchIdentityBtn").addEventListener("click", () => {
      clearIdentity();
      renderIdentityBox();
    });
  } else {
    box.innerHTML = `
      <div class="identity-new">
        <label>ニックネーム<span class="req">必須</span>
          <input type="text" id="fNickname" placeholder="表示される投稿者名" required>
        </label>
        <div class="identity-hint">投稿すると管理キーが自動で発行されます。編集・削除に必要なので保存しておいてください。</div>
        <button type="button" class="link-btn" id="restoreIdentityBtn">すでに管理キーをお持ちの方はこちら</button>
        <div class="identity-restore" id="identityRestoreBox" style="display:none;">
          <label>ニックネーム
            <input type="text" id="rNickname" placeholder="以前使用したニックネーム">
          </label>
          <label>管理キー
            <input type="text" id="rKey" placeholder="例：A7K9-X2PQ">
          </label>
          <button type="button" class="secondary-btn" id="restoreIdentityConfirm">この情報で復元する</button>
        </div>
      </div>
    `;
    document.getElementById("restoreIdentityBtn").addEventListener("click", () => {
      document.getElementById("identityRestoreBox").style.display = "block";
    });
    document.getElementById("restoreIdentityConfirm").addEventListener("click", () => {
      const nickname = document.getElementById("rNickname").value.trim();
      const key = document.getElementById("rKey").value.trim();
      if (!nickname || !key) {
        alert("ニックネームと管理キーの両方を入力してください。");
        return;
      }
      saveIdentity(nickname, key);
      renderIdentityBox();
    });
  }
}

/* ---------- 分類選択ボタン ---------- */
function setupTypeSelect(selectId, hiddenId, initial) {
  const wrap = document.getElementById(selectId);
  const hidden = document.getElementById(hiddenId);
  if (!wrap) return;
  const buttons = wrap.querySelectorAll("button");
  buttons.forEach((btn) => {
    if (initial && btn.dataset.type === initial) {
      btn.classList.add("active");
      hidden.value = initial;
    }
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      hidden.value = btn.dataset.type;
    });
  });
}

/* ---------- 投稿画面 ---------- */
function setupPostForm() {
  const form = document.getElementById("postForm");
  if (!form) return;

  renderIdentityBox();
  setupTypeSelect("typeSelect", "fCategory");

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();

    const title = document.getElementById("fTitle").value.trim();
    const category = document.getElementById("fCategory").value;
    const description = document.getElementById("fDescription").value.trim();
    const tagsRaw = document.getElementById("fTags").value.trim();
    const example = document.getElementById("fExample").value.trim();

    if (!title || !category || !description) {
      alert("タイトル・分類・説明は必須です。");
      return;
    }

    let identity = getIdentity();
    if (!identity) {
      const nicknameInput = document.getElementById("fNickname");
      const nickname = nicknameInput ? nicknameInput.value.trim() : "";
      if (!nickname) {
        alert("ニックネームを入力してください。");
        return;
      }
      identity = { nickname, managementKey: generateManagementKey() };
    }

    const tags = tagsRaw ? tagsRaw.split(/[,、]/).map((t) => t.trim()).filter(Boolean) : [];

    const submitBtn = form.querySelector(".submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "投稿しています…";

    try {
      const result = await apiCreate({
        title,
        category,
        tags,
        summary: makeSummary(description),
        description,
        example,
        author: identity.nickname,
        managementKey: identity.managementKey
      });

      if (!result.ok) {
        alert(result.error || "投稿に失敗しました。時間をおいて再度お試しください。");
        submitBtn.disabled = false;
        submitBtn.textContent = "投稿する";
        return;
      }

      // 初投稿の場合、ここで初めて識別情報を保存する
      saveIdentity(identity.nickname, identity.managementKey);

      form.style.display = "none";
      const successEl = document.getElementById("postSuccess");
      successEl.style.display = "block";
      successEl.innerHTML = `
        <div class="identity-current">
          <div>投稿が完了しました。</div>
          <div class="identity-key">投稿ID：<span class="mono">${escapeHtml(result.post.id)}</span></div>
          <div class="identity-key">管理キー：<span class="mono">${escapeHtml(identity.managementKey)}</span></div>
          <div class="identity-hint">編集・削除にはこのIDと管理キーが必要です。忘れないようにしてください。</div>
          <a class="submit-btn as-link" href="community-detail.html?id=${encodeURIComponent(result.post.id)}">投稿を見る</a>
        </div>
      `;
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。ネットワーク環境をご確認のうえ、再度お試しください。");
      submitBtn.disabled = false;
      submitBtn.textContent = "投稿する";
    }
  });
}

/* ---------- 編集・削除画面 ---------- */
function setupEditPage() {
  const lookupForm = document.getElementById("lookupForm");
  if (!lookupForm) return;

  const editArea = document.getElementById("editArea");
  const errorEl = document.getElementById("lookupError");
  let currentId = null;
  let currentKey = null;

  lookupForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorEl.style.display = "none";
    const id = document.getElementById("lId").value.trim();
    const key = document.getElementById("lKey").value.trim();

    const submitBtn = lookupForm.querySelector(".submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "確認しています…";

    try {
      const result = await apiLookup(id, key);
      submitBtn.disabled = false;
      submitBtn.textContent = "確認する";

      if (!result.ok) {
        errorEl.textContent = result.error || "確認できませんでした。";
        errorEl.style.display = "block";
        editArea.style.display = "none";
        return;
      }

      currentId = id;
      currentKey = key;
      lookupForm.style.display = "none";
      editArea.style.display = "block";
      populateEditForm(result.post);
    } catch (err) {
      console.error(err);
      submitBtn.disabled = false;
      submitBtn.textContent = "確認する";
      errorEl.textContent = "通信エラーが発生しました。時間をおいて再度お試しください。";
      errorEl.style.display = "block";
    }
  });

  function populateEditForm(post) {
    document.getElementById("eTitle").value = post.title;
    document.getElementById("eDescription").value = post.description;
    document.getElementById("eTags").value = (post.tags || []).join(", ");
    document.getElementById("eExample").value = post.example || "";
    setupTypeSelect("editTypeSelect", "eCategory", post.category);
  }

  const editForm = document.getElementById("editForm");
  editForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!currentId) return;

    const title = document.getElementById("eTitle").value.trim();
    const category = document.getElementById("eCategory").value;
    const description = document.getElementById("eDescription").value.trim();
    const tagsRaw = document.getElementById("eTags").value.trim();
    const example = document.getElementById("eExample").value.trim();

    if (!title || !category || !description) {
      alert("タイトル・分類・説明は必須です。");
      return;
    }

    const tags = tagsRaw ? tagsRaw.split(/[,、]/).map((t) => t.trim()).filter(Boolean) : [];
    const submitBtn = editForm.querySelector(".submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "更新しています…";

    try {
      const result = await apiUpdate(currentId, currentKey, {
        title,
        category,
        tags,
        summary: makeSummary(description),
        description,
        example
      });

      if (!result.ok) {
        alert(result.error || "更新に失敗しました。");
        submitBtn.disabled = false;
        submitBtn.textContent = "更新する";
        return;
      }

      alert("更新しました。");
      window.location.href = `community-detail.html?id=${encodeURIComponent(currentId)}`;
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。時間をおいて再度お試しください。");
      submitBtn.disabled = false;
      submitBtn.textContent = "更新する";
    }
  });

  const deleteBtn = document.getElementById("deleteBtn");
  const deleteConfirm = document.getElementById("deleteConfirm");
  deleteBtn.addEventListener("click", () => {
    deleteConfirm.style.display = "block";
  });
  document.getElementById("deleteConfirmNo").addEventListener("click", () => {
    deleteConfirm.style.display = "none";
  });
  document.getElementById("deleteConfirmYes").addEventListener("click", async () => {
    if (!currentId) return;
    const yesBtn = document.getElementById("deleteConfirmYes");
    yesBtn.disabled = true;
    yesBtn.textContent = "削除しています…";

    try {
      const result = await apiDelete(currentId, currentKey);
      if (!result.ok) {
        alert(result.error || "削除に失敗しました。");
        yesBtn.disabled = false;
        yesBtn.textContent = "削除する";
        return;
      }
      alert("削除しました。");
      window.location.href = "community.html";
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。時間をおいて再度お試しください。");
      yesBtn.disabled = false;
      yesBtn.textContent = "削除する";
    }
  });
}

/* ---------- 詳細ページ ---------- */
function renderCommunityDetail() {
  const container = document.getElementById("communityDetailContent");
  if (!container) return;

  const id = new URLSearchParams(window.location.search).get("id");
  const entry = findCommunityById(id);

  document.title = entry ? `${entry.title} | みんなのパラドックス` : "見つかりません | みんなのパラドックス";

  renderBreadcrumb([
    { label: "ホーム", href: "index.html" },
    { label: "みんなのパラドックス", href: "community.html" },
    { label: entry ? entry.title : "見つかりません" }
  ]);

  if (!entry) {
    container.innerHTML = `<div class="not-found">お探しの投稿は見つかりませんでした。</div>`;
    return;
  }

  container.innerHTML = `
    <div class="detail-card">
      <div class="detail-id">${escapeHtml(entry.id)}</div>
      <h1 class="detail-title">${escapeHtml(entry.title)}</h1>
      <div class="detail-meta">
        <span class="type-mark">${escapeHtml(entry.category)}</span>
        ${(entry.tags || []).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}
      </div>
      <div class="detail-summary">${escapeHtml(entry.summary)}</div>

      <div class="detail-block">
        <h2>詳細説明</h2>
        <p>${escapeHtml(entry.description || "")}</p>
      </div>

      ${entry.example ? `
      <div class="detail-block">
        <h2>具体例</h2>
        <p>${escapeHtml(entry.example)}</p>
      </div>` : ""}

      <div class="post-author-row">
        <span>投稿者：${escapeHtml(entry.author || "匿名")}</span>
        <span>投稿日：${escapeHtml(entry.createdAt || "")}</span>
      </div>
    </div>

    <button type="button" class="report-btn" id="reportToggleBtn">この投稿を通報</button>

    <div class="report-panel" id="reportPanel" style="display:none;">
      <h2>通報する</h2>
      <div class="report-target">
        <div>投稿ID：<span class="mono">${escapeHtml(entry.id)}</span></div>
        <div>タイトル：${escapeHtml(entry.title)}</div>
      </div>
      <label>通報理由<span class="req">必須</span>
        <select id="reportReason">
          <option value="スパム">スパム</option>
          <option value="誹謗中傷">誹謗中傷</option>
          <option value="著作権侵害">著作権侵害</option>
          <option value="不適切な内容">不適切な内容</option>
          <option value="その他">その他</option>
        </select>
      </label>
      <label>詳細（任意）
        <textarea id="reportDetail" rows="3" placeholder="具体的な状況があればご記入ください"></textarea>
      </label>
      <button type="button" class="submit-btn" id="reportSubmitBtn">送信する</button>
      <div class="report-done" id="reportDone" style="display:none;">通報を受け付けました。ご協力ありがとうございます。</div>
    </div>
  `;

  const toggleBtn = document.getElementById("reportToggleBtn");
  const panel = document.getElementById("reportPanel");
  toggleBtn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  document.getElementById("reportSubmitBtn").addEventListener("click", async () => {
    const reason = document.getElementById("reportReason").value;
    const detail = document.getElementById("reportDetail").value.trim();
    const submitBtn = document.getElementById("reportSubmitBtn");
    submitBtn.disabled = true;
    submitBtn.textContent = "送信しています…";

    try {
      await apiReport({ postId: entry.id, title: entry.title, reason, detail });
    } catch (err) {
      console.error(err);
      // 送信に失敗した場合でも利用者にはエラーで返さず、後で確認できるよう保存しておく
      try {
        const fallback = JSON.parse(localStorage.getItem(LS_REPORTS_FALLBACK) || "[]");
        fallback.push({ postId: entry.id, title: entry.title, reason, detail });
        localStorage.setItem(LS_REPORTS_FALLBACK, JSON.stringify(fallback));
      } catch (e2) { /* 何もしない */ }
    }

    document.getElementById("reportReason").disabled = true;
    document.getElementById("reportDetail").disabled = true;
    submitBtn.style.display = "none";
    document.getElementById("reportDone").style.display = "block";
  });
}

/* ---------- 初期化 ---------- */
async function initCommunity() {
  const isListPage = document.getElementById("communityEntryList");
  const isPostPage = document.getElementById("postForm");
  const isEditPage = document.getElementById("lookupForm");
  const isDetailPage = document.getElementById("communityDetailContent");

  // 投稿・編集ページは一覧データがなくても表示できるが、
  // 詳細・一覧ページの表示にはスプレッドシートからの取得が必要
  if (isListPage || isDetailPage) {
    const target = document.getElementById("communityEntryList") || document.getElementById("communityDetailContent");
    if (target) target.innerHTML = `<div class="not-found">読み込み中…</div>`;

    try {
      const result = await apiList();
      if (!result.ok) throw new Error(result.error || "取得に失敗しました");
      ALL_COMMUNITY_ENTRIES = result.posts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    } catch (err) {
      console.error(err);
      if (target) target.innerHTML = `<div class="not-found">データの読み込みに失敗しました。時間をおいて再度お試しください。</div>`;
      return;
    }
  }

  if (isListPage) {
    renderBreadcrumb([{ label: "ホーム", href: "index.html" }, { label: "みんなのパラドックス" }]);
    renderCommunityCategoryGroups();
    renderCommunityEntryList();
    setupCommunitySearch();
    setupCommunityClearFilter();
  }

  if (isPostPage) {
    renderBreadcrumb([
      { label: "ホーム", href: "index.html" },
      { label: "みんなのパラドックス", href: "community.html" },
      { label: "投稿する" }
    ]);
    setupPostForm();
  }

  if (isEditPage) {
    renderBreadcrumb([
      { label: "ホーム", href: "index.html" },
      { label: "みんなのパラドックス", href: "community.html" },
      { label: "編集・削除" }
    ]);
    setupEditPage();
  }

  if (isDetailPage) {
    renderCommunityDetail();
  }
}

document.addEventListener("DOMContentLoaded", initCommunity);
