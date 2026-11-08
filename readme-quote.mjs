#!/usr/bin/env node
// README.md의 인용구 영역을 오늘의 문구(또는 지정한 uid의 인용구)로 바꾼다.
//
//   node readme-quote.mjs              오늘의 문구 (Raycast quote 확장기능과 같은 선택)
//   node readme-quote.mjs <block uid>  quotes.db에서 그 uid의 인용구
//
// 환경 변수: ROAM_TOKEN (오늘의 문구일 때 필수), ROAM_GRAPH (기본 chitacan),
//           TZ (날짜 기준, 워크플로에서는 Asia/Seoul),
//           TRIGGERED_BY (workflow_dispatch를 실행한 사람, 없으면 자동 실행으로 표시)

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DB_PATH = join(here, "quotes.db");
const README_PATH = join(here, "README.md");
const GRAPH = process.env.ROAM_GRAPH || "chitacan";
const MAX_ATTEMPTS = 5;
const START = "<!-- quote:start -->";
const END = "<!-- quote:end -->";

// ---- 아래 선택 로직은 raycast/extensions/quote의 src/db.ts, src/today.ts와 같아야 한다 ----

// MM-DD-YYYY (로컬 시간), Roam daily note uid와 같은 형식. utils.ts getToday()
function getToday(date = new Date()) {
  return ("0" + (date.getMonth() + 1)).slice(-2) + "-" + ("0" + date.getDate()).slice(-2) + "-" + date.getFullYear();
}

// FNV-1a: 같은 날은 항상 같은 인용구. db.ts hash()
function hash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// db.ts getQuoteOfDay()
function getQuoteOfDay(db, day, attempt = 0) {
  const { count } = db.prepare("SELECT count(*) AS count FROM quotes").get();
  if (!count) throw new Error("quotes.db가 비어 있습니다.");
  const offset = hash(attempt === 0 ? day : `${day}#${attempt}`) % count;
  return db.prepare("SELECT uid, raw_text FROM quotes ORDER BY uid LIMIT 1 OFFSET ?").get(offset);
}

// utils.ts getBlockString(): 블록 문자열, 그 uid의 블록이 없으면 null
async function getBlockString(uid) {
  const res = await fetch(`https://api.roamresearch.com/api/graph/${GRAPH}/pull`, {
    method: "POST",
    headers: {
      "X-Authorization": `Bearer ${process.env.ROAM_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ eid: `[:block/uid "${uid}"]`, selector: "[:block/string]" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Roam API ${res.status}: ${await res.text()}`);
  const { result } = await res.json();
  return result?.[":block/string"] ?? null;
}

// today.ts pickQuote(): Roam에서 지워진 인용구는 건너뛴다.
async function pickQuote(db, day) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const quote = getQuoteOfDay(db, day, attempt);
    if ((await getBlockString(quote.uid)) !== null) return quote;
  }
  throw new Error("Roam에 남아 있는 인용구를 찾지 못했습니다.");
}

// ---- 선택 로직 끝 ----

function getQuoteByUid(db, uid) {
  if (!/^[\w-]+$/.test(uid)) throw new Error(`올바른 block uid가 아닙니다: ${uid}`);
  const quote = db.prepare("SELECT uid, raw_text FROM quotes WHERE uid = ?").get(uid);
  if (!quote) throw new Error(`quotes.db에 ${uid} 인용구가 없습니다.`);
  return quote;
}

function render(quote, day, { picked, triggeredBy }) {
  const [mm, dd, yyyy] = day.split("-");
  const date = `${yyyy}-${mm}-${dd}`;
  const link = `[Roam](https://roamresearch.com/#/app/${GRAPH}/page/${quote.uid})`;
  const who = triggeredBy && `[${triggeredBy}](https://github.com/${triggeredBy})`;
  const source = !triggeredBy
    ? "🤖 매일 자동으로 선택된 오늘의 문구"
    : picked
      ? `✋ ${who}님이 workflow_dispatch로 실행한 오늘의 문구`
      : `✋ ${who}님이 workflow_dispatch로 추가한 인용구`;
  const body = quote.raw_text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${START}\n${body}\n\n<sub>${source} · ${date} · ${link}</sub>\n${END}`;
}

// 기존 인용구 영역은 지우고, 없으면 README 끝에 붙인다.
function updateReadme(block) {
  const readme = readFileSync(README_PATH, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END, start);
  const next =
    start !== -1 && end !== -1
      ? readme.slice(0, start) + block + readme.slice(end + END.length)
      : `${readme.trim() ? `${readme.trimEnd()}\n\n` : ""}${block}\n`;
  writeFileSync(README_PATH, next);
}

const uid = process.argv[2]?.trim();
const triggeredBy = process.env.TRIGGERED_BY?.trim() || undefined;
if (!uid && !process.env.ROAM_TOKEN) {
  console.error("ROAM_TOKEN이 없습니다 (.env 또는 secret 확인)");
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const day = getToday();
try {
  const quote = uid ? getQuoteByUid(db, uid) : await pickQuote(db, day);
  updateReadme(render(quote, day, { picked: !uid, triggeredBy }));
  console.log(`${day} ${quote.uid} → README.md`);
} finally {
  db.close();
}
