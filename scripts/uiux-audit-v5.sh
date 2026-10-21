#!/usr/bin/env bash
set -u
cd /home/z/my-project/mjengoos
LOG=/home/z/my-project/download/qa-uiux-audit/audit-v5.txt
SHOTS=/home/z/my-project/download/qa-uiux-audit
: > "$LOG"; say(){ echo "$*" | tee -a "$LOG"; }
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db" NEXTAUTH_SECRET="$(openssl rand -hex 32)" RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app6.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null | grep -q 200 && break; sleep 1; done
AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }
EV(){ AB eval "$1"; }
AB set viewport 390 844
AB open http://127.0.0.1:3000/
AB wait --load networkidle; sleep 2
AB cookies clear > /dev/null 2>&1
EV "(async()=>{try{const ds=await indexedDB.databases();for(const d of ds){indexedDB.deleteDatabase(d.name)}}catch(e){};try{localStorage.clear();sessionStorage.clear()}catch(e){};return 'idb+ls cleared'})()" 2>&1 | tail -1
sleep 1
AB open http://127.0.0.1:3000/
AB wait --load networkidle; sleep 2
AB find label "Email" fill contractor@mjengo.os
AB find label "Password" fill mjengo2026
AB find role button click --name "Sign in"
sleep 4
AB reload; AB wait --load networkidle; sleep 2
AB screenshot "$SHOTS/v5-header-390.png"
say "== header children boxes @390 =="
EV "JSON.stringify((()=>{const out=[];const walk=(el,d)=>{if(d>3)return;const b=el.getBoundingClientRect();out.push({d,tag:el.tagName,c:(el.className||'').toString().slice(0,40),l:Math.round(b.left),r:Math.round(b.right),w:Math.round(b.width)});[...el.children].forEach(x=>walk(x,d+1))};const h=document.querySelector('header');if(!h)return 'no-header';walk(h,0);return out.filter(x=>x.d<=2)})())" | tail -1
say "== first-child visual check =="
EV "(()=>{const h=document.querySelector('header');const first=h.querySelector('div');const b=first.getBoundingClientRect();const s=getComputedStyle(first);return JSON.stringify({left:Math.round(b.left),w:Math.round(b.width),ml:s.marginLeft,mr:s.marginRight,shrink:s.flexShrink,ovf:getComputedStyle(h).overflowX})})()" | tail -1
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
say "== V5 COMPLETE =="
