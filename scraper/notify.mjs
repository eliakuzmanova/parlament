// Известия чрез ntfy.sh – безплатна услуга за push известия.
// Всеки, който инсталира приложението ntfy (Android/iOS) и се абонира за темата,
// получава известие при нови гласувания. Темата се задава като тайна NTFY_TOPIC
// в GitHub, а SITE_URL е адресът на сайта (за да отвори гласуването при докосване).

const RES = { pass: "Прието", fail: "Неприето", q: "Квалифицирано мнозинство" };

export async function notify(items) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const top = items.slice(0, 8);
  const lines = top.map((f) => {
    const [y, n, a] = f.t;
    const split = f.d ? `, ${f.d} депутати гласуваха различно от групата си` : "";
    return `• ${RES[f.res] || ""}: ${f.title.slice(0, 140)} (за ${y}, против ${n}, въздържал се ${a}${split})`;
  });
  if (items.length > top.length) lines.push(`…и още ${items.length - top.length}`);
  const body = {
    topic,
    title: items.length === 1 ? "Ново гласуване в парламента" : `${items.length} нови гласувания в парламента`,
    message: lines.join("\n"),
    tags: ["classical_building"],
  };
  if (site) body.click = items.length === 1 ? `${site}/#/v/${items[0].id}` : `${site}/#/`;
  try {
    const res = await fetch(server, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    console.log(`Известие изпратено (${res.status})`);
  } catch (e) {
    console.warn("Известието не се изпрати:", e.message);
  }
}
