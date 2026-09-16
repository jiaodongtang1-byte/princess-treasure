/* ============================================================================
   把 OSM 矢量数据画成绘本地图 + 实时跟随 + 雷达盘。

   不用瓦片——OSM 本来就是 WGS-84，跟浏览器给的坐标系一致，
   所以没有 GCJ-02 那 50~500 米的偏移问题，也不需要联网取图。

   性能上的关键取舍：几何只渲染一次（世界坐标），之后靠 <g transform> 平移缩放，
   而不是每秒重建六百个节点。路宽用 non-scaling-stroke，缩放时保持视觉宽度不变，
   跟真地图一样。文字和浮层反过来，每次按屏幕坐标重算，免得被缩放拉变形。
   ============================================================================ */

const NS = "http://www.w3.org/2000/svg";
const W = 1000, H = 750;              // viewBox
const GOLD = "#B8912F";

/* 路一律比地亮（白），描边比地深。把路的填充设成跟底色接近的米色，路就整个消失了。 */
const ROAD = [
  [/^(motorway|trunk)$/,                         7.5, "#FFFFFF", "#C2A874", 2.4],
  [/^(primary)$/,                                6.4, "#FFFFFF", "#C6AD7C", 2.2],
  [/^(secondary)$/,                              5.2, "#FFFFFF", "#CCB78C", 2.0],
  [/^(tertiary)$/,                               4.0, "#FFFFFF", "#D2C09A", 1.7],
  [/^(residential|unclassified|living_street)$/, 2.7, "#FFFFFF", "#D8C9A8", 1.3],
  [/^(pedestrian|service)$/,                     2.1, "#FFFDF7", "#DCCFB2", 1.1],
  [/^(footway|path|cycleway|steps)$/,            1.2, null,      "#D3C6AA", 0.9],
];
const BUILDING_FILL = ["#DFCDB0", "#D8C4A4", "#D2BD9B"];
const LABEL_RE = /^(motorway|trunk|primary|secondary|tertiary|residential|pedestrian)$/;

function roadStyle(h) {
  for (const [re, w, fill, stroke, sw] of ROAD) if (re.test(h)) return { w, fill, stroke, sw };
  return null;
}
const el = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* 视野档位。不用连续缩放：地图会一直抖，而且每次移动都重排，看着晕。
   档位之间留迟滞，避免在边界上反复横跳。 */
/* 最小 250 米：再近就只剩一块建筑多边形填满整屏，街道全出画，反而看不出自己在哪 */
const SPANS = [250, 380, 550, 850, 1300, 2000, 3200, 5000, 8000];
export function pickSpan(needM, current) {
  for (const s of SPANS) {
    if (needM <= s) {
      // 要往小档换，得明显小于当前档才换（迟滞 25%）
      if (current && s < current && needM > s * 0.75) return current;
      return s;
    }
  }
  return SPANS[SPANS.length - 1];
}

/**
 * 建一张会跟着人走的地图。
 * @param {HTMLElement} mount 挂载点
 * @param {Array} geo OSM 要素
 * @param {[number,number]} target 信物坐标
 */
export function createMap(mount, geo, target) {
  const [tLat, tLon] = target;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(tLat * Math.PI / 180);

  // 世界坐标：以信物为原点，单位是米
  const wx = (lon) => (lon - tLon) * mPerLon;
  const wy = (lat) => -(lat - tLat) * mPerLat;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid slice",
                          class: "map-svg" });
  svg.appendChild(el("rect", { x: -20000, y: -20000, width: 40000, height: 40000,
                               fill: "#F5EBD8" }));

  const gWorld = el("g", { class: "world" });
  const gGround = el("g", {}), gWater = el("g", {}), gBld = el("g", {});
  const gRoad = el("g", {}), gRoadTop = el("g", {});
  const gLabel = el("g", { class: "labels" });

  const path = (f) => f.g.map((p, i) =>
    (i ? "L" : "M") + wx(p[1]).toFixed(1) + " " + wy(p[0]).toFixed(1)).join(" ");

  let bi = 0;
  const labels = [];
  for (const f of geo) {
    const t = f.t, d = path(f);
    if (t.landuse || t.leisure) {
      const col = t.landuse === "forest" ? "#C6DBB2" : t.leisure ? "#CFE0BB" : "#D6E3C4";
      gGround.appendChild(el("path", { d, fill: col, stroke: "#AFC79A", "stroke-width": 1.2,
                                       "vector-effect": "non-scaling-stroke" }));
    } else if (t.natural === "water" || t.waterway) {
      gWater.appendChild(el("path", { d, fill: "#BEDAE6", stroke: "#94BFD2", "stroke-width": 1.3,
                                      "vector-effect": "non-scaling-stroke" }));
    } else if (t.building) {
      gBld.appendChild(el("path", { d, fill: BUILDING_FILL[bi++ % 3], stroke: "#AE9160",
                                    "stroke-width": 1.4, "stroke-linejoin": "round",
                                    "vector-effect": "non-scaling-stroke" }));
    } else if (t.barrier === "wall") {
      gBld.appendChild(el("path", { d, fill: "none", stroke: "#B29B76", "stroke-width": 2.6,
                                    "stroke-linecap": "round",
                                    "vector-effect": "non-scaling-stroke" }));
    } else if (t.railway) {
      gRoad.appendChild(el("path", { d, fill: "none", stroke: "#9C93A8", "stroke-width": 2.2,
                                     "stroke-dasharray": "10 6",
                                     "vector-effect": "non-scaling-stroke" }));
    }
  }

  // 路分两遍画：先描边、再填充，交叉口才不会互相盖出毛刺
  const roads = geo.filter((f) => f.t.highway && roadStyle(f.t.highway))
    .sort((a, b) => roadStyle(b.t.highway).w - roadStyle(a.t.highway).w);
  for (const f of roads) {
    const s = roadStyle(f.t.highway);
    gRoad.appendChild(el("path", { d: path(f), fill: "none", stroke: s.stroke,
                                   "stroke-width": s.w + s.sw * 2, "stroke-linecap": "round",
                                   "stroke-linejoin": "round",
                                   "vector-effect": "non-scaling-stroke" }));
  }
  for (const f of roads) {
    const s = roadStyle(f.t.highway);
    if (!s.fill) continue;
    gRoadTop.appendChild(el("path", { d: path(f), fill: "none", stroke: s.fill,
                                      "stroke-width": s.w, "stroke-linecap": "round",
                                      "stroke-linejoin": "round",
                                      "vector-effect": "non-scaling-stroke" }));
  }

  // 路名：世界坐标摆位（跟着地图走），字号每次按缩放反算（不被拉变形）
  const taken = new Set();
  for (const f of roads) {
    if (labels.length >= 18) break;
    if (!f.t.name || !LABEL_RE.test(f.t.highway)) continue;
    const p = f.g[Math.floor(f.g.length / 2)];
    const X = wx(p[1]), Y = wy(p[0]);
    const key = f.t.name;
    if (taken.has(key)) continue;
    taken.add(key);
    const big = /^(motorway|trunk|primary)$/.test(f.t.highway);
    const tx = el("text", { x: X.toFixed(0), y: Y.toFixed(0), "text-anchor": "middle",
                            fill: big ? "#6B5A3E" : "#8A7B5E", "paint-order": "stroke",
                            stroke: "#F5EBD8", "stroke-width": 4, "stroke-linejoin": "round",
                            "font-family": "PingFang SC, sans-serif" });
    tx.textContent = f.t.name;
    labels.push({ node: tx, big });
    gLabel.appendChild(tx);
  }

  gWorld.append(gGround, gWater, gBld, gRoad, gRoadTop, gLabel);
  svg.appendChild(gWorld);

  // 浮层用屏幕坐标，每次重算：罗盘、罗盘针、轨迹、信物、她
  const gOver = el("g", { class: "overlay" });
  const trail = el("path", { fill: "none", stroke: GOLD, "stroke-width": 3,
                             "stroke-dasharray": "1.5 9", "stroke-linecap": "round",
                             opacity: .55 });
  const link = el("path", { fill: "none", stroke: GOLD, "stroke-width": 2,
                            "stroke-dasharray": "7 7", opacity: .45 });
  const pin = el("g", {});
  pin.innerHTML = `<circle r="13" fill="${GOLD}" opacity=".16"/>
    <circle r="7.5" fill="#FFFBF4" stroke="${GOLD}" stroke-width="2.2"/>
    <circle r="2.6" fill="${GOLD}"/>`;
  const me = el("g", {});
  me.innerHTML = `<circle r="19" fill="#2B2F3C" opacity=".08"/>
    <circle r="9" fill="#FFFBF4" stroke="#2B2F3C" stroke-width="2.6"/>
    <circle r="3.4" fill="#2B2F3C"/>`;
  gOver.append(link, trail, pin, me);
  svg.appendChild(gOver);

  mount.replaceChildren(svg);

  let span = 900, center = { x: 0, y: 0 };
  const t2s = { k: 1 };
  const toScreen = (X, Y) => [X * t2s.k + W / 2 - center.x * t2s.k,
                              Y * t2s.k + H / 2 - center.y * t2s.k];

  /** 重画一帧。me/trail 传 null 就是还没定位。 */
  function draw({ me: meFix = null, trailPts = [] } = {}) {
    const targetPts = { X: 0, Y: 0 };
    let needM = 300;

    if (meFix) {
      const mx = wx(meFix.lon), my = wy(meFix.lat);
      needM = Math.hypot(mx, my) * 2.6 + 90;     // 两点都要进画面，再留点边
      center = { x: mx / 2, y: my / 2 };         // 取中点，你和信物各占一边
      meFix._X = mx; meFix._Y = my;
    } else {
      center = { x: 0, y: 0 };
    }
    span = pickSpan(needM, span);

    const k = W / span;                          // viewBox 单位 / 米
    t2s.k = k;
    gWorld.setAttribute("transform",
      `translate(${(W / 2 - center.x * k).toFixed(1)} ${(H / 2 - center.y * k).toFixed(1)}) scale(${k.toFixed(6)})`);
    for (const l of labels) l.node.setAttribute("font-size", (l.big ? 13 : 11.5) / k * (W / 1180));

    // 信物
    const [px_, py_] = toScreen(0, 0);
    pin.setAttribute("transform", `translate(${px_} ${py_})`);

    if (meFix) {
      const [mx_, my_] = toScreen(meFix._X, meFix._Y);
      me.setAttribute("transform", `translate(${mx_} ${my_})`);
      me.style.display = "";
      // 两点之间连一条虚线，走的时候一眼看得出还差多远
      link.setAttribute("d", `M ${mx_} ${my_} L ${px_} ${py_}`);
      link.style.display = "";
      trail.setAttribute("d", trailPts.map((p, i) => {
        const [x, y] = toScreen(wx(p.lon), wy(p.lat));
        return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }).join(" "));
      trail.style.display = trailPts.length > 1 ? "" : "none";
    } else {
      me.style.display = "none";
      link.style.display = "none";
      trail.style.display = "none";
    }
  }

  return { draw, toScreen, get spanM() { return span; }, wx, wy, W, H, svg };
}

/* ------------------------------------------------------------------ 雷达盘
   右下角那个圆。跟地图同一套信息，但只看方向和强弱，不被街道干扰。
   北上、你居中、信物是个亮点；扫过的针每次滴的时候走一下。 */

export function createRadarDisc(mount) {
  const S = 200, C = S / 2;
  const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, class: "disc-svg" });

  svg.appendChild(el("circle", { cx: C, cy: C, r: 94, fill: "#FFFBF4", opacity: .9 }));
  for (const r of [94, 62, 32]) {
    svg.appendChild(el("circle", { cx: C, cy: C, r, fill: "none", stroke: GOLD,
                                   "stroke-width": r === 94 ? 1.6 : 1, opacity: r === 94 ? .7 : .32 }));
  }
  const cross = el("g", { opacity: .22 });
  cross.appendChild(el("line", { x1: C, y1: C - 94, x2: C, y2: C + 94, stroke: GOLD, "stroke-width": 1 }));
  cross.appendChild(el("line", { x1: C - 94, y1: C, x2: C + 94, y2: C, stroke: GOLD, "stroke-width": 1 }));
  svg.appendChild(cross);

  const nlab = el("text", { x: C, y: 14, "text-anchor": "middle", fill: GOLD, "font-size": 11,
                            "font-family": "Songti SC, serif", "font-weight": 600 });
  nlab.textContent = "北";
  svg.appendChild(nlab);

  // 每次滴的时候扩散一圈
  const pulse = el("circle", { cx: C, cy: C, r: 8, fill: "none", stroke: GOLD,
                               "stroke-width": 2.4, opacity: 0 });
  svg.appendChild(pulse);

  const sweep = el("line", { x1: C, y1: C, x2: C, y2: C - 94, stroke: GOLD,
                             "stroke-width": 2, opacity: .5 });
  svg.appendChild(sweep);

  const blip = el("g", {});
  blip.innerHTML = `<circle r="10" fill="${GOLD}" opacity=".16"/>
    <circle r="5" fill="${GOLD}"/><circle r="5" fill="none" stroke="#FFFBF4" stroke-width="1.6"/>`;
  svg.appendChild(blip);

  const you = el("g", {});
  you.innerHTML = `<circle r="4.5" fill="#2B2F3C"/><circle r="4.5" fill="none"
    stroke="#FFFBF4" stroke-width="1.8"/>`;
  you.setAttribute("transform", `translate(${C} ${C})`);
  svg.appendChild(you);

  const num = el("text", { x: C, y: C + 46, "text-anchor": "middle", fill: "#2B2F3C",
                           "font-size": 21, "font-weight": 600, class: "disc-dist",
                           "font-family": "ui-monospace, SF Mono, monospace" });
  svg.appendChild(num);
  const unit = el("text", { x: C, y: C + 62, "text-anchor": "middle", fill: "#6B6F7C",
                            "font-size": 10, "font-family": "PingFang SC, sans-serif" });
  unit.textContent = "米";
  svg.appendChild(unit);

  mount.replaceChildren(svg);

  let lastPulse = 0;
  function pulseNow() {
    const t = performance.now();
    if (t - lastPulse < 130) return;             // 太快了就视觉疲劳，也别浪费动画
    lastPulse = t;
    pulse.setAttribute("r", 8);
    pulse.setAttribute("opacity", .8);
    const t0 = t;
    const step = (now) => {
      const p = Math.min((now - t0) / 460, 1);
      pulse.setAttribute("r", 8 + p * 84);
      pulse.setAttribute("opacity", .8 * (1 - p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  return {
    /** @param {{dist:number, bearing:number, spanM:number, signal:number}|null} s */
    update(s) {
      if (!s) { num.textContent = "—"; unit.style.display = "none";
                blip.style.display = "none"; sweep.style.display = "none"; return; }
      unit.style.display = "";
      sweep.style.display = "";
      num.textContent = s.dist < 1000 ? Math.round(s.dist) : (s.dist / 1000).toFixed(1);
      unit.textContent = s.dist < 1000 ? "米" : "公里";

      // 半径按当前视野归一，跟地图是一个尺度
      const rr = clamp(s.dist / (s.spanM / 2), 0, 1) * 86;
      const a = (s.bearing - 90) * Math.PI / 180;
      blip.style.display = "";
      blip.setAttribute("transform", `translate(${C + Math.cos(a) * rr} ${C + Math.sin(a) * rr})`);
      sweep.setAttribute("transform", `rotate(${s.bearing} ${C} ${C})`);
    },
    pulse: pulseNow,
  };
}
