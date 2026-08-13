#!/bin/sh
set -eu

mkdir -p /app/data
chown -R bun:bun /app/data

# Camoufox is fetched at build time into /home/bun/.cache/camoufox.
# `su` without `-` preserves the caller's HOME (/root), which makes the
# login script silently fall back to detectable Chromium. Export the bun
# user's home so the anti-detection browser is found at runtime.
export HOME=/home/bun
export XDG_CACHE_HOME=/home/bun/.cache

exec su -s /bin/sh bun -c 'exec bun src/index.ts'
