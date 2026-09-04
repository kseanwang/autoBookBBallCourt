const fs = require('fs');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const OPEN_WAIT_TIMEOUT_MS = 15000;
const CHOOSE_TIMEOUT_MS = 8000;
const TAKEN_KEYWORDS = ['已出租', '已被預約', '已被訂', '已額滿', '已租', '已預約'];

class BookingSession {
  constructor(onLog, onStatus) {
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.browsers = [];
    this.aborted = false;
    this.running = false;
    this.timeOffsetMs = 0;
  }

  log(msg) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const line = `[${now}] ${msg}`;
    console.log(line);
    this.onLog(line);
  }

  // 與伺服器時間的偏移量（ms）：serverTime = Date.now() + timeOffsetMs
  now() {
    return Date.now() + this.timeOffsetMs;
  }

  async syncServerTime() {
    try {
      const res = await fetch('https://service.gov.taipei/rental/', { method: 'HEAD' });
      const dateHeader = res.headers.get('date');
      const serverTime = dateHeader ? new Date(dateHeader).getTime() : NaN;
      if (!Number.isNaN(serverTime)) {
        this.timeOffsetMs = serverTime - Date.now();
        this.log(`🕐 已校正伺服器時間，偏移量: ${this.timeOffsetMs}ms`);
        return;
      }
    } catch (e) {
      this.log(`⚠️ 時間校正失敗，改用本機時鐘: ${e.message}`);
    }
    this.timeOffsetMs = 0;
  }

  stop() {
    this.aborted = true;
    for (const b of this.browsers) b.close().catch(() => {});
    this.browsers = [];
    this.onStatus({ type: 'stopped' });
  }

  async start(config) {
    if (this.running) return;
    this.running = true;
    this.aborted = false;

    const {
      venueId, targetDateText, targetMonth, targetDay,
      executeDate, executeTime, runNow, numBots,
    } = config;

    const TARGET_MONTH = parseInt(targetMonth);
    const TARGET_DAY = parseInt(targetDay);
    const NUM_BOTS = parseInt(numBots) || 2;
    const PRE_LOAD_SECONDS = 60;

    const STEP1_URL = `https://service.gov.taipei/rental/OnLine/Step1/${venueId}`;
    const STEP2_URL = `https://service.gov.taipei/rental/OnLine/Step2/${venueId}`;
    // 場地是否開放受理的真正閘門是 Step1（Step2 只認「這個 session 是否已經 GET 過 Step1」，
    // 跟場地本身開不開放無關；一個 session 沒 visit 過 Step1 就直接打 Step2 一律會被導回首頁）
    const STEP1_PATH = `/rental/OnLine/Step1/${venueId}`;

    let EXECUTE_TIME = null;
    if (executeDate && executeTime) {
      EXECUTE_TIME = new Date(`${executeDate}T${executeTime}:00+08:00`);
    }

    this.log(`🚀 搶位腳本啟動 v4.0`);
    this.log(`📍 場地 ID: ${venueId}`);
    this.log(`🎯 目標時段：${targetDateText}`);
    this.log(`🤖 並行 Bot 數量：${NUM_BOTS}`);
    if (!runNow && EXECUTE_TIME) {
      this.log(`⏰ 預定執行：${EXECUTE_TIME.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    }

    await this.syncServerTime();

    // ── 倒數等待（到預熱時間）──
    if (!runNow && EXECUTE_TIME) {
      const preLoadTime = new Date(EXECUTE_TIME.getTime() - PRE_LOAD_SECONDS * 1000);
      while (true) {
        if (this.aborted) { this.running = false; return; }
        const diff = preLoadTime.getTime() - this.now();
        if (diff <= 0) { this.log('⏰ 預熱時間到！啟動瀏覽器並預載頁面...'); break; }

        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        this.onStatus({ type: 'waiting', countdown: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` });

        await sleep(diff > 60000 ? 5000 : diff > 5000 ? 1000 : 200);
      }
    }

    if (this.aborted) { this.running = false; return; }

    // ── 找 Chrome ──
    const chromePath = findChrome();
    if (!chromePath) {
      this.log('❌ 找不到 Google Chrome，請先安裝後再試');
      this.onStatus({ type: 'error', message: '找不到 Chrome' });
      this.running = false;
      return;
    }

    let puppeteer;
    try {
      puppeteer = require('puppeteer-core');
    } catch (e) {
      this.log('❌ 找不到 puppeteer-core，請執行 npm install');
      this.onStatus({ type: 'error' });
      this.running = false;
      return;
    }

    this.onStatus({ type: 'running' });

    const launchOptions = {
      executablePath: chromePath,
      headless: false,
      defaultViewport: null,
      args: ['--window-size=1280,900'],
    };

    const shared = { done: false, step3Url: null };

    const makeBot = async (botId) => {
      let browser;
      try {
        this.log(`[Bot ${botId}] 🌐 啟動瀏覽器...`);
        browser = await puppeteer.launch(launchOptions);
        this.browsers.push(browser);
        const page = await browser.newPage();
        await page.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );

        page.on('dialog', async (dialog) => {
          const msg = dialog.message();
          this.log(`[Bot ${botId}] 💬 彈窗: "${msg}"`);
          // 一律自動接受，避免卡住頁面；彈窗本身不代表成功或失敗，一律以是否導到 Step3 為準
          await dialog.accept();
        });

        await this._preLoad(page, botId, STEP1_URL, STEP2_URL, targetDateText, TARGET_MONTH, TARGET_DAY);

        // 精準等待到整點
        if (!runNow && EXECUTE_TIME) {
          while (this.now() < EXECUTE_TIME.getTime()) {
            if (this.aborted) break;
            await sleep(10);
          }
          this.log(`[Bot ${botId}] 🎯 精準時間到達！`);
        }

        if (this.aborted) return { browser, page, success: false, botId };

        const success = await this._selectAndSubmit(
          page, botId, targetDateText, STEP2_URL, STEP1_PATH, shared
        );
        return { browser, page, success, botId };
      } catch (err) {
        this.log(`[Bot ${botId}] ❌ 錯誤: ${err.message}`);
        if (browser) {
          await browser.close().catch(() => {});
          this.browsers = this.browsers.filter(b => b !== browser);
        }
        return { browser: null, page: null, success: false, botId };
      }
    };

    try {
      const results = await Promise.all(
        Array.from({ length: NUM_BOTS }, (_, i) => makeBot(i + 1))
      );

      const successResult = results.find(r => r.success && r.browser);
      const step3Url = shared.step3Url;

      if (step3Url) {
        this.log('🎊 搶位完成！請在開啟的瀏覽器中完成 Step3');
        this.onStatus({ type: 'completed', step3Url });
      } else {
        this.log('⚠️ 所有 Bot 均未成功到達 Step3，請手動操作');
        this.onStatus({ type: 'error', message: '搶位未成功' });
      }

      for (const r of results) {
        if (r.browser && r !== successResult) {
          await r.browser.close().catch(() => {});
          this.browsers = this.browsers.filter(b => b !== r.browser);
          this.log(`[Bot ${r.botId}] 🌐 瀏覽器已關閉`);
        }
      }
    } catch (err) {
      if (!this.aborted) {
        this.log(`❌ 未預期錯誤：${err.message}`);
        this.onStatus({ type: 'error', message: err.message });
      }
    } finally {
      this.running = false;
    }
  }

  // ── 預熱：嘗試走到 Step2；若場地尚未開放受理，只記錄狀態不當作錯誤 ──
  async _preLoad(page, botId, STEP1_URL, STEP2_URL, targetDateText, TARGET_MONTH, TARGET_DAY) {
    this.log(`[Bot ${botId}] 📄 直接嘗試載入 Step2...`);
    try {
      await page.goto(STEP2_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      this.log(`[Bot ${botId}] ⚠️ Step2 載入超時，繼續...`);
    }

    if (!page.url().includes('/OnLine/Step2/')) {
      await this._doStep1(page, botId, STEP1_URL, STEP2_URL);
    }

    if (!page.url().includes('/OnLine/Step2/')) {
      this.log(`[Bot ${botId}] ⚠️ 場地目前尚未開放受理，將於執行時間持續嘗試進入`);
      return;
    }

    await page.waitForSelector('#CounterPeriodForm', { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('.datepicker-switch', { timeout: 5000 }).catch(() => {});
    this.log(`[Bot ${botId}] 📅 導航日曆到 ${TARGET_MONTH}/${TARGET_DAY}...`);
    await this._navigateToTargetDate(page, TARGET_MONTH, TARGET_DAY, targetDateText);

    const btnInfo = await page.evaluate((t) => {
      const btn = document.querySelector(`div.btn2[alldate="${t}"]`);
      return btn ? { status: btn.getAttribute('status'), ischoose: btn.getAttribute('ischoose'), rented: btn.classList.contains('rented') } : null;
    }, targetDateText);
    this.log(`[Bot ${botId}] ✅ 預熱完成，按鈕: ${JSON.stringify(btnInfo)}`);
  }

  // ── Step1（被重導才呼叫）──
  async _doStep1(page, botId, STEP1_URL, STEP2_URL) {
    this.log(`[Bot ${botId}] 📋 Step1：閱讀並同意條款`);
    try {
      await page.goto(STEP1_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      this.log(`[Bot ${botId}] ⚠️ Step1 載入超時，繼續...`);
    }

    if (!page.url().includes('/OnLine/Step1/')) {
      // 被導回首頁：場地尚未開放受理
      return;
    }

    await page.waitForSelector('#chkYes', { timeout: 5000 }).catch(() => {});
    const chk = await page.$('#chkYes');
    if (chk) {
      const isChecked = await page.evaluate(() => document.getElementById('chkYes').checked);
      if (!isChecked) await page.click('#chkYes');
      await page.evaluate(() => { if (typeof CheckRead === 'function') CheckRead(); });
    }

    const btn = await page.$('#PersonalPolicyYes');
    if (btn) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),
          page.click('#PersonalPolicyYes'),
        ]);
      } catch (err) {
        // 忽略，交由呼叫端檢查最終 URL
      }
    }
    this.log(`[Bot ${botId}] ✅ Step1 完成`);
  }

  // ── 導航日曆到目標日期（僅用於預熱期的視覺化確認，非必要步驟）──
  async _navigateToTargetDate(page, TARGET_MONTH, TARGET_DAY, targetDateText) {
    const monthNames = ['','一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    const targetMonthCN = monthNames[TARGET_MONTH] || '';

    for (let attempt = 0; attempt < 12; attempt++) {
      const monthText = await page.evaluate(() => {
        const sw = document.querySelector('.datepicker-switch');
        return sw ? sw.textContent.trim() : '';
      });
      if (monthText.includes(targetMonthCN) || monthText.includes(`${TARGET_MONTH}月`)) break;
      await page.evaluate(() => {
        const nextBtn = document.querySelector('th.next');
        if (nextBtn) nextBtn.click();
      });
      await page.waitForFunction(
        (prev) => {
          const sw = document.querySelector('.datepicker-switch');
          return sw && sw.textContent.trim() !== prev;
        },
        { timeout: 1000 },
        monthText
      ).catch(() => {});
    }

    await page.evaluate((day) => {
      const tds = document.querySelectorAll('.datepicker-days td.day:not(.old):not(.new)');
      for (const td of tds) {
        if (td.textContent.trim() === String(day)) { td.click(); return; }
      }
    }, TARGET_DAY);

    await page.waitForSelector(`div.btn2[alldate="${targetDateText}"]`, { timeout: 3000 }).catch(() => {});
  }

  // ── 場地開放輪詢：輕量 fetch（redirect:manual）偵測 Step1 是否已可進入。
  //    用 Step1 而不是 Step2，是因為 Step2 能不能進只看這個 session 有沒有 GET 過
  //    Step1（與場地開不開放無關），Step1 才是真正受「未開放受理」管制的關卡；
  //    這次 fetch 成功時 session 也同時記到「已看過 Step1」，緊接著 goto Step2 就會成功 ──
  async _pollStep1Reachable(page, path, deadlineTs) {
    while (this.now() < deadlineTs) {
      if (this.aborted) return false;
      const reachable = await page.evaluate(async (p) => {
        try {
          const res = await fetch(p, { method: 'GET', credentials: 'same-origin', redirect: 'manual' });
          return res.type !== 'opaqueredirect' && res.status === 200;
        } catch (e) {
          return false;
        }
      }, path).catch(() => false);
      if (reachable) return true;
      await sleep(120);
    }
    return false;
  }

  async _ensureStep2Ready(page, botId, STEP2_URL, STEP1_PATH, deadlineTs) {
    if (page.url().includes('/OnLine/Step2/')) {
      const hasForm = await page.$('#CounterPeriodForm');
      if (hasForm) return true;
    }

    this.log(`[Bot ${botId}] ⏳ 場地尚未開放，開始輪詢...`);
    const reachable = await this._pollStep1Reachable(page, STEP1_PATH, deadlineTs);
    if (!reachable) {
      this.log(`[Bot ${botId}] ❌ 等待場地開放逾時`);
      return false;
    }

    this.log(`[Bot ${botId}] 🚪 偵測到場地開放，進入 Step2...`);
    try {
      await page.goto(STEP2_URL, { waitUntil: 'domcontentloaded', timeout: 8000 });
    } catch (err) {
      this.log(`[Bot ${botId}] ⚠️ Step2 載入超時: ${err.message}`);
    }
    if (!page.url().includes('/OnLine/Step2/')) return false;

    await page.waitForSelector('#CounterPeriodForm', { timeout: 5000 }).catch(() => {});
    return !!(await page.$('#CounterPeriodForm'));
  }

  // ── 直接呼叫網站的選位 API（等同真人點擊時段按鈕），
  //    選成功後呼叫網站原生 getSessionChoose() 補齊送出表單所需的隱藏欄位 ──
  async _chooseSlotViaFetch(page, venueId, targetDateText) {
    return page.evaluate(async (ObjectID, allDate) => {
      try {
        const res = await fetch('/rental/CounterPlace/chooseRentalPartial', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: `ObjectID=${encodeURIComponent(ObjectID)}&allDate=${encodeURIComponent(allDate)}`,
          credentials: 'same-origin',
        });
        const text = await res.text();

        // 伺服器對「時段已被搶走」等情況有時會回 500 + HTML 錯誤頁（不是 JSON），
        // 一定要先擋掉，否則會把整個錯誤頁誤判成「成功片段」塞進 #ScheduleList
        if (!res.ok) {
          return { ok: false, message: `HTTP ${res.status}`, httpError: true };
        }

        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 不是 JSON，代表是成功的 HTML 片段（與網站原生點擊行為一致） */ }

        if (json) {
          return { ok: false, message: json.message || text };
        }

        // 網站原生點擊時段按鈕的回呼是把片段寫進 #ScheduleList（不是 #SessionList，
        // 這裡曾經寫錯過，導致選位其實已經成功，但畫面沒更新、程式誤判失敗一直重試到逾時）
        const scheduleList = document.getElementById('ScheduleList');
        if (scheduleList) scheduleList.innerHTML = text;
        if (typeof getSessionChoose === 'function') getSessionChoose();

        // 網站原生 handler 對「非 JSON 回應」本身就視為成功，不再額外檢查 ischoose 屬性
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.message, networkError: true };
      }
    }, venueId, targetDateText);
  }

  async _selectTargetSlot(page, botId, venueId, targetDateText, deadlineTs, shared) {
    let attempt = 0;
    while (this.now() < deadlineTs) {
      if (shared.done || this.aborted) return false;
      attempt += 1;

      const result = await this._chooseSlotViaFetch(page, venueId, targetDateText);
      if (result.ok) {
        this.log(`[Bot ${botId}] ✅ 已選定時段（第 ${attempt} 次嘗試）`);
        return true;
      }

      const msg = result.message || '未知原因';
      if (TAKEN_KEYWORDS.some(k => msg.includes(k))) {
        this.log(`[Bot ${botId}] ❌ 時段已被他人搶走：${msg}`);
        return false;
      }
      if (attempt === 1 || attempt % 5 === 0) {
        this.log(`[Bot ${botId}] 第 ${attempt} 次選位未成功：${msg}`);
      }
      await sleep(150);
    }
    this.log(`[Bot ${botId}] ❌ 選位逾時`);
    return false;
  }

  // ── 送出預約：成功與否一律以是否真的導到 Step3 為準 ──
  async _submitReservation(page, botId) {
    this.log(`[Bot ${botId}] 🔄 送出預約...`);
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
    await page.evaluate(() => {
      if (typeof showReservationAlert === 'function') {
        showReservationAlert();
      }
    });
    await navPromise;

    if (page.url().includes('/OnLine/Step3/')) return page.url();

    const extraDeadline = Date.now() + 3000;
    while (Date.now() < extraDeadline) {
      if (page.url().includes('/OnLine/Step3/')) return page.url();
      await sleep(150);
    }
    return null;
  }

  async _selectAndSubmit(page, botId, targetDateText, STEP2_URL, STEP1_PATH, shared) {
    if (shared.done) {
      this.log(`[Bot ${botId}] 其他 Bot 已成功，略過`);
      return false;
    }

    const openDeadline = this.now() + OPEN_WAIT_TIMEOUT_MS;
    const ready = await this._ensureStep2Ready(page, botId, STEP2_URL, STEP1_PATH, openDeadline);
    if (!ready) return false;
    if (shared.done) return false;

    // 不再用 status/class 猜測「已被搶走」或「尚未開放」（status=4 在網站圖例上寫的是
    // 「尚未開放」，不是「已出租」，用它判斷已被搶走方向是錯的），一律直接呼叫選位 API，
    // 讓伺服器的真實回應（TAKEN_KEYWORDS）判斷是否真的被搶走
    const venueId = STEP2_URL.split('/').pop();
    const chooseDeadline = this.now() + CHOOSE_TIMEOUT_MS;
    const chosen = await this._selectTargetSlot(page, botId, venueId, targetDateText, chooseDeadline, shared);
    if (!chosen || shared.done) return false;

    const step3Url = await this._submitReservation(page, botId);
    if (step3Url) {
      shared.done = true;
      shared.step3Url = step3Url;
      this.log(`[Bot ${botId}] 🎉 成功進入 Step3！`);
      return true;
    }

    this.log(`[Bot ${botId}] ❌ 送出後未導到 Step3，目前 URL: ${page.url()}`);
    return false;
  }
}

module.exports = BookingSession;
