import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

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

    // 威力彩第一區 1-38 六顆，第二區 1-8 一顆。
    // Pilio 每列通常會包含日期、期別，所以取該列最後 7 個可疑號碼。
    const candidates = nums.filter(n => n >= 1 && n <= 38);
    if (candidates.length >= 7) {
      const last7 = candidates.slice(-7);
      const first = last7.slice(0, 6);
      const second = last7[6];
      if (first.length === 6 && second >= 1 && second <= 8 && uniq(first).length === 6) {
        rows.push({ first, second, raw: text });
      }
    }
  });

  // fallback：若表格解析不到，改用全文掃描六顆+第二區格式
  if (rows.length < 3) {
    const text = normalizeText(html);
    const re = /(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})/g;
    let m;
    while ((m = re.exec(text))) {
      const seven = m.slice(1, 8).map(Number);
      const first = seven.slice(0, 6);
      const second = seven[6];
      if (first.every(n => n >= 1 && n <= 38) && second >= 1 && second <= 8 && uniq(first).length === 6) {
        rows.push({ first, second, raw: seven.map(pad).join(",") });
      }
    }
  }

  // 去重
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
  for (let i = 0; i < 6; i++) for (let n = 1; n <= 38; n++) pos[i][n] = 0;
  draws.forEach(d => d.first.forEach((n, i) => pos[i][n]++));
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

  // 1) 找「和最新一期至少對中 2 顆」的歷史相似開法
  const similar = history.filter(d => d.first.filter(n => latestSet.has(n)).length >= 2);

  const score = {};
  for (let n = 1; n <= 38; n++) score[n] = 0;

  // 2) 相似開法裡，沒在最新一期出現但常跟著出現的號碼加分
  similar.forEach(d => {
    d.first.forEach(n => {
      if (!latestSet.has(n)) score[n] += 5;
    });
  });

  // 3) 歷史整體頻率加分
  for (let n = 1; n <= 38; n++) score[n] += freqAll[n] * 0.2;

  // 4) 紅色位置規律：各位置最近常出現的附近號碼加分
  const latestSorted = [...latest.first].sort((a, b) => a - b);
  latestSorted.forEach((n, idx) => {
    const posFreq = positions[idx] || {};
    for (let cand = Math.max(1, n - 3); cand <= Math.min(38, n + 3); cand++) {
      score[cand] += (posFreq[cand] || 0) * 0.35;
    }
  });

  // 灰色區：近期 3 期全部開過的第一區號碼先刪
  const greyRemove = uniq(recent3.flatMap(d => d.first)).sort((a, b) => a - b);

  // 熱到太密集：近 10 期開 3 次以上先刪
  const tooHotRemove = range(1, 38).filter(n => freqRecent10[n] >= 3);

  // 最新一期直接刪
  const latestRemove = latest.first;

  const removeSet = new Set([...greyRemove, ...tooHotRemove, ...latestRemove]);

  const finalNumbers = range(1, 38)
    .filter(n => !removeSet.has(n))
    .map(n => ({ number: pad(n), score: Number(score[n].toFixed(2)) }))
    .sort((a, b) => b.score - a.score || Number(a.number) - Number(b.number));

  const secondCount = {};
  for (let n = 1; n <= 8; n++) secondCount[n] = 0;
  history.forEach(d => secondCount[d.second]++);
  const secondArea = range(1, 8)
    .filter(n => n !== latest.second)
    .map(n => ({ number: pad(n), score: secondCount[n] }))
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
    if (!draws.length) throw new Error("抓不到威力彩資料，可能網站格式改變或暫時阻擋。");

    res.json(analyze(draws));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Weili auto analyzer running on port ${PORT}`);
});
