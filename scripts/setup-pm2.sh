#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> PM2 kuruluyor..."
npm install -g pm2

echo "==> Eski süreçler durduruluyor..."
npm run stop 2>/dev/null || true
pm2 delete automation-tcg 2>/dev/null || true
pkill -f "node src/index.js" 2>/dev/null || true

echo "==> Uygulama PM2 ile başlatılıyor..."
pm2 start ecosystem.config.js

echo "==> PM2 kaydediliyor..."
pm2 save

echo "==> Sunucu yeniden başlayınca otomatik açılması ayarlanıyor..."
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root | tail -1)
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD"
fi

pm2 status
echo ""
echo "Tamam. Panel: http://$(hostname -I | awk '{print $1}'):3000/login.html"
echo "Loglar: pm2 logs automation-tcg"
