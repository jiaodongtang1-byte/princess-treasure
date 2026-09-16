/* ============================================================================
   把 OSM 矢量数据画成绘本地图 + 实时跟随 + 雷达盘。

   不用瓦片——OSM 本来就是 WGS-84，跟浏览器给的坐标系一致，
   所以没有 GCJ-02 那 50~500 米的偏移问题，也不需要联网取图。

   性能上的关键取舍：几何只渲染一次（世界坐标），之后靠 <g transform> 平移缩放，
   而不是每秒重建六百个节点。路宽用 non-scaling-stroke，缩放时保持视觉宽度不变，
   跟真地图一样。文字和浮层反过来，每次按屏幕坐标重算，免得被缩放拉变形。

   视角：**以「你」为中心**，信物在哪由边缘箭头 + 虚线指过去。
   地图给人的第一问是「我在哪」，不是「目标在哪」——后者交给箭头。
   ============================================================================ */

const NS = "http://www.w3.org/2000/svg";
const W = 1000, H = 750;              // viewBox 的基准宽高（高度每帧按屏幕比例重算）
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

function roadStyle(h) {
  for (const [re, w, fill, stroke, sw] of ROAD) if (re.test(h)) return { w, fill, stroke, sw };
  return null;
}

/* 名字的优先级与样式。0 最先抢位置——抢不到就整个不画，宁可少也不要糊成一团。
   颜色按地物性质分：水系蓝、绿地绿、路名棕、楼名深棕。 */
const LANDMARK = { size: 13,   fill: "#4A6B3A", weight: 600 };   // 公园/广场/河
const WATER    = { size: 12.5, fill: "#3C6E85", weight: 600 };
const BUILDING = { size: 11.5, fill: "#5E503A", weight: 600 };
const ROAD_BIG = { size: 11.5, fill: "#6B5A3E", weight: 600 };
const ROAD_SML = { size: 10.5, fill: "#8A7B5E", weight: 500 };
const RAIL     = { size: 10,   fill: "#7A7186", weight: 500 };

const el = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* 视野档位。不用连续缩放：地图会一直抖，而且每次移动都重排，看着晕。
   档位之间留迟滞，避免在边界上反复横跳。 */
/* 最小 250 米：再近就只剩一块建筑多边形填满整屏，街道全出画，反而看不出自己在哪。
   最大 1300 米：再远「我在哪」就淹在一片色块里了——远处的信物交给边缘箭头。 */
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

/** 中文字宽约 1 em，西文约 0.55 em——用来预估标签占位，不精确但够用 */
function textW(s, fs) {
  let n = 0;
  for (const ch of s) n += /[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.55;
  return n * fs;
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
  svg.appendChild(el("rect", { x: -30000, y: -30000, width: 60000, height: 60000,
                               fill: "#F5EBD8" }));

  const gWorld = el("g", { class: "world" });
  const gGround = el("g", {}), gWater = el("g", {}), gBld = el("g", {});
  const gRoad = el("g", {}), gRoadTop = el("g", {});
  const gLabel = el("g", { class: "labels" });

  const path = (f) => f.g.map((p, i) =>
    (i ? "L" : "M") + wx(p[1]).toFixed(1) + " " + wy(p[0]).toFixed(1)).join(" ");

  /** 世界坐标下的包围盒，用来判断「这个地物在屏幕上够不够大，配不配拥有名字」 */
  function bbox(f) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of f.g) {
      const X = wx(p[1]), Y = wy(p[0]);
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    return [x0, y0, x1, y1];
  }

  /** 折线的正中间那一点 + 那一段的走向——路名要顺着路写，不横着盖上去 */
  function midpoint(f) {
    const pts = f.g.map((p) => [wx(p[1]), wy(p[0])]);
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d); total += d;
    }
    let acc = 0;
    for (let i = 0; i < seg.length; i++) {
      if (acc + seg[i] >= total / 2) {
        const t = seg[i] ? (total / 2 - acc) / seg[i] : 0;
        const ang = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]) * 180 / Math.PI;
        return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
                 y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
                 // 倒着写的字要翻正
                 ang: (ang > 90 || ang < -90) ? ang + 180 : ang };
      }
      acc += seg[i];
    }
    return { x: pts[0][0], y: pts[0][1], ang: 0 };
  }

  /* 名字池：几何只走一遍，把「谁有名字」记下来；
     具体画不画、画哪、多大，留到每帧按当前缩放和占位决定。 */
  const pool = [];
  function addLabel(name, X, Y, sizeM, style, ang, prio) {
    const node = el("text", { "text-anchor": "middle", "dominant-baseline": "middle",
                              fill: style.fill, "font-weight": style.weight,
                              "paint-order": "stroke", stroke: "#F5EBD8",
                              "stroke-width": 3.4, "stroke-linejoin": "round",
                              "font-family": "PingFang SC, Hiragino Sans GB, sans-serif" });
    node.textContent = name;
    gLabel.appendChild(node);
    pool.push({ node, name, X, Y, style, ang: ang || 0, prio,
                // 屏幕占比小于 8% 的地物，缩远了就不给它名字，否则满屏小字
                minSpan: clamp(sizeM / 0.08, 0, 6000) });
  }

  let bi = 0;
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

  /* 收名字。顺序即优先级：水面和绿地是地标 → 楼 → 大路 → 小路 → 轨道。 */
  const named = geo.filter((f) => f.t.name);
  const seen = new Set();                      // 同名要素（一条河被切成好几段）只留一段
  for (const f of named) {
    const t = f.t;
    if (seen.has(t.name)) continue;
    const [x0, y0, x1, y1] = bbox(f);
    const diag = Math.hypot(x1 - x0, y1 - y0);

    if (t.natural === "water" || t.waterway) {
      const m = midpoint(f);
      addLabel(t.name, m.x, m.y, Math.max(diag, 120), WATER, m.ang, 0);
      seen.add(t.name);
    } else if (t.landuse || t.leisure) {
      const m = midpoint(f);
      addLabel(t.name, m.x, m.y, diag, LANDMARK, 0, 0);
      seen.add(t.name);
    } else if (t.building) {
      const m = midpoint(f);
      addLabel(t.name, m.x, m.y, diag, BUILDING, 0, 1);
      seen.add(t.name);
    } else if (t.railway) {
      const m = midpoint(f);
      addLabel(t.name, m.x, m.y, diag, RAIL, m.ang, 4);
      seen.add(t.name);
    } else if (t.highway && roadStyle(t.highway)) {
      const big = /^(motorway|trunk|primary|secondary)$/.test(t.highway);
      const m = midpoint(f);
      addLabel(t.name, m.x, m.y, diag, big ? ROAD_BIG : ROAD_SML, m.ang, big ? 2 : 3);
      seen.add(t.name);
    }
  }

  gWorld.append(gGround, gWater, gBld, gRoad, gRoadTop, gLabel);
  svg.appendChild(gWorld);

  // 浮层用屏幕坐标，每次重算：轨迹、指路虚线、信物、「你在这」
  const gOver = el("g", { class: "overlay" });
  const trail = el("path", { fill: "none", stroke: GOLD, "stroke-width": 3,
                             "stroke-dasharray": "1.5 9", "stroke-linecap": "round",
                             opacity: .55 });
  const link = el("path", { fill: "none", stroke: GOLD, "stroke-width": 2,
                            "stroke-dasharray": "7 7", opacity: .45 });

  // 信物在画面里：金色别针 + 一圈光环
  const pinNear = el("g", { class: "pin-near" });
  pinNear.innerHTML = `<circle r="13" fill="${GOLD}" opacity=".16"/>
    <circle r="7.5" fill="#FFFBF4" stroke="${GOLD}" stroke-width="2.2"/>
    <circle r="2.6" fill="${GOLD}"/>`;

  // 信物在画面外：贴边一个箭头指着它，方向比位置重要
  const pinFar = el("g", { class: "pin-far" });
  pinFar.innerHTML = `<circle r="15" fill="${GOLD}" opacity=".14"/>
    <circle r="14" fill="#FFFBF4" stroke="${GOLD}" stroke-width="2.2"/>
    <path d="M -3.5 -6 L 5 0 L -3.5 6 Z" fill="${GOLD}"/>`;

  const me = el("g", {});
  me.innerHTML = `<circle r="19" fill="#2B2F3C" opacity=".08"/>
    <circle r="9" fill="#FFFBF4" stroke="#2B2F3C" stroke-width="2.6"/>
    <circle r="3.4" fill="#2B2F3C"/>`;
  gOver.append(link, trail, pinNear, pinFar, me);
  svg.appendChild(gOver);

  mount.replaceChildren(svg);

  let span = 900, center = { x: 0, y: 0 };
  const t2s = { k: 1, cy: H / 2, cpm: 1, cw: W, ch: H };

  /* 自动跟随 vs 手动扒图。她一动手指就切手动（地图不再自己跑），
     按「回到我的位置」才切回来——不自动切回，否则她正在看的地方会被悄悄挪走。 */
  let follow = true, lastArgs = { me: null, trailPts: [], signal: 0 };
  let onFollow = null;
  const setFollow = (v) => { if (follow !== v) { follow = v; onFollow?.(v); } };

  /* 压在地图上的那几块界面（线索卡、雷达盘、按钮），换算成 viewBox 坐标。
     箭头要是钻到它们底下，等于没给指路——所以得知道它们在哪。 */
  /* 箭头躲全部三块；标签只躲雷达盘和按钮。
     线索卡占了左上角一大片，标签要是也躲它，半个屏幕的名字就全没了——
     被卡片压掉半个字，也比为了躲它让一整片地图没有名字强。 */
  const BLOCK_ARROW = [".cluecard", ".disc", ".map-cta"];
  const BLOCK_LABEL = [".disc", ".map-cta"];
  function blockers(VX0, VY0, s, sels = BLOCK_ARROW) {
    const mr = svg.getBoundingClientRect();
    const scope = mount.closest(".screen") || document;
    const out = [];
    for (const sel of sels) {
      const e = scope.querySelector(sel);
      if (!e) continue;
      const r = e.getBoundingClientRect();
      if (!r.width) continue;
      out.push([VX0 + (r.left - mr.left) / s, VY0 + (r.top - mr.top) / s,
                VX0 + (r.right - mr.left) / s, VY0 + (r.bottom - mr.top) / s]);
    }
    return out;
  }

  /** 重画一帧。me 传 null 就是还没定位——那会儿以信物为中心。 */
  function draw({ me: meFix = null, trailPts = [], signal = 0 } = {}) {
    lastArgs = { me: meFix, trailPts, signal };
    /* viewBox 跟着屏幕比例走，不是写死 1000×750。
       写死的话 preserveAspectRatio=slice 在竖屏会裁掉左右各四分之一的地图
       （竖屏可见宽度只剩 52%），贴边的标签和箭头也就画到框外面去了。
       现在 viewBox 的长宽比 = 屏幕的长宽比，裁不掉任何东西，
       而且「视野 span 米」恒等于屏幕宽度上的米数，横竖屏含义一致。 */
    const cw = svg.clientWidth || W, ch = svg.clientHeight || H;
    const VH = W * ch / cw;                          // 可视高度（viewBox 单位）
    svg.setAttribute("viewBox", `0 0 ${W} ${VH.toFixed(1)}`);
    const VX0 = 0, VY0 = 0, VX1 = W, VY1 = VH;
    const s = cw / W;                                // CSS px → viewBox 单位
    const px = (v) => v / s;
    t2s.cpm = cw / span; t2s.cw = cw; t2s.ch = ch;   // 手指换算：CSS px / 米、以及画布 CSS 尺寸

    let needM = 900;

    if (meFix) {
      const mx = wx(meFix.lon), my = wy(meFix.lat);
      meFix._X = mx; meFix._Y = my;
      if (follow) {
        const d = Math.hypot(mx, my);
        // 以「你」为中心。视野随距离缓慢放开，但封在 1300 米内：
        // 再远就只剩色块，看不出自己在哪——远处的信物由边缘箭头负责。
        needM = clamp(d * 1.4 + 220, 250, 1300);
        center = { x: mx, y: my };
      }
    } else if (follow) {
      center = { x: 0, y: 0 };
    }
    if (follow) span = pickSpan(needM, span);    // 手动缩放时档位让位给她的手指

    const k = W / span;                          // viewBox 单位 / 米
    t2s.k = k; t2s.cy = VY1 / 2;
    gWorld.setAttribute("transform",
      `translate(${(W / 2 - center.x * k).toFixed(1)} ${(VY1 / 2 - center.y * k).toFixed(1)}) scale(${k.toFixed(6)})`);

    /* 标签排布：按优先级抢位置，抢不到就不画。
       横屏竖屏都按屏幕坐标算，所以同一套数据在两种朝向下都不会糊。 */
    const grid = new Set(), CELL = 34;
    const mark = (x, y) => {                       // 占住一小块，别让标签压到标记上
      for (let gx = Math.floor((x - 14) / CELL); gx <= Math.floor((x + 14) / CELL); gx++)
        for (let gy = Math.floor((y - 14) / CELL); gy <= Math.floor((y + 14) / CELL); gy++)
          grid.add(gx + "," + gy);
    };
    const blks = blockers(VX0, VY0, s);                      // 箭头要躲的
    const blksLabel = blockers(VX0, VY0, s, BLOCK_LABEL);    // 标签要躲的（少一块）
    for (const [x0, y0, x1, y1] of blksLabel)
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++)
          grid.add(gx + "," + gy);
    // 两个标记先占位，标签再排——否则「电子科技博物馆」会正好压在她那个点上
    const [px_, py_] = toScreen(0, 0);
    mark(px_, py_);
    if (meFix) mark(...toScreen(meFix._X, meFix._Y));

    // 先全藏掉再挑着显示。只藏「这一轮没通过筛选的」是不够的——
    // 被截断（下面的 slice）和没排上队的那些压根不会被遍历到，会一直挂着上一轮的样式。
    for (const l of pool) l.node.style.display = "none";

    /* 谁配拥有名字。两条规则合起来用：
       ① 同类里按「离画面中心多远」排——不这么排的话，全图最大的那几十个地物
          （学知苑宿舍群、富士康厂房）会先把名额占满，而她眼前那条路一个字都没有。
       ② 每类给个配额——校园里一屏能塞下八十个有名字的楼，
          纯按优先级排就会变成一片「学知苑N栋」，路名全被挤掉。 */
    const CAP = [5, 4, 6, 3, 2];             // 水系绿地 / 大路 / 楼 / 小路 / 轨道
    const used = [0, 0, 0, 0, 0];
    const live = pool.filter((l) => span <= l.minSpan)
      .sort((a, b) => a.prio - b.prio ||
        Math.hypot(a.X - center.x, a.Y - center.y) - Math.hypot(b.X - center.x, b.Y - center.y));
    for (const l of live) {
      if (used[l.prio] >= CAP[l.prio]) continue;
      const [x, y] = toScreen(l.X, l.Y);
      const fs = px(l.style.size);
      const w = textW(l.name, fs) + px(6), h = fs * 1.25;
      if (x < VX0 + w / 2 || x > VX1 - w / 2 || y < VY0 + h || y > VY1 - h) {
        l.node.style.display = "none"; continue;
      }
      let hit = false;
      for (let gx = Math.floor((x - w / 2) / CELL); gx <= Math.floor((x + w / 2) / CELL) && !hit; gx++)
        for (let gy = Math.floor((y - h / 2) / CELL); gy <= Math.floor((y + h / 2) / CELL); gy++)
          if (grid.has(gx + "," + gy)) { hit = true; break; }
      if (hit) { l.node.style.display = "none"; continue; }
      for (let gx = Math.floor((x - w / 2) / CELL); gx <= Math.floor((x + w / 2) / CELL); gx++)
        for (let gy = Math.floor((y - h / 2) / CELL); gy <= Math.floor((y + h / 2) / CELL); gy++)
          grid.add(gx + "," + gy);
      used[l.prio]++;
      l.node.style.display = "";
      l.node.setAttribute("x", l.X.toFixed(1));
      l.node.setAttribute("y", l.Y.toFixed(1));
      l.node.setAttribute("font-size", (px(l.style.size) / k).toFixed(3));
      l.node.setAttribute("stroke-width", (px(3.4) / k).toFixed(3));
      l.node.setAttribute("transform", l.ang
        ? `rotate(${l.ang.toFixed(1)} ${l.X.toFixed(1)} ${l.Y.toFixed(1)})` : "");
    }

    // 四边留白不一样：下边要躲开「我到了，拍照」那颗大按钮
    const PADX = 40, PADT = 40, PADB = 100;
    const off = px_ < VX0 + PADX || px_ > VX1 - PADX || py_ < VY0 + PADT || py_ > VY1 - PADB;

    let ax = px_, ay = py_;
    if (off) {
      /* 从画面中心沿真实方位射出去，打到可视边框为止。
         分别夹 x 和 y 会把方向压歪——东北方向的目标被夹到角上，看着像正 45°。 */
      const dx = px_ - W / 2, dy = py_ - VY1 / 2;
      const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
      const tx = ux > 0 ? (VX1 - PADX - W / 2) / ux : ux < 0 ? (VX0 + PADX - W / 2) / ux : Infinity;
      const ty = uy > 0 ? (VY1 - PADB - VY1 / 2) / uy : uy < 0 ? (VY0 + PADT - VY1 / 2) / uy : Infinity;
      const t = Math.min(tx, ty);
      ax = W / 2 + ux * t;
      ay = VY1 / 2 + uy * t;
      // 线索卡和雷达盘压在地图上，箭头钻到下面去就等于没有——推到最近的边外
      for (const [x0, y0, x1, y1] of blks) {
        if (ax <= x0 - 10 || ax >= x1 + 10 || ay <= y0 - 10 || ay >= y1 + 10) continue;
        let best = null;
        for (const [cx, cy] of [[x0 - 10, ay], [x1 + 10, ay], [ax, y0 - 10], [ax, y1 + 10]]) {
          const px2 = clamp(cx, VX0 + PADX, VX1 - PADX);
          const py2 = clamp(cy, VY0 + PADT, VY1 - PADB);
          const d = Math.hypot(px2 - ax, py2 - ay);
          if (!best || d < best[2]) best = [px2, py2, d];
        }
        ax = best[0]; ay = best[1];
      }
      pinFar.setAttribute("transform",
        `translate(${ax.toFixed(1)} ${ay.toFixed(1)}) rotate(${(Math.atan2(py_ - VY1 / 2, px_ - W / 2) * 180 / Math.PI).toFixed(1)})`);
    }
    pinFar.style.display = off ? "" : "none";
    pinNear.style.display = off ? "none" : "";
    pinNear.setAttribute("transform", `translate(${px_} ${py_})`);

    if (meFix) {
      const [mx_, my_] = toScreen(meFix._X, meFix._Y);
      me.setAttribute("transform", `translate(${mx_} ${my_})`);
      me.style.display = "";
      // 指路虚线。热的时候亮一点——地图和雷达说的是同一件事，不该各说各的。
      link.setAttribute("d", `M ${mx_} ${my_} L ${ax.toFixed(1)} ${ay.toFixed(1)}`);
      link.setAttribute("opacity", (0.25 + clamp(signal, 0, 1) * 0.55).toFixed(2));
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

  function toScreen(X, Y) {
    return [X * t2s.k + W / 2 - center.x * t2s.k,
            Y * t2s.k + t2s.cy - center.y * t2s.k];
  }

  const repaint = () => draw(lastArgs);
  const clampCenter = () => {
    // 别让她一手指把地图推到没有数据的地方，然后以为是坏了
    center.x = clamp(center.x, -20000, 20000);
    center.y = clamp(center.y, -20000, 20000);
  };

  /* ---- 拖动平移 / 双指缩放 ----
     用 pointer 事件而不是 touch：iOS 上 pointer 事件带 pointerId，
     两指各算各的，不用自己维护 touch 列表。 */
  const pts = new Map();
  let rect = null, pinchIds = null, pinchD0 = 0, span0 = 0;

  mount.addEventListener("pointerdown", (e) => {
    if (!pts.size) rect = mount.getBoundingClientRect();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) setFollow(false);
    if (pts.size === 2) {
      pinchIds = [...pts.keys()];
      const [a, b] = pinchIds.map((i) => pts.get(i));
      pinchD0 = Math.hypot(a.x - b.x, a.y - b.y);
      span0 = span;
    }
    // 合成事件（测试台）里的 pointerId 没有真实指针，会抛 NotFoundError。
    // 抓不住就算了，指针留在元素内一样收得到 move。
    try { mount.setPointerCapture(e.pointerId); } catch {}
  });

  mount.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (pts.size === 1) {
      // 手指往右拖，地图跟着往右走，所以视野中心是往左挪
      center.x -= dx / t2s.cpm;
      center.y -= dy / t2s.cpm;
      clampCenter();
    } else if (pinchIds && pts.size >= 2) {
      /* 缩放要用「起始距离 ÷ 当前距离」这种绝对算法，不能每帧拿上一次的结果连乘——
         两根手指各发各的 pointermove，连乘会把同一段位移算两遍
         （实测：捏合放大，结果视野从 1300 米被推到 4876 米）。 */
      const [a, b] = pinchIds.map((i) => pts.get(i));
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD0 > 0 && d > 0) {
        const next = clamp(span0 * pinchD0 / d, 80, 8000);
        if (next !== span) {
          // 把两指中点底下的那个地点钉住，缩放手感才跟在指头上（不然会从中心往外窜）
          const cx = (a.x + b.x) / 2 - rect.left, cy2 = (a.y + b.y) / 2 - rect.top;
          const wxp = center.x + (cx - t2s.cw / 2) / t2s.cpm;
          const wyp = center.y + (cy2 - t2s.ch / 2) / t2s.cpm;
          span = next;
          const cpm2 = t2s.cw / span;
          center.x = wxp - (cx - t2s.cw / 2) / cpm2;
          center.y = wyp - (cy2 - t2s.ch / 2) / cpm2;
          clampCenter();
        }
      }
    }
    repaint();
  });

  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchIds = null;
  };
  mount.addEventListener("pointerup", lift);
  mount.addEventListener("pointercancel", lift);
  mount.addEventListener("pointerleave", lift);

  return {
    draw, toScreen, repaint, wx, wy, W, H, svg,
    get spanM() { return span; },
    get following() { return follow; },
    onFollow(fn) { onFollow = fn; },
    // 回到「以我为中心」。立即重画一帧，不等下一个定位点。
    followMe() { setFollow(true); repaint(); },
  };
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
