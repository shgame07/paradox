/**
 * ================================================================
 * みんなのパラドックス - スプレッドシート連携API (Google Apps Script)
 * ----------------------------------------------------------------
 * 使い方：
 * 1. Googleスプレッドシートを新規作成する
 * 2. 「拡張機能」→「Apps Script」を開く
 * 3. デフォルトの Code.gs の中身を全部消して、このファイルの内容を貼り付ける
 * 4. 上部の「デプロイ」→「新しいデプロイ」をクリック
 *    - 種類の選択：ウェブアプリ
 *    - 実行するユーザー：自分
 *    - アクセスできるユーザー：全員
 * 5. デプロイ後に表示される「ウェブアプリのURL」をコピーする
 *    （例：https://script.google.com/macros/s/XXXXXXX/exec）
 * 6. community.js の先頭にある API_URL にそのURLを貼り付ける
 *
 * シートは自動で作成されます（初回アクセス時に見出し行も自動生成）。
 * 「community」シート：投稿データ
 * 「reports」シート：通報データ
 * ================================================================
 */

const SHEET_NAME = "community";
const REPORT_SHEET_NAME = "reports";

// スプレッドシートの列の並び順（この順番で保存・読み込みされる）
const HEADERS = [
  "id", "title", "category", "tags", "summary",
  "description", "example", "author", "managementKey",
  "createdAt", "updatedAt"
];

/* ---------------------------------------------------------
   シート取得・初期化
   --------------------------------------------------------- */
function getCommunitySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function getReportSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REPORT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REPORT_SHEET_NAME);
    sheet.appendRow(["postId", "title", "reason", "detail", "reportedAt"]);
  }
  return sheet;
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/* ---------------------------------------------------------
   行 <-> オブジェクト 変換
   - managementKeyは一覧用の公開レスポンスには含めない
     （誰でも編集・削除できてしまうため）
   --------------------------------------------------------- */
function rowToObject_(row) {
  const obj = {};
  HEADERS.forEach((h, i) => {
    if (h === "tags") {
      obj[h] = row[i] ? String(row[i]).split(",").map((s) => s.trim()).filter(Boolean) : [];
    } else {
      obj[h] = row[i];
    }
  });
  return obj;
}

function readAllRows_() {
  const sheet = getCommunitySheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values
    .map((row, i) => ({ obj: rowToObject_(row), sheetRow: i + 2 }))
    .filter((r) => r.obj.id); // 空行は除外
}

function findRow_(id) {
  return readAllRows_().find((r) => r.obj.id === id) || null;
}

function nextId_() {
  const rows = readAllRows_();
  let max = 0;
  rows.forEach((r) => {
    const m = /^MP-(\d+)$/.exec(r.obj.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return "MP-" + String(max + 1).padStart(6, "0");
}

/* ---------------------------------------------------------
   共通レスポンス
   --------------------------------------------------------- */
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------
   GET: 一覧取得のみ（?action=list）
   --------------------------------------------------------- */
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || "list";

  if (action === "list") {
    const posts = readAllRows_().map((r) => {
      const copy = Object.assign({}, r.obj);
      delete copy.managementKey; // 公開データからは管理キーを除外
      return copy;
    });
    return jsonOut_({ ok: true, posts });
  }

  return jsonOut_({ ok: false, error: "unknown action" });
}

/* ---------------------------------------------------------
   POST: 投稿 / 本人確認 / 更新 / 削除 / 通報
   body（JSON文字列）の action で分岐する
   --------------------------------------------------------- */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: "リクエストの形式が不正です" });
  }

  const action = body.action;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    switch (action) {
      case "create": return jsonOut_(handleCreate_(body));
      case "lookup": return jsonOut_(handleLookup_(body));
      case "update": return jsonOut_(handleUpdate_(body));
      case "delete": return jsonOut_(handleDelete_(body));
      case "report": return jsonOut_(handleReport_(body));
      default: return jsonOut_({ ok: false, error: "unknown action" });
    }
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 投稿する ---------- */
function handleCreate_(body) {
  const post = body.post || {};
  if (!post.title || !post.category || !post.description || !post.managementKey || !post.author) {
    return { ok: false, error: "必須項目が不足しています" };
  }

  const sheet = getCommunitySheet_();
  const id = nextId_();
  const now = todayStr_();

  const row = [
    id,
    post.title,
    post.category,
    (post.tags || []).join(","),
    post.summary || "",
    post.description,
    post.example || "",
    post.author,
    post.managementKey,
    now,
    now
  ];
  sheet.appendRow(row);

  const publicPost = rowToObject_(row);
  delete publicPost.managementKey;
  return { ok: true, post: publicPost };
}

/* ---------- 本人確認（編集画面を開く前のチェック） ---------- */
function handleLookup_(body) {
  const { id, managementKey } = body;
  const found = findRow_(id);
  if (!found) return { ok: false, error: "その投稿IDは見つかりませんでした。" };
  if (!found.obj.managementKey || found.obj.managementKey !== managementKey) {
    return { ok: false, error: "投稿IDと管理キーの組み合わせが一致しませんでした。" };
  }
  const publicPost = Object.assign({}, found.obj);
  delete publicPost.managementKey;
  return { ok: true, post: publicPost };
}

/* ---------- 更新する ---------- */
function handleUpdate_(body) {
  const { id, managementKey, post } = body;
  if (!post || !post.title || !post.category || !post.description) {
    return { ok: false, error: "必須項目が不足しています" };
  }

  const sheet = getCommunitySheet_();
  const found = findRow_(id);
  if (!found) return { ok: false, error: "その投稿IDは見つかりませんでした。" };
  if (!found.obj.managementKey || found.obj.managementKey !== managementKey) {
    return { ok: false, error: "管理キーが一致しません。" };
  }

  const now = todayStr_();
  const updatedRow = [
    id,
    post.title,
    post.category,
    (post.tags || []).join(","),
    post.summary || "",
    post.description,
    post.example || "",
    found.obj.author,
    found.obj.managementKey,
    found.obj.createdAt,
    now
  ];
  sheet.getRange(found.sheetRow, 1, 1, HEADERS.length).setValues([updatedRow]);

  const publicPost = rowToObject_(updatedRow);
  delete publicPost.managementKey;
  return { ok: true, post: publicPost };
}

/* ---------- 削除する ---------- */
function handleDelete_(body) {
  const { id, managementKey } = body;
  const sheet = getCommunitySheet_();
  const found = findRow_(id);
  if (!found) return { ok: false, error: "その投稿IDは見つかりませんでした。" };
  if (!found.obj.managementKey || found.obj.managementKey !== managementKey) {
    return { ok: false, error: "管理キーが一致しません。" };
  }
  sheet.deleteRow(found.sheetRow);
  return { ok: true };
}

/* ---------- 通報する ---------- */
function handleReport_(body) {
  if (!body.postId || !body.reason) {
    return { ok: false, error: "必須項目が不足しています" };
  }
  const sheet = getReportSheet_();
  sheet.appendRow([
    body.postId,
    body.title || "",
    body.reason,
    body.detail || "",
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")
  ]);
  return { ok: true };
}
