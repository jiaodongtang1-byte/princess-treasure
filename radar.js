/* ============================================================================
   雷达：不是「离得近就响」，是「正在靠近才响」。

   作者 2026-09-16 定的规则：
     · 正在靠近目标   → 滴得越快
     · 背离目标       → 不响
     · 站着不动       → 不响
     · 方向有偏差     → 微弱的响

   做成「靠近速度」而不是「距离」：
     speed   = 这段时间移动了多远 / 时间
     closing = 距离缩短了多少 / 时间
     cos     = closing / speed      ← 这就是移动方向与「目标方向」的夹角余弦
               cos=1 正对目标；cos=0.7 偏 45°；cos=0 垂直；cos<0 背离

   用 cos 而不是「距离变没变」，是因为 cos 天然把「走得快」和「走得对」分开：
   走得快但方向错，不该给强信号。
   ============================================================================ */

const R = 6371000, RAD = Math.PI / 180;

export function meters(aLat, aLon, bLat, bLon) {
  const dla = (bLat - aLat) * RAD, dlo = (bLon - aLon) * RAD;
  const x = Math.sin(dla / 2) ** 2
    + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** 目标相对正北的方位角，单位度（0=北，顺时针） */
export function bearing(aLat, aLon, bLat, bLon) {
  const y = Math.sin((bLon - aLon) * RAD) * Math.cos(bLat * RAD);
  const x = Math.cos(aLat * RAD) * Math.sin(bLat * RAD)
    - Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos((bLon - aLon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---- 可调参数。现场觉得不跟手就改这几个数。 ---- */
const BASELINE_MS = 10000;    // 拿多久以前的点算速度：太短会被定位噪声淹没（±2.5 米抖 5 秒就像在走）
const ACC_MAX = 25;       // 米。定位精度差于这个（商场里、楼缝里）就不判「在走」，雷达静音、HUD 说信号弱
const STILL_SPEED = 0.5;      // m/s，低于这个算「没动」
const STALE_MS = 4000;        // 这么久没有新定位点，就当不知道她在不在走，别按旧状态一直滴
const MIN_COS = 0.12;         // 方向余弦低于这个算「背离/横向」，不响
const WEAK_COS = 0.45;        // 低于这个只给微弱的响
const BEAT_SLOW = 1000, BEAT_FAST = 120;   // 滴声间隔的两端（毫秒）
const GAIN_WEAK = 0.07, GAIN_FULL = 0.2;

export function createRadar() {
  let target = null;          // [lat, lon]
  const hist = [];            // 最近 30 秒的定位点
  let audio = null;
  let timer = null;
  let running = false;
  let onPulse = null;         // 每次滴的时候回调，给画面同步用
  let state = null;

  function unlock() {
    // iOS 锁屏/切后台回来是 "interrupted" 不是 "suspended"，只认后者就永远唤不醒
    if (audio) { if (audio.state !== "running") audio.resume().catch(() => {}); return true; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    audio = new Ctx();
    return true;
  }

  function tone(freq, dur, peak) {
    // 上下文没在跑时 currentTime 不走，排进去的滴声会在恢复那一刻一起炸响
    if (!audio || audio.state !== "running") return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine"; o.frequency.value = freq;
    const t0 = audio.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(audio.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  function push(fix) {         // {lat, lon, acc, t}
    hist.push(fix);
    while (hist.length > 2 && fix.t - hist[0].t > 30000) hist.shift();
    return compute();
  }

  function compute() {
    if (!target || !hist.length) return null;
    const now = hist[hist.length - 1];
    // 取窗口内最老的一个点做基线，基线越长噪声影响越小。
    // 只有一个点（或间隔不足 1 秒）时算不出速度——那不是「没数据」，
    // 是「还不知道她在不在走」：距离和方位照样给，速度记 0 就行。
    // 这样地图和盘面一拿到定位就有东西可显示，不用干等基线攒满。
    //
    // 速度只拿精度合格（≤ACC_MAX）的点算——精度差时位移全是噪声。
    // mv = 最近 STALE_MS 内最新的合格点，base = 它之前 BASELINE_MS 内最老的合格点。
    // 不能要求「现在这个点」和「10 秒前那个点」都合格：从商场走出来后得白等 10 秒，
    // 贴着楼走精度在 25 米上下跳时，雷达大半时间不响、HUD 每秒闪一次。
    let mv = null;
    for (let i = hist.length - 1; i >= 0 && now.t - hist[i].t <= STALE_MS; i--) {
      if (hist[i].acc <= ACC_MAX) { mv = hist[i]; break; }
    }
    let base = mv;
    if (mv) for (const h of hist) { if (h.acc <= ACC_MAX && h.t <= mv.t && mv.t - h.t <= BASELINE_MS) { base = h; break; } }
    const dt = mv ? (mv.t - base.t) / 1000 : 0;
    const ok = dt >= 3;

    const dNow = meters(now.lat, now.lon, target[0], target[1]);
    const dMv = mv ? meters(mv.lat, mv.lon, target[0], target[1]) : dNow;
    const dOld = ok ? meters(base.lat, base.lon, target[0], target[1]) : dMv;
    const moved = ok ? meters(mv.lat, mv.lon, base.lat, base.lon) : 0;
    const speed = ok ? moved / dt : 0;
    const closing = ok ? (dOld - dMv) / dt : 0;
    const cos = speed > 0.08 ? closing / speed : 0;

    state = {
      lat: now.lat, lon: now.lon, acc: now.acc, t: now.t,
      weak: !mv,                // 最近几秒没有一个靠得住的点：雷达静音，HUD 说信号弱
      dist: dNow,
      speed,
      closing,
      cos,
      bearing: bearing(now.lat, now.lon, target[0], target[1]),
      // 信号强度：方向越正、离得越近，越强。跟发声用同一道门槛——
      // 不然慢走时 HUD 说「对，就是这个方向」，雷达却一声不响
      signal: speed < STILL_SPEED || cos <= MIN_COS ? 0 : cos * (1 + 25 / Math.max(dNow, 25)),
    };
    return state;
  }

  function intervalFor(s) {
    const q = clamp((s.cos - MIN_COS) / (1 - MIN_COS), 0, 1);
    // 方向分和距离分都 ≤1，相乘不用再夹。原先 q×(1+距离项) 一夹到 1，
    // 方向正时 1 公里外和 25 米处一样急。现在正对目标：1 公里 ≈640ms、100 米 ≈430ms、25 米内 120ms
    const strength = q * (0.3 + 0.7 * Math.sqrt(25 / Math.max(s.dist, 25)));
    return Math.round(BEAT_SLOW - (BEAT_SLOW - BEAT_FAST) * strength);
  }

  function loop() {
    if (!running) return;
    const s = state;
    let wait = 700;

    if (!s || Date.now() - s.t > STALE_MS || s.speed < STILL_SPEED || s.cos <= MIN_COS) {
      // 定位断流 / 站着不动 / 背离 / 横向走：安静。但继续轮询，一动起来立刻响
      if (onPulse) onPulse(0);
      wait = 420;
    } else {
      const weak = s.cos < WEAK_COS;
      tone(weak ? 720 : 880, weak ? 0.05 : 0.075, weak ? GAIN_WEAK : GAIN_FULL);
      if (onPulse) onPulse(s.signal);
      wait = intervalFor(s);
    }
    timer = setTimeout(loop, wait);
  }

  return {
    setTarget(t) {
      target = t;
      // 不清历史：坐标跟目标无关，留着才能立刻按新目标算出距离（清掉的话头一帧显示上一站的「8 米」）
      this.refresh();
    },
    push,
    unlock,
    onPulse(fn) { onPulse = fn; },
    refresh() { return compute(); },
    get state() { return state; },
    start() { if (!running) { running = true; loop(); } },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
