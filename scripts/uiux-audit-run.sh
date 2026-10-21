#!/usr/bin/env bash
# UI/UX modernization audit — runtime discovery (single-session runner).
# Starts prod servers + browser QA at 4 breakpoints across all surfaces.
# Output: /home/z/my-project/download/qa-uiux-audit/{*.png,audit-log.txt}
set -u
cd /home/z/my-project/mjengoos
LOG=/home/z/my-project/download/qa-uiux-audit/audit-log.txt
SHOTS=/home/z/my-project/download/qa-uiux-audit
mkdir -p "$SHOTS"
: > "$LOG"
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
P(){ echo "PASS: $*" | tee -a "$LOG"; }
F(){ echo "FAIL: $*" | tee -a "$LOG"; }
CHK(){ if [ "$1" = "1" ]; then P "$2"; else F "$2"; fi }

# ---------- 0. sanity ----------
command -v agent-browser >/dev/null || { echo "agent-browser missing"; exit 1; }

# ---------- 1. servers ----------
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db"
export NEXTAUTH_SECRET="$(openssl rand -hex 32)"
export RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app.log 2>&1 &
( cd mjengoos-website/.next/standalone && PORT=3001 HOSTNAME=127.0.0.1 NODE_ENV=production nohup node server.js > /tmp/site.log 2>&1 & )
for i in $(seq 1 45); do
  A=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null)
  S=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/website 2>/dev/null)
  [ "$A" = "200" ] && [ "$S" = "200" ] && break; sleep 1
done
log "servers: app=$A site=$S"
[ "$A" = "200" ] && [ "$S" = "200" ] || { echo "servers failed"; tail -5 /tmp/app.log /tmp/site.log; exit 1; }

SHARE_TOKEN=$(DATABASE_URL="$DATABASE_URL" bun -e "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient(); const r=await p.project.findFirst({where:{name:'Nyumba Yangu — 3BR Bungalow'},select:{shareToken:true}}); console.log(r?.shareToken||'')" 2>/dev/null | tail -1)
log "share token: ${SHARE_TOKEN:0:8}..."

B(){ agent-browser "$@" >> "$LOG" 2>&1; }

overflow(){ B eval "JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})"; }
no_h_overflow(){ overflow | grep -q '"sw":*[0-9]*' && ! overflow | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d['sw']<=d['cw']+1 else 1)" 2>/dev/null; }

# ---------- 2. LOGIN SURFACE ----------
log "== LOGIN 1440x900 =="
B set viewport 1440 900
B open http://127.0.0.1:3000/
B wait --load networkidle
B screenshot "$SHOTS/login-1440.png"
OVF=$(overflow); log "login1440 overflow: $OVF"
echo "$OVF" | grep -qE '"sw":[0-9]+,' || true
# aside brand panel + main form both present
B get count "aside" > /tmp/c1 2>&1; ASIDES=$(tr -dc '0-9' < /tmp/c1 | tail -c 2)
B get count "main" > /tmp/c2 2>&1; Mains=$(tr -dc '0-9' < /tmp/c2 | tail -c 2)
log "login1440 aside=$ASIDES main=$Mains"
B console >> "$LOG" 2>&1
B errors >> "$LOG" 2>&1

log "== LOGIN 390x844 =="
B set viewport 390 844
B reload; B wait --load networkidle
B screenshot "$SHOTS/login-390.png"
log "login390 overflow: $(overflow)"
B eval "getComputedStyle(document.querySelector('aside')||document.body).display" > /tmp/c3 2>&1
log "login390 aside display: $(tail -1 /tmp/c3)"

log "== LOGIN 320x568 =="
B set viewport 320 568
B reload; B wait --load networkidle
B screenshot "$SHOTS/login-320.png"
log "login320 overflow: $(overflow)"
B set viewport 1440 900

# ---------- 3. SITE ==========
log "== SITE 1440 =="
B open http://127.0.0.1:3001/website
B wait --load networkidle
B screenshot "$SHOTS/site-1440.png"
log "site1440 overflow: $(overflow)"
log "site1440 errors: $(B errors; tail -3 "$LOG" | grep -c . )"
B set viewport 390 844
B reload; B wait --load networkidle
B screenshot "$SHOTS/site-390.png"
log "site390 overflow: $(overflow)"
B set viewport 1440 900

# ---------- 4. LOGIN AS CONTRACTOR ----------
log "== LOGIN FLOW (contractor) =="
B open http://127.0.0.1:3000/
B wait --load networkidle
B snapshot -i -c > /tmp/snap-login.txt 2>&1
EMAIL_REF=$(grep -oE '@e[0-9]+' /tmp/snap-login.txt | head -1)
grep -i "email" /tmp/snap-login.txt | head -3 >> "$LOG"
# use find by type via eval to be robust
B eval "(()=>{const i=[...document.querySelectorAll('input')]; return JSON.stringify(i.map(x=>x.type+':'+x.name+':'+x.id))})()" > /tmp/inputs.txt 2>&1
log "inputs: $(tail -1 /tmp/inputs.txt)"
B find label "Email" fill "contractor@mjengo.os" >> "$LOG" 2>&1 || B eval "(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.type==='email');if(!e)return 'NOEMAIL';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(e,'contractor@mjengo.os');e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >> "$LOG" 2>&1
B eval "(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.type==='password');if(!e)return 'NOPW';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(e,'mjengo2026');e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >> "$LOG" 2>&1
B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.type==='submit');if(!b)return 'NOSUBMIT';b.click();return 'clicked'})()" >> "$LOG" 2>&1
B wait --load networkidle
sleep 3
B screenshot "$SHOTS/app-contractor-1440.png"
B get url > /tmp/url.txt 2>&1; log "post-login url: $(tail -1 /tmp/url.txt)"
log "app1440 overflow: $(overflow)"
B eval "document.querySelector('[role=tablist]')?document.querySelectorAll('[role=tab]').length:0" > /tmp/tabs.txt 2>&1
log "tab count: $(tail -1 /tmp/tabs.txt)"

# per-tab sweep @1440: overflow + console errors
TABKEYS="overview site materials finder fundis money land evidence copilot ussd audit settings"
for T in $TABKEYS; do
  B eval "(()=>{const t=document.getElementById('mjengo-tab-$T');if(!t)return 'NOEL';t.click();return 'ok'})()" >> "$LOG" 2>&1
  sleep 1.2
  O=$(overflow)
  E=$(B errors; :)
  log "tab $T @1440: $O"
done
B screenshot "$SHOTS/app-money-1440.png"

# ---------- 5. MOBILE APP ==========
log "== APP 390x844 =="
B set viewport 390 844
B eval "(()=>{const t=document.getElementById('mjengo-tab-overview');if(t){t.click();return 'ok'}return 'no-desktop-tab'})()" >> "$LOG" 2>&1
B reload; B wait --load networkidle; sleep 2
B screenshot "$SHOTS/app-contractor-390.png"
log "app390 overflow: $(overflow)"
B eval "document.querySelectorAll('[data-slot], nav').length" > /tmp/n.txt 2>&1
B eval "(()=>{const b=document.querySelector('nav, [class*=bottom]');return b?getComputedStyle(b).position:'none'})()" > /tmp/bn.txt 2>&1
log "mobile nav position: $(tail -1 /tmp/bn.txt)"

# ---------- 6. CLIENT SHARE SURFACE ----------
if [ -n "$SHARE_TOKEN" ]; then
  log "== CLIENT SHARE 390 =="
  B open "http://127.0.0.1:3000/?share=$SHARE_TOKEN"
  B wait --load networkidle; sleep 2
  B screenshot "$SHOTS/client-share-390.png"
  log "client390 overflow: $(overflow)"
  B set viewport 1440 900
  B reload; B wait --load networkidle; sleep 2
  B screenshot "$SHOTS/client-share-1440.png"
  log "client1440 overflow: $(overflow)"
fi

# ---------- 7. SUPPLIER PORTAL ----------
log "== SUPPLIER =="
# clear session via cookie clear, login as supplier
B cookies clear >> "$LOG" 2>&1
B open http://127.0.0.1:3000/
B wait --load networkidle; sleep 1
B eval "(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.type==='email');if(!e)return 'NOEMAIL';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(e,'supplier@mjengo.os');e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >> "$LOG" 2>&1
B eval "(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.type==='password');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(e,'mjengo2026');e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()" >> "$LOG" 2>&1
B eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.type==='submit');b.click();return 'clicked'})()" >> "$LOG" 2>&1
B wait --load networkidle; sleep 3
B screenshot "$SHOTS/supplier-1440.png"
log "supplier overflow: $(overflow)"
B eval "document.body.innerText.slice(0,200).replace(/\n/g,' | ')" > /tmp/sup.txt 2>&1
log "supplier text head: $(tail -1 /tmp/sup.txt)"

# ---------- 8. A11Y SPOT CHECKS ----------
log "== A11Y SPOTS =="
B open http://127.0.0.1:3000/
B wait --load networkidle; sleep 1
B cookies clear >> "$LOG" 2>&1
B reload; B wait --load networkidle; sleep 1
B eval "JSON.stringify({imgs:[...document.images].filter(i=>!i.alt).length,btnsNoName:[...document.querySelectorAll('button')].filter(b=>!b.textContent.trim()&&!b.getAttribute('aria-label')&&!b.getAttribute('aria-labelledby')).length,inputsNoLabel:[...document.querySelectorAll('input:not([type=hidden])')].filter(i=>!i.labels?.length&&!i.getAttribute('aria-label')).length})" > /tmp/a11y.txt 2>&1
log "a11y: $(tail -1 /tmp/a11y.txt)"
B eval "getComputedStyle(document.documentElement).fontSize + '/' + getComputedStyle(document.body).fontFamily" > /tmp/font.txt 2>&1
log "base font: $(tail -1 /tmp/font.txt)"

B close
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
log "== AUDIT RUN COMPLETE =="
ls -la "$SHOTS"/*.png | wc -l
