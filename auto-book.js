/**
 * 台北市場地租借自動搶位腳本 v3.0
 *
 * 流程：
 *   預熱期（PRE_LOAD_SECONDS 前）：直接嘗試進入 Step2 → 導航日曆到目標日
 *   精準時間到達：所有 Bot 同時點擊時段按鈕 → 等待 Step3
 *
 * 改進：
 *   1. 預熱期直接導航 Step2 並撥好日曆
 *   2. 點日期後用 waitForSelector 等待目標按鈕（取代 polling）
 *   3. 直接試 Step2，跳過 Step1（被重導才補做）
 *   4. 點時段後用 waitForFunction 取代 sleep(200/500)
 *   6. 多個瀏覽器並行搶位（NUM_BOTS）
 *
 * 使用方式：
 *   node auto-book.js --config '{"venueId":"...","targetDateText":"...","numBots":2}'
 *   node auto-book.js --now --config '{...}'
 *   node auto-book.js --now
 */

const puppeteer = require('puppeteer');

// ====== 解析設定 ======
const isNowMode = process.argv.includes('--now');
const configIdx = process.argv.indexOf('--config');
let externalConfig = null;
if (configIdx !== -1 && process.argv[configIdx + 1]) {
  try {
    externalConfig = JSON.parse(process.argv[configIdx + 1]);
  } catch (e) {
    console.error('❌ --config JSON 解析失敗:', e.message);
    process.exit(1);
  }
}

const VENUE_ID = externalConfig?.venueId || '27ee824a3be0';
const STEP1_URL = `https://service.gov.taipei/rental/OnLine/Step1/${VENUE_ID}`;
const STEP2_URL = `https://service.gov.taipei/rental/OnLine/Step2/${VENUE_ID}`;
const STEP3_URL = `https://service.gov.taipei/rental/OnLine/Step3/${VENUE_ID}`;
const TARGET_DATE_TEXT = externalConfig?.targetDateText || '2026/07/07(二) 20:00~22:00';
const TARGET_MONTH = externalConfig?.targetMonth || 7;
const TARGET_DAY = externalConfig?.targetDay || 7;
const NUM_BOTS = externalConfig?.numBots || 2;

let EXECUTE_TIME;
if (externalConfig?.executeDate && externalConfig?.executeTime) {
  EXECUTE_TIME = new Date(`${externalConfig.executeDate}T${externalConfig.executeTime}:00+08:00`);
} else {
  EXECUTE_TIME = new Date('2026-06-06T00:00:00+08:00');
}

// 預熱時間拉長到 15 秒，確保多個瀏覽器都能完成預載
const PRE_LOAD_SECONDS = 15;

// 跨 Bot 共享狀態
const shared = { done: false, step3Url: null };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log(`[${now}] ${msg}`);
}

async function waitUntilTarget() {
  if (isNowMode) {
    log('⚡ 立即執行模式（--now）');
    return;
  }

  const preLoadTime = new Date(EXECUTE_TIME.getTime() - PRE_LOAD_SECONDS * 1000);

  while (true) {
    const now = new Date();
    const diff = preLoadTime.getTime() - now.getTime();

    if (diff <= 0) {
      log('⏰ 預熱時間到！啟動瀏覽器並預載頁面...');
      break;
    }

    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    process.stdout.write(
      `\r⏳ 距離執行還有 ${hours}小時 ${mins}分 ${secs}秒    `
    );

    await sleep(diff > 60000 ? 10000 : diff > 5000 ? 1000 : 100);
  }
  console.log('');
}

async function preciseWaitUntilExact() {
  if (isNowMode) return;
  while (new Date().getTime() < EXECUTE_TIME.getTime()) {
    await sleep(10);
  }
  log('🎯 精準時間到達！');
}

// =============================================
// 導航日曆到目標月份和日期
// 改進 2：waitForSelector 等待目標按鈕
// =============================================
async function navigateToTargetDate(page) {
  const monthNames = ['', '一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const targetMonthText = monthNames[TARGET_MONTH] || '';

  for (let attempt = 0; attempt < 12; attempt++) {
    const monthText = await page.evaluate(() => {
      const sw = document.querySelector('.datepicker-switch');
      return sw ? sw.textContent.trim() : '';
    });
    if (monthText.includes(targetMonthText) || monthText.includes(`${TARGET_MONTH}月`)) break;
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

  // 改進 2：等待目標時段的按鈕，而非任意 .btn2
  await page.waitForSelector(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`, { timeout: 3000 }).catch(() => {});
}

// =============================================
// Step 1：被重導才呼叫
// =============================================
async function doStep1(page, botId) {
  log(`[Bot ${botId}] 📋 Step1：閱讀並同意條款`);
  try {
    await page.goto(STEP1_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    log(`[Bot ${botId}] ⚠️ Step1 載入超時，繼續...`);
  }

  await page.waitForSelector('#chkYes', { timeout: 5000 }).catch(() => {});
  const chk = await page.$('#chkYes');
  if (chk) {
    const isChecked = await page.evaluate(() => document.getElementById('chkYes').checked);
    if (!isChecked) await page.click('#chkYes');
    await page.evaluate(() => {
      if (typeof CheckRead === 'function') CheckRead();
    });
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
  log(`[Bot ${botId}] ✅ Step1 完成`);
}

// =============================================
// 預熱：走 Step1 → Step2，撥好日曆
// =============================================
async function preLoad(page, botId) {
  await doStep1(page, botId);

  await page.waitForSelector('.datepicker-switch', { timeout: 5000 }).catch(() => {});
  log(`[Bot ${botId}] 📅 導航日曆到 ${TARGET_MONTH}/${TARGET_DAY}...`);
  await navigateToTargetDate(page);

  const btnInfo = await page.evaluate((targetText) => {
    const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
    return btn
      ? { disabled: btn.classList.contains('disabled'), status: btn.getAttribute('status') }
      : null;
  }, TARGET_DATE_TEXT);
  log(`[Bot ${botId}] ✅ 預熱完成，按鈕: ${JSON.stringify(btnInfo)}`);
}

// =============================================
// 點擊時段並推進到 Step3
// 改進 4：waitForFunction 取代 sleep
// =============================================
async function clickSlotAndProceed(page, botId, getBotAlert) {
  if (shared.done) {
    log(`[Bot ${botId}] 其他 Bot 已成功，略過`);
    return false;
  }

  log(`[Bot ${botId}] 🎯 點擊目標時段...`);

  let btnHandle = await page.$(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`);
  if (!btnHandle) {
    log(`[Bot ${botId}] ⚠️ 按鈕不見，重新導航...`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await navigateToTargetDate(page);
    btnHandle = await page.$(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`);
  }

  if (!btnHandle) {
    log(`[Bot ${botId}] ❌ 找不到目標時段按鈕`);
    return false;
  }

  const btnInfo = await page.evaluate((targetText) => {
    const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
    if (!btn) return null;
    if (btn.getAttribute('status') === '4' || btn.classList.contains('rented')) {
      return { rented: true };
    }
    return { disabled: btn.classList.contains('disabled'), status: btn.getAttribute('status') };
  }, TARGET_DATE_TEXT);

  if (btnInfo?.rented) {
    log(`[Bot ${botId}] ❌ 時段已被他人預訂`);
    return false;
  }
  log(`[Bot ${botId}] 按鈕狀態: ${JSON.stringify(btnInfo)}`);

  // 最多重試 5 次（應對開放瞬間 server 稍有延遲）
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (shared.done || getBotAlert()) break;
    if (attempt > 1) log(`[Bot ${botId}] 第 ${attempt} 次點擊...`);

    // 移除 disabled（如果按鈕尚未開放）
    await page.evaluate((targetText) => {
      const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
      if (btn) btn.classList.remove('disabled');
    }, TARGET_DATE_TEXT);

    btnHandle = await page.$(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`);
    if (!btnHandle) break;
    await btnHandle.click();

    // 改進 4：等按鈕消失或 ischoose=1，取代 sleep(200)
    const changed = await page.waitForFunction(
      (targetText) => {
        const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
        return !btn || btn.getAttribute('ischoose') === '1';
      },
      { timeout: 1500 },
      TARGET_DATE_TEXT
    ).then(() => true).catch(() => false);

    if (changed || getBotAlert()) break;
  }

  // 讓 event loop 充分跑完排隊的 dialog handler
  await sleep(200);
  log(`[Bot ${botId}] post-loop: botAlert=${getBotAlert()}, shared.done=${shared.done}`);

  // 先等待頁面自然導航 / AJAX 回調完成（最多 4 秒）
  // 這避免了呼叫 showReservationAlert 與按鈕 click AJAX 回調發生衝突
  const naturalDeadline = Date.now() + 800;
  while (Date.now() < naturalDeadline) {
    if (page.url().includes('Step3')) break;
    if (getBotAlert()) break;
    if (shared.done) { log(`[Bot ${botId}] 其他 Bot 已成功，退出`); return false; }
    await sleep(100);
  }

  // 若 botAlert 已設（此 bot 確認預約），直接 goto Step3
  if (getBotAlert()) {
    log(`[Bot ${botId}] 🎉 預約確認，直接導航 Step3...`);
    try {
      await page.goto(STEP3_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      log(`[Bot ${botId}] ⚠️ goto Step3: ${e.message}`);
    }
  } else if (!page.url().includes('Step3') && !shared.done) {
    // 自然導航未發生，用 showReservationAlert 作最後手段
    log(`[Bot ${botId}] 🔄 觸發 showReservationAlert...`);
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
  log(`[Bot ${botId}] 📍 當前 URL: ${url}`);
  if (url.includes('Step3')) {
    shared.done = true;
    shared.step3Url = url;
    log(`[Bot ${botId}] ✅ 成功進入 Step3！`);
    return true;
  }

  return getBotAlert();
}

// =============================================
// 改進 6：單個 Bot 完整生命週期
// =============================================
async function runBot(botId, launchOptions) {
  let browser;
  try {
    log(`[Bot ${botId}] 🌐 啟動瀏覽器...`);
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    let botAlert = false;
    page.on('dialog', async (dialog) => {
      const msg = dialog.message();
      log(`[Bot ${botId}] 💬 JS 彈窗: "${msg}"`);
      await dialog.accept();
      if (msg.includes('保留10分鐘') || msg.includes('10分鐘內預約')) {
        botAlert = true;
        shared.done = true;
        log(`[Bot ${botId}] 🎉 偵測到預約確認彈窗 → 搶位成功！`);
      }
    });

    await preLoad(page, botId);
    await preciseWaitUntilExact();

    const success = await clickSlotAndProceed(page, botId, () => botAlert);
    return { browser, page, success, botId };
  } catch (err) {
    log(`[Bot ${botId}] ❌ 錯誤: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return { browser: null, page: null, success: false, botId };
  }
}

async function main() {
  log('🚀 台北市場地租借自動搶位腳本啟動 v3.0');
  log(`📍 場地 ID: ${VENUE_ID}`);
  log(`🎯 目標時段：${TARGET_DATE_TEXT}`);
  log(`📅 目標日期：${TARGET_MONTH}月${TARGET_DAY}日`);
  log(`🤖 並行 Bot 數量：${NUM_BOTS}`);
  if (!isNowMode) {
    log(`⏰ 預定執行時間：${EXECUTE_TIME.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  }

  await waitUntilTarget();

  const isServer = !!(process.env.CLOUDWAYS || process.env.SERVER_MODE || process.env.NODE_ENV === 'production');
  const launchOptions = {
    headless: isServer ? 'new' : false,
    defaultViewport: isServer ? { width: 1280, height: 900 } : null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--window-size=1280,900',
    ],
  };
  if (process.env.CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.CHROMIUM_PATH;
    log(`   使用自訂 Chromium: ${process.env.CHROMIUM_PATH}`);
  }
  log(`   模式: ${isServer ? 'headless (伺服器)' : '有頭模式 (本機)'}`);

  // 改進 6：並行啟動所有 Bot
  const results = await Promise.all(
    Array.from({ length: NUM_BOTS }, (_, i) => runBot(i + 1, launchOptions))
  );

  const successResult = results.find(r => r.success && r.browser);
  const step3Url = shared.step3Url;

  log('');
  if (step3Url) {
    log('🎊 ===========================');
    log('🎊   自動操作已完成！');
    log('🎊   已進入 Step3 頁面');
    log('🎊   請在瀏覽器中完成後續操作');
    log('🎊 ===========================');
    log(`📍 Step3 URL: ${step3Url}`);
    log(`STEP3_URL: ${step3Url}`);
  } else {
    log('⚠️ 所有 Bot 均未成功到達 Step3，請手動操作');
  }

  // 關閉非成功的瀏覽器
  for (const r of results) {
    if (r.browser && r !== successResult) {
      await r.browser.close().catch(() => {});
      log(`[Bot ${r.botId}] 🌐 瀏覽器已關閉`);
    }
  }

  if (isServer) {
    if (successResult?.page) {
      try {
        const screenshotPath = `screenshot-${Date.now()}.png`;
        await successResult.page.screenshot({ path: screenshotPath, fullPage: true });
        log(`📸 已儲存截圖: ${screenshotPath}`);
      } catch (e) {
        log(`⚠️ 截圖失敗: ${e.message}`);
      }
      log('⏳ 瀏覽器保持開啟 10 分鐘，請盡快點選控制台的「開啟 Step 3」按鈕');
      await sleep(600000);
    }
    if (successResult?.browser) await successResult.browser.close().catch(() => {});
    log('🌐 瀏覽器已關閉');
  } else if (successResult?.browser) {
    log('🔄 成功的瀏覽器保持開啟中... 按 Ctrl+C 結束腳本');
    await new Promise(() => {});
  }
}

main().catch(err => {
  console.error('❌ 腳本執行失敗：', err);
  process.exit(1);
});
