#!/usr/bin/env bash
# Установка сайта на чистый сервер Ubuntu или Debian. Запускать от root.
# Перед запуском файл с ключами должен лежать в /root/site.env.
# Необязательный аргумент: свой домен. Без него адрес будет вида 1-2-3-4.sslip.io.
set -euo pipefail

REPO=https://github.com/uquqaparoy16-tech/lolsarxip1.git
SITE=/opt/site
DOMAIN="${1:-}"

[ -f /root/site.env ] || { echo "Нет файла /root/site.env с ключами"; exit 1; }

IP=$(curl -4 -fsS https://api.ipify.org)
[ -n "$DOMAIN" ] || DOMAIN="$(echo "$IP" | tr . -).sslip.io"

# 0,5 ГБ памяти мало для установки пакетов, поэтому добавляем файл подкачки
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git gnupg debian-keyring debian-archive-keyring apt-transport-https ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y nodejs caddy

[ -d "$SITE/.git" ] && git -C "$SITE" pull || git clone "$REPO" "$SITE"

grep -v -E '^(HOST|PORT|TRUST_PROXY|SITE_URL)=' /root/site.env > "$SITE/.env"
cat >> "$SITE/.env" <<CONF
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=1
SITE_URL=https://$DOMAIN
CONF
chmod 600 "$SITE/.env"

cat > /etc/systemd/system/dota.service <<'UNIT'
[Unit]
Description=Dota site
After=network-online.target

[Service]
WorkingDirectory=/opt/site
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
CADDY

systemctl daemon-reload
systemctl enable --now dota
systemctl restart dota
systemctl restart caddy
ufw allow 22,80,443/tcp
ufw --force enable

echo
echo "Готово: https://$DOMAIN"
