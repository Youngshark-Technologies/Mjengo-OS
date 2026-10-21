#!/usr/bin/env bash
# Debug: which element intercepts clicks at the hero CTA point?
set -u
cd /home/z/my-project/mjengoos/mjengoos-website
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null; sleep 1
PORT=3001
nohup bunx next start -p $PORT > /tmp/hero-dbg.log 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ 2>/dev/null | grep -q 200 && break; sleep 1; done
agent-browser set viewport 1440 900
agent-browser open http://127.0.0.1:$PORT/ > /dev/null
agent-browser wait --load networkidle > /dev/null; sleep 1
agent-browser eval "
(()=>{
  const a=document.querySelector('section[data-hero-animation] a[href=\"/signup\"]');
  const r=a.getBoundingClientRect();
  const x=r.x+r.width/2, y=r.y+r.height/2;
  const el=document.elementFromPoint(x,y);
  const chain=[];
  let e=el; while(e&&chain.length<5){chain.push(e.tagName+'.'+(e.className&&e.className.baseVal===undefined?String(e.className).split(' ').slice(0,4).join('.'):'svg')+'['+(e.getAttribute('aria-hidden')??'')+']');e=e.parentElement}
  // stacking info
  const covers=[...document.querySelectorAll('div.absolute.inset-0')].map(d=>({
    parent:d.parentElement.tagName,
    section:d.closest('section')?.getAttribute('data-hero-animation')||'other',
    cls:String(d.className).slice(0,50),
    rect:JSON.parse(JSON.stringify(d.getBoundingClientRect())).y
  }));
  const aSt=getComputedStyle(a), aZ=aSt.zIndex, aPos=aSt.position;
  const secSt=getComputedStyle(document.querySelector('section[data-hero-animation]'));
  return JSON.stringify({clickX:x,clickY:y,hitChain:chain,covers:covers.slice(0,4),aPos,aZ,secTransform:secSt.transform,secIso:secSt.isolation},null,1);
})()
" 2>&1 | tail -30
pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
