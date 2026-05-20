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
const range = (a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const uniq = arr => [...new Set(arr)];

function parseNumbers(text){
  return (text.match(/\b\d{1,2}\b/g)||[])
    .map(Number).filter(n=>n>=1&&n<=38);
}

function parsePilioDraws(html){
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_,tr)=>{
    const text = $(tr).text().replace(/\u00a0/g," ").replace(/\s+/g," ").trim();
    const nums = parseNumbers(text);
    if(nums.length >= 7){
      const last7 = nums.slice(-7);
      const first = last7.slice(0,6);
      const second = last7[6];
      if(uniq(first).length===6 && second>=1 && second<=8){
        rows.push({ first, second, raw:text });
      }
    }
  });

  const seen = new Set();
  return rows.filter(d=>{
    const key = d.first.join("-")+"|"+d.second;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countMap(draws){
  const m = {};
  for(let n=1;n<=38;n++) m[n]=0;
  draws.forEach(d=>d.first.forEach(n=>m[n]++));
  return m;
}

function lastSeenMap(draws){
  const m = {};
  for(let n=1;n<=38;n++) m[n]=999;
  draws.forEach((d,i)=>{
    d.first.forEach(n=>{
      if(m[n]===999) m[n]=i;
    });
  });
  return m;
}

function tail(n){ return n % 10; }

function scoreNumbers(history, weights){
  const recent10 = history.slice(0,10);
  const recent30 = history.slice(0,30);
  const recent50 = history.slice(0,50);
  const latest = history[0];

  const freq10 = countMap(recent10);
  const freq30 = countMap(recent30);
  const freq50 = countMap(recent50);
  const freqAll = countMap(history);
  const lastSeen = lastSeenMap(history);
  const latestSet = new Set(latest.first);
  const latestTails = latest.first.map(tail);

  const similar = history.slice(1).filter(d =>
    d.first.filter(n=>latestSet.has(n)).length >= 2
  );

  const score = {};
  for(let n=1;n<=38;n++) score[n]=0;

  similar.forEach(d=>{
    d.first.forEach(n=>{
      if(!latestSet.has(n)) score[n] += weights.similar;
    });
  });

  for(let n=1;n<=38;n++){
    score[n] += freq10[n] * weights.hot10;
    score[n] += freq30[n] * weights.hot30;
    score[n] += freq50[n] * weights.hot50;
    score[n] += freqAll[n] * weights.all;

    if(freq10[n]===0 && lastSeen[n]>=8) score[n] += weights.cold;
    if(lastSeen[n]>=15 && lastSeen[n]<=35) score[n] += weights.rebound;
    if(freq10[n]>=3) score[n] -= weights.tooHot;
    if(latestTails.includes(tail(n)) && !latestSet.has(n)) score[n] += weights.tail;

    if(n>=13 && n<=25) score[n] += weights.midZone;
  }

  const removeSet = new Set([
    ...latest.first,
    ...range(1,38).filter(n=>freq10[n]>=4)
  ]);

  return range(1,38)
    .filter(n=>!removeSet.has(n))
    .map(n=>({ number:n, rawScore:score[n] }))
    .sort((a,b)=>b.rawScore-a.rawScore)
    .slice(0,16);
}

function backtest(draws, weights, limit=100){
  const results = [];
  const hitMap = {};
  for(let n=1;n<=38;n++) hitMap[n]=0;

  const max = Math.min(limit, draws.length - 60);

  for(let i=0;i<max;i++){
    const target = draws[i];
    const history = draws.slice(i+1);
    if(history.length < 50) continue;

    const pick = scoreNumbers(history, weights).slice(0,6).map(x=>x.number);
    const hits = pick.filter(n=>target.first.includes(n)).length;

    pick.forEach(n=>{
      if(target.first.includes(n)) hitMap[n]++;
    });

    results.push(hits);
  }

  const total = results.length || 1;
  const avg = results.reduce((a,b)=>a+b,0) / total;
  const hit3 = results.filter(x=>x>=3).length / total;
  const hit4 = results.filter(x=>x>=4).length / total;

  const dist = {};
  for(let i=0;i<=6;i++) dist[i]=results.filter(x=>x===i).length;

  return {
    avg,
    hit3,
    hit4,
    score: avg*40 + hit3*80 + hit4*160,
    total,
    dist,
    hitMap
  };
}

function optimize(draws){
  const candidates = [
    {similar:8, hot10:.3, hot30:1, hot50:1.2, all:.1, cold:8, rebound:7, tooHot:12, tail:3, midZone:1},
    {similar:10, hot10:.1, hot30:.8, hot50:1.5, all:.08, cold:10, rebound:8, tooHot:15, tail:4, midZone:1.2},
    {similar:6, hot10:.5, hot30:1.1, hot50:1, all:.15, cold:7, rebound:9, tooHot:10, tail:2, midZone:.8},
    {similar:12, hot10:-.2, hot30:.9, hot50:1.3, all:.1, cold:12, rebound:6, tooHot:18, tail:5, midZone:1},
    {similar:9, hot10:0, hot30:1.2, hot50:1.4, all:.05, cold:9, rebound:10, tooHot:14, tail:3.5, midZone:1.5}
  ];

  return candidates
    .map(w=>({ weights:w, test:backtest(draws,w,100) }))
    .sort((a,b)=>b.test.score-a.test.score)[0];
}

function buildGroups(top16){
  const p = top16.map(x=>x.number);
  const groups = [
    p.slice(0,6),
    [p[0],p[2],p[4],p[7],p[10],p[13]],
    [p[1],p[3],p[5],p[8],p[11],p[14]]
  ];

  return groups
    .filter(g=>g.length===6 && uniq(g).length===6)
    .map(g=>({ numbers:g.map(pad) }));
}

function analyze(draws){
  const best = optimize(draws);
  const top16Raw = scoreNumbers(draws, best.weights);
  const hitMap = best.test.hitMap;

  const maxHit = Math.max(...Object.values(hitMap),1);

  const finalNumbers = top16Raw.map(x=>{
    const hitScore = Math.round(60 + (hitMap[x.number] / maxHit) * 39);
    return {
      number: pad(x.number),
      hitScore,
      score: hitScore,
      rawScore: Number(x.rawScore.toFixed(2))
    };
  });

  const secondCount = {};
  for(let n=1;n<=8;n++) secondCount[n]=0;
  draws.slice(1,120).forEach(d=>secondCount[d.second]++);

  const latest = draws[0];

  return {
    mode:"近100期自動回測最佳化版",
    source:PILIO_URL,
    totalDraws:draws.length,
    latest:{
      first:latest.first.map(pad),
      second:pad(latest.second),
      raw:latest.raw
    },
    backtest:{
      total:best.test.total,
      averageHits:Number(best.test.avg.toFixed(2)),
      hit3Rate:Math.round(best.test.hit3*100),
      hit4Rate:Math.round(best.test.hit4*100),
      distribution:best.test.dist
    },
    top6:finalNumbers.slice(0,6),
    next6:finalNumbers.slice(6,12),
    top16:finalNumbers,
    finalNumbers,
    groups:buildGroups(finalNumbers),
    secondArea:range(1,8)
      .filter(n=>n!==latest.second)
      .map(n=>({number:pad(n),score:secondCount[n]}))
      .sort((a,b)=>b.score-a.score)
      .slice(0,4),
    rules:{
      bestWeights:best.weights,
      note:"這是用歷史100期回測挑出的最佳權重，不代表未來保證90%。"
    },
    note:"命中分數來自歷史回測，不是保證中獎率。"
  };
}

app.get("/api/analyze", async (_,res)=>{
  try{
    const html = await fetch(PILIO_URL,{
      headers:{"user-agent":"Mozilla/5.0 Lottery Analyzer"}
    }).then(r=>{
      if(!r.ok) throw new Error(`Pilio fetch failed: ${r.status}`);
      return r.text();
    });

    const draws = parsePilioDraws(html);
    if(draws.length < 80) throw new Error("歷史資料不足，無法回測。");

    res.json(analyze(draws));
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

app.get("/health",(_,res)=>res.json({ok:true,mode:"回測最佳化版"}));

app.listen(PORT,()=>console.log(`Weili backtest analyzer running on ${PORT}`));
