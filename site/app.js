/* Парламент на живо – приложението в браузъра.
   Чете JSON файловете в ./data/, които GitHub Actions обновява от parliament.bg. */
(function () {
  "use strict";

  const CFG = Object.assign({ ntfyTopic: "", ntfyServer: "https://ntfy.sh", pollSeconds: 120 }, window.APP_CONFIG || {});
  const main = document.getElementById("main");
  const toastEl = document.getElementById("toast");

  // ---------- помощни ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const enc = encodeURIComponent;
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("pnz." + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("pnz." + k, JSON.stringify(v));
      } catch (e) {}
    },
  };
  const settings = Object.assign({ theme: "auto", font: 100, notify: false, scope: "followed" }, store.get("settings", {}));
  const follows = Object.assign({ parties: [], mps: [], topics: [] }, store.get("follows", {}));
  const saveSettings = () => store.set("settings", settings);
  const saveFollows = () => store.set("follows", follows);

  const VOTE = {
    y: { label: "За", long: "За" },
    n: { label: "Против", long: "Против" },
    a: { label: "Възд.", long: "Въздържал се" },
    x: { label: "Не гл.", long: "Не гласувал" },
  };
  const RES = { pass: "Прието", fail: "Неприето", q: "Квалифицирано мнозинство" };
  const MONTHS = ["януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"];
  const todayIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
  function fmtDate(iso) {
    if (!iso) return "";
    const t = todayIso();
    const y = new Date(Date.parse(t) - 864e5).toISOString().slice(0, 10);
    if (iso === t) return "Днес";
    if (iso === y) return "Вчера";
    const [Y, M, D] = iso.split("-").map(Number);
    return `${D} ${MONTHS[M - 1]} ${Y}`;
  }
  const pct = (v) => (v == null ? "–" : `${String(v).replace(".", ",")}%`);
  const initials = (name) => (name || "").split(" ").filter(Boolean).slice(0, 3).map((w) => w[0]).filter((_, i, a) => i === 0 || i === a.length - 1).join("");

  // ---------- данни ----------
  const D = { meta: null, ns: null, feed: [], byId: new Map(), mps: [], mpById: new Map(), parties: [], sessions: new Map(), hist: new Map() };

  async function getJson(url, fresh) {
    const res = await fetch(url, { cache: fresh ? "no-store" : "default" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  async function loadAll(fresh) {
    const meta = await getJson("data/meta.json", true);
    const ns = store.get("ns", null) && meta.ns.includes(store.get("ns", null)) ? store.get("ns", null) : meta.latestNs;
    const v = encodeURIComponent(meta.updatedAt);
    const [feed, mps, parties] = await Promise.all([
      getJson(`data/feed-${ns}.json?v=${v}`, fresh),
      getJson(`data/mps-${ns}.json?v=${v}`, fresh),
      getJson(`data/parties-${ns}.json?v=${v}`, fresh),
    ]);
    D.meta = meta;
    D.ns = ns;
    D.feed = feed;
    D.byId = new Map(feed.map((f) => [f.id, f]));
    D.mps = mps;
    D.mpById = new Map(mps.map((m) => [String(m.id), m]));
    D.parties = parties;
    D.hist.clear();
  }

  async function session(sten) {
    if (!D.sessions.has(sten)) D.sessions.set(sten, getJson(`data/votes/${sten}.json`));
    return D.sessions.get(sten);
  }
  async function history(id) {
    if (!D.hist.has(id)) D.hist.set(id, getJson(`data/mp/${D.ns}/${id}.json?v=${enc(D.meta.updatedAt)}`));
    return D.hist.get(id);
  }
  const topicName = (id) => (D.meta.topics.find((t) => t.id === id) || { name: "Друго" }).name;
  const partyOrder = () => D.parties.map((p) => p.name);

  // ---------- малки компоненти ----------
  const resBadge = (f) => `<span class="res res-${f.res}" title="${esc(f.note || "Изчислено от поименните данни")}">${RES[f.res] || ""}</span>`;
  const vchip = (c, long) => `<span class="vchip ${c}">${(long ? VOTE[c].long : VOTE[c].label)}</span>`;
  function bar(t) {
    const total = t[0] + t[1] + t[2] + t[3] || 1;
    const w = (n) => ((n / total) * 100).toFixed(2);
    return `<div class="bar" role="img" aria-label="За ${t[0]}, против ${t[1]}, въздържал се ${t[2]}, не гласували ${t[3]}"><span class="y" style="width:${w(t[0])}%"></span><span class="n" style="width:${w(t[1])}%"></span><span class="a" style="width:${w(t[2])}%"></span></div>`;
  }
  const totals = (t) =>
    `<div class="totals num"><span class="t-y">За <b>${t[0]}</b></span><span class="t-n">Против <b>${t[1]}</b></span><span class="t-a">Въздържал се <b>${t[2]}</b></span><span class="muted">Не гласували <b>${t[3]}</b></span></div>`;
  const partyDissent = (c) => (c[4] ? c[0] + c[1] + c[2] - c[{ y: 0, n: 1, a: 2 }[c[4]]] : 0);
  const sortedParties = (p) => {
    const order = partyOrder();
    return Object.entries(p).sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  };
  function partyTable(f, withLinks) {
    const rows = sortedParties(f.p)
      .map(([name, c]) => {
        const d = partyDissent(c);
        const hi = (i) => (c[4] && { y: 0, n: 1, a: 2 }[c[4]] === i ? ' class="hi"' : "");
        const nm = withLinks ? `<a href="#/party/${enc(name)}">${esc(name)}</a>` : esc(name);
        return `<tr><td class="party">${nm}</td><td${hi(0)}>${c[0]}</td><td${hi(1)}>${c[1]}</td><td${hi(2)}>${c[2]}</td><td class="muted">${c[3]}</td><td>${d ? `<span class="dis">${d}</span>` : "–"}</td></tr>`;
      })
      .join("");
    return `<div class="ptable-wrap"><table class="ptable"><thead><tr><th scope="col">Група</th><th scope="col">За</th><th scope="col">Против</th><th scope="col">Възд.</th><th scope="col">Не гл.</th><th scope="col" title="Гласували различно от мнозинството в групата си">Различно</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function voteCard(f) {
    const split = f.d ? `<span class="split-note">${f.d} ${f.d === 1 ? "депутат гласува" : "депутати гласуваха"} различно от групата си</span>` : "";
    return `<a class="vcard" href="#/v/${f.id}">
      <span class="vcard-meta"><span class="num">${esc(f.time || "")}</span><span>${esc(topicName(f.topic))}</span>${resBadge(f)}</span>
      <span class="vcard-title">${esc(f.title)}</span>
      ${f.stage ? `<span class="stage">${esc(f.stage)}</span>` : ""}
      ${bar(f.t)}${totals(f.t)}
      ${partyTable(f, false)}
      ${split}
    </a>`;
  }
  const isFollowed = (kind, id) => follows[kind].includes(String(id));
  const followBtn = (kind, id, label) => {
    const on = isFollowed(kind, id);
    return `<button class="star" type="button" data-act="follow" data-kind="${kind}" data-id="${esc(id)}" aria-pressed="${on}">${on ? "Следваш" : "Следвай"}${label ? ` <span class="sr">${esc(label)}</span>` : ""}</button>`;
  };
  function avatar(m, big) {
    const cls = `avatar${big ? " big" : ""}`;
    if (!m.photo) return `<span class="${cls}" aria-hidden="true">${esc(initials(m.name))}</span>`;
    return `<img class="${cls}" src="${esc(m.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initials="${esc(initials(m.name))}">`;
  }

  // ---------- полукръг на залата ----------
  const seatCache = new Map();
  function seats(N) {
    if (seatCache.has(N)) return seatCache.get(N);
    const rows = N > 180 ? 9 : N > 100 ? 7 : 5;
    const r0 = 0.38;
    const radii = Array.from({ length: rows }, (_, i) => r0 + ((1 - r0) * i) / (rows - 1));
    const sum = radii.reduce((a, b) => a + b, 0);
    let counts = radii.map((r) => Math.floor((N * r) / sum));
    let rest = N - counts.reduce((a, b) => a + b, 0);
    for (let i = rows - 1; rest > 0; i = (i - 1 + rows) % rows, rest--) counts[i]++;
    const R = 195, cx = 200, cy = 205;
    const pts = [];
    radii.forEach((r, i) => {
      const k = counts[i];
      for (let j = 0; j < k; j++) {
        const th = k === 1 ? Math.PI / 2 : Math.PI - (j * Math.PI) / (k - 1);
        pts.push({ x: cx + R * r * Math.cos(th), y: cy - R * r * Math.sin(th), th, r });
      }
    });
    pts.sort((a, b) => b.th - a.th || a.r - b.r);
    const res = { pts, dot: ((R * (1 - r0)) / (rows - 1)) * 0.36 };
    seatCache.set(N, res);
    return res;
  }
  function hemicycle(s, idx) {
    const codes = s.items[idx].codes;
    const order = partyOrder();
    const list = s.mpOrder.map((id, i) => ({ id, name: s.mps[id][0], party: s.mps[id][1], c: codes[i] || "x" }));
    const rank = { y: 0, a: 1, n: 2, x: 3 };
    list.sort((a, b) => {
      const pa = order.indexOf(a.party), pb = order.indexOf(b.party);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || rank[a.c] - rank[b.c] || a.name.localeCompare(b.name, "bg");
    });
    const { pts, dot } = seats(list.length);
    const circles = list
      .map((m, i) => {
        const p = pts[i];
        return `<a href="#/mp/${m.id}" aria-label="${esc(m.name)}, ${esc(m.party)}: ${VOTE[m.c].long}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${dot.toFixed(2)}" class="s-${m.c}"><title>${esc(m.name)} (${esc(m.party)}): ${VOTE[m.c].long}</title></circle></a>`;
      })
      .join("");
    const groups = [];
    list.forEach((m) => {
      const g = groups[groups.length - 1];
      if (!g || g.name !== m.party) groups.push({ name: m.party, n: 1 });
      else g.n++;
    });
    return `<svg class="hemi" viewBox="0 0 400 212" role="group" aria-label="Залата: всяка точка е депутат">${circles}</svg>
      <div class="legend"><span><i class="s-y" style="background:var(--v-y)"></i>За</span><span><i style="background:var(--v-n)"></i>Против</span><span><i style="background:var(--v-a)"></i>Въздържал се</span><span><i style="background:var(--v-x)"></i>Не гласувал</span></div>
      <p class="small muted" style="text-align:center;margin:0">Групите отляво надясно: ${groups.map((g) => esc(g.name)).join(", ")}. Докосни точка, за да видиш депутата.</p>`;
  }

  // ---------- изгледи ----------
  const ui = { q: "", topic: "all", splitOnly: false, hideProc: false, limit: 40, mpQ: "", mpParty: "all", mpSort: "name", histTab: null, histLimit: 50, partyTab: "all" };

  function feedView() {
    const q = ui.q.trim().toLowerCase();
    let items = D.feed.filter(
      (f) =>
        (ui.topic === "all" || f.topic === ui.topic) &&
        (!ui.splitOnly || f.d > 0) &&
        (!ui.hideProc || f.topic !== "procedure") &&
        (!q || f.title.toLowerCase().includes(q)),
    );
    const total = items.length;
    items = items.slice(0, ui.limit);
    let lastDay = "";
    const list = items
      .map((f) => {
        const head = f.date !== lastDay ? `<h2 class="day">${fmtDate(f.date)}</h2>` : "";
        lastDay = f.date;
        return head + voteCard(f);
      })
      .join("");
    const topics = [{ id: "all", name: "Всички" }].concat(D.meta.topics.filter((t) => D.feed.some((f) => f.topic === t.id)));
    return `
      <div class="page-head"><h1>Последни гласувания</h1><p>${D.ns}-о Народно събрание. Обновено ${new Date(D.meta.updatedAt).toLocaleString("bg-BG", { timeZone: "Europe/Sofia", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}.</p></div>
      <div class="controls">
        <label class="sr" for="q">Търсене</label>
        <input id="q" class="search" type="search" placeholder="Търси в заглавията, напр. „бюджет“" value="${esc(ui.q)}" data-input="q">
        <div class="chips" role="group" aria-label="Тема">${topics.map((t) => `<button type="button" class="chip" data-act="topic" data-id="${t.id}" aria-pressed="${ui.topic === t.id}">${esc(t.name)}</button>`).join("")}</div>
        <div class="row">
          <label class="toggle"><input type="checkbox" data-check="splitOnly" ${ui.splitOnly ? "checked" : ""}> Само където депутати гласуваха различно от групата си</label>
          <label class="toggle"><input type="checkbox" data-check="hideProc" ${ui.hideProc ? "checked" : ""}> Скрий процедурните</label>
        </div>
      </div>
      ${list || `<p class="empty">Няма гласувания по тези филтри. Опитай с „Всички“ или изчисти търсенето.</p>`}
      ${total > ui.limit ? `<button class="more" type="button" data-act="more">Покажи още (${total - ui.limit})</button>` : ""}`;
  }

  async function voteView(id) {
    const f = D.byId.get(id);
    if (!f) return `<p class="empty">Това гласуване не е намерено. <a href="#/">Към всички гласувания</a></p>`;
    const s = await session(f.sten);
    const idx = s.items.findIndex((it) => it.item === f.item);
    const it = s.items[idx];
    // кой е гласувал различно от групата си
    const byParty = {};
    s.mpOrder.forEach((mpId, i) => {
      const c = it.codes[i] || "x";
      const party = s.mps[mpId][1];
      (byParty[party] = byParty[party] || []).push({ id: mpId, name: s.mps[mpId][0], c });
    });
    const dissenters = [];
    for (const [party, c] of sortedParties(f.p)) {
      if (!c[4]) continue;
      for (const m of byParty[party] || []) if (m.c !== "x" && m.c !== c[4]) dissenters.push({ ...m, party, maj: c[4] });
    }
    const dissHtml = dissenters.length
      ? `<ul class="mplist">${dissenters
          .map((m) => `<li><span class="grow"><a href="#/mp/${m.id}">${esc(m.name)}</a> <span class="small muted">${esc(m.party)}</span></span>${vchip(m.c, true)}<span class="small muted">групата: ${VOTE[m.maj].long.toLowerCase()}</span></li>`)
          .join("")}</ul>`
      : `<p class="muted" style="margin:0">Всички групи гласуваха единно.</p>`;
    const rank = { y: 0, n: 1, a: 2, x: 3 };
    const roll = sortedParties(f.p)
      .map(([party, c]) => {
        const ms = (byParty[party] || []).slice().sort((a, b) => rank[a.c] - rank[b.c] || a.name.localeCompare(b.name, "bg"));
        return `<details class="grp"><summary>${esc(party)} <span class="small muted num">за ${c[0]}, против ${c[1]}, въздържал се ${c[2]}, не гласували ${c[3]}</span></summary>
          <div class="names">${ms.map((m) => `<a href="#/mp/${m.id}"><span>${esc(m.name)}</span>${vchip(m.c)}</a>`).join("")}</div></details>`;
      })
      .join("");
    const same = D.feed.filter((x) => x.bill === f.bill && x.id !== f.id);
    const links = s.links || {};
    return `
      <div class="vhead">
        <div class="vcard-meta"><span>${fmtDate(f.date)}${f.time ? `, ${esc(f.time)}` : ""}</span><a href="#/topic/${f.topic}">${esc(topicName(f.topic))}</a>${f.stage ? `<span>${esc(f.stage)}</span>` : ""}</div>
        <h1>${esc(f.title)}</h1>
        <div class="row">${resBadge(f)}${f.note ? `<span class="small muted">${esc(f.note)}</span>` : ""}</div>
      </div>
      <section class="panel" aria-labelledby="h-hall"><h2 id="h-hall">Залата</h2>${hemicycle(s, idx)}
        <div class="stats"><div class="stat"><b class="t-y">${f.t[0]}</b><span>За</span></div><div class="stat"><b class="t-n">${f.t[1]}</b><span>Против</span></div><div class="stat"><b class="t-a">${f.t[2]}</b><span>Въздържал се</span></div><div class="stat"><b class="muted">${f.t[3]}</b><span>Не гласували</span></div></div>
      </section>
      <section class="panel" aria-labelledby="h-parties"><h2 id="h-parties">По партии</h2>${partyTable(f, true)}
        <p class="small muted" style="margin:0">С удебелен шрифт е позицията на мнозинството в групата.</p></section>
      <section class="panel" aria-labelledby="h-dis"><h2 id="h-dis">Гласували различно от групата си${dissenters.length ? ` (${dissenters.length})` : ""}</h2>${dissHtml}</section>
      <section class="panel" aria-labelledby="h-roll"><h2 id="h-roll">Поименно</h2>${roll}</section>
      ${same.length ? `<section class="panel" aria-labelledby="h-same"><h2 id="h-same">Всички гласувания по „${esc(f.billLabel)}“</h2>${linkList(same)}<a href="#/bill/${enc(f.bill)}">Отвори законопроекта</a></section>` : ""}
      <section class="panel"><h2>Източник</h2><div class="row">${links.pdf ? `<a href="${esc(links.pdf)}" target="_blank" rel="noopener">Поименно гласуване (PDF)</a>` : ""}${links.csv ? `<a href="${esc(links.csv)}" target="_blank" rel="noopener">Данни (CSV)</a>` : ""}${links.page ? `<a href="${esc(links.page)}" target="_blank" rel="noopener">Стенограмата на parliament.bg</a>` : ""}</div></section>`;
  }

  function linkList(items) {
    return `<ul class="linklist">${items
      .map(
        (x) =>
          `<li><a href="#/v/${x.id}"><span><span class="lt">${esc(x.stage || x.title)}</span><span class="ls num">${fmtDate(x.date)}${x.time ? `, ${esc(x.time)}` : ""}. За ${x.t[0]}, против ${x.t[1]}, въздържал се ${x.t[2]}${x.d ? `. Различно от групата: ${x.d}` : ""}</span></span>${resBadge(x)}</a></li>`,
      )
      .join("")}</ul>`;
  }

  function billView(key) {
    const items = D.feed.filter((f) => f.bill === key);
    if (!items.length) return `<p class="empty">Няма гласувания по този законопроект. <a href="#/">Към всички гласувания</a></p>`;
    const sum = (i) => items.reduce((s, f) => s + f.t[i], 0);
    return `<div class="page-head"><h1>${esc(items[0].billLabel)}</h1><p>${items.length} гласувания, тема „${esc(topicName(items[0].topic))}“.</p></div>
      ${supportPanel(items, "Как гласува всяка група по този законопроект")}
      <section class="panel"><h2>Всички гласувания</h2>${linkList(items)}</section>
      <p class="small muted">Общо за всички гласувания: за ${sum(0)}, против ${sum(1)}, въздържал се ${sum(2)}.</p>`;
  }

  // дял „за“ от подадените гласове на всяка група за набор от гласувания
  function supportPanel(items, title) {
    const acc = {};
    for (const f of items)
      for (const [p, c] of Object.entries(f.p)) {
        acc[p] = acc[p] || [0, 0, 0];
        acc[p][0] += c[0];
        acc[p][1] += c[1];
        acc[p][2] += c[2];
      }
    const rows = sortedParties(acc)
      .map(([p, c]) => {
        const cast = c[0] + c[1] + c[2];
        const v = cast ? Math.round((c[0] / cast) * 100) : 0;
        return `<div class="meter"><a href="#/party/${enc(p)}">${esc(p)}</a><div class="track"><div class="fill" style="width:${v}%;background:var(--v-y)"></div></div><b>${v}%</b></div>`;
      })
      .join("");
    return `<section class="panel"><h2>${esc(title)}</h2><p class="small muted" style="margin:0">Дял на гласовете „за“ от всички подадени гласове на групата</p>${rows}</section>`;
  }

  function topicsView() {
    const rows = D.meta.topics
      .map((t) => {
        const items = D.feed.filter((f) => f.topic === t.id);
        if (!items.length) return "";
        const bills = new Set(items.map((f) => f.bill)).size;
        return `<li><a href="#/topic/${t.id}"><span><span class="lt">${esc(t.name)}</span><span class="ls">${items.length} гласувания по ${bills} ${bills === 1 ? "акт" : "акта"}. Последно: ${fmtDate(items[0].date)}</span></span>${isFollowed("topics", t.id) ? '<span class="small muted">Следваш</span>' : ""}</a></li>`;
      })
      .join("");
    return `<div class="page-head"><h1>Теми</h1><p>Гласуванията са разпределени по теми автоматично според заглавието им.</p></div><section class="panel"><ul class="linklist">${rows}</ul></section>`;
  }

  function topicView(id) {
    const items = D.feed.filter((f) => f.topic === id);
    const bills = [];
    const seen = new Map();
    for (const f of items) {
      if (!seen.has(f.bill)) {
        seen.set(f.bill, []);
        bills.push(f.bill);
      }
      seen.get(f.bill).push(f);
    }
    return `<div class="page-head"><div class="row spread"><h1>${esc(topicName(id))}</h1>${followBtn("topics", id)}</div><p>${items.length} гласувания по ${bills.length} акта.</p></div>
      ${items.length ? supportPanel(items, "Подкрепа по темата") : ""}
      ${bills
        .slice(0, 60)
        .map((b) => {
          const its = seen.get(b);
          return `<section class="panel"><h2><a href="#/bill/${enc(b)}">${esc(its[0].billLabel)}</a></h2>${linkList(its.slice(0, 8))}${its.length > 8 ? `<a href="#/bill/${enc(b)}">Всички ${its.length} гласувания</a>` : ""}</section>`;
        })
        .join("")}`;
  }

  function partiesView() {
    return `<div class="page-head"><h1>Партии</h1><p>Парламентарните групи в ${D.ns}-о Народно събрание.</p></div>
      <div class="grid-2">${D.parties
        .filter((p) => p.seats > 0 || p.items > 0)
        .map(
          (p) => `<section class="panel"><div class="row spread"><h2><a href="#/party/${enc(p.name)}">${esc(p.name)}</a></h2>${followBtn("parties", p.name)}</div>
          <div class="kv"><div class="stat"><b>${p.seats}</b><span>депутати</span></div><div class="stat"><b>${p.independent ? "–" : pct(p.cohesion)}</b><span>единство при гласуване</span></div><div class="stat"><b>${pct(p.attendance)}</b><span>участие в гласуванията</span></div><div class="stat"><b>${p.dissents}</b><span>гласа различно от групата</span></div></div></section>`,
        )
        .join("")}</div>
      <p class="small muted">Единство: средно какъв дял от гласувалите депутати на групата са гласували като мнозинството в нея.</p>`;
  }

  function partyView(name) {
    const p = D.parties.find((x) => x.name === name);
    if (!p) return `<p class="empty">Няма такава група. <a href="#/parties">Към партиите</a></p>`;
    const members = D.mps.filter((m) => m.party === name && m.current);
    const rebels = members.filter((m) => m.dissents > 0).sort((a, b) => b.dissents - a.dissents).slice(0, 10);
    const agree = Object.entries(p.agreement)
      .sort((a, b) => b[1] - a[1])
      .map(([q, v]) => `<div class="meter"><a href="#/party/${enc(q)}">${esc(q)}</a><div class="track"><div class="fill" style="width:${v}%"></div></div><b>${pct(Math.round(v))}</b></div>`)
      .join("");
    let votes = D.feed.filter((f) => f.p[name]);
    if (ui.partyTab === "split") votes = votes.filter((f) => partyDissent(f.p[name]) > 0);
    const shown = votes.slice(0, ui.limit);
    const vrows = shown
      .map((f) => {
        const c = f.p[name];
        const d = partyDissent(c);
        return `<li><a href="#/v/${f.id}"><span><span class="lt">${esc(f.title)}</span><span class="ls num">${fmtDate(f.date)}${f.time ? `, ${esc(f.time)}` : ""}. Групата: за ${c[0]}, против ${c[1]}, въздържал се ${c[2]}, не гласували ${c[3]}${d ? `. Различно: ${d}` : ""}</span></span>${c[4] ? vchip(c[4], true) : '<span class="vchip x">Разделени</span>'}</a></li>`;
      })
      .join("");
    return `<div class="page-head"><div class="row spread"><h1>${esc(name)}</h1>${followBtn("parties", name)}</div><p>${p.seats} депутати в момента.</p></div>
      <div class="kv"><div class="stat"><b>${p.independent ? "–" : pct(p.cohesion)}</b><span>единство</span></div><div class="stat"><b>${pct(p.attendance)}</b><span>участие</span></div><div class="stat"><b>${p.splits}</b><span>гласувания с разделени гласове</span></div><div class="stat"><b>${p.dissents}</b><span>гласа различно от групата</span></div></div>
      ${agree ? `<section class="panel"><h2>Колко често гласува като другите групи</h2><p class="small muted" style="margin:0">Дял от гласуванията, в които мнозинствата на двете групи са гласували еднакво</p>${agree}</section>` : ""}
      ${rebels.length ? `<section class="panel"><h2>Най-често гласуват различно от групата</h2><ul class="mplist">${rebels.map((m) => `<li>${avatar(m)}<span class="grow"><a href="#/mp/${m.id}">${esc(m.name)}</a></span><span class="num">${m.dissents} пъти</span></li>`).join("")}</ul></section>` : ""}
      <section class="panel"><h2>Гласувания на групата</h2>
        <div class="tabs" role="group" aria-label="Кои гласувания"><button type="button" class="chip" data-act="ptab" data-id="all" aria-pressed="${ui.partyTab === "all"}">Всички</button><button type="button" class="chip" data-act="ptab" data-id="split" aria-pressed="${ui.partyTab === "split"}">Само когато групата се раздели</button></div>
        ${vrows ? `<ul class="linklist">${vrows}</ul>` : `<p class="muted">Няма такива гласувания.</p>`}
        ${votes.length > ui.limit ? `<button class="more" type="button" data-act="more">Покажи още (${votes.length - ui.limit})</button>` : ""}
      </section>
      <section class="panel"><h2>Депутати (${members.length})</h2><ul class="mplist">${members.map((m) => mpRow(m)).join("")}</ul></section>`;
  }

  const mpRow = (m) =>
    `<li>${avatar(m)}<span class="grow"><a href="#/mp/${m.id}">${esc(m.name)}</a><br><span class="small muted">${esc(m.party)}${m.region ? `, ${esc(m.region)}` : ""}</span></span><span class="small num" title="участие / различно от групата">${pct(m.attendance)} участие<br>${m.dissents} различно</span>${followBtn("mps", m.id)}</li>`;

  function mpsView() {
    const q = ui.mpQ.trim().toLowerCase();
    let list = D.mps.filter((m) => m.current && (ui.mpParty === "all" || m.party === ui.mpParty) && (!q || m.name.toLowerCase().includes(q) || (m.region || "").toLowerCase().includes(q)));
    if (ui.mpSort === "att") list = list.slice().sort((a, b) => a.attendance - b.attendance);
    if (ui.mpSort === "dis") list = list.slice().sort((a, b) => b.dissents - a.dissents);
    return `<div class="page-head"><h1>Депутати</h1><p>${list.length} от ${D.mps.filter((m) => m.current).length}</p></div>
      <div class="controls">
        <label class="sr" for="mpq">Търси депутат</label><input id="mpq" class="search" type="search" placeholder="Име или избирателен район" value="${esc(ui.mpQ)}" data-input="mpQ">
        <div class="row">
          <label>Група <select class="sel" data-select="mpParty"><option value="all">Всички</option>${D.parties.map((p) => `<option ${ui.mpParty === p.name ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <label>Подреди <select class="sel" data-select="mpSort"><option value="name" ${ui.mpSort === "name" ? "selected" : ""}>по име</option><option value="att" ${ui.mpSort === "att" ? "selected" : ""}>най-малко участие</option><option value="dis" ${ui.mpSort === "dis" ? "selected" : ""}>най-често различно от групата</option></select></label>
        </div>
      </div>
      <section class="panel"><ul class="mplist">${list.map(mpRow).join("") || '<li class="muted">Няма такъв депутат.</li>'}</ul></section>`;
  }

  async function mpView(id) {
    const m = D.mpById.get(String(id));
    if (!m) return `<p class="empty">Няма такъв депутат в ${D.ns}-о Народно събрание. <a href="#/mps">Към депутатите</a></p>`;
    const h = await history(id);
    const dis = h.filter((x) => x.d);
    const tab = ui.histTab || (dis.length ? "dis" : "all");
    const list = tab === "dis" ? dis : h;
    const shown = list.slice(0, ui.histLimit);
    const rows = shown
      .map(
        (x) =>
          `<li><a href="#/v/${x.id}"><span><span class="lt">${esc(x.title)}</span><span class="ls num">${fmtDate(x.date)}${x.time ? `, ${esc(x.time)}` : ""}${x.m ? `. Групата: ${VOTE[x.m].long.toLowerCase()}` : ""}. ${RES[x.res] || ""}</span></span>${vchip(x.v, true)}</a></li>`,
      )
      .join("");
    return `<div class="row" style="gap:1rem;align-items:flex-start">${avatar(m, true)}<div class="page-head" style="flex:1;min-width:12rem"><h1>${esc(m.name)}</h1><p><a href="#/party/${enc(m.party)}">${esc(m.party)}</a>${m.region ? `, ${esc(m.region)}` : ""}${m.current ? "" : ". Вече не е депутат"}</p>${followBtn("mps", m.id)}</div></div>
      <div class="kv"><div class="stat"><b>${pct(m.attendance)}</b><span>участие в гласуванията</span></div><div class="stat"><b>${m.loyalty == null ? "–" : pct(m.loyalty)}</b><span>гласува като групата</span></div><div class="stat"><b>${m.dissents}</b><span>пъти различно от групата</span></div><div class="stat"><b class="num">${m.items}</b><span>гласувания общо</span></div></div>
      <div class="kv"><div class="stat"><b class="t-y">${m.y}</b><span>за</span></div><div class="stat"><b class="t-n">${m.n}</b><span>против</span></div><div class="stat"><b class="t-a">${m.a}</b><span>въздържал се</span></div><div class="stat"><b class="muted">${m.x}</b><span>не гласувал</span></div></div>
      <section class="panel"><h2>Как гласува</h2>
        <div class="tabs" role="group" aria-label="Кои гласувания"><button type="button" class="chip" data-act="htab" data-id="dis" aria-pressed="${tab === "dis"}">Различно от групата (${dis.length})</button><button type="button" class="chip" data-act="htab" data-id="all" aria-pressed="${tab === "all"}">Всички (${h.length})</button></div>
        ${rows ? `<ul class="linklist">${rows}</ul>` : `<p class="muted">${tab === "dis" ? "Винаги е гласувал(а) като мнозинството в групата." : "Няма гласувания."}</p>`}
        ${list.length > ui.histLimit ? `<button class="more" type="button" data-act="hmore">Покажи още (${list.length - ui.histLimit})</button>` : ""}
      </section>
      <p class="small"><a href="https://www.parliament.bg/bg/MP/${m.id}" target="_blank" rel="noopener">Профил на parliament.bg</a></p>`;
  }

  async function followingView() {
    const any = follows.parties.length + follows.mps.length + follows.topics.length;
    if (!any)
      return `<div class="page-head"><h1>Следвани</h1><p>Тук ще виждаш само това, което те интересува. Натисни „Следвай“ на партия, депутат или тема.</p></div>
        <div class="row"><a class="btn" style="display:inline-flex;align-items:center;text-decoration:none" href="#/parties">Избери партии</a><a class="btn secondary" style="display:inline-flex;align-items:center;text-decoration:none" href="#/mps">Избери депутати</a><a class="btn secondary" style="display:inline-flex;align-items:center;text-decoration:none" href="#/topics">Избери теми</a></div>`;
    const mpBlocks = await Promise.all(
      follows.mps.map(async (id) => {
        const m = D.mpById.get(String(id));
        if (!m) return "";
        const h = (await history(id)).slice(0, 5);
        return `<section class="panel"><div class="row spread"><h2><a href="#/mp/${m.id}">${esc(m.name)}</a></h2>${followBtn("mps", m.id)}</div><p class="small muted" style="margin:0">${esc(m.party)}. Участие ${pct(m.attendance)}, различно от групата ${m.dissents} пъти.</p>
          <ul class="linklist">${h.map((x) => `<li><a href="#/v/${x.id}"><span><span class="lt">${esc(x.title)}</span><span class="ls">${fmtDate(x.date)}${x.d ? ". Различно от групата" : ""}</span></span>${vchip(x.v, true)}</a></li>`).join("")}</ul></section>`;
      }),
    );
    const partyBlocks = follows.parties
      .map((name) => {
        const p = D.parties.find((x) => x.name === name);
        if (!p) return "";
        const votes = D.feed.filter((f) => f.p[name]).slice(0, 5);
        return `<section class="panel"><div class="row spread"><h2><a href="#/party/${enc(name)}">${esc(name)}</a></h2>${followBtn("parties", name)}</div>
          <ul class="linklist">${votes.map((f) => { const c = f.p[name]; return `<li><a href="#/v/${f.id}"><span><span class="lt">${esc(f.title)}</span><span class="ls num">за ${c[0]}, против ${c[1]}, въздържал се ${c[2]}, не гласували ${c[3]}</span></span>${c[4] ? vchip(c[4], true) : '<span class="vchip x">Разделени</span>'}</a></li>`; }).join("")}</ul></section>`;
      })
      .join("");
    const topicItems = D.feed.filter((f) => follows.topics.includes(f.topic)).slice(0, 10);
    return `<div class="page-head"><h1>Следвани</h1><p>Последните гласувания на това, което следваш.</p></div>
      ${partyBlocks}${mpBlocks.join("")}
      ${follows.topics.length ? `<section class="panel"><h2>По следваните теми: ${follows.topics.map((t) => `<a href="#/topic/${t}">${esc(topicName(t))}</a>`).join(", ")}</h2>${topicItems.length ? linkList(topicItems) : '<p class="muted">Още няма гласувания по тях.</p>'}</section>` : ""}`;
  }

  function settingsView() {
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    const ntfy = CFG.ntfyTopic
      ? `<p style="margin:0">Получавай известия и когато сайтът е затворен: инсталирай безплатното приложение <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a> (Android и iPhone) и се абонирай за темата <code>${esc(CFG.ntfyTopic)}</code>.</p><a class="btn secondary" style="display:inline-flex;align-items:center;text-decoration:none;align-self:flex-start" href="${esc(CFG.ntfyServer.replace(/\/$/, ""))}/${enc(CFG.ntfyTopic)}" target="_blank" rel="noopener">Отвори темата в ntfy</a>`
      : `<p class="small muted" style="margin:0">Известията при затворен сайт (ntfy) не са включени. Как се включват пише в README файла.</p>`;
    return `<div class="page-head"><h1>Настройки</h1></div>
      <section class="panel"><fieldset><legend>Тема</legend>
        ${[["auto", "Като устройството"], ["light", "Светла"], ["dark", "Тъмна"]].map(([v, l]) => `<label class="radio"><input type="radio" name="theme" value="${v}" data-set="theme" ${settings.theme === v ? "checked" : ""}> ${l}</label>`).join("")}
      </fieldset></section>
      <section class="panel"><label for="fs"><b>Размер на текста: <span id="fsv">${settings.font}%</span></b></label>
        <input id="fs" type="range" min="85" max="150" step="5" value="${settings.font}" data-set="font">
        <p class="muted" style="margin:0">Текстът се променя веднага, докато местиш плъзгача.</p></section>
      <section class="panel"><fieldset><legend>Известия, докато сайтът е отворен</legend>
        ${perm === "unsupported" ? '<p class="muted">Този браузър не поддържа известия.</p>' : `
        <label class="toggle"><input type="checkbox" data-set="notify" ${settings.notify && perm === "granted" ? "checked" : ""}> Известявай ме при нови гласувания</label>
        ${perm === "denied" ? '<p class="note">Известията са забранени в браузъра. Разреши ги от настройките на сайта в браузъра.</p>' : ""}
        <label class="radio"><input type="radio" name="scope" value="all" data-set="scope" ${settings.scope === "all" ? "checked" : ""}> За всяко ново гласуване</label>
        <label class="radio"><input type="radio" name="scope" value="followed" data-set="scope" ${settings.scope === "followed" ? "checked" : ""}> Само за следваните партии, депутати и теми</label>
        <button class="btn secondary" type="button" data-act="testnotify" style="align-self:flex-start">Изпрати пробно известие</button>`}
      </fieldset>
      <p class="small muted" style="margin:0">Проверявам за нови данни на всеки ${Math.round(CFG.pollSeconds / 60)} минути.</p></section>
      <section class="panel"><h2>Известия на телефона</h2>${ntfy}</section>
      ${D.meta.ns.length > 1 ? `<section class="panel"><label><b>Народно събрание</b> <select class="sel" data-set="ns">${D.meta.ns.map((n) => `<option value="${n}" ${n === D.ns ? "selected" : ""}>${n}-о</option>`).join("")}</select></label></section>` : ""}
      <section class="panel"><h2>За данните</h2>
        <p style="margin:0">Данните идват от поименните гласувания, които Народното събрание публикува на <a href="https://www.parliament.bg" target="_blank" rel="noopener">parliament.bg</a> след всяко заседание. Последно обновяване: ${new Date(D.meta.updatedAt).toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })}. Пленарни дни в базата: ${D.meta.sessions.filter((s) => s.ns === D.ns).length}.</p>
        <p class="small muted" style="margin:0">„Прието“ и „Неприето“ са изчислени от гласовете. Темите и групирането по законопроект са автоматични и понякога грешат.</p></section>`;
  }

  // ---------- маршрути ----------
  const routes = {
    "": feedView,
    v: voteView,
    bill: billView,
    topics: topicsView,
    topic: topicView,
    parties: partiesView,
    party: partyView,
    mps: mpsView,
    mp: mpView,
    following: followingView,
    settings: settingsView,
  };
  const navOf = { "": "feed", v: "feed", bill: "topics", topics: "topics", topic: "topics", parties: "parties", party: "parties", mps: "mps", mp: "mps", following: "following", settings: "settings" };
  let lastRoute = "";

  async function render(keepScroll) {
    const parts = location.hash.replace(/^#\/?/, "").split("/").map((s) => decodeURIComponent(s));
    const [name, arg] = parts;
    const view = routes[name] || feedView;
    const routeKey = location.hash;
    if (routeKey !== lastRoute) {
      ui.limit = 40;
      ui.histLimit = 50;
      ui.histTab = null;
      if (name !== "party") ui.partyTab = "all";
    }
    document.querySelectorAll("[data-nav]").forEach((a) => (a.dataset.nav === navOf[name || ""] ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    const y = window.scrollY;
    try {
      const html = await view(arg);
      if (location.hash !== routeKey) return; // докато зареждахме, потребителят е отишъл другаде
      main.innerHTML = html;
    } catch (e) {
      console.error(e);
      main.innerHTML = `<p class="empty">Тази страница не се зареди: ${esc(e.message)}. Провери връзката и опитай пак.</p>`;
    }
    const h1 = main.querySelector("h1");
    document.title = (h1 ? h1.textContent.trim().slice(0, 60) + " – " : "") + "Парламент на живо";
    if (keepScroll) window.scrollTo(0, y);
    else if (routeKey !== lastRoute) {
      window.scrollTo(0, 0);
      if (lastRoute) main.focus({ preventScroll: true });
    }
    lastRoute = routeKey;
    fixImages();
  }

  function fixImages() {
    main.querySelectorAll("img.avatar").forEach((img) => {
      img.addEventListener(
        "error",
        () => {
          const s = document.createElement("span");
          s.className = img.className;
          s.setAttribute("aria-hidden", "true");
          s.textContent = img.dataset.initials || "";
          img.replaceWith(s);
        },
        { once: true },
      );
    });
  }

  // ---------- събития ----------
  let inputTimer;
  main.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.input) {
      ui[t.dataset.input] = t.value;
      ui.limit = 40;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(async () => {
        const pos = t.selectionStart;
        await render(true);
        const again = main.querySelector(`[data-input="${t.dataset.input}"]`);
        if (again) {
          again.focus();
          try { again.setSelectionRange(pos, pos); } catch (err) {}
        }
      }, 250);
    }
    if (t.dataset.set === "font") {
      settings.font = Number(t.value);
      document.documentElement.style.setProperty("--fs", settings.font / 100);
      const v = document.getElementById("fsv");
      if (v) v.textContent = settings.font + "%";
      saveSettings();
    }
  });

  main.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.check) {
      ui[t.dataset.check] = t.checked;
      ui.limit = 40;
      render(true);
    }
    if (t.dataset.select) {
      ui[t.dataset.select] = t.value;
      render(true);
    }
    const k = t.dataset.set;
    if (k === "theme") {
      settings.theme = t.value;
      if (t.value === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t.value;
      saveSettings();
    }
    if (k === "scope") {
      settings.scope = t.value;
      saveSettings();
    }
    if (k === "notify") {
      if (t.checked) {
        const p = await Notification.requestPermission();
        settings.notify = p === "granted";
      } else settings.notify = false;
      saveSettings();
      render(true);
    }
    if (k === "ns") {
      store.set("ns", t.value);
      D.sessions.clear();
      await loadAll(false);
      render(true);
    }
  });

  main.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "topic") {
      ui.topic = b.dataset.id;
      ui.limit = 40;
      render(true);
    } else if (act === "more") {
      ui.limit += 40;
      render(true);
    } else if (act === "hmore") {
      ui.histLimit += 50;
      render(true);
    } else if (act === "htab") {
      ui.histTab = b.dataset.id;
      ui.histLimit = 50;
      render(true);
    } else if (act === "ptab") {
      ui.partyTab = b.dataset.id;
      ui.limit = 40;
      render(true);
    } else if (act === "follow") {
      e.preventDefault();
      const kind = b.dataset.kind;
      const id = String(b.dataset.id);
      const arr = follows[kind];
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(id);
      saveFollows();
      document.querySelectorAll(`[data-act="follow"][data-kind="${kind}"]`).forEach((x) => {
        if (String(x.dataset.id) !== id) return;
        const on = arr.includes(id);
        x.setAttribute("aria-pressed", on);
        x.firstChild.textContent = on ? "Следваш" : "Следвай";
      });
      toast(i >= 0 ? "Вече не следваш" : "Следваш. Ще го виждаш в „Следвани“.");
    } else if (act === "testnotify") {
      if (Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") return toast("Известията не са разрешени в браузъра.");
      }
      showNotification("Парламент на живо", "Известията работят. Ще получиш такова при ново гласуване.", "#/");
    }
  });

  window.addEventListener("hashchange", () => render(false));

  function toast(html, ms = 3500) {
    toastEl.innerHTML = html;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (toastEl.hidden = true), ms);
  }

  // ---------- нови гласувания и известия ----------
  async function showNotification(title, body, hash) {
    const url = location.pathname + hash;
    try {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (reg) return reg.showNotification(title, { body, icon: "icon.svg", badge: "icon.svg", data: { url }, tag: "pnz-" + hash });
    } catch (e) {}
    const n = new Notification(title, { body, icon: "icon.svg" });
    n.onclick = () => {
      window.focus();
      location.hash = hash;
    };
  }

  async function relevantMessages(items) {
    const msgs = [];
    const short = (f) => `${f.title.slice(0, 110)}${f.title.length > 110 ? "…" : ""}`;
    if (settings.scope === "all") {
      for (const f of items) msgs.push({ title: `${RES[f.res]}: за ${f.t[0]}, против ${f.t[1]}, въздържал се ${f.t[2]}`, body: short(f) + (f.d ? `\n${f.d} гласуваха различно от групата си` : ""), hash: `#/v/${f.id}` });
      return msgs;
    }
    for (const f of items) {
      if (follows.topics.includes(f.topic)) msgs.push({ title: `Тема „${topicName(f.topic)}“: ${RES[f.res].toLowerCase()}`, body: short(f), hash: `#/v/${f.id}` });
      for (const name of follows.parties) {
        const c = f.p[name];
        if (!c) continue;
        msgs.push({ title: `${name}: за ${c[0]}, против ${c[1]}, въздържал се ${c[2]}`, body: short(f), hash: `#/v/${f.id}` });
      }
    }
    if (follows.mps.length) {
      const stens = [...new Set(items.map((f) => f.sten))];
      for (const sten of stens) {
        const s = await session(sten);
        for (const id of follows.mps) {
          const i = s.mpOrder.indexOf(Number(id));
          if (i < 0) continue;
          for (const f of items.filter((x) => x.sten === sten)) {
            const it = s.items.find((x) => x.item === f.item);
            const c = it.codes[i] || "x";
            const maj = f.p[s.mps[id][1]]?.[4];
            const differs = c !== "x" && maj && maj !== c;
            msgs.push({ title: `${s.mps[id][0]}: ${VOTE[c].long.toLowerCase()}${differs ? " (различно от групата)" : ""}`, body: short(f), hash: `#/v/${f.id}` });
          }
        }
      }
    }
    return msgs;
  }

  async function checkUpdates() {
    if (!D.meta) return;
    let meta;
    try {
      meta = await getJson("data/meta.json", true);
    } catch (e) {
      return;
    }
    if (meta.updatedAt === D.meta.updatedAt) return;
    const before = new Set(D.feed.map((f) => f.id));
    D.sessions.clear();
    await loadAll(true);
    const fresh = D.feed.filter((f) => !before.has(f.id));
    if (!fresh.length) return;
    toast(`${fresh.length} ${fresh.length === 1 ? "ново гласуване" : "нови гласувания"}. <a href="#/">Виж</a>`, 8000);
    if (!location.hash || location.hash === "#/") render(true);
    if (settings.notify && "Notification" in window && Notification.permission === "granted") {
      const msgs = await relevantMessages(fresh);
      if (msgs.length > 4) showNotification(`${msgs.length} нови гласувания`, msgs.slice(0, 3).map((m) => m.title).join("\n"), "#/");
      else for (const m of msgs) showNotification(m.title, m.body, m.hash);
    }
  }

  // ---------- старт ----------
  async function start() {
    try {
      await loadAll(false);
    } catch (e) {
      main.innerHTML = `<div class="page-head"><h1>Още няма данни</h1><p>Сайтът работи, но данните от parliament.bg още не са изтеглени. Пусни „Update data“ в раздела Actions на GitHub хранилището и изчакай няколко минути.</p></div>`;
      return;
    }
    render(false);
    setInterval(checkUpdates, CFG.pollSeconds * 1000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && checkUpdates());
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  start();
})();
