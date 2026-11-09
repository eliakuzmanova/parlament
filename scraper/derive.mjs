import fs from "node:fs";
import path from "node:path";
import { prettyName } from "./parse.mjs";
import { topicOf, stageOf, billOf, resultOf, TOPICS, OTHER } from "./classify.mjs";

const isIndependent = (p) => /незав|без група/i.test(p || "");

// Един пленарен ден → компактен файл votes/<стенограма>.json
// codes: по един символ за всеки депутат от mpOrder (y за, n против, a въздържал се, x не гласувал)
export function buildSession({ sten, rows, groups, links }) {
  const mpOrder = [...new Set(rows.map((r) => r.mpId))].sort((a, b) => a - b);
  const pos = new Map(mpOrder.map((id, i) => [id, i]));
  const mps = {};
  for (const r of rows) if (!mps[r.mpId]) mps[r.mpId] = [prettyName(r.name), r.party];
  const ns = rows.find((r) => r.ns)?.ns || "";
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item)) byItem.set(r.item, Array(mpOrder.length).fill("x"));
    byItem.get(r.item)[pos.get(r.mpId)] = r.code;
  }
  const items = [];
  for (const [item, arr] of [...byItem.entries()].sort((a, b) => a[0] - b[0])) {
    const title = groups.titles[String(item)] || "";
    const codes = arr.join("");
    const allAbsent = !/[yna]/.test(codes);
    // Номер 1 винаги е регистрацията за присъствие – не е гласуване.
    if (!title && (item === 1 || allAbsent)) continue;
    if (/регистрация/i.test(title) && item === 1) continue;
    items.push({ item, time: groups.times[String(item)] || "", title: title || `Гласуване № ${item}`, codes });
  }
  return {
    sten: sten.Pl_Sten_id,
    date: (sten.Pl_Sten_date || "").slice(0, 10),
    ns,
    links,
    mpOrder,
    mps,
    items,
  };
}

const VOTES = ["y", "n", "a", "x"];
const majority = (c) => {
  // мнозинството в групата сред подадените гласове; при равенство – няма ясна позиция
  const arr = [["y", c.y], ["n", c.n], ["a", c.a]].sort((p, q) => q[1] - p[1]);
  if (arr[0][1] === 0 || arr[0][1] === arr[1][1]) return null;
  return arr[0][0];
};

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

// Преизчислява всички файлове, които сайтът чете, от записаните дни.
export function deriveAll(dataDir, roster = {}) {
  const vdir = path.join(dataDir, "votes");
  const sessions = fs.existsSync(vdir)
    ? fs
        .readdirSync(vdir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(vdir, f), "utf8")))
    : [];
  sessions.sort((a, b) => (a.date + String(a.sten).padStart(8, "0")).localeCompare(b.date + String(b.sten).padStart(8, "0")));
  const nsList = [...new Set(sessions.map((s) => s.ns).filter(Boolean))].sort((a, b) => Number(a) - Number(b));

  for (const ns of nsList) {
    const ss = sessions.filter((s) => s.ns === ns);
    const feed = [];
    const mpInfo = {}; // id → име, група (последна), статистика
    const mpHist = {}; // id → история
    const partyAcc = {}; // група → натрупани стойности
    const agree = {}; // "А|Б" → [еднакво, общо]

    for (const s of ss) {
      for (const [id, [name, party]] of Object.entries(s.mps)) {
        mpInfo[id] = mpInfo[id] || { id: Number(id), items: 0, present: 0, y: 0, n: 0, a: 0, x: 0, dissents: 0, withLine: 0 };
        mpInfo[id].name = name;
        mpInfo[id].party = party;
        mpInfo[id].lastDate = s.date;
      }
      for (const it of s.items) {
        const per = {};
        const t = { y: 0, n: 0, a: 0, x: 0 };
        s.mpOrder.forEach((id, i) => {
          const c = it.codes[i] || "x";
          const party = s.mps[id][1];
          per[party] = per[party] || { y: 0, n: 0, a: 0, x: 0 };
          per[party][c]++;
          t[c]++;
        });
        const maj = {};
        for (const [p, c] of Object.entries(per)) maj[p] = isIndependent(p) ? null : majority(c);
        let dissent = 0;
        const id = `${s.sten}-${it.item}`;
        const { res, note } = resultOf(it.title, t.y, t.n, t.a);
        s.mpOrder.forEach((mpId, i) => {
          const c = it.codes[i] || "x";
          const party = s.mps[mpId][1];
          const m = maj[party];
          const d = c !== "x" && m && c !== m;
          if (d) dissent++;
          const info = mpInfo[mpId];
          info.items++;
          info[c]++;
          if (c !== "x") info.present++;
          if (c !== "x" && m) info.withLine++;
          if (d) info.dissents++;
          (mpHist[mpId] = mpHist[mpId] || []).push({ id, date: s.date, time: it.time, title: it.title, v: c, m, d: d ? 1 : 0, res });
        });
        const bill = billOf(it.title);
        feed.push({
          id,
          sten: s.sten,
          item: it.item,
          date: s.date,
          time: it.time,
          title: it.title,
          stage: stageOf(it.title),
          topic: topicOf(it.title),
          bill: bill.key,
          billLabel: bill.label,
          t: VOTES.map((v) => t[v]),
          p: Object.fromEntries(Object.entries(per).map(([p, c]) => [p, [c.y, c.n, c.a, c.x, maj[p]]])),
          d: dissent,
          res,
          note,
        });
        for (const [p, c] of Object.entries(per)) {
          const acc = (partyAcc[p] = partyAcc[p] || { cohesionSum: 0, cohesionN: 0, castSum: 0, totalSum: 0, splits: 0, items: 0 });
          const cast = c.y + c.n + c.a;
          acc.items++;
          acc.castSum += cast;
          acc.totalSum += cast + c.x;
          if (cast > 0) {
            acc.cohesionSum += Math.max(c.y, c.n, c.a) / cast;
            acc.cohesionN++;
          }
          if ([c.y, c.n, c.a].filter((v) => v > 0).length > 1) acc.splits++;
        }
        const ps = Object.keys(maj).filter((p) => maj[p]);
        for (const p of ps)
          for (const q of ps) {
            if (p >= q) continue;
            const k = `${p}|${q}`;
            agree[k] = agree[k] || [0, 0];
            agree[k][1]++;
            if (maj[p] === maj[q]) agree[k][0]++;
          }
      }
    }

    feed.reverse(); // най-новото първо
    writeJson(path.join(dataDir, `feed-${ns}.json`), feed);

    // депутати
    const lastDate = ss.length ? ss[ss.length - 1].date : "";
    const mps = Object.values(mpInfo).map((m) => {
      const r = roster[m.id] || {};
      return {
        id: m.id,
        name: r.name || m.name,
        party: m.party,
        region: r.region || "",
        photo: r.photo ?? `https://www.parliament.bg/images/Assembly/${m.id}.png`,
        current: m.lastDate === lastDate,
        items: m.items,
        y: m.y,
        n: m.n,
        a: m.a,
        x: m.x,
        dissents: m.dissents,
        attendance: m.items ? Math.round((m.present / m.items) * 1000) / 10 : 0,
        loyalty: m.withLine ? Math.round((1 - m.dissents / m.withLine) * 1000) / 10 : null,
      };
    });
    mps.sort((a, b) => a.name.localeCompare(b.name, "bg"));
    writeJson(path.join(dataDir, `mps-${ns}.json`), mps);
    for (const [id, h] of Object.entries(mpHist)) writeJson(path.join(dataDir, "mp", ns, `${id}.json`), h.reverse());

    // групи
    const current = mps.filter((m) => m.current);
    const parties = Object.entries(partyAcc).map(([name, acc]) => {
      const members = current.filter((m) => m.party === name);
      const agreement = {};
      for (const [k, [same, tot]] of Object.entries(agree)) {
        const [p, q] = k.split("|");
        if (p === name) agreement[q] = Math.round((same / tot) * 1000) / 10;
        if (q === name) agreement[p] = Math.round((same / tot) * 1000) / 10;
      }
      return {
        name,
        seats: members.length,
        independent: isIndependent(name),
        cohesion: acc.cohesionN ? Math.round((acc.cohesionSum / acc.cohesionN) * 1000) / 10 : null,
        attendance: acc.totalSum ? Math.round((acc.castSum / acc.totalSum) * 1000) / 10 : null,
        splits: acc.splits,
        items: acc.items,
        dissents: members.reduce((s, m) => s + m.dissents, 0),
        agreement,
      };
    });
    parties.sort((a, b) => b.seats - a.seats || a.name.localeCompare(b.name, "bg"));
    writeJson(path.join(dataDir, `parties-${ns}.json`), parties);
  }

  const meta = {
    updatedAt: new Date().toISOString(),
    ns: nsList,
    latestNs: nsList[nsList.length - 1] || null,
    sessions: sessions.map((s) => ({ sten: s.sten, date: s.date, ns: s.ns, items: s.items.length })),
    topics: [...TOPICS.map(({ id, name }) => ({ id, name })), OTHER],
  };
  writeJson(path.join(dataDir, "meta.json"), meta);
  return meta;
}
