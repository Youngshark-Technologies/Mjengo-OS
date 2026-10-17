#!/bin/bash
# MJG-019 — container entrypoint: ensure the schema exists, then serve.
# SQLite + prisma db push is idempotent: it creates the file/tables if missing
# and adds missing columns otherwise. It never drops data on existing tables.
set -euo pipefail
cd /app

echo "[entrypoint] applying schema (prisma db push)..."
bunx prisma db push --skip-generate

echo "[entrypoint] starting MjengoOS on :${PORT:-3000}"
# .next/standalone contents are copied to /app in the Dockerfile -> server.js at root.
exec bun server.js
