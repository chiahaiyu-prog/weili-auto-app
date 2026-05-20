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
const PILIO_BASE = "https://www.pilio.idv.tw/lto/list.asp";

const pad = n => String(n).padStart(2, "0");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const uniq = arr => [...new Set(arr)];

function parseNumbers(text) {
  return (text.match(/\b\d{1,2}\b/g) || [])
    .map(Number)
    .filter(n => n >= 1 && n <= 38);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 Lottery Analyzer"
    }
  });

  if (!res.ok) throw new Error(`抓取失敗：${res.status}`);

  return await res.text();
}

function parsePilioDrawsFromHtml(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, tr) => {
    const text = $(tr)
      .text()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const nums = parseNumbers(text);

    if (nums.length >= 7) {
      const last7 = nums.slice(-7);
      const first = last7.slice(0, 6);
      const second = last7[6];

      if (
        first.length === 6 &&
        uniq(first).length === 6 &&
        second >= 1 &&
        second <= 8
      ) {
        rows.push({ first, second, raw: text });
      }
    }
  });

  return rows;
}

async function fetchManyDraws() {
  const all = [];

  // 先抓首頁
  const html = await fetchHtml(PILIO_BASE);
  all.push(...parsePilioDrawsFromHtml(html));

  // 嘗試抓分頁，Pilio 有時候分頁格式會變，所以用多種候選格式
  for (let p = 2; p <= 20; p++) {
    const urls = [
      `${PILIO_BASE}?indexpage=${p}`,
      `${PILIO_BASE}?page=${p}`,
      `${PILIO_BASE}?Page=${p}`,
      `${PILIO_BASE}?p=${p}`
    ];

    for (const url of urls) {
      try {
        const h = await fetchHtml(url);
        const rows = parsePilioDrawsFromHtml(h);

        if (rows.length > 0) {
          all.push(...rows);
          break;
        }
      } catch (_) {}
    }

    if (all.length >= 300) break;
  }

  const seen = new Set();

  return all
    .filter(d => {
      const key = `${d.first.join("-")}|${d.second}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 300);
}

function countMap(draws) {
  const m = {};
  for (let n = 1; n <= 38; n++) m[n] = 0;
  draws.forEach(d => d.first.forEach(n => m[n]++));
  return m;
}

function gapMap(draws) {
  const m = {};
  for (let n = 1; n <= 38; n++) m[n] = 999;

  draws.forEach((d, i) => {
    d.first.forEach(n => {
      if (m[n] === 999) m[n] = i;
    });
  });

  return m;
}

function tail(n) {
  return n % 10;
}
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function buildRandomWeights() {
  return {
    hot10: rand(-5, 8),
    hot30: rand(-3, 6),
    hot50: rand(-2, 5),
    hot100: rand(-2, 4),
    coldGap: rand(-2, 8),
    allFreq: rand(-1, 2),
    repeatPenalty: rand(-20, 2),
    tailBonus: rand(-5, 10),
    overHotPenalty: rand(-25, 0),
    coldZeroBonus: rand(0, 15),
    similarBonus: rand(0, 12)
  };
}

function similarDraws(history, latestSet) {
  return history.filter(d =>
    d.first.filter(n => latestSet.has(n)).length >= 2
  );
}

function scoreNumbers(history, weights) {
  const latest = history[0];

  const recent10 = history.slice(0, 10);
  const recent30 = history.slice(0, 30);
  const recent50 = history.slice(0, 50);
  const recent100 = history.slice(0, 100);

  const f10 = countMap(recent10);
  const f30 = countMap(recent30);
  const f50 = countMap(recent50);
  const f100 = countMap(recent100);
  const all = countMap(history);
  const gap = gapMap(history);

  const latestSet = new Set(latest.first);
  const latestTails = latest.first.map(tail);
  const sim = similarDraws(history.slice(1), latestSet);

  const score = {};

  for (let n = 1; n <= 38; n++) {
    const simCount = sim.reduce((s, d) => {
      return s + (d.first.includes(n) ? 1 : 0);
    }, 0);

    score[n] =
      f10[n] * weights.hot10 +
      f30[n] * weights.hot30 +
      f50[n] * weights.hot50 +
      f100[n] * weights.hot100 +
      gap[n] * weights.coldGap +
      all[n] * weights.allFreq +
      (latestSet.has(n) ? weights.repeatPenalty : 0) +
      (latestTails.includes(tail(n)) ? weights.tailBonus : 0) +
      (f10[n] >= 4 ? weights.overHotPenalty : 0) +
      (f10[n] === 0 ? weights.coldZeroBonus : 0) +
      simCount * weights.similarBonus;
  }

  return score;
}

function balancePick(scoreObj) {
  const list = range(1, 38)
    .map(n => ({ n, score: scoreObj[n] }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.n);

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

  let odd = pick.filter(n => n % 2 === 1).length;

  if (odd === 0 || odd === 6) {
    for (const n of list) {
      for (let i = 0; i < pick.length; i++) {
        const test = [...pick];
        test[i] = n;

        const o = test.filter(x => x % 2 === 1).length;

        if (o >= 2 && o <= 4 && uniq(test).length === 6) {
          pick = test;
          odd = o;
          break;
        }
      }

      if (odd >= 2 && odd <= 4) break;
    }
  }

  let sum = pick.reduce((a, b) => a + b, 0);

  if (sum < 85 || sum > 160) {
    for (const n of list) {
      for (let i = 0; i < pick.length; i++) {
        const test = [...pick];
        test[i] = n;

        const s = test.reduce((a, b) => a + b, 0);

        if (s >= 85 && s <= 160 && uniq(test).length === 6) {
          pick = test;
          sum = s;
          break;
        }
      }

      if (sum >= 85 && sum <= 160) break;
    }
  }

  return pick.sort((a, b) => a - b);
}
function blindTest(draws, weights) {
  const results = [];

  // 歷史越多，最多測 120 期；資料少就自動縮小
  const max = Math.min(120, draws.length - 30);

  for (let i = 0; i < max; i++) {
    const target = draws[i];
    const history = draws.slice(i + 1);

    if (history.length < 30) continue;

    const scoreObj = scoreNumbers(history, weights);
    const pick = balancePick(scoreObj);

    const hits = pick.filter(n => target.first.includes(n)).length;
    results.push(hits);
  }

  const total = results.length || 1;
  const avg = results.reduce((a, b) => a + b, 0) / total;

  const rate = x =>
    Math.round((results.filter(h => h >= x).length / total) * 100);

  const distribution = {};
  for (let i = 0; i <= 6; i++) {
    distribution[i] = results.filter(x => x === i).length;
  }

  return {
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

function modelScore(test) {
  return (
    test.hit6Rate * 2000 +
    test.hit5Rate * 1000 +
    test.hit4Rate * 300 +
    test.hit3Rate * 80 +
    test.hit2Rate * 15 +
    test.averageHits * 10
  );
}

function optimize(draws) {
  const models = [];

  // Render 免費版不要太重，先測 250 組
  for (let i = 0; i < 250; i++) {
    const weights = buildRandomWeights();
    const test = blindTest(draws, weights);

    models.push({
      weights,
      test,
      score: modelScore(test)
    });
  }

  models.sort((a, b) => b.score - a.score);
  return models[0];
}

function analyze(draws) {
  const best = optimize(draws);

  const scoreObj = scoreNumbers(draws, best.weights);
  const finalNumbers = balancePick(scoreObj);

  const latest = draws[0];

  const secondCount = {};
  for (let n = 1; n <= 8; n++) secondCount[n] = 0;

  draws.slice(1).forEach(d => {
    secondCount[d.second]++;
  });

  const secondArea = range(1, 8)
    .filter(n => n !== latest.second)
    .map(n => ({
      number: pad(n),
      score: secondCount[n]
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return {
    mode: "300期歷史盲測 Optimizer",
    totalDraws: draws.length,
    latest: {
      first: latest.first.map(pad),
      second: pad(latest.second)
    },
    bestModel: best.test,
    backtest: best.test,
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
    secondArea,
    rules: {
      testedModels: 250,
      bestWeights: best.weights,
      note: "抓最多300期，盲測最多120期，優先拉高中3~6顆比例。"
    },
    note: "歷史盲測只代表過去推演結果，不保證未來中獎。"
  };
}

app.get("/api/analyze", async (_, res) => {
  try {
    const draws = await fetchManyDraws();

    if (draws.length < 1) {
      throw new Error("抓不到威力彩資料。");
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
    mode: "300期歷史盲測 Optimizer"
  });
});

app.listen(PORT, () => {
  console.log(`Weili 300 draws optimizer running on ${PORT}`);
});
