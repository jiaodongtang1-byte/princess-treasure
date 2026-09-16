/* ============================================================================
   主逻辑：六屏的状态机 + 实时地图 + 雷达 + 相机 + 存档。
   文案与地点在 story.js；地图与雷达盘在 map.js；雷达判断与声音在 radar.js。
   ============================================================================ */

import { STORY, emblemSvg } from "./story.js";
import { createMap, createRadarDisc } from "./map.js";
import { createRadar } from "./radar.js";

const $ = (id) => document.getElementById(id);
const { stations, ui } = STORY;
const radar = createRadar();

/* ---------------------------------------------------------------- 存档 */

const SAVE_KEY = "p41.progress";
let state = { idx: 0, qr: {} };

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    if (s && typeof s.idx === "number") state = { idx: s.idx, qr: s.qr || {} };
  } catch {}
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

/* ---------------------------------------------------------------- 定位与实时地图 */

const geo = { watch: null, ok: false, trail: [], lastDraw: 0, lastTrail: 0 };
let map = null, disc = null;

function startGeo() {
  if (!("geolocation" in navigator) || geo.watch !== null) return;
  geo.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 25000,
  });
}

function onGeoErr(e) {
  geo.ok = false;
  if (current === "s-map") {
    $("hud-hint").textContent = e.code === 1 ? "没有定位权限" : "定位不可用";
    toast(ui.noGeo, 4200);
  }
}

function onFix(p) {
  geo.ok = true;
  const now = Date.now();
  const fix = {
    lat: p.coords.latitude, lon: p.coords.longitude,
    acc: p.coords.accuracy, t: p.timestamp || now,
  };

  const s = radar.push(fix);

  // 轨迹：每 5 秒落一个点，最多留 60 个（约 5 分钟）
  if (now - geo.lastTrail > 5000) {
    geo.lastTrail = now;
    geo.trail.push(fix);
    if (geo.trail.length > 60) geo.trail.shift();
  }

  // 重画限流：定位可能一秒来好几次，界面不需要跟着抖
  if (current === "s-map" && now - geo.lastDraw > 900) {
    geo.lastDraw = now;
    redrawMap(s);
  }
}

function redrawMap(s) {
  if (!map) return;
  if (!s || !geo.ok) {
    map.draw({ me: null });
    disc.update(null);
    $("hud-hint").textContent = "找信号中…";
    return;
  }
  map.draw({ me: s, trailPts: geo.trail });
  disc.update({ dist: s.dist, bearing: s.bearing, spanM: map.spanM, signal: s.signal });
  $("hud-hint").textContent = s.dist < 60 ? "就在附近了" : "";
}

/* ---------------------------------------------------------------- 地图屏 */

const mapCache = new Map();

async function goMap(i) {
  const st = stations[i];
  document.documentElement.style.setProperty("--kc", st.color);
  show("s-map");

  $("cc-k").textContent = ui.clueKickerShort(i);
  $("cc-t").textContent = st.clueTitle;
  $("cc-d").textContent = st.clueBody;
  $("map-cta").textContent = ui.toCapture;

  let geoData = mapCache.get(st.id);
  if (!geoData) {
    try {
      const r = await fetch(st.map.file);
      geoData = await r.json();
      mapCache.set(st.id, geoData);
    } catch {
      toast("地图数据没加载出来，雷达照样能用", 3800);
      geoData = [];
    }
  }

  map = createMap($("map-mount"), geoData, st.coord);
  if (!disc) {
    disc = createRadarDisc($("disc"));
    // 只有真滴了才扩散，不然安静的时候盘面还在一下一下跳，像坏了
    radar.onPulse((signal) => { if (signal > 0) disc.pulse(); });
  }

  geo.trail = [];
  radar.setTarget(st.coord);
  radar.unlock();
  radar.start();
  startGeo();
  redrawMap(radar.state);
}

/* ---------------------------------------------------------------- 相机 */

const cam = { stream: null, facing: "user", shot: null, err: null };

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
  if (cam.facing === "user") { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(v, 0, 0);
  return c.toDataURL("image/jpeg", 0.82);
}

/* ---------------------------------------------------------------- 扫码
   jsQR 由 index.html 用普通 script 标签加载（落盘的，不走 CDN）。
   加载不到就 window.jsQR 为 undefined，扫码整段跳过，不影响主线流程。 */

const qrReady = () => typeof window.jsQR === "function";

/* 三条约束都是踩出来的（第一版每帧在 448² 上跑 jsQR，直接把渲染进程压垮）：
   ① 限速：约 6 次/秒就够认二维码了
   ② 画布尺寸只设一次
   ③ 停就真停，别留无限 rAF */
const QR_SIDE = 320;
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
  radar.stop();
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
    `<img src="${photos[i] || ""}" alt="${s.kingdom}">`).join("");
  $("fn-t").textContent = STORY.final.title;
  $("fn-d").textContent = STORY.final.body;
  $("fn-btn").textContent = STORY.final.button;
  $("letter-body").textContent = STORY.final.letter;
  $("letter").hidden = true;
  show("s-finale");
  radar.stop();
}

async function finishCapture(st) {
  const photo = cam.shot;
  if (photo) await putPhoto(st.id, photo);
  stopCam();
  goReveal(stations.indexOf(st), photo);
}

/* ---------------------------------------------------------------- 绑定 */

$("cover-btn").addEventListener("click", () => {
  radar.unlock();                     // iOS 音频要用户手势才能起
  goClue(state.idx);
});

$("clue-btn").addEventListener("click", () => goMap(state.idx));

$("map-cta").addEventListener("click", () => goCapture(state.idx));

$("shutter").addEventListener("click", async () => {
  cam.shot = grabShot();
  if (!cam.shot) return;
  const st = stations[state.idx];
  const needQr = qrReady() && !state.qr[st.id];
  if (!needQr) { finishCapture(st); return; }
  $("shutter").hidden = true;
  $("btn-qr").hidden = true;
  $("btn-skip").hidden = false;
  $("qr-skip-label") && ($("qr-skip-label").textContent = ui.qrSkip);
  $("btn-skip").textContent = ui.qrSkip;
  $("qr-hint").textContent = ui.scanning;
  $("qr-scan").hidden = false;
  startQrScan(st);
});

$("btn-qr").addEventListener("click", () => {
  const st = stations[state.idx];
  $("shutter").hidden = true;
  $("btn-qr").hidden = true;
  $("btn-skip").hidden = false;
  $("btn-skip").textContent = ui.qrSkip;
  $("qr-hint").textContent = ui.scanning;
  $("qr-scan").hidden = false;
  startQrScan(st);
});

$("btn-skip").addEventListener("click", () => {
  stopQrScan();
  $("qr-scan").hidden = true;
  finishCapture(stations[state.idx]);
});

$("btn-flip").addEventListener("click", async () => {
  if (!cam.stream) { await openCamera(); return; }
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

document.addEventListener("visibilitychange", () => {
  if (document.hidden) radar.stop();
  else if (current === "s-map") radar.start();
});

/* ---------------------------------------------------------------- 启动 */

loadState();
if (state.idx > 0) goClue(Math.min(state.idx, stations.length - 1));
else goCover();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
