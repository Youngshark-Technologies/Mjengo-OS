#!/usr/bin/env bash
# Debug v3: measure actual section boxes at the CTA point.
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-dbg3.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null | grep -q 200 && break; sleep 1; done
agent-browser close --all > /dev/null 2>&1
agent-browser set viewport 1440 900
agent-browser open http://127.0.0.1:$PORT/ > /dev/null
agent-browser wait --load networkidle > /dev/null; sleep 1.5
agent-browser eval "
(()=>{
  const sec=document.querySelector('section[data-hero-animation]');
  const heroRect=JSON.parse(JSON.stringify(sec.getBoundingClientRect()));
  const secs=[...document.querySelectorAll('main > *:not(script)')].map(el=>({
    tag:el.tagName+'.'+String(el.className).split(' ').slice(0,3).join('.'),
    y:Math.round(el.getBoundingClientRect().y),
    h:Math.round(el.getBoundingClientRect().height)
  }));
  const dark=[...document.querySelectorAll('main section')].filter(s=>getComputedStyle(s).backgroundColor.includes('6,35,28')).map(s=>String(s.className).slice(0,60)+' @y='+Math.round(s.getBoundingClientRect().y));
  const a=sec.querySelector('a[href=\"/signup\"]');
  const ar=a.getBoundingClientRect();
  return JSON.stringify({hero:{y:Math.round(heroRect.y),h:Math.round(heroRect.height)},anchor:{y:Math.round(ar.y)},sections:secs.slice(0,8),darkSections:dark},null,1);
})()
" 2>&1 | tail -40
agent-browser close --all > /dev/null 2>&1
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
