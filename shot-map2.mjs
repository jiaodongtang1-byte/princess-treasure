import { createRequire } from 'node:module';
const require = createRequire('C:/claude/03工具/project-037-生日探索地图/');
const { chromium } = require('playwright');
const T = [30.754618, 103.920084], MLA = 1/111320;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1180,height:820}, deviceScaleFactor:2 });
await ctx.addInitScript(() => {
  navigator.geolocation.watchPosition = (ok) => {
    window.__setPos = (lat,lon,acc,t)=>ok({coords:{latitude:lat,longitude:lon,accuracy:acc},timestamp:t});
    return 1; };
  navigator.geolocation.clearWatch = () => {};
});
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:8899/index.html',{waitUntil:'load'});
await p.waitForTimeout(500);
await p.click('#cover-btn'); await p.click('#clue-btn'); await p.waitForTimeout(1400);

async function place(label, eastM, northM, simSeconds=14) {
  await p.evaluate(async ([T,MLA,e,n,sec]) => {
    const t0=Date.now();
    for(let i=0;i<=sec;i++){
      const f=i/sec;
      window.__setPos(T[0]+n*f*MLA, T[1]+e*f*MLA, 5, t0+i*1000);
      await new Promise(r=>setTimeout(r,35));
    }
  }, [T,MLA,eastM,northM,simSeconds]);
  // 界面重画有 900ms 限流；等它过去再落最后一个点，否则画面停在第一个点上
  await p.waitForTimeout(1000);
  await p.evaluate(([T,MLA,e,n]) => window.__setPos(T[0]+n*MLA, T[1]+e*MLA, 5, Date.now()),
    [T,MLA,eastM,northM]);
  await p.waitForTimeout(700);
  await p.screenshot({ path:`map-${label}.png` });
  const d = await p.evaluate(()=>({ dist:document.querySelector('.disc-dist')?.textContent,
    transform:document.querySelector('.world').getAttribute('transform'),
    trail:document.querySelectorAll('.overlay path')[1]?.getAttribute('d')?.split('L').length }));
  console.log(label, JSON.stringify(d));
}
await place('a-far', 900, 0);      // 远处直冲
await place('b-near', 120, 0);     // 快到
await place('c-here', 20, 0);      // 到了
console.log('报错:', errs.length?errs:'无');
await b.close();
