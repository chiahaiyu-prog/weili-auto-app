const $ = id => document.getElementById(id);

function balls(el, nums, second = false) {
  el.innerHTML = "";
  nums.forEach(x => {
    const n = typeof x === "string" ? x : x.number;
    const div = document.createElement("div");
    div.className = "ball";
    div.textContent = n;
    el.appendChild(div);
  });
}

function textNums(el, nums) {
  el.textContent = nums && nums.length ? nums.join("、") : "無";
}

async function load() {
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "分析中...";
  try {
    const res = await fetch("/api/analyze");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "分析失敗");

    balls($("latestFirst"), data.latest.first);
    balls($("latestSecond"), [data.latest.second]);
    balls($("topNumbers"), data.top16);
    balls($("secondArea"), data.secondArea);

    textNums($("greyRemove"), data.rules.greyRemove);
    textNums($("tooHotRemove"), data.rules.tooHotRemove);
    textNums($("latestRemove"), data.rules.latestRemove);

    $("allNumbers").innerHTML = data.finalNumbers.map(x => `
      <div class="item">
        <b>${x.number}</b>
        <span class="score">分數 ${x.score}</span>
      </div>
    `).join("");
  } catch (e) {
    alert(e.message);
  } finally {
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "重新分析";
  }
}

$("refreshBtn").addEventListener("click", load);
load();
