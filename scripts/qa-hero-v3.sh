#!/usr/bin/env bash
# QA v3: CTA navigation via section-scoped CSS selector clicks.
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
LOG=/home/z/my-project/download/qa-hero-animation/qa-hero-v3.txt
: > "$LOG"; say(){ echo "$*" | tee -a "$LOG"; }
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-site3.log 2>&1 &
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null)
  [ "$C" = "200" ] && break; sleep 1
done
say "server: HTTP $C"
AB(){ agent-browser "$@" 2>&1 | tee -a "$LOG"; }

AB set viewport 1440 900
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle; sleep 1.5

say "== hero CTA uniqueness =="
say "heroGetStarted: $(AB get count 'section[data-hero-animation] a[href="/signup"]' | tail -1)"
say "heroExplore: $(AB get count 'section[data-hero-animation] a[href="/platform"]' | tail -1)"

say "== click Get Started (hero) =="
AB click 'section[data-hero-animation] a[href="/signup"]'
sleep 2
say "url: $(AB get url | tail -1)"
say "h1 there: $(AB eval "document.querySelector('h1')?.textContent?.slice(0,60)||'none'" | tail -1)"
AB back; sleep 2

say "== click Explore MjengoOS (hero) =="
AB click 'section[data-hero-animation] a[href="/platform"]'
sleep 2
say "url: $(AB get url | tail -1)"
AB back; sleep 1

say "== keyboard reachability: tab to hero CTA and press Enter =="
AB open http://127.0.0.1:$PORT/
AB wait --load networkidle; sleep 1
AB eval "document.querySelector('section[data-hero-animation] a[href=\"/signup\"]').focus()" > /dev/null
AB press Enter; sleep 2
say "url after keyboard Enter: $(AB get url | tail -1)"

say "== page errors =="
AB errors | tail -6
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
say "== QA V3 COMPLETE =="
