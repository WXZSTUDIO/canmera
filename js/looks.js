// js/looks.js
// 影调（Look）预设定义 + 色彩工具函数。
// 新增影调只需往 LOOKS 数组追加一项，渲染管线会自动适配。

/**
 * 色温(Kelvin) -> RGB 增益。
 * 基于 Tanner Helland 黑体近似算法，归一化到 [0,1]。
 * 6500K 附近接近白色，低温偏暖（红多蓝少），高温偏冷（蓝多红少）。
 * @param {number} kelvin 色温，单位开尔文
 * @returns {[number, number, number]} 归一化 RGB 增益
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
 * 每个 look 的字段含义：
 *  - id / name：标识与展示名
 *  - matrix：3x3 创意色彩矩阵（行主序 9 个数），用于青绿/暖橙等整体偏色
 *  - offset：vec3 lift，给暗部轻微提色
 *  - hue：色相旋转（弧度），进一步微调色彩倾向
 *  - temperature：推荐色温(K)，切换该影调时同步到白平衡滑杆
 *  - contrast / saturation：对比度 / 饱和度
 *  - exposure：曝光偏移（档），与用户曝光补偿相加后转亮度倍数
 *  - grain：颗粒强度
 *  - vignette：暗角强度
 */
export const LOOKS = [
  {
    id: 'neutral',
    name: '中性',
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
  {
    id: 'yunmeng',
    name: 'Log·云梦',
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

/**
 * 按 id 查找影调。
 * @param {string} id
 * @returns {object|undefined}
 */
export function getLookById(id) {
  return LOOKS.find((l) => l.id === id);
}
