#!/bin/sh
set -eu

systemctl stop caddy
trap 'systemctl start caddy' EXIT

/opt/certbot/bin/certbot renew \
	--quiet \
	--deploy-hook /opt/dbx-mini-games/deploy/systemd/certbot-deploy.sh
