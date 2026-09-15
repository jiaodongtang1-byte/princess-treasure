/* ============================================================================
   单一内容源。
   地点名、国度名、信物、线索、姿势提示、坐标、封面与终章文案，全部在下面。
   改内容只改这个文件，六屏跟着变——不要改 app.js 或 index.html 里的文案。
   ============================================================================ */

export const STORY = {
  cover: {
    kicker: "生 日 寻 宝",
    title: "公主的寻宝书",
    sub: "十月九日 · 三个国度 · 三件信物",
    button: "翻 开",
    footer: "写给 2026 年 10 月 9 日的你",
  },

  stations: [
    {
      id: "tianjie",
      real: "龙湖时代天街",
      coord: [30.754618, 103.920084],      // 信物所在地（OSM way/543806921 质心，待换成人能站准的点）
      kingdom: "灰姑娘的舞会",
      color: "#D98324",
      colorName: "舞会的金",
      emblem: "clock",
      blurb: "灯火、玻璃、十二点的钟。信物在光最亮的地方，不在最暗的地方。",

      clueTitle: "跟着光走，别跟着人走",
      clueBody: "出了旋转门往西，过了那道抬杆的门，左手边有排长椅。信物在第三张下面。",
      pose: "比一个心",
      relic: "玻璃鞋",
      relicText: "舞会散场时落下的那只。找到它的人，是被记住的人。",
      qr: "P41-TIANJIE",                   // 卡片二维码里编的字符串，扫到才认
      map: { file: "data/天街.json", spanM: 520 },
    },
    {
      id: "heyuan",
      real: "成都合院",
      coord: [30.746403, 103.918538],
      kingdom: "睡美人的蔷薇园",
      color: "#C05A78",
      colorName: "蔷薇的红",
      emblem: "rose",
      blurb: "有墙、安静、花底下藏着东西。走得慢一点，别看漏。",

      clueTitle: "（第二站的线索待定）",
      clueBody: "（待定）",
      pose: "（姿势待定）",
      relic: "（第二件信物待定）",
      relicText: "（待定）",
      qr: "P41-HEYUAN",
      map: { file: "data/合院.json", spanM: 520 },
    },
    {
      id: "zhulou",
      real: "电子科技大学清水河校区",
      coord: [30.749073, 103.925117],
      kingdom: "贝儿的书房",
      color: "#41618F",
      colorName: "书房的靛",
      emblem: "book",
      blurb: "书、灯、走过很多次的路。终章在这里。",

      clueTitle: "（第三站的线索待定）",
      clueBody: "（待定）",
      pose: "（姿势待定）",
      relic: "（第三件信物待定）",
      relicText: "（待定）",
      qr: "P41-ZHULOU",
      map: { file: "data/主楼.json", spanM: 520 },
    },
  ],

  final: {
    title: "三个国度都走完了",
    body: "三张照片在这里，一封信在下面。",
    button: "打开信",
    letter: "（终章的信还没写）",
  },

  /* 提示语。改这里不用动代码。 */
  ui: {
    clueKicker: (n, kingdom) => `第 ${["一", "二", "三"][n] || n + 1} 站 · ${kingdom}`,
    clueKickerShort: (n) => `线 索 · 其 ${["一", "二", "三"][n] || n + 1}`,
    clueButton: "带着这个线索出发",
    toCapture: "我到了，拍照",
    qrHint: "扫一扫礼物旁边的卡片",
    qrSkip: "卡片找不到，跳过",
    qrDone: "卡片已确证",
    shutterTip: "拍下来才算数 · 照片只存在这台 iPad 上",
    revealKicker: (n) => `第 ${["一", "二", "三"][n] || n + 1} 件 信 物`,
    revealButton: "收下，看下一个线索",
    revealLastButton: "收下，去看终章",
    photoLabel: "她拍的那张照片",
    scanning: "把卡片上的码对进框里",
    qrFail: "没认出来，再靠近一点、对准一点",
    noCamera: "打不开摄像头",
    noGeo: "拿不到定位——雷达先不响了，线索照样能走",
  },
};

/* 图标：名字 → SVG 内容。只给描边，颜色由外面传。 */
export const EMBLEM = {
  clock: '<circle cx="24" cy="26" r="15.5"/><path d="M24 10.5 V26" stroke-width="2.9" stroke-linecap="round"/><path d="M24 26 L30.6 19.4" stroke-width="1.7" stroke-linecap="round"/>',
  rose: '<circle cx="24" cy="14.5" r="6"/><circle cx="33.5" cy="21.5" r="6"/><circle cx="29.9" cy="32.5" r="6"/><circle cx="18.1" cy="32.5" r="6"/><circle cx="14.5" cy="21.5" r="6"/><circle cx="24" cy="24.5" r="3.4" fill="currentColor" stroke="none"/>',
  book: '<path d="M24 15.5 C20 12.4 12.5 12.2 8.5 14 V34.5 C12.5 32.7 20 32.9 24 36 C28 32.9 35.5 32.7 39.5 34.5 V14 C35.5 12.2 28 12.4 24 15.5 Z"/><path d="M24 15.5 V36"/>',
};

export function emblemSvg(key, color, cls) {
  return `<svg viewBox="0 0 48 48" fill="none" stroke="${color}" stroke-width="1.7"`
    + ` stroke-linejoin="round"${cls ? ` class="${cls}"` : ""}>${EMBLEM[key] || ""}</svg>`;
}

/* 雷达分档。2026-09-15 按实机 ±5 米（GNSS）收紧；精度差时由 radar.js 运行时放宽。 */
export const BANDS = [
  { key: "far",  maxM: Infinity, beatMs: 1200, label: "远" },
  { key: "mid",  maxM: 800,      beatMs: 500,  label: "中" },
  { key: "near", maxM: 250,      beatMs: 150,  label: "近" },
  { key: "here", maxM: 60,       beatMs: 0,    label: "到了" },
];

/* 迟滞：进档比出档靠内 20%，否则会在边界上疯狂来回切 */
export const HYSTERESIS = 0.2;
