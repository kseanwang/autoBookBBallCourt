const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const countdown   = document.getElementById('countdown');
const startBtn    = document.getElementById('startBtn');
const stopBtn     = document.getElementById('stopBtn');
const logOutput   = document.getElementById('logOutput');
const step3Banner = document.getElementById('step3Banner');
const step3Link   = document.getElementById('step3Link');

// ── Status display ──
const STATUS_LABELS = {
  idle:      '待機中',
  waiting:   '倒數中',
  running:   '搶位中',
  completed: '完成 ✓',
  error:     '錯誤',
  stopped:   '已停止',
};

function setStatus(type, opts = {}) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = STATUS_LABELS[type] || type;

  if (type === 'waiting' && opts.countdown) {
    countdown.textContent = opts.countdown;
    countdown.classList.add('visible');
  } else {
    countdown.classList.remove('visible');
  }

  const running = type === 'waiting' || type === 'running';
  startBtn.disabled = running;
  stopBtn.disabled  = !running;

  // Disable inputs while running
  document.querySelectorAll('input').forEach(el => {
    if (el.id !== 'runNow') el.disabled = running;
  });
}

// ── Log display ──
function appendLog(msg) {
  const div = document.createElement('div');
  div.className = 'log-line';

  if (msg.includes('✅') || msg.includes('🎊') || msg.includes('完成')) div.classList.add('success');
  else if (msg.includes('❌') || msg.includes('錯誤')) div.classList.add('error');
  else if (msg.includes('⚠️')) div.classList.add('warn');
  else if (msg.includes('⏰') || msg.includes('🎯') || msg.includes('🚀')) div.classList.add('info');

  div.textContent = msg;
  logOutput.appendChild(div);
  logOutput.scrollTop = logOutput.scrollHeight;
}

// ── IPC listeners ──
window.electronAPI.onLog((msg) => appendLog(msg));

window.electronAPI.onStatus((data) => {
  setStatus(data.type, data);

  if (data.type === 'completed' && data.step3Url) {
    step3Banner.classList.add('visible');
    step3Link.href = data.step3Url;
    step3Link.textContent = data.step3Url;
  }
  if (data.type === 'error' || data.type === 'stopped') {
    setStatus(data.type);
  }
});

// ── Start ──
startBtn.addEventListener('click', async () => {
  const config = {
    venueId:        document.getElementById('venueId').value.trim(),
    targetDateText: document.getElementById('targetDateText').value.trim(),
    targetMonth:    parseInt(document.getElementById('targetMonth').value),
    targetDay:      parseInt(document.getElementById('targetDay').value),
    executeDate:    document.getElementById('executeDate').value,
    executeTime:    document.getElementById('executeTime').value,
    runNow:         document.getElementById('runNow').checked,
  };

  if (!config.venueId || !config.targetDateText) {
    appendLog('❌ 請填寫場地 ID 和目標時段');
    return;
  }

  step3Banner.classList.remove('visible');
  setStatus('waiting');
  appendLog(`▶ 啟動任務：${config.targetDateText}`);

  const result = await window.electronAPI.startBooking(config);
  if (!result.success) {
    appendLog(`❌ ${result.error}`);
    setStatus('error');
  }
});

// ── Stop ──
stopBtn.addEventListener('click', async () => {
  await window.electronAPI.stopBooking();
  setStatus('stopped');
  appendLog('■ 已手動停止');
});

// ── Clear log ──
document.getElementById('clearLogBtn').addEventListener('click', () => {
  logOutput.innerHTML = '';
});

// Initial state
setStatus('idle');
