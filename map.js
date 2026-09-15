/* ============================================================================
   把 OSM 矢量数据画成绘本地图。
   不用瓦片——OSM 本来就是 WGS-84，跟浏览器给的坐标系一致，
   所以没有 GCJ-02 那 50~500 米的偏移问题，也不需要联网取图。
   ============================================================================ */

const NS = "http://www.w3.org/2000/svg";

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
const GOLD = "#B8912F";
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

/**
 * 画一张地图。
 * @param {HTMLElement} mount  挂载点（会被清空）
 * @param {Array} geo          OSM 要素数组，来自 data/*.json
 * @param {{center:[number,number], spanM:number, target:[number,number]}} opts
 * @returns {{px:Function, py:Function, W:number, H:number, sx:number}} 投影，供雷达浮层复用
 */
export function renderMap(mount, geo, opts) {
  const W = 1000, H = 750;                       // viewBox；实际尺寸由外面撑满
  const [cLat, cLon] = opts.center;
  const spanM = opts.spanM || 520;

  /* 投影必须由「中心坐标 + 固定米数」决定，不能由数据外接框决定。
     Overpass 对「有一条边落进框内」的 way 会返回整条几何——穿过全城的铁路、
     环路就是这样被拉进来的，外接框能到十几公里。拿它算缩放，整站会缩成角落一小团。
     视野外的部分交给 SVG viewBox 自然裁掉。 */
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(cLat * Math.PI / 180);
  const sx = W / spanM;                          // 像素/米（viewBox 单位/米）
  const px = (p) => W / 2 + (p[1] - cLon) * mPerLon * sx;
  const py = (p) => H / 2 - (p[0] - cLat) * mPerLat * sx;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid slice",
                          class: "map-svg" });

  const path = (f) => f.g
    .map((p, i) => (i ? "L" : "M") + px(p).toFixed(1) + " " + py(p).toFixed(1)).join(" ");
  const near = (f) => f.g.some((p) => Math.abs(px(p) - W / 2) < W && Math.abs(py(p) - H / 2) < H);

  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: "#F5EBD8" }));

  const gGround = el("g", {}), gWater = el("g", {}), gBld = el("g", {});
  const gRoad = el("g", {}), gRoadTop = el("g", {}), gLabel = el("g", {});

  let bi = 0;
  for (const f of geo) {
    if (!near(f)) continue;
    const t = f.t, d = path(f);
    if (t.landuse || t.leisure) {
      const col = t.landuse === "forest" ? "#C6DBB2" : t.leisure ? "#CFE0BB" : "#D6E3C4";
      gGround.appendChild(el("path", { d, fill: col, stroke: "#AFC79A", "stroke-width": 1.2 }));
    } else if (t.natural === "water" || t.waterway) {
      gWater.appendChild(el("path", { d, fill: "#BEDAE6", stroke: "#94BFD2", "stroke-width": 1.3 }));
    } else if (t.building) {
      gBld.appendChild(el("path", { d, fill: BUILDING_FILL[bi++ % 3], stroke: "#AE9160",
                                    "stroke-width": 1.4, "stroke-linejoin": "round" }));
    } else if (t.barrier === "wall") {
      gBld.appendChild(el("path", { d, fill: "none", stroke: "#B29B76", "stroke-width": 2.6,
                                    "stroke-linecap": "round" }));
    } else if (t.railway) {
      gRoad.appendChild(el("path", { d, fill: "none", stroke: "#9C93A8", "stroke-width": 2.2,
                                     "stroke-dasharray": "10 6" }));
    }
  }

  // 路分两遍画：先所有描边、再所有填充，交叉口才不会互相盖出毛刺
  const roads = geo.filter((f) => f.t.highway && near(f) && roadStyle(f.t.highway))
    .sort((a, b) => roadStyle(b.t.highway).w - roadStyle(a.t.highway).w);
  for (const f of roads) {
    const s = roadStyle(f.t.highway);
    gRoad.appendChild(el("path", { d: path(f), fill: "none", stroke: s.stroke,
                                   "stroke-width": s.w + s.sw * 2, "stroke-linecap": "round",
                                   "stroke-linejoin": "round" }));
  }
  for (const f of roads) {
    const s = roadStyle(f.t.highway);
    if (!s.fill) continue;
    gRoadTop.appendChild(el("path", { d: path(f), fill: "none", stroke: s.fill,
                                      "stroke-width": s.w, "stroke-linecap": "round",
                                      "stroke-linejoin": "round" }));
  }

  // 路名：只标主要道路，且互相隔开，别糊成一片
  const placed = [];
  let n = 0;
  for (const f of roads) {
    if (n >= 14) break;
    if (!f.t.name || !LABEL_RE.test(f.t.highway)) continue;
    const p = f.g[Math.floor(f.g.length / 2)];
    const x = px(p), y = py(p);
    if (x < 70 || x > W - 70 || y < 42 || y > H - 42) continue;
    if (placed.some((q) => Math.hypot(q[0] - x, q[1] - y) < 110)) continue;
    const big = /^(motorway|trunk|primary)$/.test(f.t.highway);
    const tx = el("text", { x: x.toFixed(0), y: y.toFixed(0), "text-anchor": "middle",
                            fill: big ? "#6B5A3E" : "#8A7B5E", "font-size": big ? 13 : 11.5,
                            "font-family": "PingFang SC, sans-serif", "paint-order": "stroke",
                            stroke: "#F5EBD8", "stroke-width": 4, "stroke-linejoin": "round" });
    tx.textContent = f.t.name;
    gLabel.appendChild(tx);
    placed.push([x, y]);
    n++;
  }

  svg.append(gGround, gWater, gBld, gRoad, gRoadTop, gLabel);
  mount.replaceChildren(svg);

  // 罗盘（贴右下，避开线索卡）
  const cx0 = W - 92, cy0 = H - 108;
  const comp = el("g", { transform: `translate(${cx0} ${cy0})` });
  comp.appendChild(el("circle", { r: 34, fill: "#FFFBF4", opacity: .82 }));
  comp.appendChild(el("circle", { r: 34, fill: "none", stroke: GOLD, "stroke-width": 1.4, opacity: .7 }));
  comp.appendChild(el("path", { d: "M 0 -28 L 6 0 L 0 28 L -6 0 Z", fill: GOLD, opacity: .85 }));
  comp.appendChild(el("path", { d: "M -28 0 L 0 6 L 28 0 L 0 -6 Z", fill: GOLD, opacity: .45 }));
  const nl = el("text", { x: 0, y: -39, "text-anchor": "middle", fill: GOLD, "font-size": 12,
                          "font-family": "Songti SC, serif", "font-weight": 600 });
  nl.textContent = "北";
  comp.appendChild(nl);
  svg.appendChild(comp);

  return { px, py, W, H, sx, svg };
}

/** 雷达同心圆 + 目标点 + 「她在这里」。返回一个可反复调用的更新函数。 */
export function makeRadarLayer(svg, proj) {
  const g = el("g", { class: "radar-layer" });
  const rings = [200, 100, 50].map((m) => {
    const c = el("circle", { cx: proj.W / 2, cy: proj.H / 2, r: (m * proj.sx).toFixed(1),
                             fill: "none", stroke: GOLD, "stroke-width": 1.6,
                             opacity: m >= 200 ? .16 : m >= 100 ? .28 : .46 });
    g.appendChild(c);
    return c;
  });

  const pin = el("g", {});
  pin.innerHTML = `<circle r="13" fill="${GOLD}" opacity=".16"/>
    <circle r="7.5" fill="#FFFBF4" stroke="${GOLD}" stroke-width="2.2"/>
    <circle r="2.6" fill="${GOLD}"/>`;
  g.appendChild(pin);

  const me = el("g", {});
  me.innerHTML = `<circle r="17" fill="#2B2F3C" opacity=".07"/>
    <circle r="8.5" fill="#FFFBF4" stroke="#2B2F3C" stroke-width="2.4"/>
    <circle r="3" fill="#2B2F3C"/>`;
  g.appendChild(me);

  const trail = el("path", { fill: "none", stroke: GOLD, "stroke-width": 3.2,
                             "stroke-dasharray": "1.5 10", "stroke-linecap": "round", opacity: .62 });
  g.insertBefore(trail, g.firstChild);
  svg.appendChild(g);

  const [tx, ty] = [proj.W / 2, proj.H / 2];
  pin.setAttribute("transform", `translate(${tx} ${ty})`);

  // 她在这里：给一个像素位置就画到那儿；没定位时藏起来
  return {
    setMe(pixelXY) {
      if (!pixelXY) { me.style.display = "none"; trail.style.display = "none"; return; }
      me.style.display = ""; trail.style.display = "";
      const [mx, my] = pixelXY;
      me.setAttribute("transform", `translate(${mx} ${my})`);
      trail.setAttribute("d", `M ${mx - 330} ${my + 195} Q ${mx - 175} ${my + 118} ${mx} ${my}`);
    },
  };
}
