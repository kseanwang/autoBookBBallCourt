/**
 * PM2 Ecosystem Config — Cloudways 部署用
 *
 * 啟動: pm2 start ecosystem.config.js
 * 查看: pm2 status / pm2 logs
 * 重啟: pm2 restart autobookbballcourt
 * 停止: pm2 stop autobookbballcourt
 */
module.exports = {
  apps: [
    {
      name: 'autobookbballcourt',
      script: 'server.js',
      cwd: __dirname,

      // 環境變數
      env: {
        NODE_ENV: 'production',
        PORT: 3939,
        HOST: '0.0.0.0',
        SERVER_MODE: '1',
        CLOUDWAYS: '1',
        // 如果使用系統 Chromium，取消註解下行並填入路徑
        // CHROMIUM_PATH: '/usr/bin/chromium-browser',
      },

      // 自動重啟
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',

      // 日誌
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // 進階設定
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};
