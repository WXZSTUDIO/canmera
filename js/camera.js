// js/camera.js
// 摄像头封装：getUserMedia 取流、ImageCapture 拍照/对焦、MediaRecorder 录影。
// 所有浏览器能力缺失均做 try/catch 优雅降级，不抛出到 UI 层造成白屏。

/**
 * 摄像头控制器。
 */
export class CameraController {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {ImageCapture|null} */
    this.imageCapture = null;
    /** @type {MediaRecorder|null} */
    this.recorder = null;
    /** @type {Blob[]} */
    this.recordedChunks = [];
    this.recording = false;
    this.facing = 'environment';
  }

  /**
   * 启动摄像头并绑定到 video 元素。
   * @param {HTMLVideoElement} videoEl
   * @param {string} facing 'environment' | 'user'
   */
  async start(videoEl, facing) {
    if (facing) this.facing = facing;
    // 先释放旧流，避免多路占用的泄漏
    this.stop();

    const constraints = {
      video: {
        facingMode: this.facing,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = this.stream;
    // iOS Safari 需要显式播放且 muted+playsinline（已在 HTML 设置）
    await videoEl.play();

    // ImageCapture 渐进增强（iOS Safari 不支持，会安全跳过）
    try {
      if ('ImageCapture' in window) {
        const track = this.stream.getVideoTracks()[0];
        if (track) this.imageCapture = new ImageCapture(track);
      }
    } catch (e) {
      this.imageCapture = null;
    }
    return this.stream;
  }

  /**
   * 用 ImageCapture 拍原始照片（最高质量）。
   * @returns {Promise<Blob|null>}
   */
  async takePhoto() {
    if (this.imageCapture && typeof this.imageCapture.takePhoto === 'function') {
      try {
        return await this.imageCapture.takePhoto();
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * 设置对焦（单点对焦 / 手动）。
   * @param {'single-shot'|'manual'|'continuous'} mode
   * @param {{x:number,y:number}} [point] 归一化坐标 0~1，原点左上
   * @returns {Promise<boolean>} 是否成功设置（不支持返回 false，仅作 UI 演示）
   */
  async setFocus(mode, point) {
    if (this.imageCapture && typeof this.imageCapture.setOptions === 'function') {
      try {
        const opts = { focusMode: mode };
        if (point) opts.pointsOfInterest = [{ x: point.x, y: point.y }];
        await this.imageCapture.setOptions(opts);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /**
   * 开始录制（画布流，已含影调）。
   * @param {MediaStream} stream
   * @param {string} [mimeType]
   */
  startRecording(stream, mimeType) {
    this.recordedChunks = [];
    const options = mimeType ? { mimeType } : undefined;
    this.recorder = new MediaRecorder(stream, options);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.recorder.start();
    this.recording = true;
  }

  /**
   * 停止录制并返回合并后的 Blob。
   * @returns {Promise<Blob>}
   */
  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('未处于录制状态'));
        return;
      }
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || 'video/webm';
        const blob = new Blob(this.recordedChunks, { type });
        this.recording = false;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  /** 停止并释放摄像头流 */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.imageCapture = null;
  }
}

/**
 * 选择浏览器支持的录影 MIME 类型。
 * @returns {string}
 */
export function pickRecordMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = [
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}
