#!/usr/bin/env bash
# v4: clean-session client share + mobile header clipping inspection.
set -u
cd /home/z/my-project/mjengoos
LOG=/home/z/my-project/download/qa-uiux-audit/audit-v4.txt
SHOTS=/home/z/my-project/download/qa-uiux-audit
: > "$LOG"
say(){ echo "$*" | tee -a "$LOG"; }
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db" NEXTAUTH_SECRET="$(openssl rand -hex 32)" RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app5.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null | grep -q 200 && break; sleep 1; done
AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }
EV(){ AB eval "$1"; }
OVF(){ EV "JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})" | grep -oE '\{.*\}' | tail -1; }
share_token=$(DATABASE_URL="$DATABASE_URL" bun -e "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient(); const r=await p.project.findFirst({where:{name:'Nyumba Yangu — 3BR Bungalow'},select:{shareToken:true}}); console.log(r?.shareToken||'')" 2>/dev/null | tail -1)

say "== CLEAN client share 390 =="
AB set viewport 390 844
AB open "http://127.0.0.1:3000/?share=$share_token"
AB wait --load networkidle; sleep 3
AB screenshot "$SHOTS/v4-client-clean-390.png"
say "ovf: $(OVF)"
say "head: $(EV "document.body.innerText.slice(0,300).replace(/\n/g,' | ')" | tail -1)"
say "has RecordExpense: $(EV "document.body.innerText.includes('Record expense')" | tail -1)"
say "has Reports btn: $(EV "document.body.innerText.includes('Reports')" | tail -1)"

say "== header clip inspection 390 (contractor) =="
AB cookies clear > /dev/null 2>&1
AB open http://127.0.0.1:3000/
AB wait --load networkidle; sleep 2
AB find label "Email" fill contractor@mjengo.os
AB find label "Password" fill mjengo2026
AB find role button click --name "Sign in"
sleep 4
AB set viewport 390 844
AB reload; AB wait --load networkidle; sleep 2
AB screenshot "$SHOTS/v4-header-390.png"
EV "JSON.stringify((()=>{const h=document.querySelector('header')||document.querySelector('[class*=sticky]');if(!h)return 'no-header';const r=h.getBoundingClientRect();const kids=[...h.querySelectorAll('*')].slice(0,40).map(e=>{const b=e.getBoundingClientRect();return {t:e.tagName,c:(e.className||'').toString().slice(0,30),l:Math.round(b.left),r:Math.round(b.right)}});const clipped=kids.filter(k=>k.l<-1||k.r>391);return {hdr:[Math.round(r.left),Math.round(r.right)],clipped:clipped.slice(0,6)}})())" | tail -1
EV "(()=>{const img=document.querySelector('header [class*=amber], header img, header svg');if(!img)return 'none';const b=img.getBoundingClientRect();const p=img.closest('div,a,button');const pb=p?p.getBoundingClientRect():b;return JSON.stringify({tag:img.tagName,il:Math.round(b.left),ir:Math.round(b.right),pl:Math.round(pb.left)})})()" | tail -1
AB errors | tail -3
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
say "== V4 COMPLETE =="
