#!/bin/bash
# ============================================
#  Cloudways 部署腳本 — 場地搶位系統
#  在 Cloudways 主機 SSH 中執行此腳本
# ============================================

set -e

echo "🏀 場地搶位系統 — Cloudways 部署開始"
echo "========================================"

# 1. 載入 nvm 環境（確保 npm/pm2 可用）
echo ""
echo "⚙️  Step 1: 載入 nvm 環境..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
  echo "   ✅ nvm 已載入，Node: $(node -v), npm: $(npm -v)"
else
  echo "   ⚠️  未找到 nvm，嘗試使用系統 node/npm..."
fi

# 確認 npm 可用
if ! command -v npm &> /dev/null; then
  echo "   ❌ npm 找不到，請確認 Node.js 已安裝"
  exit 1
fi

# 2. 安裝 Node.js 相依套件
echo ""
echo "📦 Step 2: 安裝 Node.js 套件..."
npm install --production

# 3. 建立日誌目錄
echo ""
echo "📁 Step 3: 建立日誌目錄..."
mkdir -p logs

# 4. 確認 PM2
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
