// 每張商品卡最下面插一行：藍點數 · [市價] · [查價] · 每點價值。
// 「查價」請 background.js 背景 fetch Google 抓第一筆價格寫回 chrome.storage，這裡即時收到填入（不開分頁）。
// 市價一律以 TWD 存 chrome.storage（跨分頁/跨網域共用）；幣別 TWD/USD 可切，換頁/切幣別都不跑掉。
// 注意：不用商城自帶的 gtag_view_item_price——它只是「點數 × 固定匯率」的美元標示，非真實市價。
(function () {
  "use strict";

  const POINTS_RE = /([\d,]{2,})\s*(?:points?|pts?|point|點|blue\s*points?)/i;
  function parsePoints(text) {
    if (!text) return null;
    const m = POINTS_RE.exec(text);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  const nf = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lstore = {
    get(k, d) { try { const v = localStorage.getItem("bpx_" + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("bpx_" + k, v); } catch (e) {} },
  };
  const settings = {
    currency: lstore.get("cur", "TWD"),
    rate: parseFloat(lstore.get("rate", "32")) || 32,
    collapsed: lstore.get("collapsed", "0") === "1",
  };

  const items = [];         // {sku, name, points, priceTwd, input, per, linkEl, linkUrl}
  const seen = new Set();
  const priceCache = {};    // sku -> TWD number
  const linkCache = {};     // sku -> 商品連結

  // 內部存 TWD；依幣別換算顯示。
  function toDisplay(twd) {
    if (twd == null) return "";
    return settings.currency === "USD" ? +(twd / settings.rate).toFixed(2) : Math.round(twd);
  }
  function fromDisplay(v) {
    if (!Number.isFinite(v)) return null;
    return settings.currency === "USD" ? v * settings.rate : v;
  }
  // 每點價值合理區間（TWD/點，與顯示幣別無關）。超出 → 標 ⚠ 提醒價格可能抓錯。
  const PER_MIN = 1, PER_MAX = 15;
  function perWarn(twd, points) {
    if (twd == null || !points) return false;
    const v = twd / points;
    return v > PER_MAX || v < PER_MIN;
  }
  function perText(twd, points) {
    if (twd == null || !points) return "";
    const warn = perWarn(twd, points) ? " ⚠" : "";
    if (settings.currency === "USD") return "US$" + (twd / settings.rate / points).toFixed(4) + "/點" + warn;
    return "NT$" + (twd / points).toFixed(3) + "/點" + warn;
  }
  const pricePlaceholder = () => (settings.currency === "USD" ? "市價US$" : "市價NT$");

  function renderItem(it) {
    it.input.value = it.priceTwd == null ? "" : toDisplay(it.priceTwd);
    it.input.placeholder = pricePlaceholder();
    it.per.textContent = perText(it.priceTwd, it.points);
    it.per.title = perWarn(it.priceTwd, it.points) ? "每點價值超出 NT$" + PER_MIN + "~" + PER_MAX + "，價格可能抓錯，請確認" : "";
  }
  function renderAll() { items.forEach(renderItem); renderList(); }
  function setLink(it) {
    if (it.linkUrl) { it.linkEl.href = it.linkUrl; it.linkEl.style.display = ""; }
    else it.linkEl.style.display = "none";
  }

  // 浮層清單：只列已查到價的商品，依每點價值排序（預設高→低＝最划算優先）。
  let listEl = null, countEl = null, sortDir = -1;
  function renderList() {
    if (!listEl) return;
    const priced = items.filter((it) => it.priceTwd != null && it.points);
    priced.sort((a, b) => sortDir * (a.priceTwd / a.points - b.priceTwd / b.points));
    countEl.textContent = priced.length + " 項已查價";
    listEl.innerHTML = priced.length
      ? priced.map((it) =>
          '<div class="bpx-row" data-sku="' + esc(it.sku) + '">' +
            '<span class="bpx-row-name" title="' + esc(it.name) + '">' + esc(it.name) + "</span>" +
            '<span class="bpx-row-val">' + perText(it.priceTwd, it.points) + "</span>" +
          "</div>"
        ).join("")
      : '<div class="bpx-empty">尚無已查價商品</div>';
  }

  // 請 background 查一張卡的市價；成功由 storage.onChanged 填入，這裡只回成敗。
  function lookup(it) {
    return new Promise((resolve) => {
      it.per.textContent = "查詢中…";
      let done = false;
      const finish = (ok, msg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok) it.per.textContent = msg || "查詢失敗，手動填"; // ok 時由 renderItem 顯示每點價值
        resolve(ok);
      };
      // 保底逾時：background 三來源串接（Bing→DDG→Google）最壞約 24s，給 30s；
      // 就算逾時，晚到的價格仍會經 storage.onChanged 自動補上卡片。
      const timer = setTimeout(() => finish(false, "逾時，可能被限流"), 30000);
      // 擴充重載後、舊分頁沒重新整理 → context 失效，sendMessage 會丟例外。攔下來提示重整。
      try {
        chrome.runtime.sendMessage({ type: "bpx-price", q: it.name, sku: it.sku }, (resp) => {
          const ok = !chrome.runtime.lastError && resp && resp.ok;
          if (ok) {
            // 直接用回傳價更新；不靠 onChanged（值沒變時不會觸發，會卡在「查詢中…」）
            it.priceTwd = resp.price;
            priceCache[it.sku] = resp.price;
            renderItem(it);
            renderList();
            finish(true);
          } else {
            finish(false, resp && resp.error === "blocked" ? "被 Google 限流，稍後再試" : undefined);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        done = true;
        it.per.textContent = "請重新整理頁面";
        console.log("[BPX] context invalidated，請 F5 重整", e);
        resolve(false);
      }
    });
  }

  // 本頁未查的逐張查（節流），一次全打會被 Google 擋。只處理當前頁載入的卡。
  let batching = false;
  async function runBatch(btn) {
    if (batching) return;
    batching = true;
    const orig = btn.textContent;
    const todo = items.filter((it) => it.priceTwd == null);
    try {
      for (let i = 0; i < todo.length; i++) {
        btn.textContent = "查詢中 " + (i + 1) + "/" + todo.length;
        await lookup(todo[i]);
        // ponytail: 固定 1.5s 間隔。主來源 Bing/DDG 不做 Google 那種行為指紋比對，只需避開「連打被限流」。
        // 還是被擋就把間隔拉大、或手動單張查；要更聰明再改成被擋時指數退避。最後一筆後不用等。
        if (i < todo.length - 1) await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      btn.textContent = orig;
      batching = false;
    }
  }

  function enhanceCards() {
    document.querySelectorAll(".gtag_view_item_name").forEach((nameInput) => {
      const name = (nameInput.value || "").trim();
      if (!name) return;
      const imgBlock = nameInput.closest(".gridItemImage") || nameInput.parentElement;
      const sku = (imgBlock.querySelector(".gtag_view_item_id") || {}).value || name;
      if (seen.has(sku)) return;
      seen.add(sku);

      let card = imgBlock;
      for (let i = 0; i < 5 && card.parentElement; i++) {
        if (parsePoints(card.textContent)) break;
        card = card.parentElement;
      }
      if (card.dataset.bpxDone) return;
      card.dataset.bpxDone = "1";
      const points = parsePoints(card.textContent);

      card.insertAdjacentHTML(
        "beforeend",
        '<div class="bpx-badge">' +
          '<span class="bpx-pts">' + (points != null ? nf(points) + " 點" : "點數?") + "</span>" +
          '<input class="bpx-price" type="number">' +
          '<button class="bpx-search" type="button">查價</button>' +
          '<a class="bpx-link" target="_blank" rel="noopener" style="display:none">商品↗</a>' +
          '<span class="bpx-per"></span>' +
          "</div>"
      );
      const badge = card.lastElementChild;
      const input = badge.querySelector(".bpx-price");
      const searchBtn = badge.querySelector(".bpx-search");
      const linkEl = badge.querySelector(".bpx-link");
      const per = badge.querySelector(".bpx-per");

      const it = {
        sku, name, points, input, per, linkEl, card,
        priceTwd: sku in priceCache ? priceCache[sku] : null,
        linkUrl: sku in linkCache ? linkCache[sku] : null,
      };
      items.push(it);
      renderItem(it);
      setLink(it);
      linkEl.addEventListener("click", (e) => e.stopPropagation());

      [input, searchBtn].forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));
      input.addEventListener("input", () => {
        it.priceTwd = fromDisplay(parseFloat(input.value));
        if (it.priceTwd == null) {
          delete priceCache[sku];
          chrome.storage.local.remove("price_" + sku);
        } else {
          priceCache[sku] = it.priceTwd;
          chrome.storage.local.set({ ["price_" + sku]: it.priceTwd });
        }
        per.textContent = perText(it.priceTwd, it.points);
        renderList();
      });
      searchBtn.addEventListener("click", (e) => {
        e.preventDefault();
        lookup(it);
      });
    });
  }

  // google.js 抓到價格寫回 chrome.storage → 這裡即時更新對應商品卡。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    Object.keys(changes).forEach((k) => {
      const nv = changes[k].newValue;
      if (k.startsWith("price_")) {
        const sku = k.slice(6);
        if (typeof nv === "number") priceCache[sku] = nv;
        else delete priceCache[sku];
        const it = items.find((x) => x.sku === sku);
        if (it) { it.priceTwd = typeof nv === "number" ? nv : null; renderItem(it); renderList(); }
      } else if (k.startsWith("link_")) {
        const sku = k.slice(5);
        if (nv) linkCache[sku] = nv; else delete linkCache[sku];
        const it = items.find((x) => x.sku === sku);
        if (it) { it.linkUrl = nv || null; setLink(it); }
      }
    });
  });

  function buildPanel() {
    if (document.querySelector(".bpx-panel")) return;
    const p = document.createElement("div");
    p.className = "bpx-panel" + (settings.collapsed ? " bpx-min" : "");
    p.innerHTML =
      '<div class="bpx-bar">' +
        '<span class="bpx-title">藍血價值 Blue Points Value</span>' +
        '<button class="bpx-toggle" type="button"></button>' +
      "</div>" +
      '<div class="bpx-head">' +
        '<button class="bpx-all" type="button">查本頁未查的</button>' +
        '<button class="bpx-cur" type="button"></button>' +
        '<span class="bpx-rate-info"></span>' +
      "</div>" +
      '<div class="bpx-head">' +
        '<span class="bpx-count"></span>' +
        '<button class="bpx-sort" type="button"></button>' +
      "</div>" +
      '<div class="bpx-list"></div>';
    document.body.appendChild(p);

    const toggleBtn = p.querySelector(".bpx-toggle");
    const syncMin = () => (toggleBtn.textContent = settings.collapsed ? "＋" : "－");
    syncMin();
    toggleBtn.addEventListener("click", () => {
      settings.collapsed = !settings.collapsed;
      lstore.set("collapsed", settings.collapsed ? "1" : "0");
      p.classList.toggle("bpx-min", settings.collapsed);
      syncMin();
    });

    const allBtn = p.querySelector(".bpx-all");
    allBtn.addEventListener("click", () => runBatch(allBtn));
    const curBtn = p.querySelector(".bpx-cur");
    const rateInfo = p.querySelector(".bpx-rate-info");
    listEl = p.querySelector(".bpx-list");
    countEl = p.querySelector(".bpx-count");
    const sortBtn = p.querySelector(".bpx-sort");
    const syncSort = () => (sortBtn.textContent = "每點價值 " + (sortDir < 0 ? "▼" : "▲"));
    syncSort();
    sortBtn.addEventListener("click", () => { sortDir = -sortDir; syncSort(); renderList(); });

    // 點清單列 → 捲到該商品卡並短暫高亮
    listEl.addEventListener("click", (e) => {
      const row = e.target.closest(".bpx-row");
      if (!row) return;
      const it = items.find((x) => x.sku === row.dataset.sku);
      if (!it || !it.card) return;
      it.card.scrollIntoView({ behavior: "smooth", block: "center" });
      it.card.classList.add("bpx-hit");
      setTimeout(() => it.card.classList.remove("bpx-hit"), 1500);
    });

    function sync() {
      curBtn.textContent = "幣別 " + settings.currency + " ⇄";
      const usd = settings.currency === "USD";
      rateInfo.textContent = usd ? "匯率 " + settings.rate : "";
      rateInfo.style.display = usd ? "" : "none";
    }
    sync();
    curBtn.addEventListener("click", () => {
      settings.currency = settings.currency === "TWD" ? "USD" : "TWD";
      lstore.set("cur", settings.currency);
      sync();
      renderAll();
    });

    // 即期匯率自動抓（僅 USD 模式用得到；不給手動設定）
    chrome.runtime.sendMessage({ type: "bpx-rate" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      settings.rate = +resp.rate.toFixed(3);
      lstore.set("rate", settings.rate); // 快取最後一次匯率，離線時當 fallback
      sync();
      renderAll();
    });
  }

  // self-check（每次載入跑，壞了 console 會叫）
  function selfCheck() {
    const ok =
      parsePoints("1,234 點") === 1234 &&
      parsePoints("5000 points") === 5000 &&
      parsePoints("免費") === null &&
      parsePoints("") === null &&
      perWarn(1600, 100) === true &&  // 16/點 > 15
      perWarn(50, 100) === true &&    // 0.5/點 < 1
      perWarn(500, 100) === false &&  // 5/點 正常
      perWarn(300, null) === false;   // 沒點數不判定
    if (!ok) console.error("[BPX] parsePoints self-check FAILED");
  }
  selfCheck();

  const observer = new MutationObserver(run);
  function run() {
    observer.disconnect();
    try {
      enhanceCards();
      renderList();
    } finally {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  buildPanel();
  // 先讀出已存的市價，再開始掃描（避免 async storage 造成初始空白）。
  chrome.storage.local.get(null, (all) => {
    Object.keys(all).forEach((k) => {
      if (k.startsWith("price_")) priceCache[k.slice(6)] = all[k];
      else if (k.startsWith("link_")) linkCache[k.slice(5)] = all[k];
    });
    run();
  });
})();
