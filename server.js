const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== 狀態管理 ======
let currentJob = null; // { process, config, status, logs }

// ====== API: 取得目前任務狀態 ======
app.get('/api/status', (req, res) => {
  if (!currentJob) {
    return res.json({ running: false, status: 'idle', logs: [] });
  }
  res.json({
    running: currentJob.status === 'running',
    status: currentJob.status,
    config: currentJob.config,
    logs: currentJob.logs.slice(-200), // 最近 200 條
  });
});

// ====== API: 啟動搶位任務 ======
app.post('/api/start', (req, res) => {
  if (currentJob && currentJob.status === 'running') {
    return res.status(400).json({ error: '已有任務正在執行中，請先停止' });
  }

  const {
    venueId,
    targetDateText,
    targetMonth,
    targetDay,
    executeDate,
    executeTime,
    runNow,
  } = req.body;

  // 驗證必要欄位
  if (!venueId || !targetDateText || !executeDate || !executeTime) {
    return res.status(400).json({ error: '缺少必要設定欄位' });
  }

  const config = {
    venueId,
    targetDateText,
    targetMonth: parseInt(targetMonth),
    targetDay: parseInt(targetDay),
    executeDate,
    executeTime,
    runNow: !!runNow,
  };

  // 組合參數啟動 auto-book.js
  const args = ['auto-book.js'];
  if (config.runNow) args.push('--now');
  args.push('--config', JSON.stringify(config));

  const child = spawn('node', args, {
    cwd: __dirname,
    env: { ...process.env },
  });

  currentJob = {
    process: child,
    config,
    status: 'running',
    logs: [],
    startTime: new Date().toISOString(),
  };

  const addLog = (msg) => {
    const line = msg.toString().trim();
    if (line) {
      currentJob.logs.push(line);
      // 只保留最近 500 條
      if (currentJob.logs.length > 500) {
        currentJob.logs = currentJob.logs.slice(-300);
      }
    }
  };

  child.stdout.on('data', addLog);
  child.stderr.on('data', addLog);

  child.on('close', (code) => {
    if (currentJob && currentJob.process === child) {
      currentJob.status = code === 0 ? 'completed' : 'stopped';
      currentJob.logs.push(`[程序結束] exit code: ${code}`);
    }
  });

  child.on('error', (err) => {
    if (currentJob && currentJob.process === child) {
      currentJob.status = 'error';
      currentJob.logs.push(`[錯誤] ${err.message}`);
    }
  });

  res.json({ success: true, message: '搶位任務已啟動', config });
});

// ====== API: 停止任務 ======
app.post('/api/stop', (req, res) => {
  if (!currentJob || currentJob.status !== 'running') {
    return res.status(400).json({ error: '沒有正在執行的任務' });
  }

  try {
    currentJob.process.kill('SIGTERM');
    currentJob.status = 'stopped';
    currentJob.logs.push('[手動停止] 任務已被使用者停止');
    res.json({ success: true, message: '任務已停止' });
  } catch (err) {
    res.status(500).json({ error: `停止失敗: ${err.message}` });
  }
});

// ====== API: 清除歷史 ======
app.post('/api/clear', (req, res) => {
  if (currentJob && currentJob.status === 'running') {
    return res.status(400).json({ error: '任務仍在執行中' });
  }
  currentJob = null;
  res.json({ success: true });
});

// ====== 啟動伺服器 ======
// Vercel 會直接 import 此模組，本機開發才呼叫 listen
if (process.env.VERCEL) {
  // Vercel 環境：直接 export，不呼叫 listen
  module.exports = app;
} else {
  const PORT = process.env.PORT || 3939;
  app.listen(PORT, () => {
    console.log('');
    console.log('🏀 ================================');
    console.log(`🏀  場地搶位控制台已啟動`);
    console.log(`🏀  http://localhost:${PORT}`);
    console.log('🏀 ================================');
    console.log('');
  });
  module.exports = app;
}
