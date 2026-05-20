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
  const map = {};
  for (let n = 1; n <= 38; n++) map[n] = 0;
  draws.forEach(d => d.first.forEach(n => map[n]++));
  return map;
}

function lastSeenMap(draws) {
  const map = {};
  for (let n = 1; n <= 38; n++) map[n] = 999;
  draws.forEach((d, i) => {
    d.first.forEach(n => {
      if (map[n] === 999) map[n] = i;
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
    [...d.first].sort((a, b) => a - b).forEach((n, i) => {
      pos[i][n]++;
    });
  });

  return pos;
}

function tail(n) {
  return n % 10;
}

function zone(n) {
  if (n <= 12) return "低區";
  if (n <= 25) return "中區";
  return "高區";
}

function comboScore(group, score) {
  let total = group.reduce((s, n) => s + score[n], 0);

  const odd = group.filter(n => n % 2 === 1).length;
  const even = 6 - odd;
  if (odd === 3 && even === 3) total += 10;
  if (odd === 2 || odd === 4) total += 5;

  const zones = {
    low: group.filter(n => n <= 12).length,
    mid: group.filter(n => n >= 13 && n <= 25).length,
    high: group.filter(n => n >= 26).length
  };

  if (zones.low >= 1 && zones.mid >= 1 && zones.high >= 1) total += 12;

  const sum = group.reduce((a, b) => a + b, 0);
  if (sum >= 95 && sum <= 145) total += 12;

  return Number(total.toFixed(2));
}

function buildGroups(finalNumbers, score) {
  const pool = finalNumbers.slice(0, 18).map(x => Number(x.number));

  const rawGroups = [
    pool.slice(0, 6),
    [pool[0], pool[2], pool[4], pool[7], pool[10], pool[13]],
    [pool[1], pool[3], pool[5], pool[8], pool[11], pool[14]],
    [pool[0], pool[5], pool[6], pool[9], pool[12], pool[15]],
    [pool[2], pool[3], pool[7], pool[10], pool[13], pool[16]]
  ];

  return rawGroups
    .filter(g => g.length === 6 && uniq(g).length === 6)
    .map(g => ({
      numbers: g.map(pad),
      confidence: Math.min(99, Math.round(comboScore(g, score) / 4))
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function analyze(draws) {
  const latest = draws[0];
  const history = draws.slice(1);

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

  const similar = history.filter(d =>
    d.first.filter(n => latestSet.has(n)).length >= 2
  );

  const score = {};
  for (let n = 1; n <= 38; n++) score[n] = 0;

  similar.forEach(d => {
    d.first.forEach(n => {
      if (!latestSet.has(n)) score[n] += 9;
    });
  });

  for (let n = 1; n <= 38; n++) {
    score[n] += freq50[n] * 1.2;
    score[n] += freq30[n] * 1.0;
    score[n] += freqAll[n] * 0.15;

    if (freq10[n] === 0 && lastSeen[n] >= 8) score[n] += 9;
    if (lastSeen[n] >= 15 && lastSeen[n] <= 35) score[n] += 8;
    if (lastSeen[n] > 35) score[n] += 3;

    if (freq10[n] >= 3) score[n] -= 8;
    if (freq10[n] >= 4) score[n] -= 15;
  }

  const latestSorted = [...latest.first].sort((a, b) => a - b);

  latestSorted.forEach((n, idx) => {
    const posFreq = positions[idx] || {};
    for (let cand = Math.max(1, n - 4); cand <= Math.min(38, n + 4); cand++) {
      score[cand] += (posFreq[cand] || 0) * 0.45;
    }
  });

  const latestTails = latest.first.map(tail);

  for (let n = 1; n <= 38; n++) {
    if (latestTails.includes(tail(n)) && !latestSet.has(n)) {
      score[n] += 4;
    }

    if (n % 2 === 1) score[n] += 0.5;
    if (zone(n) === "中區") score[n] += 1.2;
  }

  const removeSet = new Set([
    ...latest.first,
    ...range(1, 38).filter(n => freq10[n] >= 4)
  ]);

  const rawList = range(1, 38)
    .filter(n => !removeSet.has(n))
    .map(n => ({
      number: pad(n),
      rawScore: score[n],
      gap: lastSeen[n],
      hot10: freq10[n],
      hot30: freq30[n],
      hot50: freq50[n]
    }))
    .sort((a, b) => b.rawScore - a.rawScore);

  const maxScore = rawList[0]?.rawScore || 1;
  const minScore = rawList[rawList.length - 1]?.rawScore || 0;

  const finalNumbers = rawList.map(x => {
    const confidence = Math.round(
      60 + ((x.rawScore - minScore) / (maxScore - minScore || 1)) * 39
    );

    return {
      number: x.number,
      confidence,
      score: confidence,
      gap: x.gap,
      hot10: x.hot10,
      hot30: x.hot30,
      hot50: x.hot50
    };
  });

  const top16 = finalNumbers.slice(0, 16);
  const top6 = top16.slice(0, 6);
  const next6 = top16.slice(6, 12);
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
    .map(n => {
      const raw = secondCount[n] * 1.5 - secondRecent[n] * 2;
      return {
        number: pad(n),
        confidence: Math.max(60, Math.min(99, Math.round(raw))),
        score: Math.max(60, Math.min(99, Math.round(raw)))
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);

  return {
    source: PILIO_URL,
    mode: "Confidence 把握度版",
    totalDraws: draws.length,
    latest: {
      first: latest.first.map(pad),
      second: pad(latest.second),
      raw: latest.raw
    },
    top6,
    next6,
    top16,
    finalNumbers,
    groups,
    secondArea,
    rules: {
      similarDrawsUsed: similar.length,
      latestRemove: latest.first.map(pad),
      logic: [
        "近10期熱度",
        "近30期權重",
        "近50期權重",
        "冷號反彈",
        "熱號降權",
        "尾數規律",
        "位置規律",
        "奇偶比例",
        "區間平衡",
        "和值範圍",
        "相似歷史開法",
        "第二區交叉"
      ]
    },
    note: "把握度是依歷史資料換算的信心分數，不代表保證中獎。"
  };
}

app.get("/api/analyze", async (req, res) => {
  try {
    const html = await fetch(PILIO_URL, {
      headers: { "user-agent": "Mozilla/5.0 Lottery Analyzer" }
    }).then(r => {
      if (!r.ok) throw new Error(`Pilio fetch failed: ${r.status}`);
      return r.text();
    });

    const draws = parsePilioDraws(html);
    if (!draws.length) throw new Error("抓不到威力彩資料");

    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true, mode: "Confidence 把握度版" });
});

app.listen(PORT, () => {
  console.log(`Weili Confidence analyzer running on port ${PORT}`);
});
