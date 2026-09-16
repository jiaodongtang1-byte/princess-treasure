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
const BASELINE_MS = 5000;     // 拿多久以前的点算速度：太短会被定位噪声淹没
const STILL_SPEED = 0.5;      // m/s，低于这个算「没动」
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
    if (audio) { if (audio.state === "suspended") audio.resume(); return true; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    audio = new Ctx();
    return true;
  }

  function tone(freq, dur, peak) {
    if (!audio) return;
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
    if (!target || hist.length < 2) return null;
    const now = hist[hist.length - 1];
    // 取窗口内最老的一个点做基线，基线越长噪声影响越小
    let base = hist[0];
    for (const h of hist) { if (now.t - h.t <= BASELINE_MS) { base = h; break; } }
    const dt = (now.t - base.t) / 1000;
    if (dt < 1) return null;

    const dNow = meters(now.lat, now.lon, target[0], target[1]);
    const dOld = meters(base.lat, base.lon, target[0], target[1]);
    const moved = meters(now.lat, now.lon, base.lat, base.lon);
    const speed = moved / dt;
    const closing = (dOld - dNow) / dt;
    const cos = speed > 0.08 ? closing / speed : 0;

    state = {
      lat: now.lat, lon: now.lon, acc: now.acc, t: now.t,
      dist: dNow,
      speed,
      closing,
      cos,
      bearing: bearing(now.lat, now.lon, target[0], target[1]),
      // 信号强度：方向越正、离得越近，越强
      signal: Math.max(0, cos) * (1 + 25 / Math.max(dNow, 25)),
    };
    return state;
  }

  function intervalFor(s) {
    const q = clamp((s.cos - MIN_COS) / (1 - MIN_COS), 0, 1);
    const strength = clamp(q * (1 + 25 / Math.max(s.dist, 25)), 0, 1);
    return Math.round(BEAT_SLOW - (BEAT_SLOW - BEAT_FAST) * strength);
  }

  function loop() {
    if (!running) return;
    const s = state;
    let wait = 700;

    if (!s || s.speed < STILL_SPEED || s.cos <= MIN_COS) {
      // 站着不动 / 背离 / 横向走：安静。但继续轮询，一动起来立刻响
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
      hist.length = 0;
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
