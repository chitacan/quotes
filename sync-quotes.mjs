#!/usr/bin/env node
// Roam Research의 [[quotes]] 인용구를 전부 받아 SQLite에 저장한다.
//
//   node sync-quotes.mjs [db 경로]   (기본: 이 파일 옆의 quotes.db)
//
// 필요한 환경 변수 (.env): ROAM_TOKEN, 선택: ROAM_GRAPH (기본 chitacan)
// 쿼리는 Thunder Client의 `Roam Research / Quotes all (with ctime)`과 같다.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const TOKEN = process.env.ROAM_TOKEN;
const GRAPH = process.env.ROAM_GRAPH || "chitacan";
const DB_PATH = process.argv[2] || join(here, "quotes.db");

if (!TOKEN) {
  console.error("ROAM_TOKEN이 없습니다 (.env 확인)");
  process.exit(1);
}

// [[quotes]]를 참조하는 블록의 자식 중 "> "로 시작하는 블록.
// 레퍼런스 횟수: 집계가 0회인 인용구를 빼버리지 않도록 자기 자신(가중치 0)을 끼워 넣고
// (sum ?w) :with ?r 로 실제 참조(가중치 1)만 더한다.
const QUERY = `[:find ?child_uid ?child_text ?parent_uid ?order ?ctime (sum ?w)
 :with ?r
 :in $ % ?tag1
 :where
 [?block :block/refs ?block_tag1]
 [?block_tag1 :node/title ?tag1]
 (ancestor ?child ?block)
 [?parent :block/children ?child]
 [?parent :block/uid ?parent_uid]
 [?child :block/uid ?child_uid]
 [?child :block/order ?order]
 [?child :block/string ?child_text]
 [(clojure.string/starts-with? ?child_text "> ")]
 [?child :create/time ?ctime]
 (or-join [?child ?r ?w]
   (and [?r :block/refs ?child] [(ground 1) ?w])
   (and [(identity ?child) ?r] [(ground 0) ?w]))]`;

const RULES = "[[(ancestor ?child ?parent) [?parent :block/children ?child]]]";

// Roam API는 peer 서버로 redirect한다. fetch는 다른 호스트로 redirect할 때
// Authorization 헤더를 지우므로 직접 따라간다.
async function fetchFollowingRedirects(url, options, depth = 0) {
  const res = await fetch(url, { ...options, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`redirect ${res.status} without Location header`);
    if (depth >= 5) throw new Error("too many redirects");
    return fetchFollowingRedirects(new URL(location, url).toString(), options, depth + 1);
  }
  return res;
}

async function fetchQuotes() {
  const res = await fetchFollowingRedirects(
    `https://api.roamresearch.com/api/graph/${GRAPH}/q`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query: QUERY, args: [RULES, "quotes"] }),
    },
  );
  if (!res.ok) throw new Error(`Roam API ${res.status}: ${await res.text()}`);
  const { result } = await res.json();
  return result.map(([uid, text, parentUid, order, ctime, refs]) => ({
    uid,
    text,
    parentUid,
    order,
    ctime,
    refs,
  }));
}

async function roamPost(path, body) {
  const res = await fetchFollowingRedirects(`https://api.roamresearch.com/api/graph/${GRAPH}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Roam API ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

// 부모 블록, 그 위 블록(또는 페이지), 페이지 제목을 한꺼번에 가져온다.
async function fetchParents(parentUids) {
  const parents = new Map();
  const CHUNK = 200;
  for (let i = 0; i < parentUids.length; i += CHUNK) {
    const eids = parentUids
      .slice(i, i + CHUNK)
      .map((uid) => `[:block/uid ${JSON.stringify(uid)}]`)
      .join(" ");
    const result = await roamPost("pull-many", {
      eids: `[${eids}]`,
      selector: "[:block/uid :block/string {:block/page [:node/title]} {:block/_children [:block/string :node/title]}]",
    });
    for (const p of result ?? []) {
      if (!p) continue;
      const [above] = p[":block/_children"] ?? [];
      parents.set(p[":block/uid"], {
        text: p[":block/string"] ?? "",
        aboveText: above?.[":block/string"],
        aboveTitle: above?.[":node/title"],
        pageTitle: p[":block/page"]?.[":node/title"],
      });
    }
  }
  return parents;
}

// Readwise가 하이라이트 페이지에 만드는 머리말 블록. 출처는 그 페이지 제목이다.
const READWISE_HEADER = /^\s*(Highlights first synced by|New highlights added)\b/;

// 데일리 노트 템플릿의 섹션처럼 출처가 아닌 블록.
const NOT_SOURCES = new Set(["Quick Capture", "Timeblock", "Inbox", "Meeting"]);

// 출처 표시용 텍스트: [[quotes]] 태그를 걷어낸 본문. 출처가 아니면 "".
function sourceText(text) {
  if (!text || READWISE_HEADER.test(text)) return "";
  const s = toRawText(text.replace(/#\[\[quotes\]\]|\[\[quotes\]\]|(^|\s)#quotes(?=\s|$)/g, " "));
  return NOT_SOURCES.has(s) ? "" : s;
}

// 인용구의 출처: 부모 블록 → 그 위 블록(또는 페이지) → 부모가 속한 페이지 제목 순으로
// 처음 출처다운 것. 부모가 `#quotes`만 있는 블록이면 위로 올라가고,
// Readwise 하이라이트는 페이지 제목이 된다.
export function sourceOf(parent) {
  if (!parent) return "";
  if (READWISE_HEADER.test(parent.text) && parent.pageTitle) return parent.pageTitle;
  return sourceText(parent.text) || parent.aboveTitle || sourceText(parent.aboveText) || parent.pageTitle || "";
}

// Roam 문법을 걷어낸 본문.
export function toRawText(text) {
  let s = text;

  s = s.replace(/^>\s*/, ""); // 인용 표시
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1"); // 코드 블록
  s = s.replace(/\s*\(\[View Highlight\]\([^)]*\)\)/g, ""); // Readwise 하이라이트 링크
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // 이미지
  s = s.replace(/\{\{[^{}]*\}\}/g, ""); // {{embed: ...}}, {{[[TODO]]}} 등

  // [별칭](url | [[페이지]] | ((uid))) → 별칭
  s = s.replace(/\[([^\]]+)\]\((?:\(\([^)]*\)\)|\[\[[^\]]*\]\]|[^)]*)\)/g, "$1");

  // [[페이지]], #[[페이지]] → 페이지 (중첩은 안쪽부터)
  for (let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/#?\[\[([^[\]]*)\]\]/g, "$1");
  }
  s = s.replace(/(^|[\s(])#([^\s#[\](),.!?]+)/g, "$1$2"); // #태그 → 태그
  s = s.replace(/\(\([\w-]{9}\)\)/g, ""); // ((블록 참조))
  s = s.replace(/^([^\n:]+)::\s*/gm, "$1: "); // 속성:: 값

  // 강조: ^^하이라이트^^, **굵게**, __기울임__, ~~취소선~~, `코드`, $$수식$$
  s = s.replace(/\^\^([\s\S]+?)\^\^/g, "$1");
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
  s = s.replace(/__([\s\S]+?)__/g, "$1");
  s = s.replace(/~~([\s\S]+?)~~/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, "$1");

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function save(quotes) {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      uid         TEXT PRIMARY KEY,  -- 인용구 블록 uid
      text        TEXT NOT NULL,     -- Roam 원문
      raw_text    TEXT NOT NULL,     -- Roam 문법을 걷어낸 본문
      parent_uid  TEXT NOT NULL,     -- [[quotes]]를 참조하는 부모 블록 uid
      block_order INTEGER NOT NULL,  -- 부모 아래에서의 순서
      created_at  INTEGER NOT NULL,  -- :create/time (ms)
      ref_count   INTEGER NOT NULL,  -- 이 블록을 참조/embed한 블록 수
      synced_at   INTEGER NOT NULL,  -- 처음 저장된 시각 (ms)
      source      TEXT               -- 출처 (sourceOf 참고)
    );
    CREATE INDEX IF NOT EXISTS quotes_created_at ON quotes (created_at DESC);
  `);
  // source 컬럼이 생기기 전에 만든 DB
  const columns = db.prepare("PRAGMA table_info(quotes)").all().map((c) => c.name);
  if (!columns.includes("source")) db.exec("ALTER TABLE quotes ADD COLUMN source TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS quotes_source ON quotes (source)");

  // 새 uid는 추가하고, 이미 있는 uid는 text, raw_text, ref_count, source만 갱신한다.
  // Roam에서 지워진 인용구는 지우지 않고 남겨둔다.
  const upsert = db.prepare(`
    INSERT INTO quotes (uid, text, raw_text, parent_uid, block_order, created_at, ref_count, synced_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (uid) DO UPDATE SET
      text      = excluded.text,
      raw_text  = excluded.raw_text,
      ref_count = excluded.ref_count,
      source    = excluded.source
  `);
  const syncedAt = Date.now();

  db.exec("BEGIN");
  try {
    for (const q of quotes) {
      upsert.run(q.uid, q.text, toRawText(q.text), q.parentUid, q.order, q.ctime, q.refs, syncedAt, q.source);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
}

const quotes = [...new Map((await fetchQuotes()).map((q) => [q.uid, q])).values()];
const parents = await fetchParents([...new Set(quotes.map((q) => q.parentUid))]);
for (const q of quotes) q.source = sourceOf(parents.get(q.parentUid));
save(quotes);
console.log(`${quotes.length} quotes → ${DB_PATH}`);
