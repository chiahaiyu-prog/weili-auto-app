import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static("."));

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/index.html");
});

const PORT = process.env.PORT || 3000;
const PILIO_URL = "https://www.pilio.idv.tw/lto/list.asp";

const pad = n => String(n).padStart(2, "0");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const uniq = arr => [...new Set(arr)];

function parseNumbers(text) {
  return (text.match(/\b\d{1,2}\b/g) || [])
    .map(x => Number(x))
    .filter(n => n >= 1 && n <= 38);
}

function normalizeText(html) {
  const $ = cheerio.load(html);
  return $("body")
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/\n+/g, "\n");
}

function parsePilioDraws(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, tr) => {
    const text = $(tr).text().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const nums = parseNumbers(text);

    const candidates = nums.filter(n => n >= 1 && n <= 38);

    if (candidates.length >= 7) {
      const last7 = candidates.slice(-7);
      const first = last7.slice(0, 6);
      const second = last7[6];

      if (
        first.length === 6 &&
        second >= 1 &&
        second <= 8 &&
        uniq(first).length === 6
      ) {
        rows.push({ first, second, raw: text });
      }
    }
  });

  if (rows.length < 3) {
    const text = normalizeText(html);
    const re = /(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})/g;

    let m;
    while ((m = re.exec(text))) {
      const seven = m.slice(1, 8).map(Number);
      const first = seven.slice(0, 6);
      const second = seven[6];

      if (
        first.every(n => n >= 1 && n <= 38) &&
        second >= 1 &&
        second <= 8 &&
        uniq(first).length === 6
      ) {
        rows.push({ first, second, raw: seven.map(pad).join(",") });
      }
    }
  }

  const seen = new Set();

  return rows.filter(d => {
    const key = `${d.first.join("-")}|${d.second}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countMap(draws, key = "first") {
  const map = {};
  for (let n = 1; n <= 38; n++) map[n] = 0;

  draws.forEach(d => d[key].forEach(n => map[n]++));

  return map;
}

function positionMap(draws) {
  const pos = Array.from({ length: 6 }, () => ({}));

  for (let i = 0; i < 6; i++) {
    for (let n = 1; n <= 38; n++) pos[i][n] = 0;
  }

  draws.forEach(d =>
    d.first.forEach((n, i) => pos[i][n]++)
  );

  return pos;
}

function analyze(draws) {
  const latest = draws[0];
  const recent3 = draws.slice(0, 3);
  const recent10 = draws.slice(0, 10);
  const history = draws.slice(1);

  const latestSet = new Set(latest.first);

  const freqAll = countMap(history);
  const freqRecent10 = countMap(recent10);
  const positions = positionMap(history);

  const similar = history.filter(
    d => d.first.filter(n => latestSet.has(n)).length >= 2
  );

  const score = {};
  for (let n = 1; n <= 38; n++) score[n] = 0;

  similar.forEach(d => {
    d.first.forEach(n => {
      if (!latestSet.has(n)) score[n] += 5;
    });
  });

  for (let n = 1; n <= 38; n++) {
    score[n] += freqAll[n] * 0.2;
  }

  const latestSorted = [...latest.first].sort((a, b) => a - b);

  latestSorted.forEach((n, idx) => {
    const posFreq = positions[idx] || {};

    for (
      let cand = Math.max(1, n - 3);
      cand <= Math.min(38, n + 3);
      cand++
    ) {
      score[cand] += (posFreq[cand] || 0) * 0.35;
    }
  });

  const greyRemove = uniq(
    recent3.flatMap(d => d.first)
  ).sort((a, b) => a - b);

  const tooHotRemove = range(1, 38).filter(
    n => freqRecent10[n] >= 3
  );

  const latestRemove = latest.first;

  const removeSet = new Set([
    ...greyRemove,
    ...tooHotRemove,
    ...latestRemove
  ]);

  const finalNumbers = range(1, 38)
    .filter(n => !removeSet.has(n))
    .map(n => ({
      number: pad(n),
      score: Number(score[n].toFixed(2))
    }))
    .sort((a, b) => b.score - a.score || Number(a.number) - Number(b.number));

  const secondCount = {};
  for (let n = 1; n <= 8; n++) secondCount[n] = 0;

  history.forEach(d => secondCount[d.second]++);

  const secondArea = range(1, 8)
    .filter(n => n !== latest.second)
    .map(n => ({
      number: pad(n),
      score: secondCount[n]
    }))
    .sort((a, b) => b.score - a.score);

  return {
    source: PILIO_URL,
    totalDraws: draws.length,
    latest: {
      first: latest.first.map(pad),
      second: pad(latest.second),
      raw: latest.raw
    },
    rules: {
      similarDrawsUsed: similar.length,
      greyRemove: greyRemove.map(pad),
      tooHotRemove: tooHotRemove.map(pad),
      latestRemove: latestRemove.map(pad)
    },
    finalNumbers,
    top16: finalNumbers.slice(0, 16),
    secondArea: secondArea.slice(0, 4),
    note: "彩券分析只能當參考，不能保證中獎。"
  };
}

app.get("/api/analyze", async (req, res) => {
  try {
    const html = await fetch(PILIO_URL, {
      headers: {
        "user-agent": "Mozilla/5.0 Lottery Analyzer"
      }
    }).then(r => {
      if (!r.ok) throw new Error(`Pilio fetch failed: ${r.status}`);
      return r.text();
    });

    const draws = parsePilioDraws(html);

    if (!draws.length) {
      throw new Error("抓不到威力彩資料");
    }

    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Weili auto analyzer running on port ${PORT}`);
});
