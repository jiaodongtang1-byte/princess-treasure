/* ============================================================================
   雷达：朝着礼物走才响；站着时转动 iPad、对准礼物方向也响（像金属探测器）。

   作者定的规则（2026-09-16 定，09-17 加了「原地转身找方向」）：
     · 朝着礼物走       → 滴，方向越正、离得越近越急
     · 方向有偏差       → 微弱地响
     · 背离 / 横着走    → 不响
     · 站着不动         → 不响；但站着转动 iPad、对准礼物方向时换一种音高滴，停转 5 秒后安静

   2026-09-17 重做：原先全靠 GNSS 位置差分算「朝哪走」，定位误差几米就被噪声淹没，
   只能拿 10 秒基线硬抹平——走起来要等好几秒才响，精度差时干脆静音。现在三路信号各管一件事：
     · 罗盘（webkitCompassHeading，约 60Hz）  → 她朝哪边，几乎没有延迟
     · 加速度计步（devicemotion）              → 她在不在走，一两步就知道
     · GNSS 位置                                → 礼物在哪个方位、离多远。方位角对定位误差不敏感：
                                                 ±50 米精度、300 米外只偏约 9.5°，所以不再因为「精度差」整个静音
   罗盘用不了（没授权、读数无效、iPad 竖直举着）时依次退回：GNSS 航向（coords.heading）→ 位置差分。
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
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);     // 两个方向差多少度，0~180

/* ---- 可调参数。现场觉得不跟手就改这几个数。 ---- */
const TICK_MS = 100;                         // 每 0.1 秒判一次：转身后下一拍就变，不用等上一声的间隔走完
const MIN_COS = 0.12;                        // 方向余弦低于这个算「背离/横向」，不响（约偏 83°）
const WEAK_COS = 0.45;                       // 低于这个只给微弱的响（约偏 63°）
const BEAT_SLOW = 1000, BEAT_FAST = 120;     // 走路时滴声间隔的两端（毫秒）
const NEAR_SLOW = 320;                       // 礼物附近：离得越近越接近 BEAT_FAST
const GAIN_WEAK = 0.07, GAIN_FULL = 0.2;
const TONE_WALK = 880, TONE_WEAK = 720, TONE_SWEEP = 1175;   // 原地找方向用更高的音，跟走路分得开

// 在不在走
const STEP_ACC = 1.2;                        // m/s²，去掉重力后的加速度冲过这个值算一步
const STEP_GAP_MS = 300;                     // 两步之间至少隔这么久（手抖不算步）
const WALK_WINDOW_MS = 1500;                 // 这段时间里 ≥2 步算在走
const GNSS_WALK_SPEED = 0.6;                 // coords.speed 过这个也算在走（托得太稳、计步没数到时兜底）

// 朝哪边
const COMPASS_MAX_ERR = 30;                  // webkitCompassAccuracy 超过这么多度就不信
const COMPASS_MAX_AGE = 500;
const MAX_TILT = 65;                         // 离水平面超过这个角度（竖着举）罗盘指向没准，不用
const GNSS_HEADING_SPEED = 0.8;              // 走得比这快，coords.heading 才靠得住
const FIX_MAX_AGE = 2500;                    // coords.speed / heading 过了这么久就不算数
const POS_MAX_AGE = 15000;                   // 位置旧到这个程度，方位角已经不可信

// 离得太近时方位角不可靠（误差半径跟距离一个量级），只按距离滴
const NEAR_MIN = 40, NEAR_ACC_K = 3;

// 原地转身找方向
const SWEEP_TURN = 15;                       // 转过这么多度算「在找方向」
const SWEEP_HOLD_MS = 5000;                  // 停止转动这么久后安静，「站着不动不响」大多数时候仍然成立
const SWEEP_IN = 25, SWEEP_OUT = 35;         // 朝向进入 ±25° 开始响，离开 ±35° 才停（迟滞，别在边上来回跳）
const SWEEP_SLOW = 900, SWEEP_FAST = 150;

// 位置差分（没有罗盘、也没有 GNSS 航向时的兜底）
const BASELINE_MS = 10000;                   // 拿多久以前的点算速度：太短会被定位噪声淹没
const ACC_MAX = 25;                          // 米。差分只用精度好于这个的点，差的点位移全是噪声
const STILL_SPEED = 0.5;                     // m/s，低于这个算「没动」
const MIN_MOVED = 5.5;                       // 米。差分还要求整段确实走出去这么远，否则站着不动的定位抖动会被当成在走
const STALE_MS = 4000;                       // 这么久没有合格的新点，就当不知道她在不在走

/* 屏幕「上方」相对设备竖屏顶边转了多少度。webkitCompassHeading 按竖屏顶边算，
   横着拿时要加上这个。用 type 查表，不用 angle——iPad 的 WebKit 把横屏当自然方向，angle 会差 90°。 */
const FRONT = { "portrait-primary": 0, "landscape-primary": 90, "portrait-secondary": 180, "landscape-secondary": 270 };

export function createRadar() {
  let target = null;          // [lat, lon]
  const hist = [];            // 最近 30 秒的定位点
  let audio = null;
  let timer = null;
  let running = false;
  let onPulse = null;         // 每次滴的时候回调，给画面同步用
  let onTick = null;          // 每拍回调：HUD 文案、地图上的朝向扇形
  let onPerm = null;
  let state = null;
  let lastBeep = 0;

  /* ---------------------------------------------------------------- 声音 */

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

  /* ---------------------------------------------------------------- 罗盘与计步 */

  const sens = {
    perm: "unknown", on: false,
    heading: null, headingT: 0, err: -1,     // 屏幕上方朝哪（度，磁北≈真北，成都磁偏角 2.4° 忽略）
    tilt: null,                              // 离水平面多少度
    steps: [], above: false, lastStep: 0, motionT: 0,
    anchor: null, turnT: -1e9,               // 上次转过 SWEEP_TURN 度的时刻
    sweepOn: false,
  };

  function onOrient(e) {
    let h = null, err = 0;
    if (typeof e.webkitCompassHeading === "number") {
      // iOS。还没拿到航向时 WebKit 给 heading=0、accuracy=-1——丢掉，不然首帧假装面朝正北
      if (!(e.webkitCompassAccuracy >= 0)) return;
      h = e.webkitCompassHeading; err = e.webkitCompassAccuracy;
    } else if (e.type === "deviceorientationabsolute" && typeof e.alpha === "number") {
      h = 360 - e.alpha;                     // 安卓：alpha 是逆时针角，换成罗盘的顺时针
    } else {
      return;
    }
    h = (h + (FRONT[screen.orientation?.type] || 0)) % 360;
    const now = Date.now();
    if (sens.anchor === null) sens.anchor = h;
    else if (angDiff(h, sens.anchor) >= SWEEP_TURN) { sens.anchor = h; sens.turnT = now; }
    sens.heading = h; sens.err = err; sens.headingT = now;
  }

  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    let gm = null;
    if (g && g.x != null) {
      gm = Math.hypot(g.x, g.y, g.z);
      // 只取 |z| 的比例：不依赖 iOS 和安卓对坐标轴正负号的约定
      if (gm > 1) sens.tilt = Math.acos(Math.min(1, Math.abs(g.z) / gm)) / RAD;
    }
    const a = e.acceleration;
    const mag = a && a.x != null ? Math.hypot(a.x, a.y, a.z) : gm != null ? Math.abs(gm - 9.81) : null;
    if (mag == null) return;
    const now = Date.now();
    // 上升沿过阈值记一步。计步时间用 Date.now，别用 e.interval（WebKit 给的是秒，规范要求毫秒）
    if (mag > STEP_ACC && !sens.above && now - sens.lastStep >= STEP_GAP_MS) { sens.steps.push(now); sens.lastStep = now; }
    sens.above = mag > STEP_ACC;
    while (sens.steps.length && now - sens.steps[0] > WALK_WINDOW_MS) sens.steps.shift();
    sens.motionT = now;
  }

  function attach() {
    if (sens.on) return;
    sens.on = true;
    addEventListener("deviceorientation", onOrient);
    addEventListener("deviceorientationabsolute", onOrient);
    addEventListener("devicemotion", onMotion);
  }
  function detach() {
    if (!sens.on) return;
    sens.on = false;
    removeEventListener("deviceorientation", onOrient);
    removeEventListener("deviceorientationabsolute", onOrient);
    removeEventListener("devicemotion", onMotion);
    sens.heading = null; sens.steps.length = 0; sens.sweepOn = false;
  }

  /* 必须在点击回调里同步调用（前面不能有 await）：iOS 要用户手势才弹「运动与方向」授权。
     已经决定过（允许或拒绝）时不弹窗，立刻返回缓存的结果。 */
  function requestSensors() {
    const ask = window.DeviceOrientationEvent?.requestPermission;
    if (typeof ask !== "function") {         // 安卓、桌面：不用问
      sens.perm = "granted";
      if (running) attach();
      return;
    }
    if (sens.perm === "granted") return;
    ask.call(window.DeviceOrientationEvent).then((r) => {
      sens.perm = r;
      if (r === "granted") { if (running) attach(); }
      else onPerm?.(r);
    }).catch(() => {});
  }

  /* ---------------------------------------------------------------- 位置 */

  function push(fix) {         // {lat, lon, acc, t, speed, heading}
    hist.push(fix);
    while (hist.length > 2 && fix.t - hist[0].t > 30000) hist.shift();
    return compute();
  }

  /* 位置派生的量只在来新点时算：距离、方位、GNSS 速度航向，以及兜底用的位置差分。 */
  function compute() {
    if (!target || !hist.length) return null;
    const now = hist[hist.length - 1];
    // 差分只拿精度合格（≤ACC_MAX）的点：mv = 最近 STALE_MS 内最新的合格点，base = 它之前 BASELINE_MS 内最老的合格点。
    // 不能要求「现在这个点」和「10 秒前那个点」都合格：从商场走出来后得白等 10 秒。
    let mv = null;
    for (let i = hist.length - 1; i >= 0 && now.t - hist[i].t <= STALE_MS; i--) {
      if (hist[i].acc <= ACC_MAX) { mv = hist[i]; break; }
    }
    let base = mv;
    if (mv) for (const h of hist) { if (h.acc <= ACC_MAX && h.t <= mv.t && mv.t - h.t <= BASELINE_MS) { base = h; break; } }
    const dt = mv ? (mv.t - base.t) / 1000 : 0;
    const ok = dt >= 3;
    const dMv = mv ? meters(mv.lat, mv.lon, target[0], target[1]) : 0;
    const dOld = ok ? meters(base.lat, base.lon, target[0], target[1]) : dMv;
    const moved = ok ? meters(mv.lat, mv.lon, base.lat, base.lon) : 0;
    const speed = ok ? moved / dt : 0;
    const closing = ok ? (dOld - dMv) / dt : 0;

    state = {
      lat: now.lat, lon: now.lon, acc: now.acc, t: now.t,
      dist: meters(now.lat, now.lon, target[0], target[1]),
      bearing: bearing(now.lat, now.lon, target[0], target[1]),
      gSpeed: now.speed ?? null, gHeading: now.heading ?? null,
      speed, moved, cos: speed > 0.08 ? closing / speed : 0,
      weak: !mv,                              // 最近几秒没有一个精度好于 ACC_MAX 的点
      mode: "idle", signal: 0, beat: 0, facing: null, canSweep: false,
    };
    evaluate(Date.now());
    return state;
  }

  /* ---------------------------------------------------------------- 每拍判定 */

  function evaluate(now) {
    const s = state;
    if (!s) return null;
    const compassOk = sens.heading !== null && now - sens.headingT <= COMPASS_MAX_AGE
      && sens.err <= COMPASS_MAX_ERR && (sens.tilt === null || sens.tilt < MAX_TILT);
    const fixFresh = now - s.t <= FIX_MAX_AGE;
    const posOk = now - s.t <= POS_MAX_AGE;
    const diffOk = !s.weak && now - s.t <= STALE_MS && s.speed >= STILL_SPEED && s.moved >= MIN_MOVED;

    // 在不在走：计步在工作就信计步（加 GNSS 速度兜底）；没有计步就看 GNSS 速度；再没有就看位置差分
    const stepping = now - sens.motionT < 1000;
    const gnssWalk = fixFresh && s.gSpeed != null && s.gSpeed >= GNSS_WALK_SPEED;
    const moving = stepping ? sens.steps.length >= 2 || gnssWalk
      : s.gSpeed != null && fixFresh ? gnssWalk
      : diffOk;

    // 朝哪边：罗盘 → GNSS 航向 → 位置差分
    let cos = null;
    if (compassOk) cos = Math.cos((s.bearing - sens.heading) * RAD);
    else if (fixFresh && s.gHeading != null && s.gSpeed >= GNSS_HEADING_SPEED) cos = Math.cos((s.bearing - s.gHeading) * RAD);
    else if (diffOk) cos = s.cos;

    const nearR = Math.max(NEAR_MIN, NEAR_ACC_K * (s.acc || 0));
    s.facing = compassOk ? sens.heading : null;
    s.canSweep = compassOk;
    s.beat = 0; s.signal = 0; s.weakBeat = false;

    if (!posOk) {
      s.mode = "idle";
    } else if (s.dist < nearR) {
      // 离得太近，方位角没准：走动时只按距离滴
      s.mode = "near";
      if (moving) { s.beat = BEAT_FAST + (NEAR_SLOW - BEAT_FAST) * clamp(s.dist / nearR, 0, 1); s.signal = 1; }
    } else if (moving && cos !== null) {
      s.mode = "walk";
      if (cos > MIN_COS) {
        const q = (cos - MIN_COS) / (1 - MIN_COS);
        // 方向分和距离分都 ≤1，相乘不用再夹。正对目标：1 公里 ≈640ms、100 米 ≈430ms、25 米内 120ms
        const strength = q * (0.3 + 0.7 * Math.sqrt(25 / Math.max(s.dist, 25)));
        s.beat = Math.round(BEAT_SLOW - (BEAT_SLOW - BEAT_FAST) * strength);
        s.weakBeat = cos < WEAK_COS;
        s.signal = cos * (1 + 25 / Math.max(s.dist, 25));
      }
    } else if (!moving && compassOk && now - sens.turnT < SWEEP_HOLD_MS) {
      s.mode = "sweep";
      const ang = angDiff(s.bearing, sens.heading);
      sens.sweepOn = ang <= (sens.sweepOn ? SWEEP_OUT : SWEEP_IN);
      if (sens.sweepOn) {
        s.beat = SWEEP_FAST + (SWEEP_SLOW - SWEEP_FAST) * clamp(ang / SWEEP_OUT, 0, 1);
        s.signal = 1 - ang / SWEEP_OUT;
      }
    } else {
      s.mode = "idle";
      sens.sweepOn = false;
    }
    return s;
  }

  function loop() {
    if (!running) return;
    const now = Date.now();
    const s = evaluate(now);
    if (s && s.beat && now - lastBeep >= s.beat) {
      lastBeep = now;
      if (s.mode === "sweep") tone(TONE_SWEEP, 0.06, GAIN_FULL);
      else if (s.weakBeat) tone(TONE_WEAK, 0.05, GAIN_WEAK);
      else tone(TONE_WALK, 0.075, GAIN_FULL);
      if (onPulse) onPulse(s.signal);
    }
    if (onTick) onTick(s);
    timer = setTimeout(loop, TICK_MS);
  }

  return {
    setTarget(t) {
      target = t;
      // 不清历史：坐标跟目标无关，留着才能立刻按新目标算出距离（清掉的话头一帧显示上一站的「8 米」）
      this.refresh();
    },
    push,
    unlock,
    requestSensors,
    get sensorPerm() { return sens.perm; },
    onPulse(fn) { onPulse = fn; },
    onTick(fn) { onTick = fn; },
    onPermission(fn) { onPerm = fn; },
    refresh() { return compute(); },
    get state() { return state; },
    start() {
      if (running) return;
      running = true;
      if (sens.perm === "granted") attach();
      loop();
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      detach();                              // 传感器只在地图屏开着，省电；页面隐藏时 WebKit 本来也会暂停
    },
  };
}
