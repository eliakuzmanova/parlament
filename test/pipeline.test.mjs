import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRollcall, parseGroups, prettyName, parseCsv } from "../scraper/parse.mjs";
import { buildSession, deriveAll } from "../scraper/derive.mjs";
import { topicOf, billOf, resultOf, stageOf } from "../scraper/classify.mjs";

// Синтетичен ден във формата на parliament.bg (данните са измислени – само за теста).
const PARTIES = [["ГРУПА А", 100], ["ГРУПА Б", 80], ["ГРУПА В", 55], ["Независими", 5]];
export function fakeDay() {
  const head = "\uFEFFNAME,textbox7,textbox8,textbox800,ITEM,textbox2";
  const lines = [head];
  let id = 4000;
  const votes = { 1: () => "О", 2: (p, i) => (p === 0 ? (i === 3 ? "-" : "+") : p === 1 ? "-" : "="), 3: (p) => (p === 2 ? "+" : "О") };
  PARTIES.forEach(([party, n], p) => {
    for (let i = 0; i < n; i++, id++) {
      for (const item of [1, 2, 3]) lines.push(`ДЕПУТАТ${id} ИВАНОВ ПЕТРОВ,${id},${party},52,${item},${votes[item](p, i)}`);
    }
  });
  const groups = [
    "textbox3,textbox4",
    '"Номер (1) РЕГИСТРАЦИЯ проведено на 05-11-2026 09:01",x',
    '"Номер (2) ГЛАСУВАНЕ проведено на 05-11-2026 10:53 по тема Законопроект за изменение и допълнение на Закона за здравното осигуряване, № 52-654-01-12, внесен от Министерски съвет, първо гласуване",x',
    '"Номер (3) ГЛАСУВАНЕ проведено на 05-11-2026 11:20 по тема Процедурно предложение за удължаване на работното време",x',
  ].join("\r\n");
  return { roll: lines.join("\r\n"), groups };
}

test("CSV парсер с кавички и нови редове", () => {
  assert.deepEqual(parseCsv('a,"b, ""c""",d\r\n"x\ny",z'), [["a", 'b, "c"', "d"], ["x\ny", "z"]]);
});

test("поименно гласуване и заглавия", () => {
  const { roll, groups } = fakeDay();
  const rows = parseRollcall(roll);
  assert.equal(rows.length, 240 * 3);
  assert.equal(rows[0].code, "x");
  const g = parseGroups(groups);
  assert.equal(g.times["2"], "10:53");
  assert.match(g.titles["2"], /^Законопроект за изменение/);
  assert.equal(g.titles["1"], undefined);
});

test("класификация", () => {
  assert.equal(topicOf("Законопроект за изменение и допълнение на Закона за здравното осигуряване"), "health");
  assert.equal(topicOf("Процедурно предложение за удължаване на работното време"), "procedure");
  assert.equal(topicOf("Законопроект за ратифициране на Споразумението"), "foreign");
  assert.equal(billOf("Законопроект за енергетиката, № 52-554-01-3, второ гласуване").key, "52-554-01-3");
  assert.equal(billOf("Законопроект за енергетиката, първо гласуване").key, billOf("Законопроект за енергетиката, второ гласуване").key);
  assert.equal(stageOf("… второ гласуване – прегласуване"), "Второ четене, прегласуване");
  assert.equal(resultOf("Закон, върнат с вето", 120, 0, 0).res, "fail");
  assert.equal(resultOf("x", 10, 5, 4).res, "pass");
  assert.equal(prettyName("АЙЛИН НУРИДИН ПЕХЛИВАНОВА-ИВАНОВА"), "Айлин Нуридин Пехливанова-Иванова");
});

test("цял ден → файлове за сайта", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parl-"));
  const { roll, groups } = fakeDay();
  const s = buildSession({
    sten: { Pl_Sten_id: 11500, Pl_Sten_date: "2026-11-05 00:00:00" },
    rows: parseRollcall(roll),
    groups: parseGroups(groups),
    links: { csv: "x", pdf: null, groupsCsv: null, page: "x" },
  });
  assert.equal(s.items.length, 2, "регистрацията (№1) се пропуска");
  fs.mkdirSync(path.join(dir, "votes"));
  fs.writeFileSync(path.join(dir, "votes", "11500.json"), JSON.stringify(s));
  const meta = deriveAll(dir, {});
  assert.equal(meta.latestNs, "52");
  const feed = JSON.parse(fs.readFileSync(path.join(dir, "feed-52.json"), "utf8"));
  const v = feed.find((f) => f.item === 2);
  assert.deepEqual(v.t, [99, 81, 60, 0]);
  assert.deepEqual(v.p["ГРУПА А"], [99, 1, 0, 0, "y"]);
  assert.equal(v.d, 1, "един депутат от група А гласува различно");
  assert.equal(v.res, "fail", "99 за от 240 гласували не е мнозинство");
  assert.equal(v.topic, "health");
  const mps = JSON.parse(fs.readFileSync(path.join(dir, "mps-52.json"), "utf8"));
  assert.equal(mps.find((m) => m.id === 4003).dissents, 1);
  const parties = JSON.parse(fs.readFileSync(path.join(dir, "parties-52.json"), "utf8"));
  assert.equal(parties[0].name, "ГРУПА А");
  assert.equal(parties[0].seats, 100);
  assert.ok(parties[0].agreement["ГРУПА Б"] !== undefined);
  const hist = JSON.parse(fs.readFileSync(path.join(dir, "mp", "52", "4003.json"), "utf8"));
  assert.equal(hist.find((h) => h.id === "11500-2").d, 1);
});
