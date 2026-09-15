/* ============================================================================
   主逻辑：六屏的状态机 + 定位/雷达 + 相机 + 存档。
   文案与地点在 story.js；地图绘制在 map.js。这里只管流程和运行时。
   ============================================================================ */

import { STORY, emblemSvg, BANDS, HYSTERESIS } from "./story.js";
import { renderMap, makeRadarLayer } from "./map.js";

const $ = (id) => document.getElementById(id);
const { stations, ui } = STORY;

/* ---------------------------------------------------------------- 存档 */

const SAVE_KEY = "p41.progress";
let state = { idx: 0, qr: {} };            // idx = 当前推进到第几站；qr = 哪些站扫过卡

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    if (s && typeof s.idx === "number") state = { idx: s.idx, qr: s.qr || {} };
  } catch { /* 存档坏了就当新的来 */ }
}
function saveState() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {}
}

/* 照片走 IndexedDB：dataURL 塞 localStorage 迟早撑爆 5MB */
const DB = "p41", STORE = "photos";
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function putPhoto(key, dataUrl) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(dataUrl, key);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
async function getPhoto(key) {
  const d = await db();
  return new Promise((res) => {
    const t = d.transaction(STORE, "readonly");
    const q = t.objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => res(null);
  });
}

/* ---------------------------------------------------------------- 切屏 */

let current = null;
function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  current = id;
}
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------------------------------------------------------- 声音 */

const audio = { ctx: null, timer: null, band: null };

function unlockAudio() {
  if (audio.ctx) { if (audio.ctx.state === "suspended") audio.ctx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) audio.ctx = new Ctx();
}

function tone(freq, dur, gainPeak = 0.22) {
  const c = audio.ctx;
  if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = "sine"; o.frequency.value = freq;
  const t0 = c.currentTime;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gainPeak, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.03);
}

const BAND_FREQ = { far: 640, mid: 760, near: 900, here: 1040 };

function setBand(band) {
  if (audio.band && band && audio.band.key === band.key) return;
  audio.band = band;
  if (audio.timer) { clearTimeout(audio.timer); audio.timer = null; }
  if (!band || !audio.ctx) return;

  if (band.key === "here") {                    // 「到了」只响一声长的，不循环
    tone(BAND_FREQ.here, 0.55, 0.26);
    return;
  }
  const beat = () => {
    if (audio.band !== band) return;            // 档位已经换了，这个循环作废
    tone(BAND_FREQ[band.key] || 700, 0.07);
    audio.timer = setTimeout(beat, band.beatMs);
  };
  beat();
}
function muteRadar() { setBand(null); }

/* ---------------------------------------------------------------- 定位 */

const geo = { watch: null, hist: [], last: null, acc: null, ok: false };

function startGeo() {
  if (!("geolocation" in navigator) || geo.watch !== null) return;
  geo.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 25000,
  });
}
function onGeoErr(e) {
  geo.ok = false;
  if (current === "s-map") {
    $("hud-dist").textContent = "—";
    $("hud-band").textContent = e.code === 1 ? "没有定位权限" : "定位不可用";
    toast(ui.noGeo, 4200);
  }
}
function onFix(p) {
  geo.ok = true;
  geo.acc = p.coords.accuracy;
  // 中位数滤波：GPS 贴楼走会有多路径跳点，直接驱动滴声会抖成坏掉的样子
  geo.hist.push({ lat: p.coords.latitude, lon: p.coords.longitude });
  if (geo.hist.length > 5) geo.hist.shift();
  const med = (i) => geo.hist.map((h) => h[i]).sort((a, b) => a - b)[geo.hist.length >> 1];
  geo.last = { lat: med("lat"), lon: med("lon") };
  if (current === "s-map") updateRadar();
}

function meters(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180;
  const dla = (bLat - aLat) * r, dlo = (bLon - aLon) * r;
  const x = Math.sin(dla / 2) ** 2
    + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* 精度分层：精度差的时候不给「近」和「到了」的假希望，米数也不显示 */
function accClass(a) {
  if (a == null) return "good";
  if (a <= 50) return "good";
  if (a <= 150) return "mid";
  return "coarse";
}

function naturalBand(d) {
  for (let i = BANDS.length - 1; i >= 0; i--) if (d <= BANDS[i].maxM) return i;
  return 0;
}
/* 迟滞：往近处走立刻进档；往远处退要越过出档阈值（放宽 20%）才退，
   否则会在边界上来回切。 */
let bandIdx = 0;
function pickBand(d) {
  const nat = naturalBand(d);
  if (nat > bandIdx) bandIdx = nat;
  else if (nat < bandIdx && d > BANDS[bandIdx].maxM * (1 + HYSTERESIS)) bandIdx = nat;
  const cap = { good: 3, mid: 2, coarse: 1 }[accClass(geo.acc)];
  return BANDS[Math.min(bandIdx, cap)];
}

/* ---------------------------------------------------------------- 地图屏 */

const mapCache = new Map();

async function goMap(i) {
  const st = stations[i];
  document.documentElement.style.setProperty("--kc", st.color);
  show("s-map");

  $("hud-who").textContent = st.kingdom;
  $("cc-k").textContent = ui.clueKickerShort(i);
  $("cc-t").textContent = st.clueTitle;
  $("cc-d").textContent = st.clueBody;
  $("map-cta").textContent = ui.toCapture;

  let geo_ = mapCache.get(st.id);
  if (!geo_) {
    try {
      const r = await fetch(st.map.file);
      geo_ = await r.json();
      mapCache.set(st.id, geo_);
    } catch {
      toast("地图数据没加载出来，雷达照样能用", 3800);
      geo_ = [];
    }
  }

  const mount = $("map-mount");
  const proj = renderMap(mount, geo_, { center: st.coord, spanM: st.map.spanM });
  radarLayer = makeRadarLayer(proj.svg, proj);
  projNow = proj;
  bandIdx = 0;
  updateRadar();
  startGeo();
}

let radarLayer = null, projNow = null;

function updateRadar() {
  const st = stations[state.idx];
  if (!geo.last || !projNow) {
    // 占位符不要用「—」：在 49px 等宽粗体下它就是一根黑杠，很难看
    $("hud-dist").textContent = "";
    $("hud-band").textContent = geo.ok ? "找信号中…" : "等定位…";
    radarLayer?.setMe(null);
    return;
  }
  const d = meters(geo.last.lat, geo.last.lon, st.coord[0], st.coord[1]);
  const band = pickBand(d);
  const cls = accClass(geo.acc);

  if (cls === "coarse") {
    $("hud-dist").textContent = band.label;
  } else {
    $("hud-dist").innerHTML = `${Math.round(d)}<small>米</small>`;
    if (cls === "mid") $("hud-dist").textContent = "约 " + $("hud-dist").textContent;
  }
  $("hud-band").textContent = band.key === "here"
    ? "到了 · 就在附近"
    : `${band.label} · 滴声 ${(band.beatMs / 1000).toFixed(1)} 秒一次`;

  radarLayer.setMe([projNow.px([geo.last.lat, geo.last.lon]), projNow.py([geo.last.lat, geo.last.lon])]);
  setBand(band);
}

/* ---------------------------------------------------------------- 相机 */

const cam = { stream: null, facing: "user", shot: null };

async function startCam() {
  stopCam();
  if (!navigator.mediaDevices?.getUserMedia) { cam.err = "此环境不给摄像头"; return false; }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cam.facing }, audio: false,
    });
  } catch (e) {
    cam.err = e.name || String(e);
    return false;
  }
  const v = $("cam");
  v.srcObject = cam.stream;
  $("s-capture").classList.toggle("front", cam.facing === "user");
  try { await v.play(); } catch {}
  cam.err = null;
  return true;
}
function stopCam() {
  if (cam.stream) { cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }
}

function grabShot() {
  const v = $("cam");
  if (!v.videoWidth) return null;
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext("2d");
  // 前摄镜像：预览是镜像的，存下来也镜像，所见即所得
  if (cam.facing === "user") { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(v, 0, 0);
  return c.toDataURL("image/jpeg", 0.82);
}

/* ---------------------------------------------------------------- 扫码
   jsQR 由 index.html 用普通 script 标签加载（落盘的，不走 CDN）。
   加载不到就 window.jsQR 为 undefined，扫码整段跳过，不影响主线流程。 */

const qrReady = () => typeof window.jsQR === "function";

/* 三条约束都是踩出来的（第一版每帧在 448² 上跑 jsQR，直接把渲染进程压垮，
   测试台报 “Execution context was destroyed”）：
   ① 限速：约 6 次/秒就够认二维码了，60fps 纯属白烧 CPU
   ② 画布尺寸只设一次：每帧改 width/height 会重新分配位图
   ③ 停就真停：原版在隐藏后仍然无限 rAF，是个泄漏 */
const QR_SIDE = 320;                            // 认二维码够用了，再大只是更慢
const QR_MIN_GAP_MS = 160;
let qrLoop = null, qrActive = false, qrCanvas = null;

function startQrScan(st) {
  const v = $("cam");
  if (!qrCanvas) qrCanvas = document.createElement("canvas");
  const c = qrCanvas, ctx = c.getContext("2d", { willReadFrequently: true });
  c.width = QR_SIDE; c.height = QR_SIDE;

  qrActive = true;
  let last = 0;
  const step = (t) => {
    if (!qrActive) { qrLoop = null; return; }
    qrLoop = requestAnimationFrame(step);
    if (t - last < QR_MIN_GAP_MS) return;
    last = t;
    if (!v.videoWidth) return;

    const s = Math.min(v.videoWidth, v.videoHeight) * 0.75;
    ctx.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, QR_SIDE, QR_SIDE);
    const img = ctx.getImageData(0, 0, QR_SIDE, QR_SIDE);
    const r = window.jsQR(img.data, QR_SIDE, QR_SIDE, { inversionAttempts: "dontInvert" });
    if (r && r.data) {
      if (r.data.trim() === st.qr) {
        stopQrScan();
        state.qr[st.id] = true;
        saveState();
        toast(ui.qrDone, 1800);
        finishCapture(st);
        return;
      }
      $("qr-hint").textContent = ui.qrFail;
    }
  };
  qrLoop = requestAnimationFrame(step);
}
function stopQrScan() {
  qrActive = false;
  if (qrLoop) cancelAnimationFrame(qrLoop);
  qrLoop = null;
}

/* ---------------------------------------------------------------- 六屏 */

function goCover() {
  $("cover-em").innerHTML = stations
    .map((s) => emblemSvg(s.emblem, s.color)).join('<span class="sep"></span>');
  $("cover-k").textContent = STORY.cover.kicker;
  $("cover-t").textContent = STORY.cover.title;
  $("cover-s").textContent = STORY.cover.sub;
  $("cover-btn").textContent = STORY.cover.button;
  $("cover-fl").textContent = STORY.cover.footer;
  show("s-cover");
}

function goClue(i) {
  const st = stations[i];
  state.idx = i; saveState();
  document.documentElement.style.setProperty("--kc", st.color);
  $("clue-em").innerHTML = emblemSvg(st.emblem, st.color);
  $("clue-k").textContent = ui.clueKicker(i, st.kingdom);
  $("clue-k").style.color = st.color;
  $("clue-t").textContent = st.clueTitle;
  $("clue-d").textContent = st.clueBody;
  $("clue-rule").style.background = st.color;
  $("clue-btn").textContent = ui.clueButton;
  show("s-clue");
}

async function goCapture(i) {
  const st = stations[i];
  state.idx = i;
  $("pose-k").textContent = st.kingdom;
  $("pose-t").textContent = st.pose;
  $("qr-scan").hidden = true;
  show("s-capture");
  await openCamera();
}

/* 相机打不开不能变成死路——生日当天卡在这一屏是最坏的情况。
   失败时一定给出两条出口：再试一次、跳过拍照继续。 */
async function openCamera() {
  const ok = await startCam();
  $("shutter").hidden = !ok;
  $("btn-flip").textContent = "切换镜头";
  $("btn-skip").hidden = true;
  $("btn-qr").hidden = !ok || !qrReady();
  $("btn-qr").textContent = "扫卡片";
  if (ok) {
    $("cap-tip").textContent = ui.shutterTip;
  } else {
    $("cap-tip").textContent = `相机打不开（${cam.err || "未知"}）。可以点右边「再试一次」，或者跳过拍照继续。`;
    $("btn-flip").textContent = "再试一次";
    $("btn-skip").hidden = false;
    $("btn-skip").textContent = "跳过拍照，继续";
  }
}

function goReveal(i, photo) {
  const st = stations[i];
  const last = i === stations.length - 1;
  $("rv-photo").src = photo || "";
  $("rv-k").textContent = ui.revealKicker(i) + (state.qr[st.id] ? " · " + ui.qrDone : "");
  $("rv-k").style.color = st.color;
  $("rv-t").textContent = st.relic;
  $("rv-d").textContent = st.relicText;
  $("rv-btn").textContent = last ? ui.revealLastButton : ui.revealButton;
  show("s-reveal");
}

async function goFinale() {
  const photos = await Promise.all(stations.map((s) => getPhoto(s.id)));
  $("fn-photos").innerHTML = stations.map((s, i) =>
    `<img src="${photos[i] || ""}" alt="${s.kingdom}" style="border-color:#fff">`).join("");
  $("fn-t").textContent = STORY.final.title;
  $("fn-d").textContent = STORY.final.body;
  $("fn-btn").textContent = STORY.final.button;
  $("letter-body").textContent = STORY.final.letter;
  $("letter").hidden = true;
  show("s-finale");
  muteRadar();
}

/* 拍完 →（有卡片就扫码）→ 收信物 */
async function finishCapture(st) {
  const photo = cam.shot;
  if (photo) await putPhoto(st.id, photo);
  stopCam();
  goReveal(stations.indexOf(st), photo);
}

/* ---------------------------------------------------------------- 绑定 */

$("cover-btn").addEventListener("click", () => {
  unlockAudio();                                 // iOS 音频要用户手势才能起
  startGeo();
  goClue(state.idx);
});

$("clue-btn").addEventListener("click", () => goMap(state.idx));

$("map-cta").addEventListener("click", () => goCapture(state.idx));

$("shutter").addEventListener("click", async () => {
  cam.shot = grabShot();
  if (!cam.shot) return;
  const st = stations[state.idx];
  const needQr = qrReady() && !state.qr[st.id];
  if (!needQr) { muteRadar(); finishCapture(st); return; }
  // 有卡片就扫一下——这是「真的去过」的硬证据；找不到可以跳过
  $("shutter").hidden = true;
  $("btn-qr").hidden = true;
  $("btn-skip").hidden = false;
  $("qr-hint").textContent = ui.scanning;
  $("qr-scan").hidden = false;
  startQrScan(st);
});

$("btn-qr").addEventListener("click", () => {
  const st = stations[state.idx];
  $("shutter").hidden = true;
  $("btn-qr").hidden = true;
  $("btn-skip").hidden = false;
  $("qr-hint").textContent = ui.scanning;
  $("qr-scan").hidden = false;
  startQrScan(st);
});

$("btn-skip").addEventListener("click", () => {
  stopQrScan();
  $("qr-scan").hidden = true;
  muteRadar();
  finishCapture(stations[state.idx]);
});

$("btn-flip").addEventListener("click", async () => {
  if (!cam.stream) { await openCamera(); return; }   // 相机没开时这个按钮是「再试一次」
  cam.facing = cam.facing === "user" ? "environment" : "user";
  await openCamera();
});

$("rv-btn").addEventListener("click", () => {
  const next = state.idx + 1;
  if (next < stations.length) goClue(next);
  else goFinale();
});

$("fn-btn").addEventListener("click", () => { $("letter").hidden = false; });
$("letter-close").addEventListener("click", () => { $("letter").hidden = true; });

// 切到后台就闭嘴，回来再响
document.addEventListener("visibilitychange", () => {
  if (document.hidden) muteRadar();
});

/* ---------------------------------------------------------------- 启动 */

loadState();
if (state.idx > 0) {
  // 接着上次的地方走（照片还在 IndexedDB 里）
  goClue(Math.min(state.idx, stations.length - 1));
} else {
  goCover();
}

// Service Worker：装到主屏后断网也能翻完。file:// 打开时注册不了，忽略即可。
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
