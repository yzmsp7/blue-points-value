// Service worker：收到商城卡片的查價請求 → 背景 fetch 搜尋引擎抓第一個合理價格寫回
// chrome.storage.local，商城分頁的 onChanged 監聽即時填入。不開任何分頁。
// 來源備援鏈：Bing → DuckDuckGo →（保底）Google。Bing/DDG 不需登入 cookie、限制較寬鬆，
// 第一個抓到價的就贏、命中即停；全落空才回失敗。Google 保留當最後手段（帶 cookie 繞 CAPTCHA）。
"use strict";

// 防呆：價格附近若出現「銷售一空/缺貨/完售…」就跳過，避免抓到售完商品的殘留標價。
const SOLDOUT = /銷售一空|已?售完|完售|缺貨|補貨中|無現貨|sold\s*out|out\s*of\s*stock|no longer available/i;

// 被判定為機器人 → Google 導向 /sorry/ 或回「異常流量/請證明你不是機器人」頁。用來和「真的查不到價」區分。
const BLOCKED = /\/sorry\/|unusual traffic|異常流量|系統偵測|我們的系統|not a robot|recaptcha/i;

// ponytail: 取 HTML 裡第一個 NT$ 價格（DOM 順序≈相關度），跳過標示售完者。誤抓廣告價就用市價欄手動覆寫；
// 售完判斷用固定 200 字視窗，抓錯就調視窗或改解析 shopping 結構。
function parsePrice(html) {
  const re = /(?:NT\$|＄|\$)\s?([\d,]{3,})/g;
  let m;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (n < 100 || n > 5000000) continue;
    const ctx = html.slice(Math.max(0, m.index - 200), m.index + 200);
    if (SOLDOUT.test(ctx)) continue;
    return n;
  }
  return null;
}

// ponytail: 取第一個外部結果連結，通吃三家 redirect：DDG /l/?uddg= → Google /url?q= → 直接 href。
// 抓錯就當參考，人眼點開自會判斷。
function parseLink(html) {
  const skip = /google\.|bing\.|duckduckgo\.|gstatic\.|googleusercontent\.|msn\.|microsoft\.|schema\.org/;
  let m;
  const reUddg = /[?&]uddg=([^&"]+)/g;            // DuckDuckGo 轉址
  while ((m = reUddg.exec(html))) {
    const u = decodeURIComponent(m[1]);
    if (/^https?:\/\//.test(u) && !skip.test(u)) return u;
  }
  const reQ = /\/url\?q=(https?:\/\/[^&"]+)/g;     // Google 舊式轉址
  while ((m = reQ.exec(html))) {
    const u = decodeURIComponent(m[1]);
    if (!skip.test(u)) return u;
  }
  const reH = /href="(https?:\/\/[^"]+)"/g;        // Bing / 通用直接連結
  while ((m = reH.exec(html))) {
    if (!skip.test(m[1])) return m[1];
  }
  return null;
}

// self-check（載入即跑，壞了 console 會叫）
(function () {
  const ok =
    parsePrice("NT$1,290 現貨供應") === 1290 &&
    parsePrice("銷售一空 NT$999 待補貨") === null &&
    parsePrice("NT$50 配件 正品 NT$3,200") === 3200 &&
    BLOCKED.test("https://www.google.com/sorry/index") === true &&
    BLOCKED.test("正品 現貨供應") === false &&
    parseLink('<a href="/l/?uddg=https%3A%2F%2Fexample.com%2Fp">') === "https://example.com/p" &&
    parseLink('<a href="https://www.bing.com/x">x</a><a href="https://shop.tw/p">p</a>') === "https://shop.tw/p";
  if (!ok) console.error("[BPX bg] parsePrice self-check FAILED");
})();

// 來源備援鏈（順序即優先序）。Bing/DDG 不需 cookie、限制較寬鬆；Google 帶 cookie 當保底繞 CAPTCHA。
const SOURCES = [
  { name: "bing",   creds: "omit",    url: (q) => "https://www.bing.com/search?cc=tw&setlang=zh-TW&q=" + encodeURIComponent(q + " 價格") },
  { name: "ddg",    creds: "omit",    url: (q) => "https://html.duckduckgo.com/html/?kl=tw-tzh&q=" + encodeURIComponent(q + " 價格") },
  { name: "google", creds: "include", url: (q) => "https://www.google.com/search?gl=tw&hl=zh-TW&q=" + encodeURIComponent(q + " 價格") },
];

// 打一個來源：8s 逾時中斷（避免被導向同意頁時無限等待）。回 { price, link, blocked }。
function fetchOne(url, creds) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  return fetch(url, { credentials: creds, signal: ctrl.signal })
    .then((r) => r.text().then((html) => ({ html, finalUrl: r.url })))
    .then(({ html, finalUrl }) => {
      clearTimeout(t);
      return { price: parsePrice(html), link: parseLink(html), blocked: BLOCKED.test(finalUrl) || BLOCKED.test(html) };
    })
    .catch(() => { clearTimeout(t); return { price: null, link: null, blocked: false }; });
}

// 依序打 SOURCES：第一個抓到價的就寫回 storage 並回 ok；全落空才回失敗。
async function runChain(q, sku) {
  let googleBlocked = false;
  for (const s of SOURCES) {
    const { price, link, blocked } = await fetchOne(s.url(q), s.creds);
    if (s.name === "google") googleBlocked = blocked; // 限流只認 Google 保底那次
    const out = {};
    if (price != null) out["price_" + sku] = price;
    if (link) out["link_" + sku] = link;
    if (Object.keys(out).length) chrome.storage.local.set(out);
    if (price != null) { console.log("[BPX bg]", s.name, "命中", price); return { ok: true, price }; }
    console.log("[BPX bg]", s.name, blocked ? "被擋" : "無價，換下一個");
  }
  return { ok: false, error: googleBlocked ? "blocked" : "no-price" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "bpx-rate") {
    fetch("https://open.er-api.com/v6/latest/USD")
      .then((r) => r.json())
      .then((j) => {
        const rate = j && j.rates && j.rates.TWD;
        sendResponse(rate ? { ok: true, rate } : { ok: false });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type !== "bpx-price") return;
  runChain(msg.q, msg.sku).then(sendResponse);
  return true; // 非同步回覆
});
