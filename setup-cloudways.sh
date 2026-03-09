#!/bin/bash
# ============================================
#  Cloudways 部署腳本 — 場地搶位系統
#  在 Cloudways 主機 SSH 中執行此腳本
# ============================================

set -e

echo "🏀 場地搶位系統 — Cloudways 部署開始"
echo "========================================"

# 1. 安裝 Chromium 與相依套件（Puppeteer 需要）
echo ""
echo "📦 Step 1: 安裝 Chromium 瀏覽器相依套件..."
sudo apt-get update -y
sudo apt-get install -y \
  chromium-browser \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  wget \
  ca-certificates \
  --no-install-recommends

# 確認 Chromium 路徑
CHROMIUM_PATH=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo "")
if [ -z "$CHROMIUM_PATH" ]; then
  echo "⚠️  未找到系統 Chromium，Puppeteer 將使用內建 Chromium"
else
  echo "✅ Chromium 位置: $CHROMIUM_PATH"
  echo ""
  echo "💡 如要使用系統 Chromium，請編輯 ecosystem.config.js："
  echo "   取消註解 CHROMIUM_PATH 並設為: $CHROMIUM_PATH"
fi

# 2. 安裝 Node.js 相依套件
echo ""
echo "📦 Step 2: 安裝 Node.js 套件..."
npm install --production

# 3. 建立日誌目錄
echo ""
echo "📁 Step 3: 建立日誌目錄..."
mkdir -p logs

# 4. 安裝 PM2（如果尚未安裝）
echo ""
echo "📦 Step 4: 確認 PM2..."
if ! command -v pm2 &> /dev/null; then
  echo "   安裝 PM2..."
  npm install -g pm2
else
  echo "   ✅ PM2 已安裝: $(pm2 --version)"
fi

# 5. 用 PM2 啟動
echo ""
echo "🚀 Step 5: 啟動應用程式..."
pm2 stop autobookbballcourt 2>/dev/null || true
pm2 delete autobookbballcourt 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "🎊 ========================================"
echo "🎊  部署完成！"
echo "🎊 ========================================"
echo ""
echo "📋 常用指令："
echo "   pm2 status              — 查看狀態"
echo "   pm2 logs                — 查看日誌"
echo "   pm2 restart all         — 重啟"
echo "   pm2 stop all            — 停止"
echo ""
echo "🌐 請在 Cloudways 面板設定反向代理："
echo "   將網域指向 localhost:3939"
echo ""
