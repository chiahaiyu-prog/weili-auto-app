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

function parseDraws(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, tr) => {
    const text = $(tr).text().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const nums = parseNumbers(text);
    if (nums.length >= 7) {
      const last7 = nums.slice(-7);
      const first = last7.slice(0, 6);
      const second = last7[6];
      if (first.length === 6 && uniq(first).length === 6 && second >= 1 && second <= 8) {
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

function gapMap(draws) {
  const m = {};
  for (let n = 1; n <= 38; n++) m[n] = 999;
  draws.forEach((d, i) => d.first.forEach(n => {
    if (m[n] === 999) m[n] = i;
  }));
  return m;
}

function tail(n) { return n % 10; }
function sum(nums) { return nums.reduce((a, b) => a + b, 0); }

function structureScore(group) {
  let score = 0;
  const odd = group.filter(n => n % 2 === 1).length;
  const low = group.filter(n => n <= 12).length;
  const mid = group.filter(n => n >= 13 && n <= 25).length;
  const high = group.filter(n => n >= 26).length;
  const s = sum(group);
  const tails = group.map(tail);
  const maxTail = Math.max(...tails.map(t => tails.filter(x => x === t).length));

  if (odd === 3) score += 20;
  if (odd === 2 || odd === 4) score += 10;
  if (low >= 1 && mid >= 1 && high >= 1) score += 25;
  if (low <= 3 && mid <= 3 && high <= 3) score += 10;
  if (s >= 90 && s <= 150) score += 25;
  if (maxTail <= 2) score += 10;

  const sorted = [...group].sort((a,b)=>a-b);
  let consecutive = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i-1] === 1) consecutive++;
  if (consecutive === 1) score += 8;
  if (consecutive >= 3) score -= 15;
  return score;
}

function rankNumbers(history, style="balanced") {
  const latest = history[0];
  const latestSet = new Set(latest.first);
  const recent5 = history.slice(0,5);
  const recent10 = history.slice(0,10);
  const recent30 = history.slice(0,30);
  const recent50 = history.slice(0,50);
  const f5 = countMap(recent5);
  const f10 = countMap(recent10);
  const f30 = countMap(recent30);
  const f50 = countMap(recent50);
  const all = countMap(history);
  const gap = gapMap(history);
  const latestTails = latest.first.map(tail);
  const similar = history.slice(1).filter(d => d.first.filter(n => latestSet.has(n)).length >= 2);

  const list = range(1,38).map(n => {
    let score = 0;
    const simCount = similar.reduce((s,d)=>s+(d.first.includes(n)?1:0),0);

    if (style === "touch") {
      score = f30[n]*1.6 + f50[n]*1.1 + all[n]*0.08 + simCount*3 + (gap[n] >= 8 ? 5 : 0);
    } else if (style === "balanced") {
      score = f30[n]*1.1 + f50[n]*1.2 + all[n]*0.08 + (f10[n] === 0 && gap[n] >= 7 ? 9 : 0) + simCount*2.4 + (latestTails.includes(tail(n)) ? 2 : 0) - (f5[n] >= 2 ? 8 : 0);
    } else {
      score = (f10[n] === 0 ? 14 : 0) + (gap[n] >= 10 ? 10 : 0) + simCount*1.8 + f50[n]*0.9 - f10[n]*3;
    }

    // æ®ºä¸æèç¢¼ï¼ä¸åæ¨è¦åééçç¬¬ä¸å
    if (latestSet.has(n)) score = -999999;
    if (f10[n] >= 4) score -= 30;
    return { n, score };
  }).sort((a,b)=>b.score-a.score).map(x=>x.n);

  return list;
}

function makeGroup(history, style) {
  const ranked = rankNumbers(history, style);
  const low = ranked.filter(n => n <= 12);
  const mid = ranked.filter(n => n >= 13 && n <= 25);
  const high = ranked.filter(n => n >= 26);

  const candidates = [];
  const templates = [
    [2,2,2], [1,3,2], [2,3,1], [1,2,3], [3,2,1]
  ];
  for (const [l,m,h] of templates) {
    const g = [...low.slice(0,l), ...mid.slice(0,m), ...high.slice(0,h)];
    if (g.length === 6 && uniq(g).length === 6) candidates.push(g.sort((a,b)=>a-b));
  }

  for (let offset=0; offset<8; offset++) {
    const g = ranked.slice(offset, offset+6).sort((a,b)=>a-b);
    if (g.length === 6 && uniq(g).length === 6) candidates.push(g);
  }

  return candidates
    .map(g => ({ group:g, score: structureScore(g) + g.reduce((s,n)=>s+(ranked.indexOf(n) >= 0 ? 40-ranked.indexOf(n) : 0),0) }))
    .sort((a,b)=>b.score-a.score)[0].group;
}

function blindTest(draws, style) {
  const max = Math.min(120, Math.max(1, draws.length - 10));
  const results = [];
  for (let i=0; i<max; i++) {
    const target = draws[i];
    const history = draws.slice(i+1);
    if (history.length < 10) continue;
    const pick = makeGroup(history, style);
    results.push(pick.filter(n => target.first.includes(n)).length);
  }
  const total = results.length || 1;
  const rate = x => Math.round(results.filter(h=>h>=x).length / total * 100);
  const dist = {};
  for (let i=0;i<=6;i++) dist[i] = results.filter(h=>h===i).length;
  return {
    style,
    total,
    averageHits: Number((results.reduce((a,b)=>a+b,0)/total).toFixed(2)),
    hit1Rate: rate(1),
    hit2Rate: rate(2),
    hit3Rate: rate(3),
    hit4Rate: rate(4),
    hit5Rate: rate(5),
    hit6Rate: rate(6),
    distribution: dist
  };
}

function analyze(draws) {
  const tests = ["touch", "balanced", "jackpot"].map(style => blindTest(draws, style));
  const best = tests.sort((a,b) =>
    b.hit4Rate - a.hit4Rate || b.hit3Rate - a.hit3Rate || b.hit2Rate - a.hit2Rate || b.averageHits - a.averageHits
  )[0];

  const groupA = makeGroup(draws, "touch");
  const groupB = makeGroup(draws, "balanced");
  const groupC = makeGroup(draws, "jackpot");
  const latest = draws[0];

  const secondCount = {};
  for (let n=1;n<=8;n++) secondCount[n]=0;
  draws.slice(1).forEach(d=>secondCount[d.second]++);
  const secondArea = range(1,8)
    .filter(n=>n!==latest.second)
    .map(n=>({ number:pad(n), score:secondCount[n] }))
    .sort((a,b)=>b.score-a.score)
    .slice(0,3);

  return {
    mode: "Final Pro çµæ§ç²æ¸¬ç",
    totalDraws: draws.length,
    latest: { first: latest.first.map(pad), second: pad(latest.second) },
    backtest: best,
    allBacktests: tests,
    groups: [
      { name:"A é«å½ä¸­ç¢°èçµ", numbers: groupA.map(pad), sum: sum(groupA), structureScore: structureScore(groupA) },
      { name:"B å¹³è¡¡è¦å¾çµ", numbers: groupB.map(pad), sum: sum(groupB), structureScore: structureScore(groupB) },
      { name:"C è¡é«ççµ", numbers: groupC.map(pad), sum: sum(groupC), structureScore: structureScore(groupC) }
    ],
    form: {
      numbers: groupB.map(pad),
      oddEven: `${groupB.filter(n=>n%2===1).length}å®${groupB.filter(n=>n%2===0).length}é`,
      sum: sum(groupB),
      low: groupB.filter(n=>n<=12).length,
      mid: groupB.filter(n=>n>=13&&n<=25).length,
      high: groupB.filter(n=>n>=26).length
    },
    secondArea,
    note: "éæ¯æ­·å²çµæ§ç²æ¸¬åèï¼ä¸ä¿è­æªä¾ä¸­çï¼å·²æé¤ææ°ä¸æç¬¬ä¸åèç¢¼ã"
  };
}

app.get("/api/analyze", async (_, res) => {
  try {
    const html = await fetch(PILIO_URL, { headers: { "user-agent": "Mozilla/5.0 Lottery Analyzer" } }).then(r => {
      if (!r.ok) throw new Error(`Pilio fetch failed: ${r.status}`);
      return r.text();
    });
    const draws = parseDraws(html);
    if (draws.length < 1) throw new Error("æä¸å°å¨åå½©è³æãPilio æ ¼å¼å¯è½æ¹è®ã");
    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true, mode: "Final Pro çµæ§ç²æ¸¬ç" }));

app.listen(PORT, () => console.log(`Weili final pro running on ${PORT}`));
