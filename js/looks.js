// js/looks.js
// 影调（Look）预设定义 + 色彩工具函数。
// 新增影调只需往 LOOKS 数组追加一项，渲染管线与 UI 会自动适配。

/**
 * 色温(Kelvin) -> RGB 增益。
 * 基于 Tanner Helland 黑体近似算法，归一化到 [0,1]。
 * @param {number} kelvin
 * @returns {[number, number, number]}
 */
export function tempToRGB(kelvin) {
  const t = kelvin / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    if (t <= 19) {
      b = 0;
    } else {
      b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    }
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  r = Math.min(255, Math.max(0, r)) / 255;
  g = Math.min(255, Math.max(0, g)) / 255;
  b = Math.min(255, Math.max(0, b)) / 255;
  return [r, g, b];
}

/**
 * 影调预设列表。
 * 字段含义：
 *  - kind：'standard' 标准影调 | 'log' Log 影调（决定顶部 Log 徽标与配色）
 *  - matrix / offset / hue / temperature / contrast / saturation / exposure / grain / vignette：调色参数
 */
export const LOOKS = [
  {
    id: 'neutral',
    name: '中性',
    kind: 'standard',
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    offset: [0, 0, 0],
    hue: 0,
    temperature: 6500,
    contrast: 1.0,
    saturation: 1.0,
    exposure: 0,
    grain: 0.0,
    vignette: 0.0,
  },
  {
    id: 'macau',
    name: '标准·澳门',
    kind: 'standard',
    matrix: [1.05, 0, 0, 0, 1.0, 0, 0, 0, 0.92],
    offset: [0.02, 0, 0],
    hue: 0.02,
    temperature: 5600,
    contrast: 1.06,
    saturation: 1.25,
    exposure: 0,
    grain: 0.02,
    vignette: 0.12,
  },
  {
    id: 'cairo',
    name: '标准·开罗',
    kind: 'standard',
    matrix: [1.08, -0.02, 0, 0, 1, 0, -0.04, 0, 0.88],
    offset: [0.03, 0, 0],
    hue: 0.04,
    temperature: 5200,
    contrast: 1.22,
    saturation: 1.18,
    exposure: 0,
    grain: 0.03,
    vignette: 0.16,
  },
  // v1.5.3 新增：拉普兰（北欧冷调）
  {
    id: 'lapland',
    name: '标准·拉普兰',
    kind: 'standard',
    matrix: [0.94, 0, 0.02, 0, 1.0, 0, 0, 0.02, 1.1],
    offset: [-0.01, 0, 0.02],
    hue: -0.04,
    temperature: 6800,
    contrast: 1.1,
    saturation: 0.9,
    exposure: 0,
    grain: 0.03,
    vignette: 0.12,
  },
  // v1.5.3 新增：洛杉矶（青橙电影调）
  {
    id: 'losangeles',
    name: '标准·洛杉矶',
    kind: 'standard',
    matrix: [1.06, 0, -0.02, 0, 1.0, 0, -0.02, 0, 1.06],
    offset: [0.03, 0.01, -0.01],
    hue: 0.03,
    temperature: 5400,
    contrast: 1.12,
    saturation: 1.1,
    exposure: 0,
    grain: 0.02,
    vignette: 0.14,
  },
  {
    id: 'yunmeng',
    name: 'Log·云梦',
    kind: 'log',
    matrix: [0.9, 0, 0.04, 0, 1.05, 0, 0, 0.05, 1.05],
    offset: [-0.02, 0, 0],
    hue: -0.03,
    temperature: 4600,
    contrast: 1.12,
    saturation: 0.82,
    exposure: -0.1,
    grain: 0.05,
    vignette: 0.14,
  },
  {
    id: 'yili',
    name: 'Log·伊犁',
    kind: 'log',
    matrix: [0.92, 0, 0, 0, 0.98, 0, 0, 0, 1.12],
    offset: [-0.01, -0.01, 0.02],
    hue: -0.05,
    temperature: 5000,
    contrast: 1.15,
    saturation: 0.92,
    exposure: -0.08,
    grain: 0.04,
    vignette: 0.2,
  },
  {
    id: 'chiangmai',
    name: 'Log·清迈',
    kind: 'log',
    matrix: [1, 0, 0, 0, 1.04, 0, -0.03, 0.02, 0.95],
    offset: [0.02, 0.01, 0],
    hue: 0.06,
    temperature: 5800,
    contrast: 0.95,
    saturation: 1.05,
    exposure: 0,
    grain: 0.03,
    vignette: 0.08,
  },
];

/** 按 id 查找影调 */
export function getLookById(id) {
  return LOOKS.find((l) => l.id === id);
}

/**
 * 按自定义顺序（存 id 数组）返回影调列表。
 * 未在顺序表中的影调按默认顺序附在末尾。
 * @param {string[]} order 影调 id 顺序
 */
export function orderedLooks(order) {
  if (!Array.isArray(order) || !order.length) return LOOKS.slice();
  const picked = order.map((id) => getLookById(id)).filter(Boolean);
  const rest = LOOKS.filter((l) => !order.includes(l.id));
  return picked.concat(rest);
}
