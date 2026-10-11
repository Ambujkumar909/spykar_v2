#!/usr/bin/env bash
# Go live on https://spykarlifestyles.info — run ONCE as root:
#   sudo bash ~/spykar/spykar_v2/deploy/golive_nginx.sh
# Idempotent: safe to re-run (e.g. after renewing the certificate).
# Validates with `nginx -t` before (re)loading; on failure nothing goes live.
set -euo pipefail
REPO=/home/deploy/spykar/spykar_v2
SSL_SRC=$REPO/spykar-ssl
SSL_DST=/etc/nginx/ssl/spykarlifestyles.info
SITE=spykarlifestyles.info

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
for f in fullchain.pem privkey.pem; do [ -s "$SSL_SRC/$f" ] || { echo "Missing $SSL_SRC/$f"; exit 1; }; done

echo "==> 1/6 install nginx"
command -v nginx >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx; }
nginx -v

echo "==> 2/6 certificates → $SSL_DST"
install -d -m 755 "$SSL_DST"
install -m 644 -o root -g root "$SSL_SRC/fullchain.pem" "$SSL_DST/fullchain.pem"
install -m 600 -o root -g root "$SSL_SRC/privkey.pem"   "$SSL_DST/privkey.pem"
openssl x509 -in "$SSL_DST/fullchain.pem" -noout -subject -enddate

echo "==> 3/6 config"
install -m 644 "$REPO/deploy/nginx/spykar-ratelimit.conf" /etc/nginx/conf.d/spykar-ratelimit.conf
install -d -m 755 /etc/nginx/snippets
install -m 644 "$REPO/deploy/nginx/spykar-security-headers.conf" /etc/nginx/snippets/spykar-security-headers.conf
# Capacity = what the go-live gate load-tested (Ubuntu default is 768/worker,
# and each proxied request holds 2 connections: client + upstream).
cp -n /etc/nginx/nginx.conf /etc/nginx/nginx.conf.orig-ubuntu
sed -i -E 's/^(\s*)worker_connections\s+[0-9]+;/\1worker_connections 4096;/' /etc/nginx/nginx.conf
grep -q '^worker_rlimit_nofile' /etc/nginx/nginx.conf || sed -i '/^worker_processes/a worker_rlimit_nofile 16384;' /etc/nginx/nginx.conf
grep -E '^(worker_processes|worker_rlimit_nofile)|worker_connections' /etc/nginx/nginx.conf
install -m 644 "$REPO/deploy/nginx/$SITE.conf" /etc/nginx/sites-available/$SITE.conf
ln -sfn /etc/nginx/sites-available/$SITE.conf /etc/nginx/sites-enabled/$SITE.conf
rm -f /etc/nginx/sites-enabled/default

echo "==> 4/6 validate"
nginx -t

echo "==> 5/6 start / reload"
systemctl enable --now nginx
systemctl reload nginx
systemctl is-active nginx

echo "==> 6/6 firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp; ufw allow 443/tcp; ufw status | grep -E "80|443"
else
  echo "ufw inactive — nothing to open (check any external firewall / router forwards 80 and 443 to this server)"
fi

echo
echo "==> local check (SNI to this host)"
curl -sS -o /dev/null -w "https://$SITE/  → %{http_code}  (TLS verify ok=%{ssl_verify_result})\n" --resolve $SITE:443:127.0.0.1 https://$SITE/ || true
curl -sS -o /dev/null -w "https://$SITE/health → %{http_code}\n" --resolve $SITE:443:127.0.0.1 https://$SITE/health || true
curl -sS -o /dev/null -w "http://$SITE/ → %{http_code} (expect 301)\n" --resolve $SITE:80:127.0.0.1 http://$SITE/ || true
echo "DONE — open https://$SITE"
