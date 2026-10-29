// js/main.js
// 应用入口：状态管理、UI 事件绑定、影调切换、拍照/录影/分享/本地图片。

import { GLRenderer } from './gl.js';
import { CameraController, pickRecordMime } from './camera.js';
import { LOOKS } from './looks.js';

// ---------- DOM 引用 ----------
const canvas = document.getElementById('gl');
const video = document.getElementById('video');
const looksEl = document.getElementById('looks');
const expEl = document.getElementById('exp');
const wbEl = document.getElementById('wb');
const expVal = document.getElementById('exp-val');
const wbVal = document.getElementById('wb-val');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const focusBox = document.getElementById('focus-box');
const preview = document.getElementById('preview');
const previewMedia = document.getElementById('preview-media');
const fileInput = document.getElementById('file-input');
const btnCamera = document.getElementById('btn-camera');
const btnSwitch = document.getElementById('btn-switch');
const btnRecord = document.getElementById('btn-record');

// ---------- 全局状态 ----------
let renderer = null;
let camera = null;
const state = {
  mode: 'camera', // 'camera' | 'image'
  currentLook: LOOKS[0],
  recording: false,
  lastResult: null, // { blob, type }
};

// ---------- 工具函数 ----------
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, ms);
}

function setStatus(msg) {
  if (msg) {
    statusEl.textContent = msg;
    statusEl.hidden = false;
  } else {
    statusEl.hidden = true;
  }
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToBlob(canvas, type, q) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, q));
}

function downloadBlob(blob, type) {
  const ext = /mp4/i.test(type) ? 'mp4' : type.startsWith('video') ? 'webm' : 'jpg';
  const name = 'tianfeng-' + Date.now() + '.' + ext;
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareBlob(blob, type) {
  const ext = /mp4/i.test(type) ? 'mp4' : type.startsWith('video') ? 'webm' : 'jpg';
  const name = 'tianfeng-' + Date.now() + '.' + ext;
  const file = new File([blob], name, { type });
  // 优先使用 Web Share API（带文件）
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '飓风相机 PWA' });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 用户取消
    }
  }
  // 降级为下载
  downloadBlob(blob, type);
  toast('当前环境不支持分享，已转为下载');
}

// ---------- 画布尺寸 ----------
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
}
window.addEventListener('resize', resize);

// ---------- 渲染器初始化 ----------
try {
  renderer = new GLRenderer(canvas);
  renderer.setLook(state.currentLook);
  renderer.setExposure(0);
  renderer.setTemperature(state.currentLook.temperature);
} catch (e) {
  setStatus('WebGL 初始化失败：' + e.message);
  toast('WebGL 不可用，无法运行');
  // 极端降级：禁用所有依赖渲染管线的 UI 控件，避免后续交互调用 renderer 报 TypeError
  expEl.disabled = true;
  wbEl.disabled = true;
}

// ---------- 影调按钮 ----------
LOOKS.forEach((look, i) => {
  const btn = document.createElement('button');
  btn.className = 'look-chip' + (i === 0 ? ' active' : '');
  btn.type = 'button';
  btn.textContent = look.name;
  btn.dataset.id = look.id;
  // WebGL 不可用时直接禁用影调预设按钮
  if (!renderer) btn.disabled = true;
  btn.addEventListener('click', () => selectLook(look, btn));
  looksEl.appendChild(btn);
});

function selectLook(look, btn) {
  if (!renderer) {
    toast('WebGL 不可用');
    return;
  }
  state.currentLook = look;
  document.querySelectorAll('.look-chip').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderer.setLook(look);
  // 同步白平衡滑杆到该影调推荐色温
  wbEl.value = String(look.temperature);
  wbVal.textContent = Math.round(look.temperature) + 'K';
  renderer.setTemperature(look.temperature);
}

// ---------- 滑杆 ----------
expEl.addEventListener('input', () => {
  if (!renderer) return;
  const v = parseFloat(expEl.value);
  expVal.textContent = v.toFixed(1);
  renderer.setExposure(v);
});
wbEl.addEventListener('input', () => {
  if (!renderer) return;
  const k = parseFloat(wbEl.value);
  wbVal.textContent = Math.round(k) + 'K';
  renderer.setTemperature(k);
});

// ---------- 摄像头 ----------
async function startCamera() {
  if (!camera) camera = new CameraController();
  try {
    setStatus('正在请求摄像头权限…');
    await camera.start(video);
    state.mode = 'camera';
    // 极端降级：renderer 为 null（WebGL 失败）时跳过渲染管线，避免 TypeError 且不误报摄像头错误
    if (!renderer) {
      setStatus('摄像头已打开，但 WebGL 不可用，无法预览（可使用本地图片）');
      return;
    }
    renderer.setSource(video, 'video');
    renderer.setLook(state.currentLook);
    renderer.setTemperature(parseFloat(wbEl.value));
    renderer.start();
    setStatus('');
    toast('相机已启动');
  } catch (e) {
    setStatus('无法访问摄像头：' + (e && e.message ? e.message : e) + '（仍可使用本地图片模式）');
    toast('摄像头不可用，请使用「图片」');
  }
}

btnCamera.addEventListener('click', async () => {
  // 已开启且当前在图片模式 -> 返回实时预览
  if (camera && camera.stream && state.mode === 'image') {
    state.mode = 'camera';
    renderer.setSource(video, 'video');
    toast('返回实时预览');
  } else {
    await startCamera();
  }
});

btnSwitch.addEventListener('click', async () => {
  if (!camera) {
    await startCamera();
    return;
  }
  const facing = camera.facing === 'environment' ? 'user' : 'environment';
  try {
    await camera.start(video, facing);
    renderer.setSource(video, 'video');
    renderer.start();
    toast('已切换镜头：' + (facing === 'user' ? '前置' : '后置'));
  } catch (e) {
    toast('切换镜头失败：' + (e && e.message ? e.message : e));
  }
});

// ---------- 本地图片套影调 ----------
document.getElementById('btn-local').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.mode = 'image';
    renderer.setSource(img, 'image');
    renderer.setLook(state.currentLook);
    renderer.start();
    URL.revokeObjectURL(url);
    toast('已载入图片，可切换影调后导出');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('图片加载失败');
  };
  img.src = url;
  fileInput.value = ''; // 允许重复选择同一文件
});

// ---------- 拍照 ----------
document.getElementById('btn-capture').addEventListener('click', capturePhoto);

async function capturePhoto() {
  if (!renderer) return;
  toast('抓拍中…', 900);
  try {
    const blob = await doCapture();
    if (!blob) {
      toast('抓拍失败');
      return;
    }
    showPreview(blob, 'image');
  } catch (e) {
    toast('抓拍出错：' + (e && e.message ? e.message : e));
  }
}

function doCapture() {
  return new Promise(async (resolve) => {
    // 优先：ImageCapture 拿原图 -> 再走 WebGL 管线套影调
    let original = null;
    if (camera && camera.imageCapture && typeof camera.imageCapture.takePhoto === 'function') {
      try {
        original = await camera.takePhoto();
      } catch (_) {
        original = null;
      }
    }
    if (original) {
      const img = await blobToImage(original);
      const prevSrc = renderer.source;
      const prevKind = renderer.sourceKind;
      renderer.stop();
      renderer.setSource(img, 'image');
      renderer.renderFrame();
      const out = renderer.captureToCanvas();
      // 恢复之前的实时/图片源
      if (prevKind === 'video' && prevSrc) renderer.setSource(prevSrc, 'video');
      else if (prevKind === 'image' && prevSrc) renderer.setSource(prevSrc, 'image');
      renderer.start();
      canvasToBlob(out, 'image/jpeg', 0.92).then(resolve);
      return;
    }
    // 降级：直接抓取当前已套影调的 WebGL 画面
    const out = renderer.captureToCanvas();
    canvasToBlob(out, 'image/jpeg', 0.92).then(resolve);
  });
}

// ---------- 录影 ----------
if (typeof MediaRecorder === 'undefined') {
  btnRecord.style.display = 'none';
}
btnRecord.addEventListener('click', async () => {
  if (!renderer) return;
  if (!state.recording) {
    if (typeof MediaRecorder === 'undefined') {
      toast('当前浏览器不支持录影');
      return;
    }
    try {
      const stream = renderer.getStream(30);
      const mime = pickRecordMime();
      camera.startRecording(stream, mime);
      state.recording = true;
      btnRecord.textContent = '停止';
      btnRecord.classList.add('recording');
      toast('录制中…（再次点击停止）');
    } catch (e) {
      toast('录制启动失败：' + (e && e.message ? e.message : e));
    }
  } else {
    try {
      const blob = await camera.stopRecording();
      state.recording = false;
      btnRecord.textContent = '录制';
      btnRecord.classList.remove('recording');
      if (blob && blob.size > 0) {
        showPreview(blob, 'video');
      } else {
        toast('录制内容为空');
      }
    } catch (e) {
      toast('停止录制失败：' + (e && e.message ? e.message : e));
    }
  }
});

// ---------- 结果预览 ----------
function showPreview(blob, type) {
  state.lastResult = { blob, type };
  previewMedia.innerHTML = '';
  if (type === 'image') {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    previewMedia.appendChild(img);
  } else {
    const v = document.createElement('video');
    v.src = URL.createObjectURL(blob);
    v.controls = true;
    v.loop = true;
    v.autoplay = true;
    v.muted = false;
    previewMedia.appendChild(v);
  }
  preview.hidden = false;
}

document.getElementById('pv-close').addEventListener('click', () => {
  preview.hidden = true;
  state.lastResult = null;
});
document.getElementById('pv-download').addEventListener('click', () => {
  if (state.lastResult) downloadBlob(state.lastResult.blob, state.lastResult.type);
});
document.getElementById('pv-share').addEventListener('click', () => {
  if (state.lastResult) shareBlob(state.lastResult.blob, state.lastResult.type);
});

// 顶部「分享」按钮：分享最近一次结果
document.getElementById('btn-share').addEventListener('click', () => {
  if (!state.lastResult) {
    toast('请先拍照或录制');
    return;
  }
  shareBlob(state.lastResult.blob, state.lastResult.type);
});

// ---------- 对焦（tap） ----------
canvas.addEventListener('pointerdown', async (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  // 显示对焦框（以点击位置为中心）
  focusBox.hidden = false;
  focusBox.style.left = e.clientX + 'px';
  focusBox.style.top = e.clientY + 'px';
  clearTimeout(focusBox._t);
  focusBox._t = setTimeout(() => {
    focusBox.hidden = true;
  }, 1500);
  // 尝试设置对焦（不支持则仅 UI 演示）
  if (camera && camera.stream) {
    try {
      await camera.setFocus('single-shot', { x, y });
    } catch (_) {
      /* 忽略，仅 UI 演示 */
    }
  }
});

// ---------- PWA 注册 ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 离线壳注册失败不影响主功能 */
    });
  });
}

// ---------- 启动引导 ----------
resize();
setStatus('点击「相机」开启实时预览，或使用「图片」载入本地照片套影调');
