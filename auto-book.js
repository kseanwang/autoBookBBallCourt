/**
 * 台北市場地租借自動搶位腳本 v4.0
 *
 * 流程：
 *   預熱期（PRE_LOAD_SECONDS 前）：嘗試進入 Step2；若場地尚未開放受理會被導回首頁，此時僅記錄狀態，不視為錯誤
 *   精準時間到達：持續輪詢 Step2 是否已開放 → 開放後直接呼叫網站的選位/送出 API，不模擬滑鼠點擊
 *
 * v4.0 相對 v3.0 的修正：
 *   1. 修正誤判：網站按鈕 status=4 + class "rented" 代表「已被他人訂走」，不是「尚未開放」
 *      （尚未開放的日期網站用另一個 class "not-open-yet"，且未開放的場地整個 Step1/Step2
 *      會被 302 導回首頁並跳出「場地未開放受理」，不會停留在 Step2 顯示按鈕）
 *   2. 移除錯誤的「成功」判定：原本把「本時段僅保留10分鐘」彈窗當成搶到的訊號，
 *      但這個彈窗是網站在送出前一定會跳出的提示（不論最後有沒有搶到），
 *      會導致某個 Bot 誤判成功、讓其他 Bot 提早放棄。現在一律以「是否真的導到 Step3」為準。
 *   3. 選時段改成直接呼叫網站的 chooseRentalPartial API（頁面內 fetch），
 *      不再用滑鼠模擬點擊：避開網站點擊後蓋版 1~3 秒的 loading 遮罩造成點擊被吃掉，
 *      也避開網站自己「等超過 2 秒就放棄結果」的前端邏輯（在搶位尖峰時反而會把真正成功的回應丟掉）。
 *      選位成功後仍呼叫網站原生的 getSessionChoose()，確保後續送出表單所需的隱藏欄位跟真人操作一致。
 *   4. 場地開放瞬間改用輕量 fetch 輪詢 Step2 是否可進入（redirect:manual 偵測 302），
 *      比每次整頁 reload 快很多，抓到後才真正 goto 進去。
 *   5. 加入伺服器時間校正（HEAD 請求讀 Date header），避免本機時鐘誤差讓精準等待偏移。
 *   6. 多個瀏覽器並行搶位（NUM_BOTS）
 *
 * 使用方式：
 *   node auto-book.js --config '{"venueId":"...","targetDateText":"...","numBots":2}'
 *   node auto-book.js --now --config '{...}'
 *   node auto-book.js --now
 */

const puppeteer = require("puppeteer");
const path = require("path");

// ====== 解析設定 ======
const isNowMode = process.argv.includes("--now");
// 登入模式：開一個看得到畫面的瀏覽器，讓使用者自己在裡面完成台北通登入，
// 登入狀態存在下面的固定使用者資料夾，之後真正搶位的瀏覽器共用同一份資料夾即可沿用登入
const isLoginMode = process.argv.includes("--login");
const configIdx = process.argv.indexOf("--config");
let externalConfig = null;
if (configIdx !== -1 && process.argv[configIdx + 1]) {
  try {
    externalConfig = JSON.parse(process.argv[configIdx + 1]);
  } catch (e) {
    console.error("❌ --config JSON 解析失敗:", e.message);
    process.exit(1);
  }
}

const VENUE_ID = externalConfig?.venueId || "27ee824a3be0";
const STEP1_URL = `https://service.gov.taipei/rental/OnLine/Step1/${VENUE_ID}`;
const STEP2_URL = `https://service.gov.taipei/rental/OnLine/Step2/${VENUE_ID}`;
// 場地是否開放受理的真正閘門是 Step1（Step2 只認「這個 session 是否已經 GET 過 Step1」，
// 跟場地本身開不開放無關；一個 session 沒visit過 Step1 就直接打 Step2 一律會被導回首頁）
const STEP1_PATH = `/rental/OnLine/Step1/${VENUE_ID}`;
const TARGET_DATE_TEXT =
  externalConfig?.targetDateText || "2026/07/07(二) 20:00~22:00";
const TARGET_MONTH = externalConfig?.targetMonth || 7;
const TARGET_DAY = externalConfig?.targetDay || 7;
const NUM_BOTS = externalConfig?.numBots || 2;

// 場次清單 API 需要 year/month/day：優先從時段文字解析（"2027/01/07(四) 09:00~17:00"），
// 解析不到才退回 config 的 targetMonth/targetDay 與今年
const TARGET_YMD = (() => {
  const m = TARGET_DATE_TEXT.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  return {
    year: new Date().getFullYear(),
    month: TARGET_MONTH,
    day: TARGET_DAY,
  };
})();

let EXECUTE_TIME;
if (externalConfig?.executeDate && externalConfig?.executeTime) {
  EXECUTE_TIME = new Date(
    `${externalConfig.executeDate}T${externalConfig.executeTime}:00+08:00`,
  );
} else {
  EXECUTE_TIME = new Date("2026-06-06T00:00:00+08:00");
}

// 預熱時間拉長到 60 秒，確保多個瀏覽器與批次多時段都能在整點前完成預載
const PRE_LOAD_SECONDS = 60;
// 開放瞬間最多願意持續輪詢等待的時間（場地卡在「未開放」超過這個秒數才放棄）
const OPEN_WAIT_TIMEOUT_MS = 15000;
// 選位 API 最多重試的時間預算
const CHOOSE_TIMEOUT_MS = 8000;

// 固定的 Chrome 使用者資料夾：Cloudways 伺服器模式沒有真人可以手動登入，
// 只能退回自己 launch 瀏覽器、盡量沿用同一份 profile 的做法（仍可能因未登入被 500 擋下）
const USER_DATA_DIR = path.join(__dirname, ".puppeteer-profile");

// 本機模式改成連線到「使用者自己手動啟動」的 Chrome，而不是用 puppeteer.launch() 開新的。
// 原因：puppeteer.launch() 啟動的瀏覽器會帶 navigator.webdriver=true 這個自動化旗標，
// 就算使用者在裡面真的手打帳密登入台北通，登入也可能在網站/OAuth 那端被判定為機器人
// 而沒有真的生效（實測 LoginArea('no','') 是伺服器端渲染的，代表伺服器真的不認為你登入了）。
// 改成連線到一個使用者用一般方式（非 puppeteer 啟動）打開、帶除錯埠的 Chrome，
// navigator.webdriver 就會維持 false，登入才會是「看起來完全像真人」的正常瀏覽器行為。
const CDP_PORT = process.env.CDP_PORT || 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const CHROME_LAUNCH_HINT = `open -na "Google Chrome" --args --remote-debugging-port=${CDP_PORT} --user-data-dir="$HOME/Library/Application Support/autobook-chrome-profile"`;

async function connectToRealChrome() {
  try {
    return await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  } catch (e) {
    throw new Error(
      `無法連線到 Chrome（${CDP_URL}）。請先在終端機手動執行下面這行，開啟一個帶除錯埠的 Chrome：\n` +
      `  ${CHROME_LAUNCH_HINT}\n` +
      `開啟後保持該視窗開著，再重新執行這個任務。（原始錯誤: ${e.message}）`
    );
  }
}

// 跨 Bot 共享狀態
const shared = { done: false, step3Url: null };

// 與伺服器時間的偏移量（ms）：serverTime = Date.now() + timeOffsetMs
let timeOffsetMs = 0;
function now() {
  return Date.now() + timeOffsetMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  const nowStr = new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
  });
  console.log(`[${nowStr}] ${msg}`);
}

// =============================================
// 校正與台北市政府伺服器的時間差，避免本機時鐘誤差
// =============================================
async function syncServerTime() {
  try {
    const res = await fetch("https://service.gov.taipei/rental/", {
      method: "HEAD",
    });
    const dateHeader = res.headers.get("date");
    const serverTime = dateHeader ? new Date(dateHeader).getTime() : NaN;
    if (!Number.isNaN(serverTime)) {
      timeOffsetMs = serverTime - Date.now();
      log(`🕐 已校正伺服器時間，偏移量: ${timeOffsetMs}ms`);
      return;
    }
  } catch (e) {
    log(`⚠️ 時間校正失敗，改用本機時鐘: ${e.message}`);
  }
  timeOffsetMs = 0;
}

async function waitUntilTarget() {
  if (isNowMode) {
    log("⚡ 立即執行模式（--now）");
    return;
  }

  const preLoadTime = new Date(
    EXECUTE_TIME.getTime() - PRE_LOAD_SECONDS * 1000,
  );

  while (true) {
    const diff = preLoadTime.getTime() - now();

    if (diff <= 0) {
      log("⏰ 預熱時間到！啟動瀏覽器並預載頁面...");
      break;
    }

    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    process.stdout.write(
      `\r⏳ 距離執行還有 ${hours}小時 ${mins}分 ${secs}秒    `,
    );

    await sleep(diff > 60000 ? 10000 : diff > 5000 ? 1000 : 100);
  }
  console.log("");
}

async function preciseWaitUntilExact() {
  if (isNowMode) return;
  while (now() < EXECUTE_TIME.getTime()) {
    await sleep(10);
  }
  log("🎯 精準時間到達！");
}

// =============================================
// 導航日曆到目標月份和日期（純視覺化：實際的日期 context 由 loadSessionList() 建立，
// datepicker 尚未渲染完成時這裡會靜靜失敗，不影響搶位流程）
// =============================================
async function navigateToTargetDate(page) {
  const monthNames = [
    "",
    "一月",
    "二月",
    "三月",
    "四月",
    "五月",
    "六月",
    "七月",
    "八月",
    "九月",
    "十月",
    "十一月",
    "十二月",
  ];
  const targetMonthText = monthNames[TARGET_MONTH] || "";

  for (let attempt = 0; attempt < 12; attempt++) {
    const monthText = await page.evaluate(() => {
      const sw = document.querySelector(".datepicker-switch");
      return sw ? sw.textContent.trim() : "";
    });
    if (
      monthText.includes(targetMonthText) ||
      monthText.includes(`${TARGET_MONTH}月`)
    )
      break;
    await page.evaluate(() => {
      const nextBtn = document.querySelector("th.next");
      if (nextBtn) nextBtn.click();
    });
    await page
      .waitForFunction(
        (prev) => {
          const sw = document.querySelector(".datepicker-switch");
          return sw && sw.textContent.trim() !== prev;
        },
        { timeout: 1000 },
        monthText,
      )
      .catch(() => {});
  }

  await page.evaluate((day) => {
    const tds = document.querySelectorAll(
      ".datepicker-days td.day:not(.old):not(.new)",
    );
    for (const td of tds) {
      if (td.textContent.trim() === String(day)) {
        td.click();
        return;
      }
    }
  }, TARGET_DAY);

  await page
    .waitForSelector(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`, {
      timeout: 3000,
    })
    .catch(() => {});
}

// =============================================
// Step 1：被重導才呼叫（CheckYes() 純前端 redirect，直接 goto Step2 通常就夠）
// =============================================
async function doStep1(page, botId) {
  log(`[Bot ${botId}] 📋 Step1：閱讀並同意條款`);
  try {
    await page.goto(STEP1_URL, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  } catch (err) {
    log(`[Bot ${botId}] ⚠️ Step1 載入超時，繼續...`);
  }

  if (!page.url().includes("/OnLine/Step1/")) {
    // 被導回首頁：場地尚未開放受理，直接回報，讓上層的開放輪詢機制接手
    return;
  }

  await page.waitForSelector("#chkYes", { timeout: 5000 }).catch(() => {});
  const chk = await page.$("#chkYes");
  if (chk) {
    const isChecked = await page.evaluate(
      () => document.getElementById("chkYes").checked,
    );
    if (!isChecked) await page.click("#chkYes");
    await page.evaluate(() => {
      if (typeof CheckRead === "function") CheckRead();
    });
  }

  const btn = await page.$("#PersonalPolicyYes");
  if (btn) {
    try {
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 10000,
        }),
        page.click("#PersonalPolicyYes"),
      ]);
    } catch (err) {
      // 忽略，交由呼叫端檢查最終 URL
    }
  }
  log(`[Bot ${botId}] ✅ Step1 完成`);
}

// =============================================
// 預熱：嘗試走到 Step2；若場地尚未開放受理，只記錄狀態不當作錯誤
// =============================================
async function preLoad(page, botId) {
  log(`[Bot ${botId}] 📄 直接嘗試載入 Step2...`);
  try {
    await page.goto(STEP2_URL, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  } catch (err) {
    log(`[Bot ${botId}] ⚠️ Step2 載入超時，繼續...`);
  }

  if (!page.url().includes("/OnLine/Step2/")) {
    await doStep1(page, botId);
  }

  if (!page.url().includes("/OnLine/Step2/")) {
    log(`[Bot ${botId}] ⚠️ 場地目前尚未開放受理，將於執行時間持續嘗試進入`);
    return;
  }

  await page
    .waitForSelector("#CounterPeriodForm", { timeout: 8000 })
    .catch(() => {});
  await page
    .waitForSelector(".datepicker-switch", { timeout: 5000 })
    .catch(() => {});
  log(`[Bot ${botId}] 📅 導航日曆到 ${TARGET_MONTH}/${TARGET_DAY}...`);
  await navigateToTargetDate(page);
  // 預熱就先把日期 context 建立起來，開放瞬間少一次來回
  await loadSessionList(page);

  const btnInfo = await page.evaluate((targetText) => {
    const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
    return btn
      ? {
          status: btn.getAttribute("status"),
          ischoose: btn.getAttribute("ischoose"),
          rented: btn.classList.contains("rented"),
        }
      : null;
  }, TARGET_DATE_TEXT);
  log(`[Bot ${botId}] ✅ 預熱完成，按鈕: ${JSON.stringify(btnInfo)}`);
}

// =============================================
// 場地開放輪詢：用輕量 fetch（redirect:manual）偵測 Step1 是否已可進入。
// 用 Step1 而不是 Step2，是因為 Step2 的可進入與否只取決於這個 session 有沒有
// GET 過 Step1（跟場地開不開放無關），Step1 才是真正被「未開放受理」擋下的關卡。
// 這次 fetch 成功後，session 也會同時記到「已看過 Step1」，緊接著 goto Step2 就會成功。
// =============================================
async function pollStep1Reachable(page, path, deadlineTs) {
  while (now() < deadlineTs) {
    const reachable = await page
      .evaluate(async (p) => {
        try {
          const res = await fetch(p, {
            method: "GET",
            credentials: "same-origin",
            redirect: "manual",
          });
          return res.type !== "opaqueredirect" && res.status === 200;
        } catch (e) {
          return false;
        }
      }, path)
      .catch(() => false);
    if (reachable) return true;
    await sleep(120);
  }
  return false;
}

async function ensureStep2Ready(page, botId, deadlineTs) {
  if (page.url().includes("/OnLine/Step2/")) {
    const hasForm = await page.$("#CounterPeriodForm");
    if (hasForm) return true;
  }

  log(`[Bot ${botId}] ⏳ 場地尚未開放，開始輪詢...`);
  const reachable = await pollStep1Reachable(page, STEP1_PATH, deadlineTs);
  if (!reachable) {
    log(`[Bot ${botId}] ❌ 等待場地開放逾時`);
    return false;
  }

  log(`[Bot ${botId}] 🚪 偵測到場地開放，進入 Step2...`);
  try {
    await page.goto(STEP2_URL, {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    });
  } catch (err) {
    log(`[Bot ${botId}] ⚠️ Step2 載入超時: ${err.message}`);
  }
  if (!page.url().includes("/OnLine/Step2/")) return false;

  await page
    .waitForSelector("#CounterPeriodForm", { timeout: 5000 })
    .catch(() => {});
  return !!(await page.$("#CounterPeriodForm"));
}

// =============================================
// 載入「當日場次清單」（等同真人在日曆上點下目標日期）。
// 這一步不是視覺效果而已：伺服器會在 session 裡記住目前選的日期，
// 沒有先打這支就直接呼叫 chooseRentalPartial，伺服器一律回 HTTP 500 錯誤頁（實測）。
// 預熱期的日曆點擊有可能因為 datepicker 尚未渲染而靜靜失敗，所以這裡改用 fetch 直接打，
// 不依賴任何 DOM 點擊。
// =============================================
async function loadSessionList(page) {
  return page.evaluate(
    async (ObjectID, year, month, day) => {
      try {
        const res = await fetch(
          "/rental/CounterPlace/_CounterSessionListPartial",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: `ObjectID=${encodeURIComponent(
              ObjectID,
            )}&year=${year}&month=${month}&day=${day}`,
            credentials: "same-origin",
          },
        );
        if (!res.ok) return false;
        const text = await res.text();
        const el = document.getElementById("SessionList");
        if (el) el.innerHTML = text;
        return true;
      } catch (e) {
        return false;
      }
    },
    VENUE_ID,
    TARGET_YMD.year,
    TARGET_YMD.month,
    TARGET_YMD.day,
  );
}

// =============================================
// 直接呼叫網站的選位 API（頁面內 fetch，等同真人點擊時段按鈕的效果），
// 選成功後呼叫網站原生 getSessionChoose() 補齊送出表單所需的隱藏欄位
// =============================================
async function chooseSlotViaFetch(page, targetDateText) {
  return page.evaluate(
    async (ObjectID, allDate) => {
      try {
        const res = await fetch("/rental/CounterPlace/chooseRentalPartial", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: `ObjectID=${encodeURIComponent(
            ObjectID,
          )}&allDate=${encodeURIComponent(allDate)}`,
          credentials: "same-origin",
        });
        const text = await res.text();

        // 伺服器對「時段已被搶走」等情況有時會回 500 + HTML 錯誤頁（不是 JSON），
        // 一定要先擋掉，否則會把整個錯誤頁誤判成「成功片段」塞進 #ScheduleList
        if (!res.ok) {
          // 去掉標籤只留文字內容，方便看到錯誤頁真正想講的原因（例如「請先登入」）
          const plain = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return {
            ok: false,
            message: `HTTP ${res.status}: ${plain.slice(0, 300)}`,
            httpError: true,
          };
        }

        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          /* 不是 JSON，代表是成功的 HTML 片段（與網站原生點擊行為一致） */
        }

        if (json) {
          return { ok: false, message: json.message || text };
        }

        // 網站原生點擊時段按鈕的回呼是把片段寫進 #ScheduleList（不是 #SessionList，
        // 這裡曾經寫錯過，導致選位其實已經成功，但畫面沒更新、程式誤判失敗一直重試到逾時）
        const scheduleList = document.getElementById("ScheduleList");
        if (scheduleList) scheduleList.innerHTML = text;
        if (typeof getSessionChoose === "function") getSessionChoose();

        // 網站原生 handler 對「非 JSON 回應」本身就視為成功，不再額外檢查 ischoose 屬性
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.message, networkError: true };
      }
    },
    VENUE_ID,
    targetDateText,
  );
}

const TAKEN_KEYWORDS = [
  "已出租",
  "已被預約",
  "已被訂",
  "已額滿",
  "已租",
  "已預約",
];

// 「已在列表中」代表這個時段其實已經成功加進預約清單（可能是這個 Bot 前一次
// 送出時回應被吃掉，或同 session 先前就已選過），是成功不是失敗。
// 之前把它丟進重試迴圈，結果位子明明已經選到了，卻一路重試到逾時、從來沒按下一步。
const ALREADY_CHOSEN_KEYWORDS = ["已在列表中"];

async function selectTargetSlot(page, botId, targetDateText, deadlineTs) {
  let attempt = 0;
  // 先載入當日場次清單，否則選位 API 會直接回 500
  await loadSessionList(page);

  while (now() < deadlineTs) {
    if (shared.done) return false;
    attempt += 1;

    const result = await chooseSlotViaFetch(page, targetDateText);
    if (result.ok) {
      log(`[Bot ${botId}] ✅ 已選定時段（第 ${attempt} 次嘗試）`);
      return true;
    }

    const msg = result.message || "未知原因";
    if (ALREADY_CHOSEN_KEYWORDS.some((k) => msg.includes(k))) {
      log(`[Bot ${botId}] ✅ 時段已在預約清單中，直接送出（第 ${attempt} 次嘗試）`);
      await page.evaluate(() => {
        if (typeof getSessionChoose === "function") getSessionChoose();
      });
      return true;
    }
    if (TAKEN_KEYWORDS.some((k) => msg.includes(k))) {
      log(`[Bot ${botId}] ❌ 時段已被他人搶走：${msg}`);
      return false;
    }
    // 500 錯誤頁通常代表 session 掉了日期 context，重新載入場次清單再試
    if (result.httpError) {
      await loadSessionList(page);
    }
    if (attempt === 1 || attempt % 5 === 0) {
      log(`[Bot ${botId}] 第 ${attempt} 次選位未成功：${msg}`);
    }
    await sleep(150);
  }
  log(`[Bot ${botId}] ❌ 選位逾時`);
  return false;
}

// =============================================
// 送出預約（呼叫網站原生 showReservationAlert()，等同點擊「下一步」）
// 成功與否一律以是否真的導到 Step3 為準，「保留10分鐘」彈窗只是提示不是成功訊號
// =============================================
async function submitReservation(page, botId) {
  log(`[Bot ${botId}] 🔄 送出預約...`);
  const navPromise = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 })
    .catch(() => null);
  await page.evaluate(() => {
    if (typeof showReservationAlert === "function") {
      showReservationAlert();
    }
  });
  await navPromise;

  const url = page.url();
  if (url.includes("/OnLine/Step3/")) {
    return url;
  }

  // 導航沒發生，再多等一下讓非同步的 LoadcheckCounter 有機會跑完
  const extraDeadline = Date.now() + 3000;
  while (Date.now() < extraDeadline) {
    if (page.url().includes("/OnLine/Step3/")) return page.url();
    await sleep(150);
  }
  return null;
}

async function selectAndSubmit(page, botId) {
  if (shared.done) {
    log(`[Bot ${botId}] 其他 Bot 已成功，略過`);
    return false;
  }

  const openDeadline = now() + OPEN_WAIT_TIMEOUT_MS;
  const ready = await ensureStep2Ready(page, botId, openDeadline);
  if (!ready) return false;
  if (shared.done) return false;

  // 不再用 status/class 猜測「已被搶走」或「尚未開放」：網站圖例上 status=4 寫的是
  // 「尚未開放」而不是「已出租」，用它判斷已被搶走方向是錯的。一律直接呼叫選位 API，
  // 讓伺服器的真實回應（TAKEN_KEYWORDS）判斷是否真的被搶走；「尚未開放」類訊息會
  // 自然落入下方重試迴圈，直到逾時或轉為可選為止
  const chooseDeadline = now() + CHOOSE_TIMEOUT_MS;
  const chosen = await selectTargetSlot(
    page,
    botId,
    TARGET_DATE_TEXT,
    chooseDeadline,
  );
  if (!chosen || shared.done) return false;

  const step3Url = await submitReservation(page, botId);
  if (step3Url) {
    shared.done = true;
    shared.step3Url = step3Url;
    log(`[Bot ${botId}] 🎉 成功進入 Step3！`);
    return true;
  }

  log(`[Bot ${botId}] ❌ 送出後未導到 Step3，目前 URL: ${page.url()}`);
  return false;
}

// =============================================
// 單個 Bot 完整生命週期：browser 是共用的（連線到使用者的真實瀏覽器，或伺服器模式下
// 自己啟動的那個），每個 Bot 只負責開自己的分頁，不負責啟動/關閉整個瀏覽器
// =============================================
async function runBot(botId, browser) {
  let page;
  try {
    log(`[Bot ${botId}] 📄 開啟新分頁...`);
    page = await browser.newPage();

    page.on("dialog", async (dialog) => {
      const msg = dialog.message();
      log(`[Bot ${botId}] 💬 JS 彈窗: "${msg}"`);
      // 一律自動接受，避免卡住頁面；彈窗本身不代表成功或失敗，一律以是否導到 Step3 為準
      await dialog.accept();
    });

    await preLoad(page, botId);
    await preciseWaitUntilExact();

    const success = await selectAndSubmit(page, botId);
    return { page, success, botId };
  } catch (err) {
    log(`[Bot ${botId}] ❌ 錯誤: ${err.message}`);
    if (page) await page.close().catch(() => {});
    return { page: null, success: false, botId };
  }
}

// =============================================
// 登入模式：連線到使用者自己手動開啟（帶除錯埠）的真實 Chrome，讓使用者在裡面
// 自己完成台北通登入。故意不用 puppeteer.launch() 開新瀏覽器，因為那樣的瀏覽器
// navigator.webdriver 會是 true，網站/OAuth 可能因此判定是機器人，導致就算真人
// 手打帳密，登入也沒有真的生效（實測伺服器渲染的 LoginArea('no','') 證實了這點）。
// =============================================
async function runLoginMode() {
  log("🔑 登入模式啟動：正在連線到你手動開啟的 Chrome...");

  let browser;
  try {
    browser = await connectToRealChrome();
  } catch (e) {
    log(`❌ ${e.message}`);
    process.exit(1);
    return;
  }
  log("✅ 已連線到真實瀏覽器（不是自動化啟動的，網站不會偵測到 navigator.webdriver）");

  const page = await browser.newPage();
  await page
    .goto(STEP1_URL, { waitUntil: "domcontentloaded", timeout: 15000 })
    .catch(() => {});

  log(
    "👉 請在剛剛開啟的分頁裡，自己輸入帳密完成台北通登入（不要透過任何自動化工具代打帳密）",
  );
  log(
    "⏳ 完成登入後，回到控制台按下這個任務的「完成登入」按鈕即可（只會中斷程式與 Chrome 的連線，不會關閉你的 Chrome 視窗）",
  );

  await new Promise((resolve) => {
    process.on("SIGTERM", () => {
      log("🔌 收到關閉指令，正在中斷連線（Chrome 視窗會繼續保持開啟）...");
      resolve();
    });
  });

  await page.close().catch(() => {});
  browser.disconnect();
  log("✅ 已中斷連線，登入狀態留在你的 Chrome 裡");
  process.exit(0);
}

async function main() {
  if (isLoginMode) {
    await runLoginMode();
    return;
  }

  log("🚀 台北市場地租借自動搶位腳本啟動 v4.0");
  log(`📍 場地 ID: ${VENUE_ID}`);
  log(`🎯 目標時段：${TARGET_DATE_TEXT}`);
  log(`📅 目標日期：${TARGET_MONTH}月${TARGET_DAY}日`);
  log(`🤖 並行 Bot 數量：${NUM_BOTS}`);
  if (!isNowMode) {
    log(
      `⏰ 預定執行時間：${EXECUTE_TIME.toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei",
      })}`,
    );
  }

  await syncServerTime();
  await waitUntilTarget();

  const isServer = !!(
    process.env.CLOUDWAYS ||
    process.env.SERVER_MODE ||
    process.env.NODE_ENV === "production"
  );

  // ownBrowser=true 代表這個瀏覽器是我們自己 launch 的，程式結束時可以真的關閉它；
  // false 代表連線到使用者自己開的真實 Chrome，絕對不能關閉，只能 disconnect
  let browser;
  let ownBrowser = false;

  if (isServer) {
    // Cloudways 伺服器模式沒有真人可以手動登入，退回自己 launch 瀏覽器的舊做法，
    // 這種模式下的請求極可能還是匿名 session，仍會被選位 API 擋下
    log("   模式: headless (伺服器，無法手動登入台北通)");
    const launchOptions = {
      headless: "new",
      defaultViewport: { width: 1280, height: 900 },
      userDataDir: USER_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--window-size=1280,900",
      ],
    };
    if (process.env.CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.CHROMIUM_PATH;
      log(`   使用自訂 Chromium: ${process.env.CHROMIUM_PATH}`);
    }
    browser = await puppeteer.launch(launchOptions);
    ownBrowser = true;
  } else {
    log("   模式: 連線到手動啟動的真實 Chrome（本機）");
    try {
      browser = await connectToRealChrome();
    } catch (e) {
      log(`❌ ${e.message}`);
      process.exit(1);
      return;
    }
  }

  const results = await Promise.all(
    Array.from({ length: NUM_BOTS }, (_, i) => runBot(i + 1, browser)),
  );

  const successResult = results.find((r) => r.success && r.page);
  const step3Url = shared.step3Url;

  log("");
  if (step3Url) {
    log("🎊 ===========================");
    log("🎊   自動操作已完成！");
    log("🎊   已進入 Step3 頁面");
    log("🎊   請在瀏覽器中完成後續操作");
    log("🎊 ===========================");
    log(`📍 Step3 URL: ${step3Url}`);
    log(`STEP3_URL: ${step3Url}`);
  } else {
    log("⚠️ 所有 Bot 均未成功到達 Step3，請手動操作");
  }

  for (const r of results) {
    if (r.page && r !== successResult) {
      await r.page.close().catch(() => {});
      log(`[Bot ${r.botId}] 📄 分頁已關閉`);
    }
  }

  if (ownBrowser) {
    if (successResult?.page) {
      try {
        const screenshotPath = `screenshot-${Date.now()}.png`;
        await successResult.page.screenshot({
          path: screenshotPath,
          fullPage: true,
        });
        log(`📸 已儲存截圖: ${screenshotPath}`);
      } catch (e) {
        log(`⚠️ 截圖失敗: ${e.message}`);
      }
      log("⏳ 瀏覽器保持開啟 10 分鐘，請盡快點選控制台的「開啟 Step 3」按鈕");
      await sleep(600000);
    }
    await browser.close().catch(() => {});
    log("🌐 瀏覽器已關閉");
  } else {
    // 連線到使用者自己的 Chrome，絕對不能關閉整個瀏覽器，只中斷連線
    browser.disconnect();
    if (successResult?.page) {
      log("🔄 搶到的分頁保持開啟，請直接在該分頁完成後續操作（按 Ctrl+C 結束這個程式，Chrome 視窗不受影響）");
      await new Promise(() => {});
    }
  }
}

main().catch((err) => {
  console.error("❌ 腳本執行失敗：", err);
  process.exit(1);
});
