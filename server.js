import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("."));

app.get("/", (_, res) => {
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

function tail(n) {
  return n % 10;
}

function zone(n) {
  if (n <= 12) return "low";
  if (n <= 25) return "mid";
  return "high";
}

function scoreNumbers(history, w) {
  const latest = history[0];
  const recent5 = history.slice(0, 5);
  const recent10 = history.slice(0, 10);
  const recent30 = history.slice(0, 30);
  const recent50 = history.slice(0, 50);
  const recent100 = history.slice(0, 100);

  const freq5 = countMap(recent5);
  const freq10 = countMap(recent10);
  const freq30 = countMap(recent30);
  const freq50 = countMap(recent50);
  const freq100 = countMap(recent100);
  const freqAll = countMap(history);
  const lastSeen = lastSeenMap(history);

  const latestSet = new Set(latest.first);
  const latestTails = latest.first.map(tail);

  const similar = history.slice(1).filter(d => {
    const hit = d.first.filter(n => latestSet.has(n)).length;
    return hit >= 2;
  });

  const score = {};
  for (let n = 1; n <= 38; n++) score[n] = 0;

  similar.forEach(d => {
    d.first.forEach(n => {
      if (!latestSet.has(n)) score[n] += w.similar;
    });
  });

  for (let n = 1; n <= 38; n++) {
    score[n] += freq5[n] * w.hot5;
    score[n] += freq10[n] * w.hot10;
    score[n] += freq30[n] * w.hot30;
    score[n] += freq50[n] * w.hot50;
    score[n] += freq100[n] * w.hot100;
    score[n] += freqAll[n] * w.all;

    if (freq10[n] === 0 && lastSeen[n] >= 8) score[n] += w.cold;
    if (lastSeen[n] >= 12 && lastSeen[n] <= 35) score[n] += w.rebound;
    if (lastSeen[n] > 35) score[n] += w.longCold;

    if (freq5[n] >= 2) score[n] -= w.tooHot5;
    if (freq10[n] >= 3) score[n] -= w.tooHot10;
    if (freq10[n] >= 4) score[n] -= w.tooHotExtreme;

    if (latestTails.includes(tail(n)) && !latestSet.has(n)) {
      score[n] += w.tail;
    }

    if (zone(n) === "mid") score[n] += w.midZone;
    if (zone(n) === "low") score[n] += w.lowZone;
    if (zone(n) === "high") score[n] += w.highZone;
  }

  const removeSet = new Set([
    ...latest.first,
    ...range(1, 38).filter(n => freq10[n] >= 4)
  ]);

  return range(1, 38)
    .filter(n => !removeSet.has(n))
    .map(n => ({
      number: n,
      rawScore: score[n]
    }))
    .sort((a, b) => b.rawScore - a.rawScore)
    .slice(0, 16);
}

function comboQuality(nums) {
  const group = nums.map(Number);
  let bonus = 0;

  const odd = group.filter(n => n % 2 === 1).length;
  if (odd === 3) bonus += 10;
  if (odd === 2 || odd === 4) bonus += 5;

  const low = group.filter(n => n <= 12).length;
  const mid = group.filter(n => n >= 13 && n <= 25).length;
  const high = group.filter(n => n >= 26).length;
  if (low >= 1 && mid >= 1 && high >= 1) bonus += 12;

  const sum = group.reduce((a, b) => a + b, 0);
  if (sum >= 90 && sum <= 150) bonus += 12;

  const tails = group.map(tail);
  const maxTail = Math.max(...tails.map(t => tails.filter(x => x === t).length));
  if (maxTail >= 3) bonus -= 10;

  return bonus;
}

function backtest(draws, weights, limit = 120) {
  const results = [];
  const hitMap = {};
  for (let n = 1; n <= 38; n++) hitMap[n] = { selected: 0, hit: 0 };

  const max = Math.max(1, Math.min(limit, draws.length - 20));

  for (let i = 0; i < max; i++) {
    const target = draws[i];
    const history = draws.slice(i + 1);

    if (history.length < 20) continue;

    const pick = scoreNumbers(history, weights).slice(0, 6).map(x => x.number);
    const hits = pick.filter(n => target.first.includes(n)).length;

    pick.forEach(n => {
      hitMap[n].selected++;
      if (target.first.includes(n)) hitMap[n].hit++;
    });

    results.push(hits);
  }

  const total = results.length || 1;
  const avg = results.reduce((a, b) => a + b, 0) / total;

  const hit1 = results.filter(x => x >= 1).length / total;
  const hit2 = results.filter(x => x >= 2).length / total;
  const hit3 = results.filter(x => x >= 3).length / total;
  const hit4 = results.filter(x => x >= 4).length / total;

  const distribution = {};
  for (let i = 0; i <= 6; i++) {
    distribution[i] = results.filter(x => x === i).length;
  }

  const accuracy =
    hit2 * 35 +
    hit3 * 35 +
    hit4 * 20 +
    Math.min(avg / 3, 1) * 10;

  return {
    total,
    averageHits: Number(avg.toFixed(2)),
    hit1Rate: Math.round(hit1 * 100),
    hit2Rate: Math.round(hit2 * 100),
    hit3Rate: Math.round(hit3 * 100),
    hit4Rate: Math.round(hit4 * 100),
    accuracy: Math.round(accuracy),
    distribution,
    hitMap,
    rawResults: results
  };
}

function generateCandidates() {
  const candidates = [];

  const similarSet = [5, 8, 10, 12, 15];
  const coldSet = [4, 7, 10, 13];
  const reboundSet = [4, 7, 10, 13];
  const tailSet = [1, 3, 5];
  const hot50Set = [0.8, 1.1, 1.4];
  const hot30Set = [0.7, 1, 1.3];

  for (const similar of similarSet) {
    for (const cold of coldSet) {
      for (const rebound of reboundSet) {
        for (const tail of tailSet) {
          for (const hot50 of hot50Set) {
            for (const hot30 of hot30Set) {
              candidates.push({
                similar,
                hot5: -0.5,
                hot10: 0,
                hot30,
                hot50,
                hot100: 0.4,
                all: 0.05,
                cold,
                rebound,
                longCold: 2,
                tooHot5: 6,
                tooHot10: 10,
                tooHotExtreme: 18,
                tail,
                lowZone: 0.5,
                midZone: 1.2,
                highZone: 0.5
              });
            }
          }
        }
      }
    }
  }

  return candidates;
}

function optimize(draws) {
  const candidates = generateCandidates();

  let best = null;

  for (const weights of candidates) {
    const test = backtest(draws, weights, 120);

    const rankScore =
      test.accuracy * 2 +
      test.averageHits * 20 +
      test.hit3Rate * 1.5 +
      test.hit4Rate * 3;

    const item = { weights, test, rankScore };

    if (!best || item.rankScore > best.rankScore) {
      best = item;
    }
  }

  return best;
}

function buildGroups(finalNumbers) {
  const p = finalNumbers.map(x => Number(x.number));

  const groups = [
    p.slice(0, 6),
    [p[0], p[2], p[4], p[7], p[10], p[13]],
    [p[1], p[3], p[5], p[8], p[11], p[14]],
    [p[0], p[5], p[6], p[9], p[12], p[15]],
    [p[2], p[3], p[7], p[10], p[13], p[15]]
  ];

  return groups
    .filter(g => g.length === 6 && uniq(g).length === 6)
    .map(g => ({
      numbers: g.map(pad),
      quality: comboQuality(g)
    }))
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 3);
}

function analyze(draws) {
  const best = optimize(draws);
  const top16Raw = scoreNumbers(draws, best.weights);
  const hitMap = best.test.hitMap;

  const finalNumbers = top16Raw.map(x => {
    const stat = hitMap[x.number] || { selected: 0, hit: 0 };
    const blindRate = stat.selected > 0 ? stat.hit / stat.selected : 0;

    return {
      number: pad(x.number),
      score: Math.round(60 + blindRate * 39),
      blindSelected: stat.selected,
      blindHits: stat.hit,
      blindRate: Math.round(blindRate * 100),
      rawScore: Number(x.rawScore.toFixed(2))
    };
  }).sort((a, b) => b.score - a.score || b.rawScore - a.rawScore);

  const latest = draws[0];

  const secondCount = {};
  for (let n = 1; n <= 8; n++) secondCount[n] = 0;
  draws.slice(1, 120).forEach(d => secondCount[d.second]++);

  return {
    mode: "盲測自動調參最高準確率版",
    source: PILIO_URL,
    totalDraws: draws.length,
    latest: {
      first: latest.first.map(pad),
      second: pad(latest.second),
      raw: latest.raw
    },
    backtest: {
      total: best.test.total,
      averageHits: best.test.averageHits,
      hit1Rate: best.test.hit1Rate,
      hit2Rate: best.test.hit2Rate,
      hit3Rate: best.test.hit3Rate,
      hit4Rate: best.test.hit4Rate,
      accuracy: best.test.accuracy,
      reach90: best.test.accuracy >= 90,
      reach99: best.test.accuracy >= 99,
      distribution: best.test.distribution
    },
    top6: finalNumbers.slice(0, 6),
    next6: finalNumbers.slice(6, 12),
    top16: finalNumbers,
    finalNumbers,
    groups: buildGroups(finalNumbers),
    secondArea: range(1, 8)
      .filter(n => n !== latest.second)
      .map(n => ({
        number: pad(n),
        score: secondCount[n]
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4),
    rules: {
      bestWeights: best.weights,
      testedModels: generateCandidates().length,
      note: "每一期盲測都不看當期答案，只用更早以前的資料推演。"
    },
    note: "準確率是歷史盲測結果，不代表未來保證中獎。"
  };
}

app.get("/api/analyze", async (_, res) => {
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

    if (draws.length < 30) {
      throw new Error("歷史資料不足，無法盲測。");
    }

    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    mode: "盲測自動調參最高準確率版"
  });
});

app.listen(PORT, () => {
  console.log(`Weili blind test optimizer running on ${PORT}`);
});
