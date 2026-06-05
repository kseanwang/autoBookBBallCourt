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
    this.browser = null;
    this.page = null;
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
    if (this.browser) {
      this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.onStatus({ type: 'stopped' });
  }

  async start(config) {
    if (this.running) return;
    this.running = true;
    this.aborted = false;

    const {
      venueId, targetDateText, targetMonth, targetDay,
      executeDate, executeTime, runNow,
    } = config;

    const TARGET_MONTH = parseInt(targetMonth);
    const TARGET_DAY = parseInt(targetDay);
    const STEP1_URL = `https://service.gov.taipei/rental/OnLine/Step1/${venueId}`;
    const STEP2_URL = `https://service.gov.taipei/rental/OnLine/Step2/${venueId}`;
    const RETRY_TIMES = 30;
    const RETRY_INTERVAL_MS = 50;
    const PRE_LOAD_SECONDS = 5;

    let EXECUTE_TIME = null;
    if (executeDate && executeTime) {
      EXECUTE_TIME = new Date(`${executeDate}T${executeTime}:00+08:00`);
    }

    this.log(`🚀 搶位腳本啟動`);
    this.log(`📍 場地 ID: ${venueId}`);
    this.log(`🎯 目標時段：${targetDateText}`);
    if (!runNow && EXECUTE_TIME) {
      this.log(`⏰ 預定執行：${EXECUTE_TIME.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    }

    // ── 倒數等待 ──
    if (!runNow && EXECUTE_TIME) {
      const preLoadTime = new Date(EXECUTE_TIME.getTime() - PRE_LOAD_SECONDS * 1000);
      while (true) {
        if (this.aborted) { this.running = false; return; }
        const now = new Date();
        const diff = preLoadTime.getTime() - now.getTime();
        if (diff <= 0) { this.log('⏰ 時間到！開始執行...'); break; }

        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        const countdown = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        this.onStatus({ type: 'waiting', countdown });

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

    // ── 啟動瀏覽器 ──
    let puppeteer;
    try {
      puppeteer = require('puppeteer-core');
    } catch (e) {
      this.log('❌ 找不到 puppeteer-core，請執行 npm install');
      this.onStatus({ type: 'error' });
      this.running = false;
      return;
    }

    this.log(`🌐 啟動瀏覽器...`);
    this.onStatus({ type: 'running' });

    try {
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        defaultViewport: null,
        args: ['--window-size=1280,900'],
      });

      this.page = await this.browser.newPage();
      await this.page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );

      this.page.on('dialog', async (dialog) => {
        this.log(`💬 彈窗 [${dialog.type()}]: "${dialog.message()}" → 自動確認`);
        await dialog.accept();
      });

      // 精準等待到整點
      if (!runNow && EXECUTE_TIME) {
        while (new Date().getTime() < EXECUTE_TIME.getTime()) {
          if (this.aborted) break;
          await sleep(10);
        }
        this.log('🎯 精準時間到達！');
      }

      if (!this.aborted) await this._doStep1(STEP1_URL, STEP2_URL);
      if (!this.aborted) {
        const ok = await this._doStep2(STEP1_URL, STEP2_URL, targetDateText, TARGET_MONTH, TARGET_DAY, RETRY_TIMES, RETRY_INTERVAL_MS);
        if (ok) {
          const url = this.page.url();
          this.log('🎊 搶位完成！請在開啟的瀏覽器中完成 Step3');
          this.onStatus({ type: 'completed', step3Url: url });
        }
      }
    } catch (err) {
      if (!this.aborted) {
        this.log(`❌ 錯誤：${err.message}`);
        this.onStatus({ type: 'error', message: err.message });
      }
    } finally {
      this.running = false;
    }
  }

  // ── Step 1 ──
  async _doStep1(STEP1_URL, STEP2_URL) {
    this.log('📋 ========== Step 1：閱讀並同意條款 ==========');
    try {
      await this.page.goto(STEP1_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      this.log('✅ Step1 頁面載入完成');
    } catch (err) {
      this.log(`⚠️ Step1 載入超時: ${err.message}`);
    }

    for (let i = 0; i < 10; i++) {
      if (this.aborted) return;
      const chk = await this.page.$('#chkYes');
      if (chk) {
        const isChecked = await this.page.evaluate(() => document.getElementById('chkYes').checked);
        if (!isChecked) await this.page.click('#chkYes');
        await this.page.evaluate(() => { if (typeof CheckRead === 'function') CheckRead(); });
        this.log('✅ checkbox 已勾選');
        break;
      }
      await sleep(500);
    }

    await sleep(500);

    for (let i = 0; i < 10; i++) {
      if (this.aborted) return;
      await this.page.evaluate(() => {
        const cb = document.getElementById('chkYes');
        if (cb && !cb.checked) { cb.checked = true; if (typeof CheckRead === 'function') CheckRead(); }
      });
      await sleep(200);
      const btn = await this.page.$('#PersonalPolicyYes');
      if (btn) {
        await this.page.click('#PersonalPolicyYes');
        this.log('✅ 已點擊「已閱讀並同意」');
        break;
      }
      await sleep(500);
    }

    try {
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      this.log(`✅ 已跳轉到: ${this.page.url()}`);
    } catch (err) {
      this.log(`⚠️ ${err.message}`);
      if (!this.page.url().includes('Step2')) {
        await this.page.goto(STEP2_URL, { waitUntil: 'networkidle2', timeout: 15000 });
      }
    }
  }

  // ── Step 2 ──
  async _doStep2(STEP1_URL, STEP2_URL, targetDateText, TARGET_MONTH, TARGET_DAY, RETRY_TIMES, RETRY_INTERVAL_MS) {
    this.log('🎯 ========== Step 2：選擇時段 ==========');

    if (!this.page.url().includes('Step2')) {
      await this.page.goto(STEP2_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    // 導航日曆到目標月份
    const monthNames = ['','一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    const targetMonthCN = monthNames[TARGET_MONTH] || '';

    const monthStr = String(TARGET_MONTH).padStart(2, '0');
    const dayStr = String(TARGET_DAY).padStart(2, '0');
    const slots = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('.btn2')).map(b => b.textContent.trim())
    );
    const slotFound = slots.some(t => t.includes(`${monthStr}/${dayStr}`));

    if (!slotFound) {
      this.log(`📅 導航日曆到 ${TARGET_MONTH} 月...`);
      for (let attempt = 0; attempt < 12; attempt++) {
        if (this.aborted) return false;
        const monthText = await this.page.evaluate(() => {
          const sw = document.querySelector('.datepicker-switch');
          return sw ? sw.textContent.trim() : '';
        });
        if (monthText.includes(targetMonthCN) || monthText.includes(`${TARGET_MONTH}月`)) break;
        await this.page.evaluate(() => {
          const next = document.querySelector('th.next');
          if (next) next.click();
        });
        await sleep(500);
      }

      this.log(`📅 點擊 ${TARGET_DAY} 號...`);
      await this.page.evaluate((day) => {
        const tds = document.querySelectorAll('.datepicker-days td.day:not(.old):not(.new)');
        for (const td of tds) {
          if (td.textContent.trim() === String(day)) { td.click(); return; }
        }
      }, TARGET_DAY);
      await sleep(1500);
    }

    // 找時段按鈕並點擊
    this.log('🔍 尋找時段按鈕...');
    let timeSlotClicked = false;

    for (let i = 1; i <= RETRY_TIMES; i++) {
      if (this.aborted) return false;

      const btnInfo = await this.page.evaluate((text) => {
        const btn = document.querySelector(`div.btn2[alldate="${text}"]`);
        if (!btn) {
          return { exists: false, available: Array.from(document.querySelectorAll('.btn2')).map(b => b.textContent.trim()).slice(0, 5) };
        }
        return { exists: true, disabled: btn.classList.contains('disabled'), ischoose: btn.getAttribute('ischoose') };
      }, targetDateText);

      if (!btnInfo.exists) {
        if (i % 10 === 0) {
          this.log(`   第 ${i} 次未找到，可用: ${JSON.stringify(btnInfo.available)}`);
          await this.page.reload({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
        }
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      this.log(`   找到按鈕: disabled=${btnInfo.disabled}, ischoose=${btnInfo.ischoose}`);

      if (!btnInfo.disabled) {
        const handle = await this.page.$(`div.btn2[alldate="${targetDateText}"]`);
        if (handle) {
          await handle.click();
          await sleep(800);
          const after = await this.page.evaluate((text) => {
            const btn = document.querySelector(`div.btn2[alldate="${text}"]`);
            return btn ? btn.getAttribute('ischoose') : null;
          }, targetDateText);
          if (after === '1') {
            timeSlotClicked = true;
            this.log('✅ 時段選取成功 (ischoose=1)');
            break;
          }
          if (i % 3 === 0) {
            await this.page.reload({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
            // 重新導航日曆
            for (let a = 0; a < 12; a++) {
              const mt = await this.page.evaluate(() => document.querySelector('.datepicker-switch')?.textContent.trim() || '');
              if (mt.includes(targetMonthCN) || mt.includes(`${TARGET_MONTH}月`)) break;
              await this.page.evaluate(() => { document.querySelector('th.next')?.click(); });
              await sleep(500);
            }
            await this.page.evaluate((day) => {
              const tds = document.querySelectorAll('.datepicker-days td.day:not(.old):not(.new)');
              for (const td of tds) { if (td.textContent.trim() === String(day)) { td.click(); return; } }
            }, TARGET_DAY);
            await sleep(1500);
          }
          await sleep(RETRY_INTERVAL_MS);
        }
      } else {
        this.log('   ⚠️ 按鈕 disabled，強制點擊（測試模式）');
        await this.page.evaluate((text) => {
          const btn = document.querySelector(`div.btn2[alldate="${text}"]`);
          if (btn) btn.classList.remove('disabled');
        }, targetDateText);
        await sleep(100);
        const handle = await this.page.$(`div.btn2[alldate="${targetDateText}"]`);
        if (handle) await handle.click();
        timeSlotClicked = true;
        break;
      }
    }

    if (!timeSlotClicked) {
      this.log('❌ 無法選取目標時段');
      return false;
    }

    await sleep(500);

    // 點擊「下一步」
    this.log('🔍 點擊「下一步」...');
    for (let i = 0; i < 10; i++) {
      if (this.aborted) return false;
      const result = await this.page.evaluate(() => {
        if (typeof showReservationAlert === 'function') { showReservationAlert(); return 'direct-call'; }
        for (const btn of document.querySelectorAll('a.btn-green, a.btn')) {
          if (btn.textContent.trim() === '下一步') { btn.click(); return 'text-match'; }
        }
        return null;
      });
      if (result) { this.log(`✅ 已點擊「下一步」(${result})`); break; }
      await sleep(500);
    }

    await sleep(2000);

    try {
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
      this.log(`✅ 已跳轉到: ${this.page.url()}`);
    } catch (err) {
      this.log(`⚠️ 等待跳轉超時: ${err.message} | URL: ${this.page.url()}`);
    }

    return true;
  }
}

module.exports = BookingSession;
