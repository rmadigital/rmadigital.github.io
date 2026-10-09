/**
 * Solar Sprint · Google Apps Script (เก็บข้อมูลลง Google Sheet)
 *
 * วิธีใช้: Google Sheet → ส่วนขยาย → Apps Script → วางโค้ดนี้ทั้งหมด → Deploy เป็น Web app
 * (Execute as: Me, Who has access: Anyone) → เอาลิงก์ /exec กับ KIOSK_KEY ไปเข้ารหัสที่ tools/encode-config.html
 * แล้ววางค่าที่ได้ใน index.html ตรง const REMOTE_SECRET = "";
 *
 * เกม (index.html) ส่งคำสั่งมาที่นี่: ping, register, start, score, board, lookup, claim
 * หน้า result.html ดึงข้อมูลทั้งหมดด้วยคำสั่ง data (ต้องใช้ KIOSK_KEY)
 */

// ===== ตั้งค่า =====
// รหัสเครื่องบูธ: ใส่ให้ตรงกับช่อง "รหัสเครื่องบูธ (KIOSK_KEY)" ในเกม ใช้ตอนตรวจสิทธิ์/มอบรางวัล
const KIOSK_KEY = "1234";
// 1 เบอร์เล่นได้กี่รอบ (0 = ไม่จำกัด)
const ROUNDS_PER_PHONE = 0;
// =====================

const MAX_TOTAL = 1900; // คะแนนสูงสุดที่เป็นไปได้: แก้สำเร็จ 1000 + เวลาเหลือ 45 วิ × 20
const HOMES = ["small", "family", "large", "townhome", "shop", "garage"];
const PRIZE_LABEL = { first: "รางวัลที่ 1", consolation: "รางวัลปลอบใจ" };

const PLAYERS = "Players";
const ROUNDS = "Rounds";
const PLAYER_HEAD = [
  "token",
  "ชื่อ",
  "เบอร์โทร",
  "รหัสรับรางวัล",
  "รอบที่เล่นแล้ว",
  "คะแนนดีที่สุด",
  "ด่านที่ทำคะแนนดีที่สุด",
  "รางวัล",
  "ลงทะเบียนเมื่อ",
  "เล่นล่าสุดเมื่อ",
  "เครื่อง",
  "มอบรางวัลเมื่อ",
];
const ROUND_HEAD = [
  "เวลาที่เล่น",
  "ชื่อ",
  "เบอร์โทร",
  "ด่าน",
  "คะแนน",
  "แก้สำเร็จ",
  "รางวัล",
  "เวลาที่เหลือ (วิ)",
  "รหัสรับรางวัล",
];
// คอลัมน์ในแท็บ Players (เริ่มที่ 0)
const P = { token: 0, name: 1, phone: 2, code: 3, played: 4, best: 5, level: 6, prize: 7, first: 8, last: 9, device: 10, claimed: 11 };

// ---------- ทางเข้า ----------
// เกมที่เปิดจากไฟล์หรือเว็บอื่น ส่งมาแบบ POST (JSON เป็น text/plain)
function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json({ ok: false, error: "bad_request", message: "ข้อมูลที่ส่งมาไม่ถูกต้อง" });
  }
  return json(api(body));
}
// เปิดลิงก์ /exec ในเบราว์เซอร์: ถ้าอัปโหลด index.html ไว้ในโปรเจกต์นี้จะเปิดเกม ไม่งั้นแสดงสถานะ
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action) return json(api(p));
  if (hasGame())
    return HtmlService.createHtmlOutputFromFile("index")
      .setTitle("Solar Sprint · RMA Energy")
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return json(api({ action: "ping" }));
}
// เกมที่เปิดจาก Apps Script เอง เรียกผ่าน google.script.run.api(payload)
function api(req) {
  try {
    return Object.assign({ ok: true }, handle(req || {}));
  } catch (err) {
    return err.code
      ? { ok: false, error: err.code, message: err.message }
      : { ok: false, error: "server_error", message: String((err && err.message) || err) };
  }
}

function handle(req) {
  const kiosk = !!KIOSK_KEY && String(req.key || "") === KIOSK_KEY;
  switch (req.action) {
    case "ping":
      return { kiosk, playUrl: hasGame() ? ScriptApp.getService().getUrl() : "" };
    case "register":
      return withLock(() => register(req, kiosk));
    case "start":
      return withLock(() => start(req));
    case "score":
      return withLock(() => score(req));
    case "board":
      return board(null);
    case "data":
      if (!kiosk) throw fail("bad_key", "รหัสเครื่องบูธไม่ถูกต้อง");
      return exportData();
    case "lookup":
    case "claim":
      if (!kiosk) throw fail("bad_key", "รหัสเครื่องบูธไม่ถูกต้อง ตั้งค่าใหม่ในเมนูทีมงาน");
      return withLock(() => prizeDesk(req));
    default:
      throw fail("unknown_action", "ไม่รู้จักคำสั่งนี้");
  }
}

// ---------- คำสั่ง ----------
function register(req, kiosk) {
  const name = String(req.name || "").replace(/\s+/g, " ").trim();
  const phone = digits(req.phone);
  if (name.length < 2 || name.length > 30) throw fail("bad_name", "กรุณาใส่ชื่อ 2–30 ตัวอักษร");
  if (!/^0\d{8,9}$/.test(phone)) throw fail("bad_phone", "เบอร์โทรต้องขึ้นต้นด้วย 0 และมี 9–10 หลัก");
  if (!req.consent) throw fail("no_consent", "กรุณายอมรับเงื่อนไขการใช้ข้อมูลก่อนเริ่มเล่น");

  const sh = sheet(PLAYERS, PLAYER_HEAD);
  const found = findPlayer(sh, (r) => digits(r[P.phone]) === phone);
  const now = new Date();
  if (found) {
    const r = found.row;
    // เบอร์ที่ลงทะเบียนแล้ว: เครื่องบูธ หรือเครื่องเดิมที่มี token เดิม กลับมาเล่นต่อได้
    if (!kiosk && String(req.token || "") !== String(r[P.token]))
      throw fail("phone_taken", "เบอร์นี้ลงทะเบียนไปแล้ว ถ้าเป็นเบอร์ของคุณ ติดต่อทีมงานที่บูธ");
    sh.getRange(found.index, P.name + 1).setValue(name);
    return { token: String(r[P.token]), player: playerOut(r) };
  }
  const token = Utilities.getUuid();
  const row = [token, name, "'" + phone, "'" + newCode(sh), 0, "", "", "", now, "", String(req.device || ""), ""];
  sh.appendRow(row);
  return { token, player: playerOut(row) };
}

function start(req) {
  const sh = sheet(PLAYERS, PLAYER_HEAD);
  const found = byToken(sh, req.token);
  if (roundsLeft(found.row) <= 0) throw fail("no_rounds_left", "เบอร์นี้ใช้สิทธิ์เล่นครบแล้ว แสดงรหัสรับรางวัลกับทีมงานได้เลย");
  const played = Number(found.row[P.played]) || 0;
  sh.getRange(found.index, P.played + 1).setValue(played + 1);
  found.row[P.played] = played + 1;
  return { player: playerOut(found.row) };
}

function score(req) {
  const sh = sheet(PLAYERS, PLAYER_HEAD);
  const found = byToken(sh, req.token);
  const r = found.row;
  const total = Math.round(Number(req.total));
  if (!(total >= 0 && total <= MAX_TOTAL)) throw fail("bad_request", "คะแนนไม่ถูกต้อง");
  const home = HOMES.indexOf(req.home) >= 0 ? req.home : String(req.home || "");
  const prize = PRIZE_LABEL[req.prize] || String(req.prize || "");
  const at = new Date(Number(req.at) || Date.now());

  sheet(ROUNDS, ROUND_HEAD).appendRow([
    at,
    r[P.name],
    "'" + digits(r[P.phone]),
    home,
    total,
    req.passed ? "ใช่" : "ไม่",
    prize,
    Math.round((Number(req.remaining) || 0) * 10) / 10,
    "'" + String(r[P.code]),
  ]);
  // เก็บคะแนนดีที่สุดของคนนี้ไว้ในแท็บ Players
  const best = Number(r[P.best]);
  if (r[P.best] === "" || total > best) {
    sh.getRange(found.index, P.best + 1, 1, 3).setValues([[total, home, prize]]);
  }
  sh.getRange(found.index, P.last + 1).setValue(new Date());
  return Object.assign({ round: { total, adjusted: false } }, board(digits(r[P.phone])));
}

function prizeDesk(req) {
  const code = digits(req.code);
  const sh = sheet(PLAYERS, PLAYER_HEAD);
  const found = findPlayer(sh, (r) => digits(r[P.code]) === code && code !== "");
  if (!found) throw fail("unknown_code", "ไม่พบรหัสรับรางวัลนี้");
  const r = found.row;
  let already = false;
  if (req.action === "claim") {
    if (r[P.best] === "") throw fail("no_score", "ผู้เล่นนี้ยังเล่นไม่จบรอบ");
    if (r[P.claimed]) already = true;
    else {
      r[P.claimed] = new Date();
      sh.getRange(found.index, P.claimed + 1).setValue(r[P.claimed]);
    }
  }
  const out = playerOut(r);
  out.name = String(r[P.name]);
  out.phone = formatPhone(digits(r[P.phone]));
  out.claimedAt = r[P.claimed] ? new Date(r[P.claimed]).getTime() : null;
  return { player: out, already };
}

// ข้อมูลทั้งหมดสำหรับหน้า result.html (มีเบอร์โทรเต็ม จึงต้องใช้ KIOSK_KEY)
function exportData() {
  const time = (v) => (v ? new Date(v).getTime() : null);
  const plays = rows(sheet(ROUNDS, ROUND_HEAD))
    .filter((r) => digits(r[2]))
    .map((r) => ({
      at: time(r[0]),
      name: String(r[1]),
      phone: digits(r[2]),
      home: String(r[3]),
      total: Number(r[4]) || 0,
      passed: r[5] === "ใช่" || r[5] === true,
      prize: String(r[6]),
      remaining: Number(r[7]) || 0,
      code: digits(r[8]),
    }));
  const players = rows(sheet(PLAYERS, PLAYER_HEAD))
    .filter((r) => digits(r[P.phone]))
    .map((r) => ({
      name: String(r[P.name]),
      phone: digits(r[P.phone]),
      code: digits(r[P.code]),
      started: Number(r[P.played]) || 0,
      first: time(r[P.first]),
      last: time(r[P.last]),
      device: String(r[P.device] || ""),
      claimedAt: time(r[P.claimed]),
    }));
  return { plays, players, updatedAt: Date.now() };
}

// ตารางคะแนนรวม: คะแนนดีที่สุดของแต่ละเบอร์ เรียงมากไปน้อย คะแนนเท่ากันให้คนที่ทำได้ก่อน
function board(myPhone) {
  const rounds = rows(sheet(ROUNDS, ROUND_HEAD));
  const best = {};
  rounds.forEach((r) => {
    const phone = digits(r[2]),
      total = Number(r[4]) || 0,
      at = new Date(r[0]).getTime();
    if (!phone) return;
    const cur = best[phone];
    if (!cur || total > cur.total || (total === cur.total && at < cur.at))
      best[phone] = { name: String(r[1]), phone, total, level: String(r[3]), at };
  });
  const all = Object.keys(best)
    .map((k) => best[k])
    .sort((a, b) => b.total - a.total || a.at - b.at);
  const rank = myPhone ? all.findIndex((p) => p.phone === myPhone) + 1 : 0;
  return {
    top: all.slice(0, 10).map((p) => ({
      name: p.name,
      phoneMasked: maskPhone(p.phone),
      total: p.total,
      level: p.level,
    })),
    players: all.length,
    rounds: rounds.length,
    me: { rank: rank || null },
    updatedAt: Date.now(),
  };
}

// ---------- ตัวช่วย ----------
function sheet(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows(sh) {
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, sh.getLastColumn()).getValues() : [];
}
function findPlayer(sh, test) {
  const data = rows(sh);
  for (let i = 0; i < data.length; i++) if (test(data[i])) return { row: data[i], index: i + 2 };
  return null;
}
function byToken(sh, token) {
  const found = token ? findPlayer(sh, (r) => String(r[P.token]) === String(token)) : null;
  if (!found) throw fail("unknown_player", "ไม่พบข้อมูลผู้เล่น ลงทะเบียนใหม่อีกครั้ง");
  return found;
}
function roundsLeft(r) {
  return ROUNDS_PER_PHONE > 0 ? Math.max(0, ROUNDS_PER_PHONE - (Number(r[P.played]) || 0)) : 99;
}
function playerOut(r) {
  return {
    code: String(r[P.code]).replace(/^'/, ""),
    roundsLeft: roundsLeft(r),
    best: r[P.best] === "" ? null : { total: Number(r[P.best]), level: String(r[P.level]), prize: String(r[P.prize]) },
  };
}
// รหัสรับรางวัล 4 หลัก ไม่ซ้ำกับคนอื่น
function newCode(sh) {
  const used = {};
  rows(sh).forEach((r) => (used[digits(r[P.code])] = true));
  for (let i = 0; i < 1000; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!used[c]) return c;
  }
  return String(Math.floor(10000 + Math.random() * 90000));
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail("busy", "ระบบกำลังบันทึกข้อมูลอื่น ลองใหม่อีกครั้ง");
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
function hasGame() {
  try {
    HtmlService.createTemplateFromFile("index");
    return true;
  } catch (e) {
    return false;
  }
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function digits(v) {
  return String(v == null ? "" : v).replace(/\D/g, "");
}
function maskPhone(p) {
  return p.length < 7 ? p : p.slice(0, 3) + "-xxx-" + p.slice(-4);
}
function formatPhone(p) {
  return p.length === 10 ? p.slice(0, 3) + "-" + p.slice(3, 6) + "-" + p.slice(6) : p.slice(0, 2) + "-" + p.slice(2, 5) + "-" + p.slice(5);
}

// กด ▶ Run ฟังก์ชันนี้ 1 ครั้งหลังวางโค้ด เพื่อสร้างแท็บและให้สิทธิ์สคริปต์
function setup() {
  sheet(PLAYERS, PLAYER_HEAD);
  sheet(ROUNDS, ROUND_HEAD);
}
