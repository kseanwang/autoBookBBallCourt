const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== 狀態管理：支援多個並行任務 ======
const jobs = new Map();
let jobSeq = 0;

function makeJobId() {
  return `job_${++jobSeq}_${Date.now()}`;
}

function startJob(config) {
  const jobId = makeJobId();

  const args = ['auto-book.js'];
  if (config.runNow) args.push('--now');
  args.push('--config', JSON.stringify(config));

  const child = spawn('node', args, {
    cwd: __dirname,
    env: { ...process.env },
  });

  const job = {
    id: jobId,
    process: child,
    config,
    status: 'running',
    logs: [],
    startTime: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  const addLog = (msg) => {
    const line = msg.toString().trim();
    if (line) {
      job.logs.push(line);
      if (job.logs.length > 500) job.logs = job.logs.slice(-300);
      const urlMatch = line.match(/STEP3_URL:\s*(https?:\/\/\S+)/);
      if (urlMatch) {
        job.step3Url = urlMatch[1];
        job.status = 'step3_ready';
      }
    }
  };

  child.stdout.on('data', addLog);
  child.stderr.on('data', addLog);

  child.on('close', (code) => {
    if (jobs.get(jobId) === job) {
      job.status = code === 0 ? 'completed' : 'stopped';
      job.logs.push(`[程序結束] exit code: ${code}`);
    }
  });

  child.on('error', (err) => {
    job.status = 'error';
    job.logs.push(`[錯誤] ${err.message}`);
  });

  return jobId;
}

// ====== API: 取得所有任務狀態 ======
app.get('/api/status', (req, res) => {
  const jobList = Array.from(jobs.values()).map(j => ({
    id: j.id,
    name: j.config.name || j.config.targetDateText || '未知',
    status: j.status,
    startTime: j.startTime,
    logs: j.logs.slice(-100),
    step3Url: j.step3Url || null,
  }));
  res.json({ jobs: jobList });
});

// ====== API: 啟動單一搶位任務 ======
app.post('/api/start', (req, res) => {
  const {
    venueId, targetDateText, targetMonth, targetDay,
    executeDate, executeTime, runNow, name, numBots,
  } = req.body;

  if (!venueId || !targetDateText || !executeDate || !executeTime) {
    return res.status(400).json({ error: '缺少必要設定欄位' });
  }

  const config = {
    name: name || targetDateText,
    venueId, targetDateText,
    targetMonth: parseInt(targetMonth),
    targetDay: parseInt(targetDay),
    executeDate, executeTime,
    runNow: !!runNow,
    numBots: parseInt(numBots) || 2,
  };

  const jobId = startJob(config);
  res.json({ success: true, jobId });
});

// ====== API: 批次啟動多個時段 ======
app.post('/api/start-batch', (req, res) => {
  const { slots } = req.body;

  if (!Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: '缺少時段清單' });
  }

  for (const slot of slots) {
    if (!slot.venueId || !slot.targetDateText || !slot.executeDate || !slot.executeTime) {
      return res.status(400).json({ error: `時段設定不完整: ${slot.name || slot.targetDateText}` });
    }
  }

  // 批次清單裡的每一筆本身就代表「一個 Bot」（UI 端已依 Bot 數量展開成多筆），
  // 這裡固定 numBots=1，避免每個 process 內部又預設再開 2 個瀏覽器造成數量爆炸。
  const jobIds = slots.map(slot => startJob({
    ...slot,
    targetMonth: parseInt(slot.targetMonth),
    targetDay: parseInt(slot.targetDay),
    runNow: !!slot.runNow,
    numBots: 1,
  }));

  res.json({ success: true, jobIds, count: jobIds.length });
});

// ====== API: 停止特定任務 ======
app.post('/api/stop/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'running') {
    return res.status(400).json({ error: '找不到執行中的任務' });
  }
  try {
    job.process.kill('SIGTERM');
    job.status = 'stopped';
    job.logs.push('[手動停止] 任務已被使用者停止');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `停止失敗: ${err.message}` });
  }
});

// ====== API: 清除已完成/停止的任務 ======
app.post('/api/clear', (req, res) => {
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'running') jobs.delete(id);
  }
  res.json({ success: true });
});

// ====== 啟動伺服器 ======
const PORT = process.env.PORT || 3939;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('🏀 ================================');
  console.log(`🏀  場地搶位控制台已啟動`);
  console.log(`🏀  ${HOST}:${PORT}`);
  console.log('🏀 ================================');
  console.log('');
});

module.exports = app;
