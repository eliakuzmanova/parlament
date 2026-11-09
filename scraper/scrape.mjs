// Изтегля нови пленарни дни от parliament.bg и обновява данните на сайта.
//
//   node scraper/scrape.mjs                 – обикновено обновяване
//   node scraper/scrape.mjs --rebuild-only  – само преизчислява от вече изтеглените дни
//   START_ID=11100 node scraper/scrape.mjs  – откъде да започне при първо пускане
//
// parliament.bg няма списък на стенограмите. Всеки пленарен ден има стенограма
// с нарастващ номер (Pl_Sten_id), затова вървим напред, докато срещнем
// 30 поредни несъществуващи номера.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRollcall, parseGroups, prettyName } from "./parse.mjs";
import { buildSession, deriveAll } from "./derive.mjs";
import { notify } from "./notify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "site", "data");
const STATE = path.join(DATA, "state.json");
const API = "https://www.parliament.bg/api/v1";
const PUB = "https://www.parliament.bg";
const GAP_STOP = 30;
const MAX_SCAN = 600;
const PENDING_DAYS = 10;

const HEADERS = {
  "User-Agent": "parlament-na-zhivo (+https://github.com) Mozilla/5.0",
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "bg,en;q=0.7",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const abs = (u) => (u.startsWith("http") ? u : PUB + u);

async function get(url, as = "json") {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) {
        const text = await res.text();
        if (as === "text") return text;
        try {
          return JSON.parse(text);
        } catch {
          return null; // HTML вместо JSON = няма такъв номер
        }
      }
      if (res.status < 500) return null;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await sleep(800 * (attempt + 1));
  }
  return null;
}

const fetchSten = async (id) => {
  const s = await get(`${API}/pl-sten/${id}`);
  return s && s.Pl_Sten_id && s.Pl_Sten_date ? s : null;
};

const findFile = (sten, nameIncludes, ext) =>
  (sten.files || []).find((f) => (f.Pl_StenDname || "").includes(nameIncludes) && (f.Pl_StenDfile || "").toLowerCase().endsWith(ext));

// Връща true, ако денят има поименни данни и е записан.
async function processSten(sten) {
  const roll = findFile(sten, "Поименно", ".csv");
  if (!roll) return false;
  const grp = findFile(sten, "парламентарни групи", ".csv");
  const pdf = findFile(sten, "Поименно", ".pdf");
  const rows = parseRollcall(await get(abs(roll.Pl_StenDfile), "text"));
  if (!rows.length) return false;
  const groups = grp ? parseGroups((await get(abs(grp.Pl_StenDfile), "text")) || "") : { titles: {}, times: {} };
  const session = buildSession({
    sten,
    rows,
    groups,
    links: {
      csv: abs(roll.Pl_StenDfile),
      pdf: pdf ? abs(pdf.Pl_StenDfile) : null,
      groupsCsv: grp ? abs(grp.Pl_StenDfile) : null,
      page: `${PUB}/bg/plenaryst/ID/${sten.Pl_Sten_id}`,
    },
  });
  fs.mkdirSync(path.join(DATA, "votes"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "votes", `${sten.Pl_Sten_id}.json`), JSON.stringify(session));
  console.log(`  ✓ ${session.date} (стенограма ${sten.Pl_Sten_id}): ${session.items.length} гласувания`);
  return true;
}

async function fetchRoster() {
  const data = await get(`${API}/coll-list-ns/bg`);
  const list = data?.colListMP || [];
  const out = {};
  for (const m of list) {
    const id = m.A_ns_MP_id;
    if (!id) continue;
    const img = m.A_ns_MP_img;
    out[id] = {
      name: prettyName([m.A_ns_MPL_Name1, m.A_ns_MPL_Name2, m.A_ns_MPL_Name3].filter(Boolean).join(" ")),
      region: m.A_ns_Va_name || "",
      photo: !img ? undefined : /blank/i.test(img) ? "" : img.startsWith("http") ? img : img.startsWith("/") ? PUB + img : `${PUB}/images/Assembly/${img}`,
    };
  }
  return out;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const rebuildOnly = process.argv.includes("--rebuild-only");
  const state = readJson(STATE, { last: Number(process.env.START_ID || 11100), pending: [] });
  const before = new Set();
  const oldMeta = readJson(path.join(DATA, "meta.json"), null);
  if (oldMeta?.latestNs) for (const f of readJson(path.join(DATA, `feed-${oldMeta.latestNs}.json`), [])) before.add(f.id);

  let changed = rebuildOnly || !oldMeta;
  if (!rebuildOnly) {
    // 1) дни, за които файловете още не бяха публикувани
    const stillPending = [];
    for (const p of state.pending) {
      const sten = await fetchSten(p.id);
      const ok = sten ? await processSten(sten) : false;
      if (ok) changed = true;
      const age = (Date.now() - Date.parse(p.date)) / 864e5;
      if (!ok && age < PENDING_DAYS) stillPending.push(p);
      await sleep(200);
    }
    state.pending = stillPending;

    // 2) нови стенограми
    let gap = 0;
    for (let id = state.last + 1, n = 0; n < MAX_SCAN; id++, n++) {
      const sten = await fetchSten(id);
      await sleep(150);
      if (!sten) {
        if (++gap >= GAP_STOP) break;
        continue;
      }
      gap = 0;
      state.last = id;
      const ok = await processSten(sten);
      if (ok) changed = true;
      if (!ok) {
        const date = (sten.Pl_Sten_date || "").slice(0, 10);
        if ((Date.now() - Date.parse(date)) / 864e5 < PENDING_DAYS) state.pending.push({ id, date });
        console.log(`  … ${date} (стенограма ${id}): още няма поименни данни`);
      }
    }
  }

  let roster = readJson(path.join(DATA, "roster.json"), {});
  if (!rebuildOnly) {
    try {
      const fresh = await fetchRoster();
      if (Object.keys(fresh).length > 100 && JSON.stringify(fresh) !== JSON.stringify(roster)) {
        roster = fresh;
        changed = true;
        fs.writeFileSync(path.join(DATA, "roster.json"), JSON.stringify(roster));
      }
    } catch (e) {
      console.warn("Списъкът с депутати не се изтегли:", e.message);
    }
  }

  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  if (!changed) {
    console.log("Няма нови гласувания.");
    return;
  }
  const meta = deriveAll(DATA, roster);

  if (meta.latestNs && before.size) {
    const feed = readJson(path.join(DATA, `feed-${meta.latestNs}.json`), []);
    const fresh = feed.filter((f) => !before.has(f.id));
    if (fresh.length) await notify(fresh);
  }
  console.log(`Готово: ${meta.sessions.length} дни, последно Народно събрание: ${meta.latestNs}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
