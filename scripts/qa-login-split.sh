#!/usr/bin/env bash
# QA: split-screen login at 4 breakpoints + prod credential leak scan.
set -u
cd /home/z/my-project/mjengoos
LOG=/home/z/my-project/download/qa-uiux-audit/qa-login-v2.txt
SHOTS=/home/z/my-project/download/qa-uiux-audit
: > "$LOG"; say(){ echo "$*" | tee -a "$LOG"; }
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db" NEXTAUTH_SECRET="$(openssl rand -hex 32)" RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app7.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null | grep -q 200 && break; sleep 1; done
AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }
EV(){ AB eval "$1"; }
OVF(){ EV "JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})" | grep -oE '\{.*\}' | tail -1; }
AB cookies clear > /dev/null 2>&1
EV "(async()=>{try{const ds=await indexedDB.databases();for(const d of ds){indexedDB.deleteDatabase(d.name)}}catch(e){};try{localStorage.clear();sessionStorage.clear()}catch(e){};return 'cleared'})()" > /dev/null 2>&1

for VP in "1440 900" "768 1024" "390 844" "320 568"; do
  W=${VP% *}; H=${VP#* }
  say "== login ${W}x${H} =="
  AB set viewport $W $H
  AB open http://127.0.0.1:3000/
  AB wait --load networkidle; sleep 2
  AB screenshot "$SHOTS/qa2-login-$W.png"
  say "ovf: $(OVF)"
  say "aside: $(EV "(()=>{const a=document.querySelector('aside');if(!a)return 'none';const s=getComputedStyle(a);return JSON.stringify({display:s.display,ariaHidden:a.getAttribute('aria-hidden'),grid:document.querySelector('body div')&&getComputedStyle(document.firstElementChild.contains(a)?a.parentElement:document.body).display})})()" | tail -1)"
  say "brandCopy: $(EV "document.body.innerText.includes('Works offline')||document.body.innerText.includes('Hufanya kazi')" | tail -1)"
  say "logoChip: $(EV "(()=>{const el=[...document.querySelectorAll('main .lg\\\\:hidden, main [class*=lg\\\\:hidden]')];return el.length?getComputedStyle(el[0]).display:'n/a'})()" | tail -1)"
done
say "== prod leak scan =="
LEAK=$(grep -rl "mjengo2026\|supplier2026\|admin2026" .next/standalone/.next/server 2>/dev/null | grep -v "\.map" | wc -l)
say "leak files in server chunks: $LEAK"
LEAK2=$(grep -rl "contractor@mjengo.os" .next/standalone/.next/static 2>/dev/null | wc -l)
say "leak files in static js: $LEAK2"
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
say "== QA COMPLETE =="
