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

  draws.forEach(d => {
    d.first.forEach(n => {
      map[n]++;
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

function buildBestForm(history) {
  const freq = countMap(history);

  const low = range(1, 12)
    .map(n => ({ n, f: freq[n] }))
    .sort((a, b) => b.f - a.f);

  const mid = range(13, 25)
    .map(n => ({ n, f: freq[n] }))
    .sort((a, b) => b.f - a.f);

  const high = range(26, 38)
    .map(n => ({ n, f: freq[n] }))
    .sort((a, b) => b.f - a.f);

  // 最強形式：
  // 低區 2顆、中區2顆、高區2顆
  let pick = [
    low[0].n,
    low[1].n,
    mid[0].n,
    mid[1].n,
    high[0].n,
    high[1].n
  ];

  // 奇偶平衡調整（盡量3單3雙）
  let odd = pick.filter(n => n % 2 === 1).length;

  if (odd < 2 || odd > 4) {
    const all = [...low.slice(0,4), ...mid.slice(0,4), ...high.slice(0,4)]
      .map(x => x.n)
      .filter(n => !pick.includes(n));

    for (const n of all) {
      for (let i = 0; i < pick.length; i++) {
        const test = [...pick];
        test[i] = n;
        const o = test.filter(x => x % 2 === 1).length;
        if (o >= 2 && o <= 4) {
          pick = test;
          odd = o;
          break;
        }
      }
      if (odd >= 2 && odd <= 4) break;
    }
  }

  // 和值修正（90~150）
  let sum = pick.reduce((a,b)=>a+b,0);

  if (sum < 90 || sum > 150) {
    const all = range(1,38)
      .map(n => ({ n, f: freq[n] }))
      .sort((a,b)=>b.f-a.f);

    for (const cand of all) {
      for (let i=0;i<pick.length;i++) {
        const test = [...pick];
        test[i] = cand.n;
        const s = test.reduce((a,b)=>a+b,0);

        if (s >= 90 && s <= 150 && uniq(test).length === 6) {
          pick = test;
          sum = s;
          break;
        }
      }
      if (sum >= 90 && sum <= 150) break;
    }
  }

  return uniq(pick).sort((a,b)=>a-b);
}
function blindTest(draws) {
  const results = [];
  const max = Math.min(50, draws.length - 5);

  for (let i = 0; i < max; i++) {
    const target = draws[i];
    const history = draws.slice(i + 1);

    if (history.length < 5) continue;

    const pick = buildBestForm(history);
    const hits = pick.filter(n => target.first.includes(n)).length;

    results.push(hits);
  }

  const total = results.length || 1;
  const avg = results.reduce((a,b)=>a+b,0) / total;

  const hit1 = results.filter(x => x >= 1).length / total;
  const hit2 = results.filter(x => x >= 2).length / total;
  const hit3 = results.filter(x => x >= 3).length / total;
  const hit4 = results.filter(x => x >= 4).length / total;

  const distribution = {};
  for (let i = 0; i <= 6; i++) {
    distribution[i] = results.filter(x => x === i).length;
  }

  return {
    total,
    averageHits: Number(avg.toFixed(2)),
    hit1Rate: Math.round(hit1 * 100),
    hit2Rate: Math.round(hit2 * 100),
    hit3Rate: Math.round(hit3 * 100),
    hit4Rate: Math.round(hit4 * 100),
    distribution
  };
}

function analyze(draws) {
  const test = blindTest(draws);
  const finalNumbers = buildBestForm(draws);

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
    .sort((a,b)=>b.score-a.score)
    .slice(0,4);

  return {
    mode: "最強形式固定模型",
    latest: {
      first: latest.first.map(pad),
      second: pad(latest.second)
    },
    form: {
      numbers: finalNumbers.map(pad),
      oddEven:
        `${finalNumbers.filter(n=>n%2===1).length}單` +
        `${finalNumbers.filter(n=>n%2===0).length}雙`,
      sum: finalNumbers.reduce((a,b)=>a+b,0),
      low: finalNumbers.filter(n=>n<=12).length,
      mid: finalNumbers.filter(n=>n>=13 && n<=25).length,
      high: finalNumbers.filter(n=>n>=26).length
    },
    backtest: test,
    secondArea,
    note: "歷史盲測形式模型，不代表未來保證中獎。"
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
    mode: "最強形式固定模型"
  });
});

app.listen(PORT, () => {
  console.log(`Weili strongest form analyzer running on ${PORT}`);
});
