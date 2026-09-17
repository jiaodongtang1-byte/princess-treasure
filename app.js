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
    t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error);
  });
}
async function getPhoto(key) {
  const d = await db();
  return new Promise((res) => {
    const t = d.transaction(STORE, "readonly");
    const q = t.objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => res(null);
    t.onabort = () => res(null);
  });
}
async function clearPhotos() {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, "readwrite");
    t.objectStore(STORE).clear();
    t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error);
  });
}
/* 本次打开拍下的照片也在内存里留一份。iOS 主屏应用在后台放久了会丢 IndexedDB 连接，
   存不进去时终章照样有图可看，流程也不会卡住。 */
const shots = {};

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

/* 靠声音带路时她不会碰屏幕，iPad 默认 2 分钟就锁屏，页面一隐藏雷达和定位全停。
   锁屏回来 wake lock 会被系统收回，所以每次点屏都补一次。iOS 18.4 之前的主屏应用里无效，
   兜底是把「自动锁定」设成「永不」。 */
let wake = null;
function keepAwake() {
  if (!navigator.wakeLock || (wake && !wake.released)) return;
  navigator.wakeLock.request("screen").then((l) => { wake = l; }).catch(() => {});
}

/* ---------------------------------------------------------------- 定位与实时地图 */

const geo = { watch: null, ok: false, err: null, lastFix: null, trail: [], lastDraw: 0, lastTrail: 0, drawTimer: null };
let map = null, disc = null;

function startGeo() {
  if (!("geolocation" in navigator) || geo.watch !== null) return;
  geo.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 25000,
  });
}

function onGeoErr(e) {
  // 已经拿到过定位时，偶发的「暂时定不到」（code 2/3）不作废当前位置——
  // 不然地图会跳成以信物为中心、雷达盘变「—」，下一个点一到又跳回来。雷达自己会在断流 4 秒后静音
  if (e.code !== 1 && geo.lastFix) { if (current === "s-map") toast(ui.noGeo, 4200); return; }
  geo.ok = false;
  // 记下来。不然重画时会被「找信号中…」盖掉——权限被拒是永远找不回来的，
  // 一直骗她在等信号，她只会一直站着等。
  geo.err = e.code === 1 ? ui.geoDeniedShort : "定位不可用";
  // 必须当场重画：首次进地图时 goMap 已经画出「找信号中…」，拒绝授权的回调是后来才到的
  if (current === "s-map") {
    toast(e.code === 1 ? ui.geoDenied : ui.noGeo, e.code === 1 ? 9000 : 4200);
    redrawMap(radar.state);
  }
}

function onFix(p) {
  geo.ok = true;
  geo.err = null;
  const now = Date.now();
  const fix = {
    lat: p.coords.latitude, lon: p.coords.longitude,
    acc: p.coords.accuracy, t: p.timestamp || now,
  };

  geo.lastFix = fix;
  const s = radar.push(fix);

  // 轨迹：每 5 秒落一个点，最多留 60 个（约 5 分钟）
  if (now - geo.lastTrail > 5000) {
    geo.lastTrail = now;
    geo.trail.push(fix);
    if (geo.trail.length > 60) geo.trail.shift();
  }

  // 重画限流：定位可能一秒来好几次，界面不需要跟着抖。
  // 但被挡掉的那一次必须补画——否则「停下来看地图」正好卡在被丢掉的最后一帧上，
  // 显示的是几步之前的旧位置（这个 bug 实测过：盘面停在 160 米，人已经在 120 米）。
  if (current !== "s-map") return;
  clearTimeout(geo.drawTimer);
  if (now - geo.lastDraw > 900) {
    geo.lastDraw = now;
    redrawMap(s);
  } else {
    geo.drawTimer = setTimeout(() => {
      geo.lastDraw = Date.now();
      redrawMap(radar.state);
    }, 900 - (now - geo.lastDraw));
  }
}

/* 地图只认定位点，雷达要攒够两个点才算得出速度——
   所以刚开始那几秒地图已经有位置可画了，别跟着雷达一起装死。 */
function redrawMap(s) {
  if (!map) return;
  if (!geo.ok || !geo.lastFix) {
    map.draw({ me: null });            // 没有定位就退回到「以信物为中心」，至少知道宝藏在哪
    disc.update(null);
    $("hud-hint").textContent = geo.err || "找信号中…";
    return;
  }
  map.draw({ me: geo.lastFix, trailPts: geo.trail, signal: s ? s.signal : 0 });
  disc.update({ dist: s.dist, bearing: s.bearing, spanM: map.spanM, signal: s.signal, acc: s.acc });
  // 地图上的箭头/别针已经指明了方向，提示只补它说不了的：还有多远、是不是走对了、信号靠不靠得住
  $("hud-hint").textContent =
    s.dist < 60 && !s.weak ? "就在附近了"
    : s.weak ? "信号弱，雷达先不响，看地图走"
    : s.signal > 0.5 ? "对，就是这个方向"
    : s.signal > 0 ? "差不多是这个方向"
    : "跟着金色标记走";
}

/* ---------------------------------------------------------------- 地图屏 */

const mapCache = new Map();

async function goMap(i) {
  const st = stations[i];
  // 解锁音频必须在第一个 await 之前，之后就不算用户手势了（iOS 杀进程重开会跳过封面，这里是第一次机会）
  radar.unlock();
  keepAwake();
  document.documentElement.style.setProperty("--kc", st.color);
  show("s-map");

  $("cc-k").textContent = ui.clueKickerShort(i);
  $("cc-t").textContent = st.clueTitle;
  $("cc-d").textContent = st.clueBody;
  $("map-cta").textContent = ui.toCapture;

  // 三站共用同一张底图，按文件路径缓存——按站点缓存会把同一份数据取三遍
  let geoData = mapCache.get(st.map.file);
  if (!geoData) {
    try {
      const r = await fetch(st.map.file);
      geoData = await r.json();
      mapCache.set(st.map.file, geoData);
    } catch {
      toast("地图数据没加载出来，雷达照样能用", 3800);
      geoData = [];
    }
  }

  map = createMap($("map-mount"), geoData, st.coord);
  // 她一动手指扒图，「回到我的位置」就出现；按下去就藏起来
  $("recenter").textContent = ui.recenter;
  map.onFollow((on) => { $("recenter").hidden = on; });
  $("recenter").hidden = true;
  if (!disc) {
    disc = createRadarDisc($("disc"));
    // 只有真滴了才扩散，不然安静的时候盘面还在一下一下跳，像坏了
    radar.onPulse((signal) => { if (signal > 0) disc.pulse(); });
  }

  geo.trail = [];
  radar.setTarget(st.coord);
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
    // 不给分辨率 WebKit 可能按 640×480 采，纪念照放大就糊。ideal 拿不到也不报错
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cam.facing, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
    stopCam();            // 连点「切换镜头」时先回来的那一路没人管，会一直开着
    cam.stream = s;
  } catch (e) {
    cam.err = e.name || String(e);
    return false;
  }
  const v = $("cam");
  v.srcObject = cam.stream;
  $("s-capture").classList.toggle("front", cam.facing === "user");
  // 不等 play()：流拿到了却一帧不出时（相机被别的 App 占着之类），await 会一直挂着，按钮永远不出来
  v.play().catch(() => {});
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
  // 预览是镜像的（自拍所见即所得），存下来的照片不镜像——跟 iPad 自带相机一样，照片里的字是正的
  c.getContext("2d").drawImage(v, 0, 0);
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
  stopQrScan();           // 不先停，重复进入会叠出第二个循环
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

    // 取短边中间一半：分辨率提上去之后仍盖得住屏幕上 42vmin 的取景框，码占的像素也多一半
    const s = Math.min(v.videoWidth, v.videoHeight) * 0.5;
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
  // 每站从头来：清掉上一站的照片（不然「跳过」会把上一站的照片存成这一站的）、
  // 镜头回到前摄（上一站为扫卡片切到了后摄）、按钮先全藏（相机起来之前别留着上一站的「跳过」）
  cam.shot = null;
  cam.facing = "user";
  stopQrScan();
  $("qr-scan").hidden = true;
  $("shutter").hidden = true;
  $("btn-skip").hidden = true;
  $("btn-flip").hidden = false;
  $("btn-back").hidden = false;
  $("cap-tip").textContent = "";
  $("pose-k").textContent = st.kingdom;
  $("pose-t").textContent = st.pose;
  show("s-capture");
  await openCamera();
}

/* 相机打不开不能变成死路——生日当天卡在这一屏是最坏的情况。
   失败时一定给出出口：再试一次、跳过继续、回地图。
   扫码层开着时（拍完照、切镜头对卡片）要保住扫码层的按钮，不能复位成拍照状态——
   否则快门露出来，她一按就把刚摆好姿势的照片换成卡片照。 */
async function openCamera() {
  const ok = await startCam();
  // 相机还在打开她就离开了（回地图、跳过）：迟到的流别开着
  if (current !== "s-capture") { stopCam(); return; }
  const scanning = !$("qr-scan").hidden;
  // 倒数中不许把快门翻出来：切镜头挂起时按了快门，等新镜头起来会在倒数中途再露出快门，按两下就覆盖照片
  $("shutter").hidden = !ok || scanning || $("s-capture").classList.contains("counting");
  $("btn-flip").textContent = ok ? "切换镜头" : "再试一次";
  $("btn-skip").hidden = ok && !scanning;
  $("btn-skip").textContent = scanning ? ui.qrSkip : "跳过拍照，继续";
  $("cap-tip").textContent = scanning ? ""
    : ok ? ui.shutterTip
    : `相机打不开（${cam.err || "未知"}）。可以点右边「再试一次」，或者跳过拍照继续。`;
  if (scanning) $("qr-hint").textContent = ok ? ui.scanning : "相机打不开，点「再试一次」或者跳过";
}

/* 拍完照进扫码层。前摄是定焦超广角，卡片上的码举在正常距离只占十几个像素，基本认不出，
   所以扫码一律切到后摄；下一站 goCapture 会切回前摄。 */
async function enterScan(st) {
  $("shutter").hidden = true;
  $("btn-skip").hidden = false;
  $("btn-skip").textContent = ui.qrSkip;
  $("cap-tip").textContent = "";
  $("qr-hint").textContent = ui.scanning;
  $("qr-scan").hidden = false;
  startQrScan(st);
  if (cam.facing === "user") { cam.facing = "environment"; await openCamera(); }
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
  if (wake) { wake.release().catch(() => {}); wake = null; }
  // getPhoto 抛错（IndexedDB 连接丢了）也不能挡住终章
  const photos = await Promise.all(stations.map((s) => shots[s.id] || getPhoto(s.id).catch(() => null)));
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
  const i = stations.indexOf(st);
  const photo = cam.shot;
  if (photo) {
    shots[st.id] = photo;
    // 存不进去就重开一次连接再试；还不行也照常往下走，照片至少这次打开还在内存里
    try { await putPhoto(st.id, photo); }
    catch { dbp = null; try { await putPhoto(st.id, photo); } catch {} }
  }
  // 这一站算做完了，进度记到下一站。不记的话：收信物页被杀进程要重拍；
  // 走完终章隔天重开会被带回第三站，再按快门就把那天的照片覆盖了
  state.idx = i + 1;
  saveState();
  stopCam();
  goReveal(i, photo);
}

/* ---------------------------------------------------------------- 绑定 */

$("cover-btn").addEventListener("click", () => {
  radar.unlock();                     // iOS 音频要用户手势才能起
  goClue(state.idx);
});

$("clue-btn").addEventListener("click", () => goMap(state.idx));

/* 任何一次点屏都顺手唤醒音频、续上 wake lock：锁屏回来后第一下触摸就能把雷达声音救回来 */
document.addEventListener("touchend", () => {
  radar.unlock();
  if (current === "s-map" || current === "s-capture") keepAwake();
}, { passive: true });

$("map-cta").addEventListener("click", () => goCapture(state.idx));

$("recenter").addEventListener("click", () => map?.followMe());

/* 快门先倒数 3 秒：姿势都要空出手，一只手托着 iPad 按不了快门；支架 + 后摄也要靠它。
   倒数时把按钮都收起来，顺带防连点。拍照必须在扫码之前，扫码层只在拍完之后出现。 */
$("shutter").addEventListener("click", async () => {
  const st = stations[state.idx];
  const busy = ["shutter", "btn-flip", "btn-back"];
  busy.forEach((id) => { $(id).hidden = true; });
  $("s-capture").classList.add("counting");
  for (const n of ["3", "2", "1"]) {
    $("pose-t").textContent = n;
    await new Promise((r) => setTimeout(r, 1000));
    if (current !== "s-capture") break;
  }
  $("s-capture").classList.remove("counting");
  $("pose-t").textContent = st.pose;
  busy.forEach((id) => { $(id).hidden = false; });
  if (current !== "s-capture") return;
  cam.shot = grabShot();
  if (!cam.shot) {
    // 画面一直不来就给出口，不能只剩一个按了没用的快门
    $("btn-skip").hidden = false;
    $("btn-skip").textContent = "跳过拍照，继续";
    toast("画面没出来：点「切换镜头」重开相机，或者跳过", 3800);
    return;
  }
  if (qrReady() && !state.qr[st.id]) enterScan(st);
  else finishCapture(st);
});

$("btn-skip").addEventListener("click", () => {
  stopQrScan();
  $("qr-scan").hidden = true;
  finishCapture(stations[state.idx]);
});

$("btn-flip").addEventListener("click", async () => {
  if (cam.stream) cam.facing = cam.facing === "user" ? "environment" : "user";
  await openCamera();
});

/* 「我到了，拍照」点早了得能回去：线索原文和雷达都在地图屏 */
$("btn-back").addEventListener("click", () => {
  stopQrScan();
  stopCam();
  $("qr-scan").hidden = true;
  goMap(state.idx);
});

$("rv-btn").addEventListener("click", () => {
  if (state.idx < stations.length) goClue(state.idx);   // finishCapture 已经把进度记到下一站
  else goFinale();
});

$("fn-btn").addEventListener("click", () => { $("letter").hidden = false; });
$("letter-close").addEventListener("click", () => { $("letter").hidden = true; });

/* 清空进度：连点标题 5 下。作者在她 iPad 上彩排完要用它——不清的话，生日当天一打开
   就是彩排停下的那一站，扫码也被当成扫过了。挂在封面、线索页、终章的大标题上：
   重开应用只会落在这三屏之一。 */
let resetTaps = 0, resetAt = 0;
async function resetTap() {
  const now = Date.now();
  resetTaps = now - resetAt < 1500 ? resetTaps + 1 : 1;
  resetAt = now;
  if (resetTaps < 5) return;
  resetTaps = 0;
  if (!confirm("清空进度和照片，从封面重新开始？")) return;
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  try { await clearPhotos(); } catch {}
  location.reload();
}
["cover-t", "clue-t", "fn-t"].forEach((id) => $(id).addEventListener("click", resetTap));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { radar.stop(); return; }
  if (current === "s-map") { radar.unlock(); radar.start(); keepAwake(); }
  // 从后台切回来不算导航，浏览器不会自己去查新版
  navigator.serviceWorker?.getRegistration().then((r) => r && r.update()).catch(() => {});
});

/* ---------------------------------------------------------------- 启动 */

loadState();
if (state.idx >= stations.length) goFinale();
else if (state.idx > 0) goClue(state.idx);
else goCover();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  /* 缓存优先的代价：新版装好了，这次打开的页面还是旧模块渲染的。
     停在封面或线索页（没在走、没在拍）时自动刷新一次，改了线索和信件打开一次就能生效。
     首次安装没有 controller，不刷新；刷新后 controller 不再变，不会循环。 */
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (had && (current === "s-cover" || current === "s-clue")) location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
