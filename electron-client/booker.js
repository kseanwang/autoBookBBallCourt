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

class BookingSession {
  constructor(onLog, onStatus) {
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.browsers = [];
    this.aborted = false;
    this.running = false;
  }

  log(msg) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const line = `[${now}] ${msg}`;
    console.log(line);
    this.onLog(line);
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
    const PRE_LOAD_SECONDS = 15;

    const STEP1_URL = `https://service.gov.taipei/rental/OnLine/Step1/${venueId}`;
    const STEP2_URL = `https://service.gov.taipei/rental/OnLine/Step2/${venueId}`;
    const STEP3_URL = `https://service.gov.taipei/rental/OnLine/Step3/${venueId}`;

    let EXECUTE_TIME = null;
    if (executeDate && executeTime) {
      EXECUTE_TIME = new Date(`${executeDate}T${executeTime}:00+08:00`);
    }

    this.log(`🚀 搶位腳本啟動 v3.0`);
    this.log(`📍 場地 ID: ${venueId}`);
    this.log(`🎯 目標時段：${targetDateText}`);
    this.log(`🤖 並行 Bot 數量：${NUM_BOTS}`);
    if (!runNow && EXECUTE_TIME) {
      this.log(`⏰ 預定執行：${EXECUTE_TIME.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    }

    // ── 倒數等待（到預熱時間）──
    if (!runNow && EXECUTE_TIME) {
      const preLoadTime = new Date(EXECUTE_TIME.getTime() - PRE_LOAD_SECONDS * 1000);
      while (true) {
        if (this.aborted) { this.running = false; return; }
        const now = new Date();
        const diff = preLoadTime.getTime() - now.getTime();
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

        let botAlert = false;
        page.on('dialog', async (dialog) => {
          const msg = dialog.message();
          this.log(`[Bot ${botId}] 💬 彈窗: "${msg}"`);
          await dialog.accept();
          if (msg.includes('保留10分鐘') || msg.includes('10分鐘內預約')) {
            botAlert = true;
            shared.done = true;
            this.log(`[Bot ${botId}] 🎉 偵測到預約確認彈窗 → 搶位成功！`);
          }
        });

        await this._preLoad(page, botId, STEP1_URL, STEP2_URL, targetDateText, TARGET_MONTH, TARGET_DAY);

        // 精準等待到整點
        if (!runNow && EXECUTE_TIME) {
          while (new Date().getTime() < EXECUTE_TIME.getTime()) {
            if (this.aborted) break;
            await sleep(10);
          }
          this.log(`[Bot ${botId}] 🎯 精準時間到達！`);
        }

        if (this.aborted) return { browser, page, success: false, botId };

        const success = await this._clickSlotAndProceed(
          page, botId, targetDateText, STEP3_URL, TARGET_MONTH, TARGET_DAY, shared, () => botAlert
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

  // ── 預熱：直接嘗試 Step2，被重導才補做 Step1 ──
  async _preLoad(page, botId, STEP1_URL, STEP2_URL, targetDateText, TARGET_MONTH, TARGET_DAY) {
    this.log(`[Bot ${botId}] 📄 直接嘗試載入 Step2...`);
    try {
      await page.goto(STEP2_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      this.log(`[Bot ${botId}] ⚠️ Step2 載入超時，繼續...`);
    }

    if (!page.url().includes('Step2')) {
      await this._doStep1(page, botId, STEP1_URL, STEP2_URL);
    }

    await page.waitForSelector('.datepicker-switch', { timeout: 5000 }).catch(() => {});
    this.log(`[Bot ${botId}] 📅 導航日曆到 ${TARGET_MONTH}/${TARGET_DAY}...`);
    await this._navigateToTargetDate(page, TARGET_MONTH, TARGET_DAY, targetDateText);

    const btnInfo = await page.evaluate((t) => {
      const btn = document.querySelector(`div.btn2[alldate="${t}"]`);
      return btn ? { disabled: btn.classList.contains('disabled'), status: btn.getAttribute('status') } : null;
    }, targetDateText);
    this.log(`[Bot ${botId}] ✅ 預熱完成，按鈕: ${JSON.stringify(btnInfo)}`);
  }

  // ── Step1（被重導才呼叫）──
  async _doStep1(page, botId, STEP1_URL, STEP2_URL) {
    this.log(`[Bot ${botId}] 📋 Step1：閱讀並同意條款`);
    try {
      await page.goto(STEP1_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      this.log(`[Bot ${botId}] ⚠️ Step1 載入超時，繼續...`);
    }

    await page.waitForSelector('#chkYes', { timeout: 5000 }).catch(() => {});
    const chk = await page.$('#chkYes');
    if (chk) {
      const isChecked = await page.evaluate(() => document.getElementById('chkYes').checked);
      if (!isChecked) await page.click('#chkYes');
      await page.evaluate(() => { if (typeof CheckRead === 'function') CheckRead(); });
    }

    await page.waitForSelector('#PersonalPolicyYes', { timeout: 5000 }).catch(() => {});
    const btn = await page.$('#PersonalPolicyYes');
    if (btn) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
          page.click('#PersonalPolicyYes'),
        ]);
      } catch (err) {
        if (!page.url().includes('Step2')) {
          await page.goto(STEP2_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        }
      }
    }
    this.log(`[Bot ${botId}] ✅ Step1 完成`);
  }

  // ── 導航日曆到目標日期 ──
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

  // ── 點擊時段並推進到 Step3 ──
  async _clickSlotAndProceed(page, botId, targetDateText, STEP3_URL, TARGET_MONTH, TARGET_DAY, shared, getBotAlert) {
    if (shared.done) {
      this.log(`[Bot ${botId}] 其他 Bot 已成功，略過`);
      return false;
    }

    this.log(`[Bot ${botId}] 🎯 點擊目標時段...`);

    let btnHandle = await page.$(`div.btn2[alldate="${targetDateText}"]`);
    if (!btnHandle) {
      this.log(`[Bot ${botId}] ⚠️ 按鈕不見，重新導航...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await this._navigateToTargetDate(page, TARGET_MONTH, TARGET_DAY, targetDateText);
      btnHandle = await page.$(`div.btn2[alldate="${targetDateText}"]`);
    }

    if (!btnHandle) {
      this.log(`[Bot ${botId}] ❌ 找不到目標時段按鈕`);
      return false;
    }

    const btnInfo = await page.evaluate((t) => {
      const btn = document.querySelector(`div.btn2[alldate="${t}"]`);
      if (!btn) return null;
      if (btn.getAttribute('status') === '4' || btn.classList.contains('rented')) return { rented: true };
      return { disabled: btn.classList.contains('disabled'), status: btn.getAttribute('status') };
    }, targetDateText);

    if (btnInfo?.rented) {
      this.log(`[Bot ${botId}] ❌ 時段已被他人預訂`);
      return false;
    }
    this.log(`[Bot ${botId}] 按鈕狀態: ${JSON.stringify(btnInfo)}`);

    for (let attempt = 1; attempt <= 5; attempt++) {
      if (shared.done || getBotAlert()) break;
      if (attempt > 1) this.log(`[Bot ${botId}] 第 ${attempt} 次點擊...`);

      await page.evaluate((t) => {
        const btn = document.querySelector(`div.btn2[alldate="${t}"]`);
        if (btn) btn.classList.remove('disabled');
      }, targetDateText);

      btnHandle = await page.$(`div.btn2[alldate="${targetDateText}"]`);
      if (!btnHandle) break;
      await btnHandle.click();

      await page.waitForFunction(
        (t) => {
          const btn = document.querySelector(`div.btn2[alldate="${t}"]`);
          return !btn || btn.getAttribute('ischoose') === '1';
        },
        { timeout: 1500 },
        targetDateText
      ).then(() => true).catch(() => false);

      if (getBotAlert()) break;
    }

    await sleep(200);
    this.log(`[Bot ${botId}] post-loop: botAlert=${getBotAlert()}, shared.done=${shared.done}`);

    const naturalDeadline = Date.now() + 800;
    while (Date.now() < naturalDeadline) {
      if (page.url().includes('Step3')) break;
      if (getBotAlert()) break;
      if (shared.done) { this.log(`[Bot ${botId}] 其他 Bot 已成功，退出`); return false; }
      await sleep(100);
    }

    if (getBotAlert()) {
      this.log(`[Bot ${botId}] 🎉 預約確認，直接導航 Step3...`);
      try {
        await page.goto(STEP3_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (e) {
        this.log(`[Bot ${botId}] ⚠️ goto Step3: ${e.message}`);
      }
    } else if (!page.url().includes('Step3') && !shared.done) {
      this.log(`[Bot ${botId}] 🔄 觸發 showReservationAlert...`);
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      await page.evaluate(() => {
        if (typeof showReservationAlert === 'function') {
          showReservationAlert();
        } else {
          const btns = document.querySelectorAll('a.btn-green, a.btn');
          for (const btn of btns) {
            if (btn.textContent.trim() === '下一步') { btn.click(); return; }
          }
        }
      });
      await navPromise;
    }

    const url = page.url();
    this.log(`[Bot ${botId}] 📍 當前 URL: ${url}`);
    if (url.includes('Step3')) {
      shared.done = true;
      shared.step3Url = url;
      this.log(`[Bot ${botId}] ✅ 成功進入 Step3！`);
      return true;
    }

    return getBotAlert();
  }
}

module.exports = BookingSession;
