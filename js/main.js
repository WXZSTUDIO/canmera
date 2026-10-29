// js/main.js
// canmera 应用入口：状态管理、专业控制面板、拍照/录影、音频电平、手势、存储估算。

import { GLRenderer } from './gl.js';
import { CameraController, pickRecordMime } from './camera.js';
import { LOOKS, getLookById, orderedLooks } from './looks.js';

// ---------- 常量 ----------
const RES = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '2K': [2048, 1152],
  '4K': [3840, 2160],
};
const FPS_OPTS = [24, 25, 30, 60];
const ISO_STEPS = [100, 200, 400, 800, 1600, 3200, 6400];
const SHUTTER_STEPS = [1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 15, 1 / 8, 1 / 4, 1 / 2, 1];
const STORE_KEY = 'canmera.settings.v1';

function fmtShutter(s) {
  return s >= 1 ? s + 's' : '1/' + Math.round(1 / s) + 's';
}

// ---------- DOM ----------
const canvas = document.getElementById('gl');
const video = document.getElementById('video');
const looksEl = document.getElementById('looks');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const focusBox = document.getElementById('focus-box');
const gridEl = document.getElementById('grid');
const metersEl = document.getElementById('meters');
const dotsL = document.getElementById('dots-l');
const dotsR = document.getElementById('dots-r');
const badgeLog = document.getElementById('badge-log');
const btnMode = document.getElementById('btn-mode');
const btnRes = document.getElementById('btn-res');
const remainMin = document.getElementById('remain-min');
const remainGb = document.getElementById('remain-gb');
const brandTip = document.getElementById('brand-tip');
const btnShutter = document.getElementById('btn-shutter');
const panel = document.getElementById('panel');
const panelTitle = document.getElementById('panel-title');
const panelBody = document.getElementById('panel-body');
const panelClose = document.getElementById('panel-close');
const viewer = document.getElementById('viewer');
const viewerStage = document.getElementById('viewer-stage');
const viewerClose = document.getElementById('viewer-close');
const thumb = document.getElementById('thumb');
const thumbImg = document.getElementById('thumb-img');
const fileInput = document.getElementById('file-input');
const focalEl = document.getElementById('focal');

// ---------- 设置 ----------
const defaults = {
  res: '1080p',
  fps: 60,
  highlight: false,
  sdr: false,
  grid: false,
  swipeLooks: true,
  mic: false,
  torch: false,
  keep: false,
  qr: false,
  face: false,
  lookOrder: [],
  // 拍摄参数（仅在 keep 开启时持久化）
  lookId: 'neutral',
  exp: 0,
  wb: 6500,
  tint: 0,
  isoAuto: true,
  iso: 400,
  shutterAuto: true,
  shutterIdx: 5,
};

const settings = Object.assign({}, defaults);

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (saved) {
    Object.assign(settings, saved);
    // 拍摄参数仅在「保留设置」开启时恢复
    if (!saved.keep) {
      settings.lookId = defaults.lookId;
      settings.exp = defaults.exp;
      settings.wb = defaults.wb;
      settings.tint = defaults.tint;
      settings.isoAuto = true;
      settings.shutterAuto = true;
    }
  }
} catch (e) { /* 读取失败用默认值 */ }

function persist() {
  try {
    const out = Object.assign({}, settings);
    if (!settings.keep) {
      delete out.lookId; delete out.exp; delete out.wb; delete out.tint;
      delete out.isoAuto; delete out.iso; delete out.shutterAuto; delete out.shutterIdx;
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(out));
  } catch (e) { /* 忽略 */ }
}

// ---------- 状态 ----------
let renderer = null;
let camera = null;
const state = {
  mode: 'photo', // 'photo' | 'video'
  look: getLookById(settings.lookId) || LOOKS[0],
  recording: false,
  lastResult: null,
  faces: [],
  lowWarned: false,
};

// ---------- 工具 ----------
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
}
function setStatus(msg) {
  if (msg) { statusEl.textContent = msg; statusEl.hidden = false; }
  else statusEl.hidden = true;
}
function downloadBlob(blob, type) {
  const isVid = type.startsWith('video');
  const ext = /mp4/i.test(type) ? 'mp4' : isVid ? 'webm' : 'jpg';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'canmera-' + Date.now() + '.' + ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function shareBlob(blob, type) {
  const isVid = type.startsWith('video');
  const ext = /mp4/i.test(type) ? 'mp4' : isVid ? 'webm' : 'jpg';
  const name = 'canmera-' + Date.now() + '.' + ext;
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'canmera' }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  downloadBlob(blob, type);
  toast('当前环境不支持分享，已转为下载');
}
function canvasToBlob(c, type, q) {
  return new Promise((res) => c.toBlob(res, type, q));
}
function blobToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

// ---------- 画布 ----------
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
}
window.addEventListener('resize', resize);
resize();

// ---------- 渲染器 ----------
try {
  renderer = new GLRenderer(canvas);
  renderer.setLook(state.look);
  renderer.setExposure(settings.exp);
  renderer.setTemperature(settings.wb);
  renderer.setTint(settings.tint);
  renderer.setISO(settings.isoAuto ? null : settings.iso);
  renderer.setShutter(settings.shutterAuto ? null : SHUTTER_STEPS[settings.shutterIdx]);
  renderer.setHighlight(settings.highlight);
  renderer.setSDR(settings.sdr);
} catch (e) {
  setStatus('WebGL 初始化失败：' + e.message);
  toast('WebGL 不可用，无法运行');
}

// ---------- 影调条 ----------
function renderLooks() {
  const list = orderedLooks(settings.lookOrder);
  looksEl.innerHTML = '';
  list.forEach((look) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look-chip' + (look.id === state.look.id ? ' active' : '');
    b.textContent = look.name;
    b.dataset.kind = look.kind;
    if (!renderer) b.disabled = true;
    b.addEventListener('click', () => selectLook(look));
    looksEl.appendChild(b);
  });
}

function selectLook(look) {
  if (!renderer) { toast('WebGL 不可用'); return; }
  state.look = look;
  settings.lookId = look.id;
  renderLooks();
  badgeLog.hidden = look.kind !== 'log';
  renderer.setLook(look);
  renderer.setTemperature(settings.wb);
  persist();
}

function stepLook(dir) {
  const list = orderedLooks(settings.lookOrder);
  const i = list.findIndex((l) => l.id === state.look.id);
  const next = list[(i + dir + list.length) % list.length];
  if (next) selectLook(next);
}

// ---------- 参数栏 ----------
function updateResBtn() {
  btnRes.textContent = settings.res + ' · ' + settings.fps;
}
function updateMode() {
  btnMode.textContent = state.mode === 'video' ? '▶ 视频' : '● 照片';
}
btnMode.addEventListener('click', () => {
  state.mode = state.mode === 'photo' ? 'video' : 'photo';
  updateMode();
  toast(state.mode === 'video' ? '视频模式' : '照片模式');
});
btnRes.addEventListener('click', () => {
  openPanel('settings');
});

// ---------- 电量/存储 ----------
async function updateRemain() {
  let gb = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      gb = Math.max(0, (est.quota - est.usage) / 1e9);
    }
  } catch (e) { /* ignore */ }
  if (gb == null) {
    remainGb.textContent = '--';
    remainMin.textContent = '--';
    return;
  }
  remainGb.textContent = gb.toFixed(1);
  const [w, h] = RES[settings.res];
  const bytesPerSec = (w * h * settings.fps * 0.1) / 8; // 粗略码率
  remainMin.textContent = String(Math.round((gb * 1e9) / bytesPerSec / 60));
  if (gb < 1 && !state.lowWarned && state.recording) {
    state.lowWarned = true;
    toast('存储空间不足，请尽快结束录制');
  }
  if (gb >= 1) state.lowWarned = false;
}

// ---------- 音频电平 ----------
const DOTS = 5;
function buildDots() {
  [dotsL, dotsR].forEach((el) => {
    el.innerHTML = '';
    for (let i = 0; i < DOTS; i++) el.appendChild(document.createElement('i'));
  });
}
buildDots();

function paintDots(el, level) {
  const kids = el.children;
  const lit = Math.round(Math.min(1, level) * DOTS);
  for (let i = 0; i < DOTS; i++) {
    kids[i].classList.remove('on', 'peak');
    if (i < lit) kids[i].classList.add(i === DOTS - 1 && level > 0.85 ? 'peak' : 'on');
  }
}
setInterval(() => {
  if (!camera || !camera.analysers) return;
  const [l, r] = camera.getLevels();
  paintDots(dotsL, l);
  paintDots(dotsR, r);
}, 70);

// ---------- 摄像头 ----------
async function startCamera(opts = {}) {
  if (state.starting) return; // 防并发
  if (!camera) camera = new CameraController();
  state.starting = true;
  const [w, h] = RES[settings.res];
  try {
    setStatus('正在请求摄像头权限…');
    await camera.start(video, {
      facing: camera.facing,
      audio: settings.mic,
      width: w,
      height: h,
      frameRate: settings.fps,
    });
    metersEl.hidden = !camera.audioOn;
    if (settings.torch) {
      const ok = await camera.setTorch(true);
      if (!ok) toast('当前设备不支持闪光灯');
    }
    if (!renderer) {
      setStatus('摄像头已打开，但 WebGL 不可用，无法预览');
      state.starting = false;
      return;
    }
    renderer.setSource(video, 'video');
    renderer.setLook(state.look);
    renderer.start();
    setStatus('');
    brandTip.textContent = (camera.facing === 'user' ? '前置' : '后置') + ' ' + settings.res + ' · ' + settings.fps;
    updateRemain();
  } catch (e) {
    setStatus('无法访问摄像头：' + (e && e.message ? e.message : e));
    toast('摄像头不可用');
  }
  state.starting = false;
}

document.querySelector('.pro[data-k="flip"]').addEventListener('click', async () => {
  if (!camera || !camera.stream) { await startCamera(); return; }
  const facing = camera.facing === 'environment' ? 'user' : 'environment';
  try {
    await camera.start(video, {
      facing,
      audio: settings.mic,
      width: RES[settings.res][0],
      height: RES[settings.res][1],
      frameRate: settings.fps,
    });
    if (renderer) { renderer.setSource(video, 'video'); renderer.start(); }
    brandTip.textContent = (facing === 'user' ? '前置' : '后置') + ' ' + settings.res + ' · ' + settings.fps;
    toast('已切换镜头：' + (facing === 'user' ? '前置' : '后置'));
  } catch (e) {
    toast('切换镜头失败：' + (e && e.message ? e.message : e));
  }
});

// 焦距/镜头条
focalEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.fi');
  if (!btn) return;
  const lens = btn.dataset.lens;
  [...focalEl.children].forEach((c) => c.classList.toggle('active', c === btn));
  const facing = lens === 'front' ? 'user' : 'environment';
  if (camera && camera.stream) {
    camera.start(video, {
      facing,
      audio: settings.mic,
      width: RES[settings.res][0],
      height: RES[settings.res][1],
      frameRate: settings.fps,
    }).then(() => {
      if (renderer) { renderer.setSource(video, 'video'); renderer.start(); }
      if (lens === 'ultra') camera.setZoom(0.5).catch(() => {});
      else camera.setZoom(1).catch(() => {});
      brandTip.textContent = (facing === 'user' ? '前置' : '后置') + ' ' + settings.res + ' · ' + settings.fps;
    }).catch(() => toast('切换镜头失败'));
  } else {
    camera = camera || new CameraController();
    camera.facing = facing;
    startCamera();
  }
});

// ---------- 专业面板 ----------
function sliderRow(label, min, max, step, value, fmt, onInput) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    '<div class="row-head"><span>' + label + '</span><em>' + fmt(value) + '</em></div>' +
    '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '">';
  const em = row.querySelector('em');
  const input = row.querySelector('input');
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    em.textContent = fmt(v);
    onInput(v);
  });
  return row;
}

function toggleRow(label, checked, onChange) {
  const lab = document.createElement('label');
  lab.className = 'toggle';
  lab.innerHTML = '<span>' + label + '</span><input type="checkbox"><span class="sw"></span>';
  const input = lab.querySelector('input');
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return lab;
}

function segRow(label, options, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  wrap.innerHTML = '<div class="row-head"><span>' + label + '</span></div>';
  const seg = document.createElement('div');
  seg.className = 'seg';
  options.forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    if (String(o.value) === String(value)) b.classList.add('active');
    b.addEventListener('click', () => {
      [...seg.children].forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
      onChange(o.value);
    });
    seg.appendChild(b);
  });
  wrap.appendChild(seg);
  return wrap;
}

function noteRow(text) {
  const d = document.createElement('div');
  d.className = 'note';
  d.textContent = text;
  return d;
}

const hasFaceDetector = typeof window.FaceDetector === 'function';
const hasBarcode = typeof window.BarcodeDetector === 'function';

function openPanel(kind) {
  panelBody.innerHTML = '';
  const push = (el) => panelBody.appendChild(el);

  if (kind === 'wb') {
    panelTitle.textContent = '白平衡';
    push(sliderRow('色温', 2500, 8000, 50, settings.wb, (v) => v + 'K', (v) => {
      settings.wb = v;
      if (renderer) renderer.setTemperature(v);
      persist();
    }));
    push(sliderRow('色调', -100, 100, 1, Math.round(settings.tint * 100),
      (v) => (v > 0 ? '洋红 +' + v : v < 0 ? '绿 ' + v : '0'),
      (v) => {
        settings.tint = v / 100;
        if (renderer) renderer.setTint(settings.tint);
        persist();
      }));
    push(noteRow('色调用于校正偏绿/偏洋红，与色温独立调整。'));
  } else if (kind === 'iso') {
    panelTitle.textContent = '感光 (ISO)';
    const isoRow = sliderRow('ISO', 0, ISO_STEPS.length - 1, 1,
      ISO_STEPS.indexOf(settings.iso) < 0 ? 2 : ISO_STEPS.indexOf(settings.iso),
      (i) => 'ISO ' + ISO_STEPS[i],
      (i) => {
        settings.iso = ISO_STEPS[i];
        if (renderer) renderer.setISO(settings.isoAuto ? null : settings.iso);
        persist();
      });
    push(toggleRow('自动 ISO', settings.isoAuto, (on) => {
      settings.isoAuto = on;
      isoRow.querySelector('input').disabled = on;
      if (renderer) renderer.setISO(on ? null : settings.iso);
      persist();
    }));
    isoRow.querySelector('input').disabled = settings.isoAuto;
    push(isoRow);
  } else if (kind === 'shutter') {
    panelTitle.textContent = '快门速度';
    const sRow = sliderRow('快门', 0, SHUTTER_STEPS.length - 1, 1, settings.shutterIdx,
      (i) => fmtShutter(SHUTTER_STEPS[i]),
      (i) => {
        settings.shutterIdx = i;
        if (renderer) renderer.setShutter(settings.shutterAuto ? null : SHUTTER_STEPS[i]);
        persist();
      });
    push(toggleRow('自动快门（最慢 1/30s）', settings.shutterAuto, (on) => {
      settings.shutterAuto = on;
      sRow.querySelector('input').disabled = on;
      if (renderer) renderer.setShutter(on ? null : SHUTTER_STEPS[settings.shutterIdx]);
      persist();
    }));
    sRow.querySelector('input').disabled = settings.shutterAuto;
    push(sRow);
    push(noteRow('手动快门慢于 1/120s 会呈现运动模糊 / 长曝光拖影；范围 1/1000s ~ 1s。'));
  } else if (kind === 'exp') {
    panelTitle.textContent = '曝光';
    push(sliderRow('曝光补偿', -2, 2, 0.1, settings.exp,
      (v) => (v > 0 ? '+' : '') + v.toFixed(1),
      (v) => {
        settings.exp = v;
        if (renderer) renderer.setExposure(v);
        persist();
      }));
  } else if (kind === 'focus') {
    panelTitle.textContent = '对焦';
    push(segRow('对焦模式', [
      { label: '连续', value: 'continuous' },
      { label: '单点', value: 'single-shot' },
      { label: '手动', value: 'manual' },
    ], settings.focusMode || 'continuous', async (v) => {
      settings.focusMode = v;
      persist();
      const ok = camera ? await camera.setFocus(v) : false;
      toast(ok ? '对焦模式：' + v : '当前设备不支持切换对焦模式（仅保存设置）');
    }));
    if (hasFaceDetector) {
      push(toggleRow('人脸识别（点击人脸锁定焦点/曝光）', settings.face, (on) => {
        settings.face = on;
        persist();
        toast(on ? '人脸识别已开启' : '人脸识别已关闭');
      }));
    } else {
      push(noteRow('人脸识别：当前浏览器不支持 FaceDetector API。'));
    }
    push(noteRow('轻点取景器可手动设置焦点与测光点。'));
  } else if (kind === 'settings') {
    panelTitle.textContent = '设置';
    push(segRow('照片分辨率', Object.keys(RES).map((k) => ({ label: k, value: k })), settings.res, (v) => {
      settings.res = v;
      updateResBtn();
      persist();
      toast('照片分辨率：' + v);
    }));
    push(segRow('视频帧率', FPS_OPTS.map((f) => ({ label: f + 'fps', value: f })), settings.fps, (v) => {
      settings.fps = v;
      updateResBtn();
      updateRemain();
      persist();
      toast('帧率：' + v + 'fps（下次录制生效）');
    }));
    push(toggleRow('高亮增益 (HDR)', settings.highlight, (on) => {
      settings.highlight = on;
      if (renderer) renderer.setHighlight(on);
      persist();
    }));
    push(toggleRow('SDR 肩部兼容', settings.sdr, (on) => {
      settings.sdr = on;
      if (renderer) renderer.setSDR(on);
      persist();
    }));
    push(toggleRow('取景参考线', settings.grid, (on) => {
      settings.grid = on;
      gridEl.hidden = !on;
      persist();
    }));
    push(toggleRow('横滑切换影调', settings.swipeLooks, (on) => {
      settings.swipeLooks = on;
      persist();
    }));
    push(toggleRow('麦克风（音频电平 + 录制收声）', settings.mic, async (on) => {
      settings.mic = on;
      persist();
      if (camera && camera.stream) {
        await camera.start(video, {
          facing: camera.facing,
          audio: on,
          width: RES[settings.res][0],
          height: RES[settings.res][1],
          frameRate: settings.fps,
        });
        if (renderer) { renderer.setSource(video, 'video'); renderer.start(); }
        metersEl.hidden = !camera.audioOn;
        if (!camera.audioOn && on) toast('麦克风不可用，已回退为纯视频');
      } else {
        toast(on ? '麦克风将在开启相机后生效' : '已关闭麦克风');
      }
    }));
    push(toggleRow('闪光灯（常亮）', settings.torch, async (on) => {
      settings.torch = on;
      persist();
      if (!camera || !camera.stream) { toast('请先开启相机'); return; }
      const ok = await camera.setTorch(on);
      if (!ok) toast('当前设备不支持闪光灯');
    }));
    if (hasBarcode) {
      push(toggleRow('二维码扫描', settings.qr, (on) => {
        settings.qr = on;
        persist();
        toast(on ? '二维码扫描已开启' : '二维码扫描已关闭');
      }));
    } else {
      push(noteRow('二维码扫描：当前浏览器不支持 BarcodeDetector API。'));
    }
    push(toggleRow('保留拍摄参数（下次启动恢复）', settings.keep, (on) => {
      settings.keep = on;
      persist();
      toast(on ? '已开启保留拍摄参数' : '已关闭保留拍摄参数');
    }));

    // 影调排序
    const sortWrap = document.createElement('div');
    sortWrap.className = 'row';
    const sh = document.createElement('div');
    sh.className = 'row-head';
    sh.innerHTML = '<span>影调排序</span>';
    sortWrap.appendChild(sh);
    const list = document.createElement('div');
    list.className = 'sort-list';
    const buildSort = () => {
      list.innerHTML = '';
      const cur = orderedLooks(settings.lookOrder);
      cur.forEach((look, i) => {
        const item = document.createElement('div');
        item.className = 'sort-item';
        const nm = document.createElement('span');
        nm.textContent = look.name;
        const up = document.createElement('button');
        up.type = 'button';
        up.textContent = '↑';
        up.disabled = i === 0;
        const dn = document.createElement('button');
        dn.type = 'button';
        dn.textContent = '↓';
        dn.disabled = i === cur.length - 1;
        up.addEventListener('click', () => {
          const arr = cur.map((l) => l.id);
          [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          settings.lookOrder = arr;
          persist();
          renderLooks();
          buildSort();
        });
        dn.addEventListener('click', () => {
          const arr = cur.map((l) => l.id);
          [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
          settings.lookOrder = arr;
          persist();
          renderLooks();
          buildSort();
        });
        item.append(nm, up, dn);
        list.appendChild(item);
      });
    };
    buildSort();
    sortWrap.appendChild(list);
    push(sortWrap);

    const importRow = document.createElement('div');
    importRow.className = 'row';
    const impBtn = document.createElement('button');
    impBtn.className = 'seg';
    impBtn.style.width = '100%';
    impBtn.style.justifyContent = 'center';
    impBtn.textContent = '导入本地图片套影调';
    impBtn.addEventListener('click', () => fileInput.click());
    importRow.appendChild(impBtn);
    push(importRow);

    push(noteRow('网页端不支持：iPhone 18 Pro 可变光圈、前置方形传感器横竖切换、硬件级 Log 编码（此处以影调模拟）。'));
  }

  panel.hidden = false;
  document.querySelectorAll('.pro').forEach((b) => b.classList.remove('active'));
  const active = document.querySelector('.pro[data-k="' + kind + '"]');
  if (active) active.classList.add('active');
}

document.querySelectorAll('.pro').forEach((btn) => {
  const k = btn.dataset.k;
  if (k === 'flip') return;
  btn.addEventListener('click', () => {
    if (!panel.hidden && panelTitle.dataset.k === k) { panel.hidden = true; return; }
    panelTitle.dataset.k = k;
    openPanel(k);
  });
});
panelClose.addEventListener('click', () => {
  panel.hidden = true;
  document.querySelectorAll('.pro').forEach((b) => b.classList.remove('active'));
});

// ---------- 拍照 / 录制 ----------
btnShutter.addEventListener('click', () => {
  // 相机尚未开启时，首次点击仅用于启动（避免拍到黑帧）
  if (!camera || !camera.stream) { startCamera(); return; }
  if (state.mode === 'video') toggleRecord();
  else capturePhoto();
});

async function capturePhoto() {
  if (!renderer) return;
  toast('抓拍中…', 900);
  try {
    let target = null;
    if (camera && camera.imageCapture && typeof camera.imageCapture.takePhoto === 'function') {
      try {
        const original = await camera.takePhoto();
        if (original) {
          const img = await blobToImage(original);
          const prevSrc = renderer.source;
          const prevKind = renderer.sourceKind;
          renderer.setSource(img, 'image');
          renderer.renderFrame();
          target = renderer.captureToCanvas();
          if (prevKind === 'video' && prevSrc) renderer.setSource(prevSrc, 'video');
          else if (prevKind === 'image' && prevSrc) renderer.setSource(prevSrc, 'image');
        }
      } catch (e) { target = null; }
    }
    let out = target || renderer.captureToCanvas();
    // 按设置分辨率输出
    const [w, h] = RES[settings.res];
    const ar = out.width / out.height;
    let tw = w, th = h;
    if (ar > 1) th = Math.round(w / ar); else tw = Math.round(h * ar);
    const scaled = document.createElement('canvas');
    scaled.width = tw;
    scaled.height = th;
    scaled.getContext('2d').drawImage(out, 0, 0, tw, th);
    const blob = await canvasToBlob(scaled, 'image/jpeg', 0.92);
    if (!blob) { toast('抓拍失败'); return; }
    showPreview(blob, 'image');
    toast('已保存 · 点左下角查看');
  } catch (e) {
    toast('抓拍出错：' + (e && e.message ? e.message : e));
  }
}

function toggleRecord() {
  if (!renderer) return;
  if (typeof MediaRecorder === 'undefined') { toast('当前浏览器不支持录影'); return; }
  if (!state.recording) {
    try {
      const canvasStream = renderer.getStream(settings.fps);
      const tracks = canvasStream.getVideoTracks();
      const audio = camera ? camera.audioTracks() : [];
      const out = new MediaStream([...tracks, ...audio]);
      camera = camera || new CameraController();
      camera.startRecording(out, pickRecordMime());
      state.recording = true;
      btnShutter.classList.add('recording');
      toast('录制中…（再次点击停止）');
      updateRemain();
    } catch (e) {
      toast('录制启动失败：' + (e && e.message ? e.message : e));
    }
  } else {
    camera.stopRecording().then((blob) => {
      state.recording = false;
      btnShutter.classList.remove('recording');
      if (blob && blob.size > 0) {
        showPreview(blob, 'video');
        openViewer(); // 录影是明确动作，结束后直接展示结果
      }
      else toast('录制内容为空');
    }).catch((e) => {
      state.recording = false;
      btnShutter.classList.remove('recording');
      toast('停止录制失败：' + (e && e.message ? e.message : e));
    });
  }
}

// ---------- 结果查看器 ----------
// 显隐统一由 .is-open 类控制（不再用 hidden 属性，避免作者样式表覆盖 UA 规则）。
function openViewer() {
  if (!state.lastResult) return;
  viewer.classList.add('is-open');
  viewer.setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  viewer.classList.remove('is-open');
  viewer.setAttribute('aria-hidden', 'true');
  // 关闭后暂停视频，避免后台继续播放
  const v = viewerStage.querySelector('video');
  if (v) v.pause();
}

// 视频抽帧生成缩略图（取靠前的一帧，失败则降级为空）
function makeVideoThumb(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const objUrl = URL.createObjectURL(blob);
    v.src = objUrl;
    v.onloadeddata = () => { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 120;
        c.height = Math.max(1, Math.round(120 * ((v.videoHeight || 9) / (v.videoWidth || 16))));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.8));
      } catch (e) { resolve(null); }
      URL.revokeObjectURL(objUrl);
    };
    v.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
  });
}

// 抓拍/录影结果：写入查看器 + 更新左下角缩略图，但不打断当前拍摄
async function showPreview(blob, type) {
  state.lastResult = { blob, type };
  const url = URL.createObjectURL(blob);

  viewerStage.innerHTML = '';
  if (type === 'image') {
    const img = document.createElement('img');
    img.src = url;
    viewerStage.appendChild(img);
    thumbImg.src = url;
    thumb.hidden = false;
  } else {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    viewerStage.appendChild(v);
    const frame = await makeVideoThumb(blob);
    if (frame) { thumbImg.src = frame; thumb.hidden = false; }
    else { thumb.hidden = false; thumbImg.removeAttribute('src'); }
  }
}

// 关闭方式 1：右上角 ✕
viewerClose.addEventListener('click', closeViewer);

// 关闭方式 2：点击画面空白处
viewerStage.addEventListener('click', (e) => {
  if (e.target === viewerStage) closeViewer();
});

// 关闭方式 3：ESC 键（桌面端）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewer.classList.contains('is-open')) closeViewer();
});

// 关闭方式 4：向下滑动
let vTouchY = null;
viewer.addEventListener('touchstart', (e) => {
  vTouchY = e.touches[0] ? e.touches[0].clientY : null;
}, { passive: true });
viewer.addEventListener('touchmove', (e) => {
  if (vTouchY === null || !e.touches[0]) return;
  // 下滑超过 80px 即关闭
  if (e.touches[0].clientY - vTouchY > 80) { closeViewer(); vTouchY = null; }
}, { passive: true });
viewer.addEventListener('touchend', () => { vTouchY = null; });

// 点左下角缩略图查看
thumb.addEventListener('click', openViewer);

document.getElementById('pv-download').addEventListener('click', () => {
  if (state.lastResult) downloadBlob(state.lastResult.blob, state.lastResult.type);
});
document.getElementById('pv-share').addEventListener('click', () => {
  if (state.lastResult) shareBlob(state.lastResult.blob, state.lastResult.type);
});

// ---------- 本地图片 ----------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (renderer) {
      renderer.setSource(img, 'image');
      renderer.setLook(state.look);
      renderer.start();
      setStatus('');
      toast('已载入图片，可切换影调后导出');
    }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('图片加载失败'); };
  img.src = url;
  fileInput.value = '';
});

// ---------- 手势：横滑切影调 / 点击对焦 ----------
let px = 0, py = 0;
canvas.addEventListener('pointerdown', (e) => { px = e.clientX; py = e.clientY; });
canvas.addEventListener('pointerup', (e) => {
  const dx = e.clientX - px;
  const dy = e.clientY - py;
  if (settings.swipeLooks && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
    stepLook(dx < 0 ? 1 : -1);
    return;
  }
  handleTap(e);
});

async function handleTap(e) {
  const rect = canvas.getBoundingClientRect();
  let x = (e.clientX - rect.left) / rect.width;
  let y = (e.clientY - rect.top) / rect.height;
  // 人脸识别优先：点中人脸则锁定到人脸
  if (settings.face && state.faces.length) {
    const f = state.faces.find((b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
    if (f) { x = f.x + f.width / 2; y = f.y + f.height / 2; }
  }
  focusBox.hidden = false;
  focusBox.style.left = e.clientX + 'px';
  focusBox.style.top = e.clientY + 'px';
  clearTimeout(focusBox._t);
  focusBox._t = setTimeout(() => { focusBox.hidden = true; }, 1500);
  if (camera && camera.stream) {
    try { await camera.setFocus('single-shot', { x, y }); } catch (_) { /* 仅 UI 演示 */ }
  }
}

// ---------- 人脸 / 二维码检测 ----------
let faceBoxEl = null;
if (hasFaceDetector || hasBarcode) {
  faceBoxEl = document.createElement('div');
  faceBoxEl.style.cssText = 'position:absolute;border:1.5px solid #34d399;border-radius:4px;pointer-events:none;display:none;';
  document.getElementById('app').appendChild(faceBoxEl);
}

setInterval(async () => {
  if (!camera || !camera.stream || !video.videoWidth) return;
  try {
    if (settings.face && hasFaceDetector) {
      const det = new FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
      const faces = await det.detect(video);
      state.faces = (faces || []).map((f) => ({
        x: f.boundingBox.x / video.videoWidth,
        y: f.boundingBox.y / video.videoHeight,
        width: f.boundingBox.width / video.videoWidth,
        height: f.boundingBox.height / video.videoHeight,
      }));
      if (state.faces.length) {
        const f = state.faces[0];
        faceBoxEl.style.display = 'block';
        faceBoxEl.style.left = f.x * 100 + '%';
        faceBoxEl.style.top = f.y * 100 + '%';
        faceBoxEl.style.width = f.width * 100 + '%';
        faceBoxEl.style.height = f.height * 100 + '%';
      } else {
        faceBoxEl.style.display = 'none';
      }
    } else if (faceBoxEl) {
      faceBoxEl.style.display = 'none';
    }
    if (settings.qr && hasBarcode) {
      const bd = new BarcodeDetector();
      const codes = await bd.detect(video);
      if (codes && codes.length) toast('扫码结果：' + codes[0].rawValue, 3000);
    }
  } catch (e) { /* 检测失败忽略 */ }
}, 600);

// ---------- 初始化 ----------
renderLooks();
badgeLog.hidden = state.look.kind !== 'log';
updateResBtn();
updateMode();
gridEl.hidden = !settings.grid;
updateRemain();
if (!renderer) {
  panelBody.innerHTML = '';
}
setStatus('轻点屏幕即可开启相机');
// iOS 需在用户手势中请求权限：首次交互自动启动相机
const boot = () => {
  document.removeEventListener('pointerdown', boot);
  startCamera();
};
document.addEventListener('pointerdown', boot, { once: true });

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      // 清理历史遗留缓存（旧 cache-first 版本的 canmera-v1），避免旧代码被锁死
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith('canmera-') && k !== 'canmera-v2')
            .map((k) => caches.delete(k))
        );
      }
      // 有等待中的新版本时立即接管，不等用户关闭所有标签页
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage('SKIP_WAITING');
          }
        });
      });
      await reg.update();
    } catch (e) {
      /* 注册失败不影响主功能 */
    }
  });
}
