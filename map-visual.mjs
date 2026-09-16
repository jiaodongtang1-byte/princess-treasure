/* 地图的视觉验收：WebKit + 2x DPR（真机条件），逐个距离拍图看。
   跑法：node map-visual.mjs   （需要先起 http://127.0.0.1:8899） */
import { createRequire } from 'node:module';
const require = createRequire('C:/claude/03工具/project-037-生日探索地图/');
const { webkit } = require('playwright');

const URL = 'http://127.0.0.1:8899/index.html';
const OUT = process.env.OUT_DIR || '.';
const TARGET = [30.754618, 103.920084];      // 天街那站的信物坐标（story.js）
const M_LAT = 1 / 111320;

const b = await webkit.launch();
const ctx = await b.newContext({
  viewport: process.env.PORTRAIT ? { width: 820, height: 1180 } : { width: 1180, height: 820 },
  deviceScaleFactor: 2,
});
await ctx.addInitScript(() => {
  navigator.geolocation.watchPosition = (ok) => {
    window.__setPos = (lat, lon, acc) =>
      ok({ coords: { latitude: lat, longitude: lon, accuracy: acc }, timestamp: Date.now() });
    return 1;
  };
  navigator.geolocation.clearWatch = () => {};
});
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await p.goto(URL, { waitUntil: 'load' });
await p.waitForTimeout(700);
await p.click('#cover-btn');
await p.click('#clue-btn');
await p.waitForTimeout(1800);                            // 等地图数据 fetch 完

/* 站在离信物 d 米的地方（正南），先喂一个起点再喂终点，好让轨迹有两点 */
async function stand(d) {
  await p.evaluate(async ([T, MLA, d]) => {
    window.__setPos(T[0] + (d + 40) * MLA, T[1], 5);      // 先喂个起点，好让轨迹有两点
    await new Promise((r) => setTimeout(r, 300));
    window.__setPos(T[0] + d * MLA, T[1], 5);
    await new Promise((r) => setTimeout(r, 1400));
  }, [TARGET, M_LAT, d]);
  await p.waitForTimeout(1300);                          // 越过 900ms 的重画限流
}

const rows = [];
for (const d of [12, 120, 400, 1500]) {
  await stand(d);
  const info = await p.evaluate(() => ({
    span: document.querySelector('.disc-dist')?.textContent,
    hint: document.getElementById('hud-hint')?.textContent,
    labels: [...document.querySelectorAll('.labels text')].filter((t) => t.style.display !== 'none')
      .map((t) => t.textContent),
    pin: document.querySelector('.pin-far')?.style.display === 'none' ? '画面内别针' : '贴边箭头',
  }));
  rows.push(`距离 ${d} 米 → 盘面 ${info.span} · ${info.pin} · 提示「${info.hint}」· 标签 ${info.labels.length}：${info.labels.slice(0, 12).join("／")}`);
  await p.screenshot({ path: `${OUT}/map-${String(d).padStart(4, '0')}m.png` });
}

console.log(rows.join('\n'));
console.log('\nJS 报错:', errors.length ? errors : '无');
await b.close();
