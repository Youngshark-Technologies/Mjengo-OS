#!/usr/bin/env bash
# Debug v4: print the hit element's transform chain at the CTA point.
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-dbg4.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null | grep -q 200 && break; sleep 1; done
agent-browser close --all > /dev/null 2>&1
agent-browser set viewport 1440 900
agent-browser open http://127.0.0.1:$PORT/ > /dev/null
agent-browser wait --load networkidle > /dev/null; sleep 1.5
agent-browser eval "
(()=>{
  const sec=document.querySelector('section[data-hero-animation]');
  const a=sec.querySelector('a[href=\"/signup\"]');
  const r=a.getBoundingClientRect();
  const x=r.x+r.width/2, y=r.y+r.height/2;
  const el=document.elementFromPoint(x,y);
  const rows=[];
  let e=el, i=0;
  while(e && i<6){
    const cs=getComputedStyle(e);
    rows.push({i, tag:e.tagName+'.'+String(e.className).split(' ').slice(0,4).join('.'),
      tr:cs.transform==='none'?'none':cs.transform.slice(0,80),
      pos:cs.position, op:cs.opacity, pe:cs.pointerEvents,
      rect:{x:Math.round(e.getBoundingClientRect().x),y:Math.round(e.getBoundingClientRect().y),w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)}});
    e=e.parentElement; i++;
  }
  return JSON.stringify(rows,null,1);
})()
" 2>&1 | tail -50
agent-browser close --all > /dev/null 2>&1
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
