#!/usr/bin/env bash
# Direct API probe: contractor login + /api/projects (isolates FE vs BE).
set -u
cd /home/z/my-project/mjengoos
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db"
export NEXTAUTH_SECRET="$(openssl rand -hex 32)"
export RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app.log 2>&1 &
for i in $(seq 1 45); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null | grep -q 200 && break; sleep 1; done
echo "health: $(curl -s http://127.0.0.1:3000/api/health | head -c 120)"

JAR=/tmp/contractor.jar; rm -f $JAR
CSRF=$(curl -s -c $JAR http://127.0.0.1:3000/api/auth/csrf | python3 -c "import json,sys;print(json.load(sys.stdin)['csrfToken'])")
echo "csrf: ${CSRF:0:12}..."
LOGIN=$(curl -s -b $JAR -c $JAR -X POST http://127.0.0.1:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=contractor@mjengo.os" \
  --data-urlencode "password=mjengo2026" \
  -o /dev/null -w '%{http_code}')
echo "login: $LOGIN"
SESSION=$(curl -s -b $JAR http://127.0.0.1:3000/api/auth/session)
echo "session: $(echo "$SESSION" | head -c 300)"
PROJ=$(curl -s -b $JAR http://127.0.0.1:3000/api/projects)
echo "projects status-body: $(echo "$PROJ" | head -c 400)"
echo "projects count: $(echo "$PROJ" | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else list(d.keys()))
except Exception as e: print('parse-err', e)")"
# supervisor comparison
JAR2=/tmp/supervisor.jar; rm -f $JAR2
CSRF2=$(curl -s -c $JAR2 http://127.0.0.1:3000/api/auth/csrf | python3 -c "import json,sys;print(json.load(sys.stdin)['csrfToken'])")
curl -s -b $JAR2 -c $JAR2 -X POST http://127.0.0.1:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF2" --data-urlencode "email=supervisor@mjengo.os" \
  --data-urlencode "password=mjengo2026" -o /dev/null -w 'sup login: %{http_code}\n'
echo "supervisor projects: $(curl -s -b $JAR2 http://127.0.0.1:3000/api/projects | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else list(d.keys()))
except Exception as e: print('parse-err', e)")"
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
echo done
