#!/usr/bin/env bash
# Debug v2: identify page + scroll state + true hit-test at CTA point.
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-dbg2.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null | grep -q 200 && break; sleep 1; done
agent-browser close --all > /dev/null 2>&1
agent-browser set viewport 1440 900
agent-browser open http://127.0.0.1:$PORT/ > /dev/null
agent-browser wait --load networkidle > /dev/null; sleep 1.5
agent-browser eval "window.scrollTo(0,0); 'scrolled to top'" > /dev/null; sleep 0.5
agent-browser eval "
(()=>{
  const sec=document.querySelector('section[data-hero-animation]');
  const a=sec?.querySelector('a[href=\"/signup\"]');
  if(!a) return 'NO HERO ANCHOR — page='+location.pathname+' scrollY='+window.scrollY;
  const r=a.getBoundingClientRect();
  const x=r.x+r.width/2, y=r.y+r.height/2;
  const el=document.elementFromPoint(x,y);
  const chain=[];
  let e=el; while(e&&chain.length<4){const c=e.className&&e.className.baseVal===undefined?String(e.className).split(' ').slice(0,5).join('.'):'';chain.push(e.tagName+'.'+c);e=e.parentElement}
  return JSON.stringify({path:location.pathname,scrollY:window.scrollY,aRect:{y:Math.round(r.y),h:Math.round(r.height)},hitTop:el===a||a.contains(el),hitChain:chain});
})()
" 2>&1 | tail -5
agent-browser click 'section[data-hero-animation] a[href="/signup"]' 2>&1 | tail -2
sleep 2
agent-browser eval "location.pathname" 2>&1 | tail -1
agent-browser close --all > /dev/null 2>&1
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
