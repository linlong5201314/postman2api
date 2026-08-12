#!/bin/sh
set -eu

mkdir -p /app/data
chown -R bun:bun /app/data

exec su -s /bin/sh bun -c 'exec bun src/index.ts'
