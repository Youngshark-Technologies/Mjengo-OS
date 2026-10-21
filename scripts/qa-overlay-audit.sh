#!/usr/bin/env bash
# Audit: which inset-0 overlays actually escape their parent (viewport-anchored)?
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-dbg5.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null | grep -q 200 && break; sleep 1; done
agent-browser close --all > /dev/null 2>&1
agent-browser set viewport 1440 900
agent-browser open http://127.0.0.1:$PORT/ > /dev/null
agent-browser wait --load networkidle > /dev/null; sleep 1.5
agent-browser eval "
(()=>{
  const out=[];
  for (const d of document.querySelectorAll('main div')) {
    const cls=String(d.className);
    if(!cls.includes('absolute')||!cls.includes('inset-0')) continue;
    const r=d.getBoundingClientRect(), pr=d.parentElement.getBoundingClientRect();
    const escapes = r.width>pr.width+4 || r.height>pr.height+4;
    const pp=getComputedStyle(d.parentElement).position;
    out.push({escapes, parentPos:pp, parent:String(d.parentElement.tagName)+'.'+String(d.parentElement.className).split(' ').slice(0,4).join('.'), w:Math.round(r.width), h:Math.round(r.height), pw:Math.round(pr.width), ph:Math.round(pr.height)});
  }
  const bad=out.filter(o=>o.escapes);
  return JSON.stringify({total:out.length, escaped:bad.length, bad},null,1);
})()
" 2>&1 | tail -30
# same check on a subpage (signup)
agent-browser open http://127.0.0.1:$PORT/signup > /dev/null
agent-browser wait --load networkidle > /dev/null; sleep 1
agent-browser eval "
(()=>{
  const out=[];
  for (const d of document.querySelectorAll('main div')) {
    const cls=String(d.className);
    if(!cls.includes('absolute')||!cls.includes('inset-0')) continue;
    const r=d.getBoundingClientRect(), pr=d.parentElement.getBoundingClientRect();
    if(r.width>pr.width+4||r.height>pr.height+4) out.push(String(d.parentElement.className).slice(0,60));
  }
  return JSON.stringify({page:'signup',escaped:out.length,bad:out});
})()
" 2>&1 | tail -8
agent-browser close --all > /dev/null 2>&1
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
