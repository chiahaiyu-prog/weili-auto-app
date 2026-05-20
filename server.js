import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("."));

app.get("/", (_, res) => res.sendFile(process.cwd() + "/index.html"));

const PORT = process.env.PORT || 3000;
const PILIO_URL = "https://www.pilio.idv.tw/lto/list.asp";

const pad = n => String(n).padStart(2, "0");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const uniq = arr => [...new Set(arr)];

function parseNumbers(text) {
  return (text.match(/\b\d{1,2}\b/g) || [])
    .map(Number)
    .filter(n => n >= 1 && n <= 38);
}

function parsePilioDraws(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, tr) => {
    const text = $(tr).text().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const nums = parseNumbers(text);

    if (nums.length >= 7) {
      const last7 = nums.slice(-7);
      const first = last7.slice(0, 6);
      const second = last7[6];

      if (uniq(first).length === 6 && second >= 1 && second <= 8) {
        rows.push({ first, second, raw: text });
      }
    }
  });

  const seen = new Set();
  return rows.filter(d => {
    const key = `${d.first.join("-")}|${d.second}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countMap(draws) {
  const m = {};
  for (let n = 1; n <= 38; n++) m[n] = 0;
  draws.forEach(d => d.first.forEach(n => m[n]++));
  return m;
}

function lastSeenMap(draws) {
  const m = {};
  for (let n = 1; n <= 38; n++) m[n] = 999;
  draws.forEach((d, i) => d.first.forEach(n => {
    if (m[n] === 999) m[n] = i;
  }));
  return m;
}

function tail(n) {
  return n % 10;
}

function pickByScore(history, mode) {
  const latest = history[0];
  const recent10 = history.slice(0, 10);
  const recent30 = history.slice(0, 30);
  const recent50 = history.slice(0, 50);

  const f10 = countMap(recent10);
  const f30 = countMap(recent30);
  const f50 = countMap(recent50);
  const all = countMap(history);
  const gap = lastSeenMap(history);

  const latestSet = new Set(latest.first);
  const latestTails = latest.first.map(tail);

  const score = {};
  for (let n = 1; n <= 38; n++) score[n] = 0;

  const similar = history.slice(1).filter(d =>
    d.first.filter(n => latestSet.has(n)).length >= 2
  );

  for (let n = 1; n <= 38; n++) {
    if (mode === "hot") score[n] = f10[n] * 3 + f30[n] * 2 + f50[n];
    if (mode === "cold") score[n] = gap[n] * 2 - f10[n] * 4;
    if (mode === "tail") score[n] = latestTails.includes(tail(n)) ? 20 + f30[n] : f30[n];
    if (mode === "repeat") score[n] = latestSet.has(n) ? -99 : f30[n] + all[n] * 0.2;
    if (mode === "similar") score[n] = similar.reduce((s, d) => s + (d.first.includes(n) ? 5 : 0), 0);
    if (mode === "mixed") {
      score[n] =
        f30[n] * 1.5 +
        f50[n] * 1.2 +
        all[n] * 0.1 +
        (f10[n] === 0 && gap[n] >= 8 ? 12 : 0) +
        (latestTails.includes(tail(n)) ? 5 : 0) -
        (f10[n] >= 3 ? 15 : 0);
    }
    if (mode === "reverse") {
      score[n] =
        (f10[n] === 0 ? 20 : 0) +
        (gap[n] >= 10 ? 12 : 0) -
        f10[n] * 5 +
        f50[n] * 0.5;
    }
  }

  const removeSet = new Set([
    ...latest.first,
    ...range(1, 38).filter(n => f10[n] >= 4)
  ]);

  let list = range(1, 38)
    .filter(n => !removeSet.has(n))
    .map(n => ({ n, score: score[n] }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.n);

  return balancePick(list);
}

function balancePick(list) {
  const low = list.filter(n => n <= 12);
  const mid = list.filter(n => n >= 13 && n <= 25);
  const high = list.filter(n => n >= 26);

  let pick = [
    low[0], low[1],
    mid[0], mid[1],
    high[0], high[1]
  ].filter(Boolean);

  for (const n of list) {
    if (pick.length >= 6) break;
    if (!pick.includes(n)) pick.push(n);
  }

  pick = uniq(pick).slice(0, 6);

  return pick.sort((a, b) => a - b);
}

function blindTest(draws, mode) {
  const results = [];
  const max = Math.min(50, draws.length - 5);

  for (let i = 0; i < max; i++) {
    const target = draws[i];
    const history = draws.slice(i + 1);
    if (history.length < 5) continue;

    const pick = pickByScore(history, mode);
    const hits = pick.filter(n => target.first.includes(n)).length;
    results.push(hits);
  }

  const total = results.length || 1;
  const avg = results.reduce((a, b) => a + b, 0) / total;

  const rate = x => Math.round((results.filter(h => h >= x).length / total) * 100);

  const distribution = {};
  for (let i = 0; i <= 6; i++) distribution[i] = results.filter(x => x === i).length;

  return {
    mode,
    total,
    averageHits: Number(avg.toFixed(2)),
    hit1Rate: rate(1),
    hit2Rate: rate(2),
    hit3Rate: rate(3),
    hit4Rate: rate(4),
    hit5Rate: rate(5),
    hit6Rate: rate(6),
    distribution
  };
}

function bestModel(draws) {
  const modes = ["hot", "cold", "tail", "repeat", "similar", "mixed", "reverse"];
  const tests = modes.map(m => blindTest(draws, m));

  return tests.sort((a, b) =>
    b.hit3Rate - a.hit3Rate ||
    b.hit4Rate - a.hit4Rate ||
    b.hit2Rate - a.hit2Rate ||
    b.averageHits - a.averageHits
  )[0];
}

function analyze(draws) {
  const best = bestModel(draws);
  const finalNumbers = pickByScore(draws, best.mode);
  const latest = draws[0];

  const secondCount = {};
  for (let n = 1; n <= 8; n++) secondCount[n] = 0;
  draws.slice(1).forEach(d => secondCount[d.second]++);

  return {
    mode: "多模型增強%版",
    bestModel: best.mode,
    latest: {
      first: latest.first.map(pad),
      second: pad(latest.second)
    },
    form: {
      numbers: finalNumbers.map(pad),
      oddEven:
        `${finalNumbers.filter(n => n % 2 === 1).length}單` +
        `${finalNumbers.filter(n => n % 2 === 0).length}雙`,
      sum: finalNumbers.reduce((a, b) => a + b, 0),
      low: finalNumbers.filter(n => n <= 12).length,
      mid: finalNumbers.filter(n => n >= 13 && n <= 25).length,
      high: finalNumbers.filter(n => n >= 26).length
    },
    backtest: best,
    secondArea: range(1, 8)
      .filter(n => n !== latest.second)
      .map(n => ({ number: pad(n), score: secondCount[n] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4),
    note: "增強版會自動選中3顆以上最高的模型，但不保證未來中獎。"
  };
}

app.get("/api/analyze", async (_, res) => {
  try {
    const html = await fetch(PILIO_URL, {
      headers: { "user-agent": "Mozilla/5.0 Lottery Analyzer" }
    }).then(r => {
      if (!r.ok) throw new Error(`Pilio fetch failed: ${r.status}`);
      return r.text();
    });

    const draws = parsePilioDraws(html);
    if (draws.length < 1) throw new Error("抓不到威力彩資料。");

    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, mode: "多模型增強%版" });
});

app.listen(PORT, () => {
  console.log(`Weili enhanced percent analyzer running on ${PORT}`);
});
