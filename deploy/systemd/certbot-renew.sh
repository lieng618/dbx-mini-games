#!/bin/sh
set -eu

# Caddy keeps port 80 bound, so the ACME HTTP-01 challenge needs it briefly
# free. certbot runs these hooks only when a certificate is actually due, so an
# idle daily run never interrupts connected rooms.
#
# The post hook restores Caddy for both successful and failed attempts; the
# unit's ExecStopPost covers the case where certbot itself is killed.
/opt/certbot/bin/certbot renew \
	--quiet \
	--no-random-sleep-on-renew \
	--pre-hook "systemctl stop caddy" \
	--post-hook "systemctl start caddy" \
	--deploy-hook /opt/dbx-mini-games/deploy/systemd/certbot-deploy.sh
