// Четене на CSV файловете, които parliament.bg прикачва към всяка стенограма.
//
// „Поименно гласуване“ (pv*.csv) – един ред за всеки депутат и всяко гласуване:
//   NAME       – име с главни букви
//   textbox7   – id на депутата
//   textbox8   – парламентарна група (кратко име)
//   textbox800 – номер на Народното събрание (напр. "52")
//   ITEM       – номер на гласуването в деня
//   textbox2   – вот: + за, - против, = въздържал се, 0 / О / П / Р – не е гласувал
//
// „Гласуване по парламентарни групи“ (gv*.csv) – първата колона съдържа
//   „Номер (7) ГЛАСУВАНЕ проведено на 08-05-2026 10:53 по тема <заглавие>“
//   Оттам вземаме заглавието и часа на всяко гласуване.
//
// Форматът е взет от отворения проект electionsbg (MIT), scripts/parliament/rollcall.

const VOTE_CODE = {
  "+": "y",
  "-": "n",
  "=": "a",
  "0": "x",
  "О": "x", // кирилско О – отсъства
  "O": "x",
  "П": "x",
  "Р": "x",
  "онлайн": "x",
  "": "x",
};

export const codeOf = (raw) => VOTE_CODE[(raw ?? "").trim()] ?? "x";

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// Пълен CSV парсер: кавички, удвоени кавички и нови редове в кавички.
export function parseCsv(text) {
  const src = stripBom(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function parseRollcall(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  const col = (n) => head.indexOf(n);
  const ix = {
    name: col("NAME"),
    id: col("textbox7"),
    party: col("textbox8"),
    ns: col("textbox800"),
    item: col("ITEM"),
    vote: col("textbox2"),
  };
  for (const k of ["name", "id", "party", "item", "vote"]) {
    if (ix[k] < 0) throw new Error(`Липсва колона ${k} в CSV (заглавия: ${head.join("|")})`);
  }
  const out = [];
  for (const r of rows.slice(1)) {
    const mpId = parseInt(r[ix.id], 10);
    const item = parseInt(r[ix.item], 10);
    if (!Number.isFinite(mpId) || !Number.isFinite(item)) continue;
    out.push({
      mpId,
      name: (r[ix.name] ?? "").trim(),
      party: (r[ix.party] ?? "").trim() || "Без група",
      ns: ix.ns >= 0 ? (r[ix.ns] ?? "").trim() : "",
      item,
      code: codeOf(r[ix.vote]),
    });
  }
  return out;
}

const HEAD_RE = /Номер\s*\(\s*(\d+)\s*\)\s*ГЛАСУВАНЕ/u;
const TIME_RE = /проведено\s+на\s+(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}:\d{2})/u;
const TOPIC_RE = /по\s+тема\s+([\s\S]+)$/u;

export function parseGroups(text) {
  const titles = {};
  const times = {};
  for (const r of parseCsv(text)) {
    const first = (r[0] ?? "").replace(/\s+/g, " ").trim();
    const h = HEAD_RE.exec(first);
    if (!h) continue;
    const item = h[1];
    const t = TIME_RE.exec(first);
    if (t && !times[item]) times[item] = t[4].padStart(5, "0");
    const m = TOPIC_RE.exec(first);
    if (m && !titles[item]) {
      const title = m[1].replace(/[\s.,;:-]+$/u, "").trim();
      if (title.length >= 4) titles[item] = title;
    }
  }
  return { titles, times };
}

// „АЙЛИН НУРИДИН ПЕХЛИВАНОВА“ → „Айлин Нуридин Пехливанова“
export const prettyName = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
