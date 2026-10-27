#!/bin/sh
set -eu

install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" /etc/caddy/certs/ip.crt
install -m 0640 -o root -g caddy "$RENEWED_LINEAGE/privkey.pem" /etc/caddy/certs/ip.key
