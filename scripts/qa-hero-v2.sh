#!/usr/bin/env bash
# QA v2: CTA navigation (trusted mouse clicks at hero CTA coords),
# offscreen pause on a real page, canvas aria-hidden, page errors.
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
LOG=/home/z/my-project/download/qa-hero-animation/qa-hero-v2.txt
SHOTS=/home/z/my-project/download/qa-hero-animation
: > "$LOG"; say(){ echo "$*" | tee -a "$LOG"; }
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-site2.log 2>&1 &
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null)
  [ "$C" = "200" ] && break; sleep 1
done
say "server: HTTP $C"
AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }
EV(){ AB eval "$1"; }
PHASE(){ EV "document.querySelector('[data-hero-animation]')?.getAttribute('data-phase')||'none'" | tail -1; }

AB set viewport 1440 900
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle; sleep 1

say "== canvas a11y =="
say "canvasHidden: $(EV "(()=>{const c=document.querySelector('section[data-hero-animation] div.select-none[aria-hidden]');return c?('aria-hidden='+c.getAttribute('aria-hidden')+' size='+c.offsetWidth+'x'+c.offsetHeight):'NOT FOUND'})()" | tail -1)"
say "captionsHidden: $(EV "(()=>{const cs=[...document.querySelectorAll('section[data-hero-animation] .relative.mt-5 > [aria-hidden]')];return cs.length+' aria-hidden captions'})()" | tail -1)"

say "== CTA: trusted click at hero Get Started coords =="
XY=$(EV "(()=>{const a=document.querySelector('section[data-hero-animation] a[href=\\\"/signup\\\"]');const r=a.getBoundingClientRect();return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2)})()" | grep -oE '[0-9]+ [0-9]+' | tail -1)
say "hero signup box: $XY"
X=$(echo $XY | cut -d' ' -f1); Y=$(echo $XY | cut -d' ' -f2)
AB mouse move $X $Y; AB mouse down; AB mouse up; sleep 2
say "url after Get Started click: $(AB get url | tail -1)"
AB back; sleep 1.5

say "== CTA: trusted click at hero Explore MjengoOS coords =="
XY2=$(EV "(()=>{const a=document.querySelector('section[data-hero-animation] a[href=\\\"/platform\\\"]');const r=a.getBoundingClientRect();return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2)})()" | grep -oE '[0-9]+ [0-9]+' | tail -1)
say "hero explore box: $XY2"
X2=$(echo $XY2 | cut -d' ' -f1); Y2=$(echo $XY2 | cut -d' ' -f2)
AB mouse move $X2 $Y2; AB mouse down; AB mouse up; sleep 2
say "url after Explore click: $(AB get url | tail -1)"

say "== offscreen pause (fresh page) =="
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle
sleep 2; say "pre-scroll phase: $(PHASE)"
AB scroll down 2600; sleep 0.5
P1=$(PHASE); sleep 4; P2=$(PHASE)
say "held: $P1 -> $P2 (equal = paused)"
AB scroll up 2600; sleep 3
say "resumed phase: $(PHASE) (must advance)"

say "== page errors =="
AB errors | tail -8
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
say "== QA V2 COMPLETE =="
