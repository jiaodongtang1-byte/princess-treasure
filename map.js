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
const PAPER = "#F7EEDD";              // 地面：绘本扉页的纸色。标签光晕跟它同色，否则字周围一圈色块

/* 纸上水彩绘本。水彩感拆成几样廉价近似，一个 filter 都不用（WebKit 里 filter 会糊、会整图消失）：
   边缘积色 = 比填充深的半透明描边；罩染 = 同一块几何错位再画一遍；纸 = 地面上几百块淡色水渍 + 四边积色。
   没做纸纹噪点：整屏噪点固定层在 WebKit 测试台上拖图每帧多 18 ms（软件合成，真机未测）。
   路一律比地亮（白），描边比地深。把路的填充设成跟底色接近的米色，路就整个消失了。
   [正则, 路宽, 填充, 外边, 外边宽, 虚线] ——步行道没有填充，画成一串圆点小径 */
const ROAD = [
  [/^(motorway|trunk)$/,                         7.5, "#FFFDF8", "#C4A77A", 2.4],
  [/^(primary)$/,                                6.4, "#FFFDF8", "#C4A77A", 2.2],
  [/^(secondary)$/,                              5.2, "#FFFDF8", "#C4A77A", 2.0],
  [/^(tertiary)$/,                               4.0, "#FFFDF8", "#C4A77A", 1.7],
  [/^(residential|unclassified|living_street)$/, 2.7, "#FFFDF8", "#D2BC98", 1.3],
  [/^(pedestrian|service)$/,                     2.1, "#FFFDF8", "#D2BC98", 1.1],
  [/^(footway|path|cycleway)$/,                  2.2, null,      "#C3AC84", 0, "0.1 5.5"],
  [/^(steps)$/,                                  2.6, null,      "#BFA67C", 0, "2.2 2"],
];
const BUILDING_FILL = ["#EBD9C3", "#EAD3CC", "#E4D5E4"];   // 第三色偏丁香紫，不用灰蓝——灰蓝的楼会被读成水面
const GREEN = { park: "#CFE3C0", forest: "#BFD9AE", grass: "#DCEBCB" };

function roadStyle(h) {
  h = h.replace(/_link$/, "");                   // 匝道按主路画，原先整条被丢掉
  for (let i = 0; i < ROAD.length; i++) {
    const [re, w, fill, stroke, sw, dash] = ROAD[i];
    if (re.test(h)) return { i, w, fill, stroke, sw, dash };
  }
  return null;
}
// proposed 是没建成的线（34.9 公里穿城），platform 是站台面——都不该画成轨道
const RAILS = /^(rail|light_rail|subway|tram|narrow_gauge|monorail)$/;

/* 种子伪随机（mulberry32）：每站重建地图时，树和花长在同一个地方，不跳位 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 名字的优先级与样式。0 最先抢位置——抢不到就整个不画，宁可少也不要糊成一团。
   颜色按地物性质分：水系蓝、绿地绿、路名棕、楼名深棕。 */
const LANDMARK = { size: 13,   fill: "#557546", weight: 600, ls: 0.12 };   // 公园/广场/河
const WATER    = { size: 12.5, fill: "#3E6A80", weight: 600 };
const BUILDING = { size: 11.5, fill: "#6B5A44", weight: 600 };
const ROAD_BIG = { size: 11.5, fill: "#7A6A52", weight: 600 };
const ROAD_SML = { size: 10.5, fill: "#857255", weight: 500 };
const RAIL     = { size: 10,   fill: "#776C92", weight: 500 };

/* 四角星（信物旁的金色闪光），单位半径，用 scale 缩放 */
const STAR = "M0-1C.15-.15 .15-.15 1 0C.15 .15 .15 .15 0 1C-.15 .15-.15 .15-1 0C-.15-.15-.15-.15 0-1Z";

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
      // 要往小档换，得明显小于当前档才换（迟滞 25%）。没到门槛时只退到目标档的上一档，
      // 不能整个退回 current——否则在信物旁打开地图（current=1300）会永远卡在最远档
      if (current && s < current && needM > s * 0.75) return Math.min(current, SPANS[SPANS.indexOf(s) + 1] ?? current);
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

  // 当前国度的正色：app.js 进站时先设 --kc 再建图，这里直接读，不改调用签名
  const KC = getComputedStyle(document.documentElement).getPropertyValue("--kc").trim() || GOLD;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid slice",
                          class: "map-svg" });
  svg.appendChild(el("rect", { x: -30000, y: -30000, width: 60000, height: 60000,
                               fill: PAPER }));

  const gWorld = el("g", { class: "world" });
  const gGround = el("g", {}), gWater = el("g", {}), gDeco = el("g", {}), gBld = el("g", {});
  const gRoad = el("g", {}), gRoadTop = el("g", {});
  const gLabel = el("g", { class: "labels" });

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
                              "paint-order": "stroke", stroke: PAPER,
                              ...(style.ls ? { "letter-spacing": style.ls + "em" } : {}),
                              "stroke-width": 3.4, "stroke-linejoin": "round",
                              "font-family": "PingFang SC, Hiragino Sans GB, sans-serif" });
    node.textContent = name;
    gLabel.appendChild(node);
    pool.push({ node, name, X, Y, style, ang: ang || 0, prio,
                // 屏幕占比小于 8% 的地物，缩远了就不给它名字，否则满屏小字
                minSpan: clamp(sizeM / 0.08, 0, 6000) });
  }

  /* ---- 几何：按「样式 × 500 米分块」合并成大 path，只建一次 ----
     两头都不能走极端（WebKit 2x 实测）：
     · 一个要素一条 path（原版 1600 节点）：父组 transform 一变全部重新布局，JS 每帧 8 ms；
     · 整张图一种样式一条 path：节点只剩 200，但画面外的部分没法按包围盒跳过，
       每帧整条重新描边、重新算虚线（16 公里的轨枕虚线、300 条圆点小径），帧间隔反而多 30~60 ms。
     按块合并：节点几百，画面外的块整块跳过。线按「每段中点落在哪块」切开，切口是两个圆头，看不出来。
     Overpass 会把穿城的河、高速整条返回（数据外包框 27×15 公里），离有楼有绿地的那片超过 800 米的线段不画，
     否则光一条清水河就切出几十块。 */
  const CH = 700;
  const f1 = (v) => v.toFixed(1);
  const pt = ([x, y]) => f1(x) + " " + f1(y);
  const ptsOf = (f) => f.g.map((p) => [wx(p[1]), wy(p[0])]);
  const circ = (x, y, r) => `M${f1(x - r)} ${f1(y)}a${f1(r)} ${f1(r)} 0 1 0 ${f1(2 * r)} 0a${f1(r)} ${f1(r)} 0 1 0 ${f1(-2 * r)} 0`;

  const D = new Map();                             // 样式键 → (块 → path 数据)
  const add = (k, x, y, s, ch = CH) => {
    const c = Math.floor(x / ch) + "," + Math.floor(y / ch);
    let m = D.get(k);
    if (!m) D.set(k, (m = new Map()));
    m.set(c, (m.get(c) || "") + s);
  };
  const addRing = (k, q, ch) => add(k, q[0][0], q[0][1], "M" + q.map(pt).join("L") + "Z", ch);
  let WX0 = 1e9, WY0 = 1e9, WX1 = -1e9, WY1 = -1e9;              // 有面状数据的那片，外扩 800 米
  for (const f of geo) {
    if (!(f.t.building || f.t.landuse || f.t.leisure || f.t.natural)) continue;
    const [x0, y0, x1, y1] = bbox(f);
    WX0 = Math.min(WX0, x0 - 800); WY0 = Math.min(WY0, y0 - 800);
    WX1 = Math.max(WX1, x1 + 800); WY1 = Math.max(WY1, y1 + 800);
  }
  const addLine = (k, q) => {
    let cur = null, d = "", cx = 0, cy = 0;
    for (let i = 1; i < q.length; i++) {
      const [ax, ay] = q[i - 1], [bx, by] = q[i];
      // 两端在窗口同一侧之外才丢（穿过窗口的长段照画）
      if ((ax < WX0 && bx < WX0) || (ax > WX1 && bx > WX1) || (ay < WY0 && by < WY0) || (ay > WY1 && by > WY1)) {
        if (cur !== null) add(k, cx, cy, d);
        cur = null;
        continue;
      }
      const mx = (q[i - 1][0] + q[i][0]) / 2, my = (q[i - 1][1] + q[i][1]) / 2;
      const c = Math.floor(mx / CH) + "," + Math.floor(my / CH);
      if (c !== cur) {
        if (cur !== null) add(k, cx, cy, d);
        cur = c; cx = mx; cy = my; d = "M" + pt(q[i - 1]);
      }
      d += "L" + pt(q[i]);
    }
    if (cur !== null) add(k, cx, cy, d);
  };
  /** 把一个样式键的所有块落成 path */
  const put = (g, k, a) => {
    for (const d of D.get(k)?.values() || [])
      g.appendChild(el("path", { d, "vector-effect": "non-scaling-stroke", ...a }));
  };

  /** 统一环的方向：同样式的面合并成一条 path 时，反向的环在 nonzero 规则下会把重叠处挖成洞 */
  function orient(q) {
    let a = 0;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) a += (q[j][0] - q[i][0]) * (q[j][1] + q[i][1]);
    return a < 0 ? q.reverse() : q;
  }
  /** 手绘感：长边细分、法向抖动 ≤1.2 米、Chaikin 切角 ≤2.5 米。只给楼、绿地、水面——
      路不动：GNSS 静止误差才 ±5 米，路一抖「我」就落不到路上 */
  function soft(q, rand) {
    if (q.length > 2 && q[0][0] === q.at(-1)[0] && q[0][1] === q.at(-1)[1]) q = q.slice(0, -1);
    const s = [];
    for (let i = 0; i < q.length; i++) {
      const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % q.length];
      const L = Math.hypot(x1 - x0, y1 - y0) || 1, n = Math.ceil(L / 12);
      for (let j = 0; j < n; j++) {
        const o = (rand() * 2 - 1) * 1.2;
        s.push([x0 + (x1 - x0) * j / n - (y1 - y0) / L * o, y0 + (y1 - y0) * j / n + (x1 - x0) / L * o]);
      }
    }
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const [x0, y0] = s[i], [x1, y1] = s[(i + 1) % s.length];
      const c = Math.min(0.25, 2.5 / (Math.hypot(x1 - x0, y1 - y0) || 1));
      out.push([x0 + (x1 - x0) * c, y0 + (y1 - y0) * c], [x1 - (x1 - x0) * c, y1 - (y1 - y0) * c]);
    }
    return out;
  }
  function inPoly(x, y, q) {
    let hit = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++)
      if ((q[i][1] > y) !== (q[j][1] > y) &&
          x < (q[j][0] - q[i][0]) * (y - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) hit = !hit;
    return hit;
  }

  const greens = [], waters = [], holes = [];      // 撒树撒花用：能撒的、撒水纹的、不许撒的（楼/水/球场）
  let bi = 0;
  geo.forEach((f, idx) => {
    const t = f.t, rand = rng(idx + 1);
    if (t.landuse || t.leisure) {
      const q = ptsOf(f), s = orient(soft(q, rand));
      const kind = t.landuse === "forest" ? "forest" : t.leisure === "park" ? "park" : "grass";
      addRing("g_" + kind, s);
      addRing("gwash", s);
      (/^(pitch|stadium|sports_centre|track)$/.test(t.leisure || "") ? holes : greens)
        .push({ q, box: bbox(f), kind });
    } else if (t.natural === "water") {
      const q = ptsOf(f);
      addRing("water", orient(soft(q, rand)));
      waters.push({ q, box: bbox(f) });
      holes.push({ q, box: bbox(f) });
    } else if (t.waterway) {
      // 河道是折线：不能带填充，SVG 会把它隐式闭合成大片假水面（清水河闭合后 14×13 公里）
      if (t.waterway === "dam") return;
      const q = ptsOf(f);
      addLine(/^(river|canal)$/.test(t.waterway) ? "ww0" : /^(drain|ditch)$/.test(t.waterway) ? "ww2" : "ww1", q);
      if (!t.tunnel && !/^(drain|ditch)$/.test(t.waterway)) addLine("glint", q);
    } else if (t.building) {
      const q = ptsOf(f);
      addRing("b" + (bi++ % 3), orient(soft(q, rand)));
      holes.push({ q, box: bbox(f) });
    } else if (t.barrier === "wall") {
      addLine("wall", ptsOf(f));
    } else if (t.railway && RAILS.test(t.railway)) {
      addLine("rail", ptsOf(f));
    }
  });

  // 路：先所有桥的垫底，再所有外边，最后所有填充——交叉口才不会互相盖出毛刺
  for (const f of geo) {
    const t = f.t, s = t.highway && roadStyle(t.highway);
    if (!s) continue;
    if (t.area === "yes") { addRing("plaza", ptsOf(f)); continue; }    // 步行广场是面，不是线
    const q = ptsOf(f), tun = t.tunnel && t.tunnel !== "no" ? "t" : "";
    if (t.bridge === "yes") addLine("rb" + s.i, q);
    addLine("rc" + tun + s.i, q);
    if (s.fill) addLine("rf" + tun + s.i, q);
  }

  /* 撒点：全局抖动网格（不按单块采样，公园和草地重叠处不会撒两遍）+ 点在多边形内 + 剔除 25%。
     种子取网格坐标，每站重建都长在同一处。 */
  function scatter(list, step, salt, fn, avoid = true) {
    const seen = new Set();
    for (const g of list) {
      const [x0, y0, x1, y1] = g.box;
      for (let ix = Math.floor(x0 / step); ix <= Math.floor(x1 / step); ix++)
        for (let iy = Math.floor(y0 / step); iy <= Math.floor(y1 / step); iy++) {
          const key = ix + "," + iy;
          if (seen.has(key)) continue;
          const r = rng(Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ salt);
          const x = (ix + r()) * step, y = (iy + r()) * step;
          if (!inPoly(x, y, g.q)) continue;
          seen.add(key);
          if (r() < 0.25) continue;
          if (avoid && holes.some((h) => x > h.box[0] && x < h.box[2] && y > h.box[1] && y < h.box[3] &&
                                         inPoly(x, y, h.q))) continue;
          fn(x, y, r);
        }
    }
  }
  const of = (k) => greens.filter((g) => g.kind === k);

  // 水彩树：亮面一层；暗面错位、缩小再罩一层。封顶 2600 棵
  let nTree = 0;
  const tree = (x, y, r) => {
    if (nTree++ > 2600) return;
    const R = 5.5 + r() * 1.5;
    add("treeL", x, y, circ(x, y, R));
    add("treeD", x, y, circ(x + 1.8, y + 1.8, R * 0.7));
  };
  scatter(of("forest"), 16, 11, tree);
  scatter(of("park"), 26, 23, tree);

  // 花：一律 5 个等大圆点的梅花（大小不一的三点会拼出某只老鼠的剪影）。信物 280 米内开国度色
  let nFlower = 0;
  const flower = (x, y, r) => {
    const k = "fl" + (Math.hypot(x, y) < 280 ? 2 : nFlower++ % 2), a0 = r() * 1.26;
    let d = "";
    for (let j = 0; j < 5; j++) d += circ(x + Math.cos(a0 + j * 1.2566) * 2.2, y + Math.sin(a0 + j * 1.2566) * 2.2, 1.5);
    add(k, x, y, d);
  };
  scatter(of("grass"), 22, 37, flower);
  scatter(of("park"), 40, 53, flower);

  // 水面上的小波光
  scatter(waters, 16, 61, (x, y) => add("ripple", x, y, `M${f1(x - 3)} ${f1(y)}q3 -1.6 6 0`), false);

  /* 纸上晕开的颜料：只在有数据的那片地上，按 120 米抖动网格落几百块不规则的淡色水渍。
     颜色只取纸的暖调（不用绿、不用蓝），免得被读成公园或水面。 */
  let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  for (const h of [...greens, ...holes]) {
    bx0 = Math.min(bx0, h.box[0]); by0 = Math.min(by0, h.box[1]);
    bx1 = Math.max(bx1, h.box[2]); by1 = Math.max(by1, h.box[3]);
  }
  for (let ix = Math.floor((bx0 - 300) / 120); ix <= Math.floor((bx1 + 300) / 120); ix++)
    for (let iy = Math.floor((by0 - 300) / 120); iy <= Math.floor((by1 + 300) / 120); iy++) {
      const r = rng(Math.imul(ix, 83492791) ^ Math.imul(iy, 2654435761) ^ 71);
      if (r() < 0.35) continue;
      const cx = (ix + r()) * 120, cy = (iy + r()) * 120, R = 38 + r() * 46;
      let q = [];
      for (let j = 0; j < 9; j++) {
        const a = (j + r() * 0.5) / 9 * Math.PI * 2, rr = R * (0.7 + r() * 0.45);
        q.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
      for (let it = 0; it < 2; it++)
        q = q.flatMap(([x0, y0], i) => {
          const [x1, y1] = q[(i + 1) % q.length];
          return [[x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]];
        });
      addRing("blot" + ((ix * 7 + iy * 3) & 0x7fffffff) % 3, q, 1600);       // 纯填充、便宜，块分大些省节点
    }

  /* ---- 按图层落盘。能用 fill-opacity 就不用 opacity（后者在 WebKit 里每个元素开一块离屏层） ---- */
  put(gGround, "blot0", { fill: "#E9D3AE", "fill-opacity": 0.18 });
  put(gGround, "blot1", { fill: "#EFC9C0", "fill-opacity": 0.16 });
  put(gGround, "blot2", { fill: "#E2D9BD", "fill-opacity": 0.18 });
  // 二次晕染：所有绿地错位 1.5 米再垫一层，做出套色没对准的错位感
  put(gGround, "gwash", { fill: "#A9CF95", "fill-opacity": 0.22, transform: "translate(1.5 -1)" });
  for (const k of ["park", "forest", "grass"])
    put(gGround, "g_" + k, { fill: GREEN[k], stroke: "#9CC28A", "stroke-width": 2.4, "stroke-opacity": 0.5,
                             "stroke-linejoin": "round" });

  put(gWater, "water", { fill: "#BFDDE8", "fill-opacity": 0.9, stroke: "#8DBBD0", "stroke-width": 2.8,
                         "stroke-opacity": 0.55, "stroke-linejoin": "round" });
  [9, 5, 3.4].forEach((w, i) => put(gWater, "ww" + i, { fill: "none", stroke: "#9CCBDD", "stroke-width": w,
                                                         "stroke-linecap": "round", "stroke-linejoin": "round" }));
  put(gWater, "glint", { fill: "none", stroke: "#FFFFFF", "stroke-width": 1.2, "stroke-opacity": 0.7,
                         "stroke-dasharray": "1 14", "stroke-linecap": "round" });
  put(gWater, "ripple", { fill: "none", stroke: "#FFFFFF", "stroke-width": 1.4, "stroke-opacity": 0.8,
                          "stroke-linecap": "round" });

  // 当前国度的领地：280 米圈（三站相距 700~930 米，互不重叠）。外面一圈宽而极淡的光晕
  gDeco.appendChild(el("path", { d: circ(0, 0, 280), fill: KC, "fill-opacity": 0.06, stroke: KC,
    "stroke-width": 14, "stroke-opacity": 0.07, "vector-effect": "non-scaling-stroke" }));
  gDeco.appendChild(el("path", { d: circ(0, 0, 280), fill: "none", stroke: KC, "stroke-width": 1.6,
    "stroke-opacity": 0.45, "stroke-dasharray": "2 6", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
  put(gDeco, "treeL", { fill: "#A9CC95", "fill-opacity": 0.6 });
  put(gDeco, "treeD", { fill: "#8DB77A", "fill-opacity": 0.38 });
  put(gDeco, "fl0", { fill: "#EBB7C5", "fill-opacity": 0.85 });
  put(gDeco, "fl1", { fill: "#F2D98E", "fill-opacity": 0.85 });
  put(gDeco, "fl2", { fill: KC, "fill-opacity": 0.75 });

  BUILDING_FILL.forEach((c, i) => put(gBld, "b" + i, { fill: c, stroke: "#B79C7E", "stroke-width": 1.2,
                                                       "stroke-opacity": 0.75, "stroke-linejoin": "round" }));
  put(gBld, "wall", { fill: "none", stroke: "#CDB89A", "stroke-width": 1.8, "stroke-linecap": "round",
                      "stroke-linejoin": "round" });

  put(gRoad, "plaza", { fill: "#FFFBF2", stroke: "#D2BC98", "stroke-width": 1.2, "stroke-linejoin": "round" });
  ROAD.forEach(([, w, fill, , sw], i) => put(gRoad, "rb" + i, { fill: "none", stroke: "#C9B08A",
    "stroke-width": (fill ? w + sw * 2 : w) + 3, "stroke-linejoin": "round" }));
  ROAD.forEach(([, w, fill, stroke, sw, dash], i) => {
    // 圆点小径用圆头，台阶的短横用平头（圆头会把短横连成一条实线）
    const a = { fill: "none", stroke, "stroke-width": fill ? w + sw * 2 : w, "stroke-linejoin": "round",
                "stroke-linecap": dash && !dash.startsWith("0.1") ? "butt" : "round",
                ...(dash ? { "stroke-dasharray": dash } : {}) };
    put(gRoad, "rc" + i, a);
    put(gRoad, "rct" + i, { ...a, "stroke-dasharray": dash || "4 3", "stroke-opacity": dash ? 0.5 : 1 });
  });
  ROAD.forEach(([, w, fill], i) => {
    if (!fill) return;
    const a = { fill: "none", stroke: fill, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" };
    put(gRoadTop, "rf" + i, a);
    put(gRoadTop, "rft" + i, { ...a, "stroke-opacity": 0.6 });
  });
  // 轨道压在路面上（成都的有轨电车走路中间），再叠一层短横当枕木
  put(gRoadTop, "rail", { fill: "none", stroke: "#9A8FB5", "stroke-width": 2, "stroke-linejoin": "round" });
  put(gRoadTop, "rail", { fill: "none", stroke: "#9A8FB5", "stroke-width": 6, "stroke-opacity": 0.7,
                          "stroke-dasharray": "1.2 8" });

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

  gWorld.append(gGround, gWater, gDeco, gBld, gRoad, gRoadTop, gLabel);
  svg.appendChild(gWorld);

  // 浮层用屏幕坐标，每次重算：轨迹、指路虚线、信物、「你在这」
  const gOver = el("g", { class: "overlay" });
  const trail = el("path", { fill: "none", stroke: GOLD, "stroke-width": 3,
                             "stroke-dasharray": "1.5 9", "stroke-linecap": "round",
                             opacity: .55 });
  const link = el("path", { fill: "none", stroke: GOLD, "stroke-width": 2,
                            "stroke-dasharray": "7 7", opacity: .45 });

  // 信物在画面里：金色别针 + 国度色宝石 + 三颗金色四角星
  const pinNear = el("g", { class: "pin-near" });
  pinNear.innerHTML = `<circle r="17" fill="${GOLD}" fill-opacity=".15"/>
    <circle r="9" fill="#FFFBF4" stroke="${GOLD}" stroke-width="2.6"/>
    <circle r="3.6" fill="${KC}"/>
    ${[[16, -13, 5.5], [-15, -10, 4], [10, 15, 3.4]].map(([x, y, r]) =>
      `<path d="${STAR}" transform="translate(${x} ${y}) scale(${r})" fill="${GOLD}"/>`).join("")}`;

  // 信物在画面外：贴边一个箭头指着它，方向比位置重要。外面一圈国度色虚线
  const pinFar = el("g", { class: "pin-far" });
  pinFar.innerHTML = `<circle r="20" fill="none" stroke="${KC}" stroke-width="1.6" stroke-opacity=".6"
      stroke-dasharray="2 4" stroke-linecap="round"/>
    <circle r="15" fill="#FFFBF4" stroke="${GOLD}" stroke-width="2.4"/>
    <path d="M -3.5 -6 L 5 0 L -3.5 6 Z" fill="${GOLD}"/>`;

  // 当前国度的塔：单座、不对称（旗子偏一边）、上方不画光弧——通用童话元素，不是哪家的城堡标志。
  // 屏幕坐标、大小恒定，立在领地圈最北点 → 所以只在她位于信物北侧时进画面（横屏约 150~620 米，
  // 竖屏 40~900 米）；贴近信物时由领地圈底色和国度色的花接替。出画是地图常态，不是坏了
  const tower = el("g", { class: "tower" });
  tower.innerHTML = `<path d="M-8 0V-26H8V0Z" fill="#FFFBF4" stroke="#B79C7E" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M-11 -26L0 -46L11 -26Z" fill="${KC}" fill-opacity=".38" stroke="#B79C7E" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M0 -46V-56L9 -52L0 -48Z" fill="${KC}" stroke="${KC}" stroke-width="1" stroke-linejoin="round"/>
    <path d="M-3.5 0V-7A3.5 3.5 0 0 1 3.5 -7V0" fill="none" stroke="#B79C7E" stroke-width="1.4"/>
    <path d="M-4.5 -15V-19.5A1.6 1.6 0 0 1 -1.3 -19.5V-15Z" fill="#B79C7E"/>`;

  // 「我」：外面那圈跟着定位精度变大——信号弱时她看得见是定位飘了，不是雷达坏了
  const me = el("g", {});
  me.innerHTML = `<circle r="20" fill="#2B2F3C" fill-opacity=".07" stroke="#2B2F3C" stroke-opacity=".18" stroke-width="1"/>
    <circle r="9" fill="#FFFBF4" stroke="#2B2F3C" stroke-width="2.6"/>
    <circle r="3.4" fill="#2B2F3C"/>`;
  const accRing = me.firstElementChild;
  // 朝向扇形：罗盘告诉我们她面朝哪边。转身时跟着转，对准那条金色虚线就是对准了礼物
  const cone = el("path", { d: "M0 0L-17 -50A53 53 0 0 1 17 -50Z", fill: KC, "fill-opacity": 0.3 });
  cone.style.display = "none";
  me.insertBefore(cone, accRing.nextSibling);
  gOver.append(tower, link, trail, pinNear, pinFar, me);
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
  const BLOCK_ARROW = [".cluecard", ".disc", ".map-cta", ".hud-hint", ".recenter"];
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
    t2s.cpm = cw / span; t2s.cw = cw; t2s.ch = ch;   // 手指换算：CSS px / 米。必须在换档之后算，否则下一次拖动用的是旧档

    const k = W / span;                          // viewBox 单位 / 米
    t2s.k = k; t2s.cy = VY1 / 2;
    gWorld.setAttribute("transform",
      `translate(${(W / 2 - center.x * k).toFixed(1)} ${(VY1 / 2 - center.y * k).toFixed(1)}) scale(${k.toFixed(6)})`);
    // 树和花按米画，视野再远就只剩一片噪点（自动跟随封顶 1300，只有手动缩放才会超过）
    const decoOn = span <= 1300;
    if (gDeco.style.display !== (decoOn ? "" : "none")) gDeco.style.display = decoOn ? "" : "none";

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
    // 塔先占位，标签绕开它；落在画面外或压在卡片/雷达盘底下就不画
    const [tx_, ty_] = toScreen(0, -280);
    const towerOn = decoOn && tx_ > VX0 + 24 && tx_ < VX1 - 24 && ty_ > VY0 + 76 && ty_ < VY1 - 8 &&
      !blks.some(([x0, y0, x1, y1]) => tx_ + 16 > x0 && tx_ - 16 < x1 && ty_ > y0 && ty_ - 70 < y1);
    tower.style.display = towerOn ? "" : "none";
    if (towerOn) {
      tower.setAttribute("transform", `translate(${tx_.toFixed(1)} ${ty_.toFixed(1)}) scale(1.2)`);
      mark(tx_, ty_ - 14); mark(tx_, ty_ - 40); mark(tx_, ty_ - 60);
    }

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
      const w = textW(l.name, fs) * (1 + (l.style.ls || 0)) + px(6), h = fs * 1.25;
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
    // 信物落在线索卡/雷达盘底下也算「看不见」，改用箭头——不然别针被卡片整个盖住，画面上什么都没有
    const inBlk = (x, y) => blks.some(([x0, y0, x1, y1]) => x > x0 - 10 && x < x1 + 10 && y > y0 - 10 && y < y1 + 10);
    const off = px_ < VX0 + PADX || px_ > VX1 - PADX || py_ < VY0 + PADT || py_ > VY1 - PADB || inBlk(px_, py_);

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
          // 浮层贴着屏幕边，往外推的候选会被夹回原位（距离 0，永远胜出）——那不算推出去
          if (px2 > x0 - 10 && px2 < x1 + 10 && py2 > y0 - 10 && py2 < y1 + 10) continue;
          const d = Math.hypot(px2 - ax, py2 - ay);
          if (!best || d < best[2]) best = [px2, py2, d];
        }
        if (best) { ax = best[0]; ay = best[1]; }
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
      accRing.setAttribute("r", clamp((meFix.acc || 0) * k, 20, 120).toFixed(1));
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

  /* 用 onpointerxxx 属性而不是 addEventListener：mount 是常驻节点，每站都会重建地图，
     属性赋值会顶掉上一张地图的处理函数；addEventListener 会一站叠一套，旧地图跟着白算。 */
  mount.onpointerdown = (e) => {
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
  };

  mount.onpointermove = (e) => {
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
  };

  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchIds = null;
  };
  mount.onpointerup = mount.onpointercancel = mount.onpointerleave = lift;

  return {
    draw, toScreen, repaint, wx, wy, W, H, svg,
    get spanM() { return span; },
    get following() { return follow; },
    onFollow(fn) { onFollow = fn; },
    // 回到「以我为中心」。立即重画一帧，不等下一个定位点。
    // span 清零：双指缩放过的比例不算数，按当前距离重新挑档（否则迟滞会把手动比例一直留着）
    followMe() { span = 0; setFollow(true); repaint(); },
    // 地图北朝上，所以罗盘读数直接就是旋转角。每 0.1 秒调一次，只改一个属性，不重画
    setFacing(h) {
      if (h === null) { if (cone.style.display !== "none") cone.style.display = "none"; return; }
      cone.style.display = "";
      cone.setAttribute("transform", `rotate(${Math.round(h)})`);
    },
  };
}

/* ------------------------------------------------------------------ 雷达盘
   右下角那个圆。跟地图同一套信息，但只看方向和强弱，不被街道干扰。
   北上、你居中、信物是个亮点；扫过的针每次滴的时候走一下。 */

export function createRadarDisc(mount) {
  const S = 200, C = S / 2;
  const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, class: "disc-svg" });

  // 盘只建一次、三站共用，所以内环的国度色走 CSS 变量（--kc），进站换色时自己跟着变
  svg.appendChild(el("circle", { cx: C, cy: C, r: 96, fill: "#FFFBF4", "fill-opacity": .94 }));
  svg.appendChild(el("circle", { cx: C, cy: C, r: 88, fill: "none", style: "stroke:var(--kc)",
                                 "stroke-width": 7, "stroke-opacity": .08 }));
  svg.appendChild(el("circle", { cx: C, cy: C, r: 94, fill: "none", stroke: GOLD, "stroke-width": 1.6,
                                 "stroke-opacity": .85 }));
  for (const r of [62, 32]) {
    svg.appendChild(el("circle", { cx: C, cy: C, r, fill: "none", style: "stroke:var(--kc)",
                                   "stroke-width": 1.2, "stroke-opacity": .28, "stroke-dasharray": "2 4",
                                   "stroke-linecap": "round" }));
  }
  svg.appendChild(el("path", { d: `M${C} ${C - 94}V${C + 94}M${C - 94} ${C}H${C + 94}`, stroke: GOLD,
                               "stroke-width": 1, "stroke-opacity": .2 }));

  const nlab = el("text", { x: C, y: 17, "text-anchor": "middle", fill: GOLD, "font-size": 11,
                            "font-family": "PingFang SC, -apple-system, sans-serif", "font-weight": 600 });
  nlab.textContent = "北";
  svg.appendChild(nlab);

  // 每次滴的时候扩散一圈
  const pulse = el("circle", { cx: C, cy: C, r: 8, fill: "none", stroke: GOLD,
                               "stroke-width": 2.4, opacity: 0 });
  svg.appendChild(pulse);

  const sweep = el("line", { x1: C, y1: C, x2: C, y2: C - 90, stroke: GOLD,
                             "stroke-width": 2, "stroke-opacity": .6, "stroke-linecap": "round" });
  svg.appendChild(sweep);

  const blip = el("g", {});
  blip.innerHTML = `<circle r="10" fill="${GOLD}" fill-opacity=".16"/>
    <circle r="5" fill="${GOLD}"/><circle r="5" fill="none" stroke="#FFFBF4" stroke-width="1.6"/>`;
  svg.appendChild(blip);

  const you = el("g", {});
  you.innerHTML = `<circle r="4.5" fill="#2B2F3C"/><circle r="4.5" fill="none"
    stroke="#FFFBF4" stroke-width="1.8"/>`;
  you.setAttribute("transform", `translate(${C} ${C})`);
  svg.appendChild(you);

  const num = el("text", { x: C, y: C + 46, "text-anchor": "middle", fill: "#2B2F3C",
                           "font-size": 21, "font-weight": 600, class: "disc-dist",
                           "font-family": "ui-rounded, SF Pro Rounded, -apple-system, sans-serif" });
  svg.appendChild(num);
  const unit = el("text", { x: C, y: C + 62, "text-anchor": "middle", fill: "#6B6F7C",
                            "font-size": 10, "font-family": "PingFang SC, sans-serif" });
  unit.textContent = "米";
  svg.appendChild(unit);

  mount.replaceChildren(svg);

  let lastPulse = 0;
  let coarse = false;          // 近/中/远 模式带迟滞：精度在 50 米上下跳时别每秒切一次
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
      coarse = s.acc > (coarse ? 35 : 50);
      if (coarse) {
        // 精度差到几十米时报「37 米」是假精确，改说近/中/远
        num.textContent = s.dist < 60 ? "近" : s.dist < 300 ? "中" : "远";
        unit.style.display = "none";
      } else {
        num.textContent = s.dist < 1000 ? Math.round(s.dist) : (s.dist / 1000).toFixed(1);
        unit.textContent = s.dist < 1000 ? "米" : "公里";
      }

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
