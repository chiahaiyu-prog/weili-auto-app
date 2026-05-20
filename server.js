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
    .map(Number)
    .filter(n => n >= 1 && n <= 38);
}

function normalizeText(html) {
  const $ = cheerio.load(html);
  return $("body").text().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
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

      if (uniq(first).length === 6 && second >= 1 && second <= 8) {
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

function countMap(draws) {
  const map = {};
  for (let n = 1; n <= 38; n++) map[n] = 0;
  draws.forEach(d => d.first.forEach(n => map[n]++));
  return map;
}

function lastSeenMap(draws) {
  const map = {};
  for (let n = 1; n <= 38; n++) map[n] = 999;

  draws.forEach((d, idx) => {
    d.first.forEach(n => {
      if (map[n] === 999) map[n] = idx;
    });
  });

  return map;
}

function positionMap(draws) {
  const pos = Array.from({ length: 6 }, () => ({}));
  for (let i = 0; i < 6; i++) {
    for (let n = 1; n <= 38; n++) pos[i][n] = 0;
  }

  draws.forEach(d => {
    const sorted = [...d.first].sort((a, b) => a - b);
    sorted.forEach((n, i) => pos[i][n]++);
  });

  return pos;
}

function tail(n) {
  return n % 10;
}

function zone(n) {
  if (n <= 12) return "low";
  if (n <= 25) return "mid";
  return "high";
}

function comboScore(group, score) {
  let total = group.reduce((sum, n) => sum + (score[n] || 0), 0);

  const tails = group.map(tail);
  const sameTailCount = Math.max(...tails.map(t => tails.filter(x => x === t).length));
  if (sameTailCount >= 3) total -= 12;

  const zones = { low: 0, mid: 0, high: 0 };
  group.forEach(n => zones[zone(n)]++);
  if (zones.low === 0 || zones.mid === 0 || zones.high === 0) total -= 15;

  const sorted = [...group].sort((a, b) => a - b);
  let consecutive = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) consecutive++;
  }
  if (consecutive >= 1) total += 4;
  if (consecutive >= 3) total -= 8;

  return Number(total.toFixed(2));
}

function buildGroups(finalNumbers, score) {
  const pool = finalNumbers.slice(0, 18).map(x => Number(x.number));

  const groups = [
    pool.slice(0, 6),
    [pool[0], pool[2], pool[4], pool[7], pool[10], pool[13]].filter(Boolean),
    [pool[1], pool[3], pool[5], pool[8], pool[11], pool[14]].filter(Boolean),
    [pool[0], pool[5], pool[6], pool[9], pool[12], pool[15]].filter(Boolean),
    [pool[2], pool[3], pool[7], pool[10], pool[13], pool[16]].filter(Boolean)
  ];

  return groups
    .filter(g => g.length === 6 && uniq(g).length === 6)
    .map(g => ({
      numbers: g.map(pad),
      score: comboScore(g, score)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function analyze(draws) {
  const latest = draws[0];
  const history = draws.slice(1);
  const recent3 = draws.slice(0, 3);
  const recent10 = draws.slice(0, 10);
  const recent30 = draws.slice(0, 30);
  const recent50 = draws.slice(0, 50);

  const latestSet = new Set(latest.first);

  const freqAll = countMap(history);
  const freq10 = countMap(recent10);
  const freq30 = countMap(recent30);
  const freq50 = countMap(recent50);
  const lastSeen = lastSeenMap(draws);
  const positions = positionMap(history);

  const similar = history.filter(d => {
    const hit = d.first.filter(n => latestSet.has(n)).length;
    return hit >= 2;
  });

  const score = {};
  for (let n = 1; n <= 38; n++) score[n] = 0;

  similar.forEach(d => {
    d.first.forEach(n => {
      if (!latestSet.has(n)) score[n] += 8;
    });
  });

  for (let n = 1; n <= 38; n++) {
    score[n] += freq50[n] * 1.1;
    score[n] += freq30[n] * 0.9;
    score[n] += freqAll[n] * 0.18;

    if (freq10[n] === 0 && lastSeen[n] >= 8) score[n] += 7;
    if (lastSeen[n] >= 15 && lastSeen[n] <= 35) score[n] += 6;
    if (lastSeen[n] > 35) score[n] += 2;

    if (freq10[n] >= 3) score[n] -= 9;
    if (freq10[n] >= 4) score[n] -= 15;
  }

  const latestSorted = [...latest.first].sort((a, b) => a - b);

  latestSorted.forEach((n, idx) => {
    const posFreq = positions[idx] || {};
    for (let cand = Math.max(1, n - 4); cand <= Math.min(38, n + 4); cand++) {
      score[cand] += (posFreq[cand] || 0) * 0.42;
    }
  });

  const latestTails = latest.first.map(tail);
  for (let n = 1; n <= 38; n++) {
    if (latestTails.includes(tail(n)) && !latestSet.has(n)) {
      score[n] += 3.5;
    }
  }

  const greyRemove = uniq(recent3.flatMap(d => d.first)).sort((a, b) => a - b);
  const tooHotRemove = range(1, 38).filter(n => freq10[n] >= 4);
  const latestRemove = latest.first;

  const removeSet = new Set([...latestRemove, ...tooHotRemove]);

  const finalNumbers = range(1, 38)
    .filter(n => !removeSet.has(n))
    .map(n => ({
      number: pad(n),
      score: Number(score[n].toFixed(2)),
      gap: lastSeen[n],
      hot10: freq10[n],
      hot50: freq50[n]
    }))
    .sort((a, b) => b.score - a.score || Number(a.number) - Number(b.number));

  const top16 = finalNumbers.slice(0, 16);
  const groups = buildGroups(finalNumbers, score);

  const secondCount = {};
  const secondRecent = {};
  for (let n = 1; n <= 8; n++) {
    secondCount[n] = 0;
    secondRecent[n] = 0;
  }

  history.forEach(d => secondCount[d.second]++);
  recent10.forEach(d => secondRecent[d.second]++);

  const secondArea = range(1, 8)
    .filter(n => n !== latest.second)
    .map(n => ({
      number: pad(n),
      score: Number((secondCount[n] * 1.2 - secondRecent[n] * 1.8).toFixed(2))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return {
    source: PILIO_URL,
    mode: "Pro Max 強化版",
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
      latestRemove: latestRemove.map(pad),
      logic: [
        "近50期權重",
        "近30期權重",
        "冷號反彈",
        "尾數規律",
        "位置規律",
        "相似開法",
        "過熱號降權",
        "區間平衡組合"
      ]
    },
    finalNumbers,
    top16,
    top6: top16.slice(0, 6),
    groups,
    secondArea,
    note: "彩券不能保證準確，本分析只是依歷史資料提高篩選參考。"
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
      throw new Error("抓不到威力彩資料，可能網站格式改變。");
    }

    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, mode: "Pro Max 強化版" });
});

app.listen(PORT, () => {
  console.log(`Weili Pro Max analyzer running on port ${PORT}`);
});
