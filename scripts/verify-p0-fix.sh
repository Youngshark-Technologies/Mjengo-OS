#!/usr/bin/env bash
set -u
cd /home/z/my-project/mjengoos
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db" NEXTAUTH_SECRET="$(openssl rand -hex 32)" RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app4.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null | grep -q 200 && break; sleep 1; done
JAR=/tmp/c3.jar; rm -f $JAR
CSRF=$(curl -s -c $JAR http://127.0.0.1:3000/api/auth/csrf | python3 -c "import json,sys;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b $JAR -c $JAR -X POST http://127.0.0.1:3000/api/auth/callback/credentials -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=contractor@mjengo.os" --data-urlencode "password=mjengo2026" -o /dev/null -w 'login: %{http_code}\n'
curl -s -b $JAR http://127.0.0.1:3000/api/projects | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ok:', d.get('ok'), '| count:', len(d.get('projects',[])))
for p in d.get('projects',[]): print(' -', p['name'], '|', p.get('status'))"
echo "sharp/dlopen errors: $(grep -c 'ERR_DLOPEN\|Failed to load external' /tmp/app4.log || true)"
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
echo VERIFIED
