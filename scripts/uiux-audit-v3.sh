#!/usr/bin/env bash
# UI/UX audit v2 — authenticated surfaces (robust login via trusted clicks).
set -u
cd /home/z/my-project/mjengoos
LOG=/home/z/my-project/download/qa-uiux-audit/audit-v3.txt
SHOTS=/home/z/my-project/download/qa-uiux-audit
mkdir -p "$SHOTS"; : > "$LOG"
say(){ echo "$*" | tee -a "$LOG"; }

pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null; sleep 1
export DATABASE_URL="file:/home/z/my-project/mjengoos/db/custom.db"
export NEXTAUTH_SECRET="$(openssl rand -hex 32)"
export RATE_LIMIT_STORE=memory NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
nohup node .next/standalone/server.js > /tmp/app.log 2>&1 &
( cd mjengoos-website/.next/standalone && PORT=3001 HOSTNAME=127.0.0.1 NODE_ENV=production nohup node server.js > /tmp/site.log 2>&1 & )
for i in $(seq 1 45); do
  A=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null)
  [ "$A" = "200" ] && break; sleep 1
done
say "app health: $A"
[ "$A" = "200" ] || { tail -5 /tmp/app.log; exit 1; }

AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }
EV(){ AB eval "$1"; }
OVF(){ EV "JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})" | grep -oE '\{.*\}' | tail -1; }

share_token=$(DATABASE_URL="$DATABASE_URL" bun -e "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient(); const r=await p.project.findFirst({where:{name:'Nyumba Yangu — 3BR Bungalow'},select:{shareToken:true}}); console.log(r?.shareToken||'')" 2>/dev/null | tail -1)
say "share: ${share_token:0:8}..."

login_as(){ # $1=email $2=pass
  AB open http://127.0.0.1:3000/
  AB wait --load networkidle
  sleep 2
  AB find label "Email" fill "$1"
  AB find label "Password" fill "$2"
  AB find role button click --name "Sign in"
  sleep 4
  AB wait --load networkidle
}

# ---------- CONTRACTOR ----------
say "== contractor login =="
AB set viewport 1440 900
login_as contractor@mjengo.os mjengo2026
AB screenshot "$SHOTS/v3-contractor-1440.png"
say "url: $(AB get url | tail -1)"
say "tabs: $(EV "document.querySelectorAll('[role=tab]').length" | tail -1)"
say "head: $(EV "document.body.innerText.slice(0,160).replace(/\n/g,' | ')" | tail -1)"
say "ovf1440: $(OVF)"

say "== per-tab sweep 1440 =="
for T in overview site materials finder fundis money land evidence copilot ussd audit settings; do
  EV "(()=>{const t=document.getElementById('mjengo-tab-$T');if(!t)return 'NOEL';t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return 'ok'})()" > /dev/null 2>&1
  sleep 1.5
  say "tab $T: $(OVF) | errs: $(AB errors | grep -c ERROR)"
done
AB screenshot "$SHOTS/v3-money-1440.png"

say "== cmdk palette =="
EV "(()=>{const t=document.getElementById('mjengo-tab-overview');t&&t.dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'})()" > /dev/null 2>&1
sleep 1
AB press Control+k
sleep 1
AB screenshot "$SHOTS/v3-cmdk-1440.png"
say "cmdk visible: $(EV "!!document.querySelector('[cmdk-root]')" | tail -1)"
AB press Escape

say "== mobile 390 =="
AB set viewport 390 844
AB reload; AB wait --load networkidle; sleep 2
AB screenshot "$SHOTS/v3-contractor-390.png"
say "ovf390: $(OVF)"
say "bottomnav: $(EV "(()=>{const els=[...document.querySelectorAll('nav,[role=tablist]')];const b=els.find(e=>{const s=getComputedStyle(e);return s.position==='fixed'||s.position==='sticky'&&e.getBoundingClientRect().top>400});return b?b.className.slice(0,80):'none'})()" | tail -1)"
AB errors | tail -5

# ---------- CLIENT SHARE ----------
say "== client share =="
AB set viewport 390 844
AB open "http://127.0.0.1:3000/?share=$share_token"
AB wait --load networkidle; sleep 2
AB screenshot "$SHOTS/v3-client-390.png"
say "client390 ovf: $(OVF)"
say "client head: $(EV "document.body.innerText.slice(0,120).replace(/\n/g,' | ')" | tail -1)"

# ---------- SUPPLIER ----------
say "== supplier login =="
AB set viewport 1440 900
AB cookies clear > /dev/null 2>&1
login_as supplier@mjengo.os supplier2026
AB screenshot "$SHOTS/v3-supplier-1440.png"
say "supplier url: $(AB get url | tail -1)"
say "supplier head: $(EV "document.body.innerText.slice(0,160).replace(/\n/g,' | ')" | tail -1)"
say "supplier ovf: $(OVF)"

# ---------- A11Y SPOTS (authed) ----------
say "== a11y spots =="
say "$(EV "JSON.stringify({imgsNoAlt:[...document.images].filter(i=>!i.alt).length,btnsNoName:[...document.querySelectorAll('button')].filter(b=>!b.textContent.trim()&&!b.getAttribute('aria-label')&&!b.getAttribute('aria-labelledby')).length,inputsNoLabel:[...document.querySelectorAll('input:not([type=hidden])')].filter(i=>!(i.labels&&i.labels.length)&&!i.getAttribute('aria-label')&&!i.getAttribute('aria-labelledby')).length})" | tail -1)"

AB console | grep -iE "error|warn" | sort | uniq -c | head -10
AB close
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null
say "== V3 COMPLETE =="
