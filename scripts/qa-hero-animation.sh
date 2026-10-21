#!/usr/bin/env bash
# QA: animated hero (issue #402) — time-series scenes, overflow, CTAs,
# reduced-motion static fallback, offscreen pause, mobile, console errors.
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
LOG=/home/z/my-project/download/qa-hero-animation/qa-hero.txt
SHOTS=/home/z/my-project/download/qa-hero-animation
mkdir -p "$SHOTS"
: > "$LOG"; say(){ echo "$*" | tee -a "$LOG"; }
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1

PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-site.log 2>&1 &
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null)
  [ "$C" = "200" ] && break; sleep 1
done
say "server: HTTP $C on :$PORT"

AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }
EV(){ AB eval "$1"; }
PHASE(){ EV "document.querySelector('[data-hero-animation]')?.getAttribute('data-phase')||'none'" | tail -1; }
OVF(){ EV "JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})" | grep -oE '\{.*\}' | tail -1; }

say "== desktop 1440x900 — full story run (recorded) =="
AB set viewport 1440 900
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle
AB record start "$SHOTS/hero-story-1440.mp4"
T0=$(date +%s%3N)
sleep 0.8;  say "t+0.8s phase=$(PHASE)"; AB screenshot "$SHOTS/scene0-blueprint-1440.png"
sleep 2.6;  say "t+3.4s phase=$(PHASE)"; AB screenshot "$SHOTS/scene1-materials-1440.png"
sleep 3.2;  say "t+6.6s phase=$(PHASE)"; AB screenshot "$SHOTS/scene2-ecosystem-1440.png"
sleep 3.2;  say "t+9.8s phase=$(PHASE)"; AB screenshot "$SHOTS/scene3-evidence-1440.png"
sleep 3.2;  say "t+13.0s phase=$(PHASE)"; AB screenshot "$SHOTS/scene4-orbit-1440.png"
sleep 3.8;  say "t+16.8s phase=$(PHASE)"; AB screenshot "$SHOTS/scene5-final-1440.png"
AB record stop
say "overflow@1440: $(OVF)"

say "== a11y + CTA contracts =="
say "h1: $(EV "document.querySelector('h1')?.textContent" | tail -1)"
say "canvasAriaHidden: $(EV "document.querySelector('[data-hero-animation] > div:nth-of-type(2) ~ div, [aria-hidden][class*=select-none]')?.getAttribute('aria-hidden')||'check-manual'" | tail -1)"
say "signupLinks: $(EV "document.querySelectorAll('a[href=\"/signup\"]').length" | tail -1)"
say "platformLinks: $(EV "document.querySelectorAll('a[href=\"/platform\"]').length" | tail -1)"
say "ctaTexts: $(EV "[...document.querySelectorAll('a[href=\"/signup\"],a[href=\"/platform\"]')].map(a=>a.textContent.trim()).join('|')" | tail -1)"

say "== click Get Started -> /signup =="
AB find text "Get Started" click; sleep 1.5
say "url: $(AB get url | tail -1)"
say "== back, click Explore MjengoOS -> /platform =="
AB back; sleep 1; AB find text "Explore MjengoOS" click; sleep 1.5
say "url: $(AB get url | tail -1)"
AB back; sleep 1.5

say "== offscreen pause: scroll away, phase must hold =="
AB scroll down 2600; sleep 0.5
P1=$(PHASE); sleep 4; P2=$(PHASE)
say "phase held: $P1 -> $P2 (must be equal)"
AB scroll up 2600; sleep 1.5
say "resumed phase: $(PHASE)"

say "== reduced motion: static final frame instantly =="
AB set media reduced-motion 2>/dev/null || AB set media light reduced-motion
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle; sleep 0.6
say "phase@reduced: $(PHASE) (must be 5)"
AB screenshot "$SHOTS/reduced-motion-final-1440.png"
say "floatMotion (must be equal):"
TR1=$(EV "(()=>{const s=document.querySelector('[data-hero-animation] [aria-hidden] > div[style*=transform]');return s?s.style.transform.slice(0,60):'n/a'})()" | tail -1)
sleep 1.5
TR2=$(EV "(()=>{const s=document.querySelector('[data-hero-animation] [aria-hidden] > div[style*=transform]');return s?s.style.transform.slice(0,60):'n/a'})()" | tail -1)
say "  tr1: $TR1"
say "  tr2: $TR2"
AB set media light

say "== mobile 390x844 =="
AB set viewport 390 844
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle
sleep 1.2; say "mobile t+1.2 phase=$(PHASE)"; AB screenshot "$SHOTS/mobile-scene0-390.png"
sleep 16;  say "mobile final phase=$(PHASE)"; AB screenshot "$SHOTS/mobile-final-390.png"
say "overflow@390: $(OVF)"
AB set viewport 320 568
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle; sleep 1
say "overflow@320: $(OVF)"
AB screenshot "$SHOTS/mobile-320.png"

say "== console + page errors =="
AB errors | tail -5
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
say "== QA COMPLETE =="
