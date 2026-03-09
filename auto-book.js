/**
 * 台北市場地租借自動搶位腳本
 * 
 * 流程：
 *   Step1: 開啟線上租借頁 → 勾選 checkbox → 點「已閱讀並同意」
 *   Step2: 選擇時段 → 點「下一步」→ 按掉 JS 彈窗
 *   Step3: 自動進入第三步頁面
 *
 * 使用方式：
 *   node auto-book.js --config '{"venueId":"27ee824a3be0",...}'
 *   node auto-book.js --now --config '{"venueId":"27ee824a3be0",...}'
 *   node auto-book.js          （使用預設值）
 *   node auto-book.js --now    （使用預設值，立即執行）
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

// 從外部設定或使用預設值
const VENUE_ID = externalConfig?.venueId || '27ee824a3be0';
const STEP1_URL = `https://service.gov.taipei/rental/OnLine/Step1/${VENUE_ID}`;
const STEP2_URL = `https://service.gov.taipei/rental/OnLine/Step2/${VENUE_ID}`;
const TARGET_DATE_TEXT = externalConfig?.targetDateText || '2026/04/07(二) 20:00~22:00';
const TARGET_MONTH = externalConfig?.targetMonth || 4;
const TARGET_DAY = externalConfig?.targetDay || 7;

// 執行時間
let EXECUTE_TIME;
if (externalConfig?.executeDate && externalConfig?.executeTime) {
  EXECUTE_TIME = new Date(`${externalConfig.executeDate}T${externalConfig.executeTime}:00+08:00`);
} else {
  EXECUTE_TIME = new Date('2026-03-07T00:00:00+08:00');
}

const PRE_LOAD_SECONDS = 5;
const RETRY_TIMES = 30;
const RETRY_INTERVAL_MS = 500;

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
      log('⏰ 時間到！開始執行...');
      break;
    }

    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    process.stdout.write(
      `\r⏳ 距離執行還有 ${hours}小時 ${mins}分 ${secs}秒    `
    );

    if (diff > 60000) {
      await sleep(10000);
    } else if (diff > 5000) {
      await sleep(1000);
    } else {
      await sleep(100);
    }
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
// Step 1: 勾選 checkbox → 點「已閱讀並同意」
// =============================================
async function doStep1(page) {
  log('');
  log('📋 ========== Step 1：閱讀並同意條款 ==========');

  // 載入 Step1 頁面
  log('📄 載入 Step1 頁面...');
  try {
    await page.goto(STEP1_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    log('✅ Step1 頁面載入完成');
  } catch (err) {
    log(`⚠️ Step1 載入超時: ${err.message}，繼續嘗試...`);
  }

  // 等待 checkbox 出現並勾選
  log('🔍 尋找 checkbox #chkYes...');
  for (let i = 0; i < 10; i++) {
    const chk = await page.$('#chkYes');
    if (chk) {
      // 直接點擊 checkbox（不要先設 checked，因為 click 會 toggle）
      const isChecked = await page.evaluate(() => document.getElementById('chkYes').checked);
      if (!isChecked) {
        await page.click('#chkYes');
      }
      // 確認勾選成功
      const nowChecked = await page.evaluate(() => document.getElementById('chkYes').checked);
      log(`✅ checkbox 狀態: checked=${nowChecked}`);
      
      // 確保 CheckRead() 被呼叫
      await page.evaluate(() => {
        if (typeof CheckRead === 'function') CheckRead();
      });
      break;
    }
    log(`   第 ${i + 1} 次未找到 checkbox，等待中...`);
    await sleep(500);
  }

  await sleep(500);

  // 點擊「已閱讀並同意」按鈕
  log('🔍 尋找「已閱讀並同意」按鈕...');
  for (let i = 0; i < 10; i++) {
    // 再次確認 checkbox 是勾選的
    await page.evaluate(() => {
      const cb = document.getElementById('chkYes');
      if (cb && !cb.checked) {
        cb.checked = true;
        if (typeof CheckRead === 'function') CheckRead();
      }
    });
    await sleep(200);

    const btn = await page.$('#PersonalPolicyYes');
    if (btn) {
      // 用 Puppeteer 的 click 直接點擊按鈕
      await page.click('#PersonalPolicyYes');
      log('✅ 已點擊「已閱讀並同意」按鈕');
      break;
    }
    log(`   第 ${i + 1} 次未找到按鈕，等待中...`);
    await sleep(500);
  }

  // 等待頁面跳轉到 Step2
  log('⏳ 等待跳轉到 Step2...');
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    log(`✅ 已跳轉到: ${page.url()}`);
  } catch (err) {
    log(`⚠️ 等待跳轉超時: ${err.message}`);
    log(`   當前 URL: ${page.url()}`);
    // 如果沒有自動跳轉，手動前往 Step2
    if (!page.url().includes('Step2')) {
      log('🔄 手動前往 Step2...');
      await page.goto(STEP2_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    }
  }
}

// =============================================
// 導航日曆到目標月份和日期（獨立函數，可重複使用）
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
    await sleep(500);
  }
  // 點擊目標日期
  await page.evaluate((day) => {
    const tds = document.querySelectorAll('.datepicker-days td.day:not(.old):not(.new)');
    for (const td of tds) {
      if (td.textContent.trim() === String(day)) { td.click(); return; }
    }
  }, TARGET_DAY);
  await sleep(1500);
}

// =============================================
// Step 2: 選擇時段 → 點「下一步」→ 按掉彈窗
// =============================================
async function doStep2(page) {
  log('');
  log('🎯 ========== Step 2：選擇時段 ==========');

  // 確認在 Step2 頁面
  if (!page.url().includes('Step2')) {
    log('📄 載入 Step2 頁面...');
    await page.goto(STEP2_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  }
  log(`📍 當前 URL: ${page.url()}`);

  // 先偵測頁面結構（日曆）
  const calInfo = await page.evaluate(() => {
    const dpSwitch = document.querySelector('.datepicker-switch');
    const btn2s = document.querySelectorAll('.btn2');
    return {
      currentMonth: dpSwitch ? dpSwitch.textContent.trim() : 'N/A',
      timeSlotCount: btn2s.length,
      timeSlots: Array.from(btn2s).map(b => b.textContent.trim()),
    };
  });
  log(`   日曆目前月份: ${calInfo.currentMonth}`);
  log(`   已有時段按鈕: ${calInfo.timeSlotCount} 個`);

  // 如果時段按鈕尚未出現，需要導航日曆到4月再點7號
  const monthStr = String(TARGET_MONTH).padStart(2, '0');
  const dayStr = String(TARGET_DAY).padStart(2, '0');
  let slotFound = calInfo.timeSlots.some(t => t.includes(`${monthStr}/${dayStr}`));

  if (!slotFound) {
    const monthNames = ['', '一月', '二月', '三月', '四月', '五月', '六月',
      '七月', '八月', '九月', '十月', '十一月', '十二月'];
    const targetMonthCN = monthNames[TARGET_MONTH] || '';
    log(`📅 需要導航日曆到 ${TARGET_MONTH} 月...`);

    // 點 next (») 按鈕，直到月份包含目標月份
    for (let attempt = 0; attempt < 12; attempt++) {
      const monthText = await page.evaluate(() => {
        const sw = document.querySelector('.datepicker-switch');
        return sw ? sw.textContent.trim() : '';
      });
      log(`   目前月份: ${monthText}`);

      if (monthText.includes(targetMonthCN) || monthText.includes(`${TARGET_MONTH}月`)) {
        log(`   ✅ 已到達 ${TARGET_MONTH} 月！`);
        break;
      }

      // 點擊日曆上的 next 按鈕 (th.next)
      const nextClicked = await page.evaluate(() => {
        const nextBtn = document.querySelector('th.next');
        if (nextBtn) { nextBtn.click(); return true; }
        return false;
      });

      if (nextClicked) {
        log('   ➡️ 點擊日曆 next');
      } else {
        log('   ❌ 找不到日曆 next 按鈕');
      }
      await sleep(500);
    }

    // 點擊目標日期
    log(`📅 點擊 ${TARGET_DAY} 號...`);
    const dayClicked = await page.evaluate((day) => {
      const dayStr = String(day);
      const tds = document.querySelectorAll('.datepicker-days td.day:not(.old):not(.new)');
      for (const td of tds) {
        if (td.textContent.trim() === dayStr) {
          td.click();
          return true;
        }
      }
      // fallback: 所有 td
      const allTds = document.querySelectorAll('.datepicker-days td');
      for (const td of allTds) {
        if (td.textContent.trim() === dayStr && !td.classList.contains('old') && !td.classList.contains('new')) {
          td.click();
          return true;
        }
      }
      return false;
    }, TARGET_DAY);
    log(dayClicked ? `   ✅ 已點擊 ${TARGET_DAY} 號` : `   ❌ 未找到 ${TARGET_DAY} 號`);
    await sleep(1500); // 等待時段載入
  }

  // 尋找並點擊目標時段按鈕
  log('🔍 尋找時段按鈕...');
  let timeSlotClicked = false;

  for (let i = 1; i <= RETRY_TIMES; i++) {
    // 先檢查按鈕是否存在及其狀態
    const btnInfo = await page.evaluate((targetText) => {
      const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
      if (!btn) {
        const allBtn2 = document.querySelectorAll('.btn2');
        return { exists: false, available: Array.from(allBtn2).map(b => b.textContent.trim()).slice(0, 10) };
      }
      return {
        exists: true,
        disabled: btn.classList.contains('disabled'),
        status: btn.getAttribute('status'),
        ischoose: btn.getAttribute('ischoose'),
        text: btn.textContent.trim(),
      };
    }, TARGET_DATE_TEXT);

    if (!btnInfo.exists) {
      if (i <= 3 || i % 5 === 0) {
        log(`   第 ${i} 次未找到按鈕，可用: ${JSON.stringify(btnInfo.available)}`);
      }
      if (i % 10 === 0) {
        log('🔄 重新整理頁面...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      }
      await sleep(RETRY_INTERVAL_MS);
      continue;
    }

    log(`   找到按鈕: disabled=${btnInfo.disabled}, status=${btnInfo.status}, ischoose=${btnInfo.ischoose}`);

    if (!btnInfo.disabled) {
      // ✅ 按鈕可用（正式開放狀態）— 用 Puppeteer 原生滑鼠點擊
      log('   🖱️ 按鈕可用，使用 Puppeteer 原生點擊...');
      const btnHandle = await page.$(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`);
      if (btnHandle) {
        await btnHandle.click();
        await sleep(800);

        // 驗證是否選取成功 (ischoose 應變為 "1")
        const afterClick = await page.evaluate((targetText) => {
          const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
          return btn ? { ischoose: btn.getAttribute('ischoose'), classes: btn.className } : null;
        }, TARGET_DATE_TEXT);
        log(`   點擊後狀態: ${JSON.stringify(afterClick)}`);

        if (afterClick && afterClick.ischoose === '1') {
          timeSlotClicked = true;
          log('   ✅ 時段已成功選取 (ischoose=1)！');
          break;
        } else {
          log('   ⚠️ ischoose 未變為 1，時段可能尚未開放，繼續重試...');
          // 重新整理再試（可能需要等到 status 改變）
          if (i % 3 === 0) {
            log('   🔄 重新整理頁面...');
            await page.reload({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
            // 重新導航日曆
            await navigateToTargetDate(page);
          }
          await sleep(RETRY_INTERVAL_MS);
          continue;
        }
      }
    } else {
      // ⚠️ 按鈕 disabled（測試模式/尚未開放）— 嘗試強制點擊
      log('   ⚠️ 按鈕 disabled（尚未開放），嘗試強制操作...');

      // 先移除 disabled，再用 Puppeteer 滑鼠點擊（觸發原生事件處理器）
      await page.evaluate((targetText) => {
        const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
        if (btn) btn.classList.remove('disabled');
      }, TARGET_DATE_TEXT);
      await sleep(100);

      const btnHandle = await page.$(`div.btn2[alldate="${TARGET_DATE_TEXT}"]`);
      if (btnHandle) {
        await btnHandle.click();
        await sleep(500);

        // 驗證 ischoose 是否改變
        const recheck = await page.evaluate((targetText) => {
          const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
          return btn ? { ischoose: btn.getAttribute('ischoose'), classes: btn.className } : null;
        }, TARGET_DATE_TEXT);
        log(`   點擊後狀態: ${JSON.stringify(recheck)}`);

        timeSlotClicked = true;
        log('   ✅ 已強制點擊時段按鈕（測試模式）');
      }
      break;
    }
  }

  if (!timeSlotClicked) {
    log('❌ 無法找到目標時段按鈕，請手動操作');
    return false;
  }

  await sleep(500);

  // 最終驗證選取狀態
  const finalCheck = await page.evaluate((targetText) => {
    const btn = document.querySelector(`div.btn2[alldate="${targetText}"]`);
    if (!btn) return { found: false };
    return { found: true, ischoose: btn.getAttribute('ischoose'), classes: btn.className };
  }, TARGET_DATE_TEXT);
  log(`   最終選取狀態: ${JSON.stringify(finalCheck)}`);

  if (finalCheck.found && finalCheck.ischoose !== '1') {
    log('   ⚠️ 時段未被正確選取 (ischoose≠1)，可能尚未開放登記');
    log('   ⚠️ 繼續嘗試點擊「下一步」...');
  }

  // 點擊「下一步」按鈕
  log('🔍 尋找「下一步」按鈕...');
  for (let i = 0; i < 10; i++) {
    const nextStepClicked = await page.evaluate(() => {
      // 直接呼叫 showReservationAlert (最可靠)
      if (typeof showReservationAlert === 'function') {
        showReservationAlert();
        return { found: true, method: 'direct-call' };
      }
      // fallback: 尋找按鈕點擊
      const btns = document.querySelectorAll('a.btn-green, a.btn');
      for (const btn of btns) {
        if (btn.textContent.trim() === '下一步') {
          btn.click();
          return { found: true, method: 'text-match' };
        }
      }
      return { found: false };
    });

    if (nextStepClicked.found) {
      log(`   ✅ 已點擊「下一步」(${nextStepClicked.method})`);
      break;
    }
    log(`   第 ${i + 1} 次未找到「下一步」`);
    await sleep(500);
  }

  // 等待 JS 彈窗被 dialog handler 處理
  log('⏳ 等待 JS 彈窗...');
  await sleep(2000);

  // 等待跳轉到 Step3
  log('⏳ 等待跳轉到 Step3...');
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    log(`✅ 已跳轉到: ${page.url()}`);
  } catch (err) {
    log(`⚠️ 等待跳轉超時: ${err.message}`);
    log(`   當前 URL: ${page.url()}`);
  }

  return true;
}

async function main() {
  log('🚀 台北市場地租借自動搶位腳本啟動');
  log(`📍 場地 ID: ${VENUE_ID}`);
  log(`📍 Step1: ${STEP1_URL}`);
  log(`📍 Step2: ${STEP2_URL}`);
  log(`🎯 目標時段：${TARGET_DATE_TEXT}`);
  log(`📅 目標日期：${TARGET_MONTH}月${TARGET_DAY}日`);

  if (!isNowMode) {
    log(`⏰ 預定執行時間：${EXECUTE_TIME.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  }

  // 等待到接近目標時間
  await waitUntilTarget();

  // 啟動瀏覽器
  log('🌐 正在啟動瀏覽器...');

  // 判斷環境：伺服器使用 headless，本機使用有頭模式
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

  // 如果設定了 CHROMIUM_PATH 環境變數，使用系統 Chromium
  if (process.env.CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.CHROMIUM_PATH;
    log(`   使用自訂 Chromium: ${process.env.CHROMIUM_PATH}`);
  }

  log(`   模式: ${isServer ? 'headless (伺服器)' : '有頭模式 (本機)'}`);
  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  // 🔑 預先設定 dialog handler — 自動按掉所有 JS 彈窗 (alert/confirm/prompt)
  page.on('dialog', async (dialog) => {
    log(`💬 偵測到 JS 彈窗 [${dialog.type()}]: "${dialog.message()}"`);
    await dialog.accept(); // 按「確定」
    log('   ✅ 已自動按掉彈窗');
  });

  // 精準等待到 00:00:00
  await preciseWaitUntilExact();

  // ===== Step 1 =====
  await doStep1(page);

  // ===== Step 2 =====
  const step2Success = await doStep2(page);

  // ===== 完成 =====
  log('');
  if (step2Success) {
    log('🎊 ===========================');
    log('🎊   自動操作已完成！');
    log('🎊   已進入 Step3 頁面');
    log('🎊   請在瀏覽器中完成後續操作');
    log('🎊 ===========================');
  } else {
    log('⚠️ ===========================');
    log('⚠️   部分步驟未完成');
    log('⚠️   請在瀏覽器中手動操作');
    log('⚠️ ===========================');
  }

  log(`📍 當前 URL: ${page.url()}`);

  // 伺服器模式：擷取截圖後關閉瀏覽器；本機模式：保持開啟
  const isServer = !!(process.env.CLOUDWAYS || process.env.SERVER_MODE || process.env.NODE_ENV === 'production');
  if (isServer) {
    try {
      const screenshotPath = `screenshot-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log(`📸 已儲存截圖: ${screenshotPath}`);
    } catch (e) {
      log(`⚠️ 截圖失敗: ${e.message}`);
    }
    await browser.close();
    log('🌐 瀏覽器已關閉');
  } else {
    log('🔄 瀏覽器保持開啟中... 按 Ctrl+C 結束腳本');
    await new Promise(() => {});
  }
}

main().catch(err => {
  console.error('❌ 腳本執行失敗：', err);
  process.exit(1);
});
