// js/camera.js
// 摄像头封装：getUserMedia 取流、麦克风音频电平(L/R)、ImageCapture 拍照/对焦、
// 闪光灯(torch)、变焦、MediaRecorder 录影。
// 所有浏览器能力缺失均做 try/catch 优雅降级，不抛出到 UI 层造成白屏。

export class CameraController {
  constructor() {
    this.stream = null;
    this.imageCapture = null;
    this.recorder = null;
    this.recordedChunks = [];
    this.recording = false;
    this.facing = 'environment';
    this.audioCtx = null;
    this.analysers = null;
    this.audioOn = false;
    this.torchOn = false;
  }

  /**
   * 启动摄像头并绑定到 video 元素。
   * @param {HTMLVideoElement} videoEl
   * @param {{facing?:string, audio?:boolean, width?:number, height?:number, frameRate?:number}} opts
   */
  async start(videoEl, opts = {}) {
    const facing = opts.facing || this.facing;
    const width = opts.width || 1920;
    const height = opts.height || 1080;
    const frameRate = opts.frameRate || 30;
    const wantAudio = !!opts.audio;

    this.facing = facing;
    this.stop();

    const base = {
      facingMode: facing,
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
    };

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: base,
        audio: wantAudio ? { echoCancellation: true, noiseSuppression: true } : false,
      });
      this.audioOn = wantAudio;
    } catch (e) {
      if (!wantAudio) throw e;
      // 麦克风不可用/被拒 -> 回退为纯视频，保证相机仍可用
      stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      this.audioOn = false;
    }

    this.stream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();

    try {
      if ('ImageCapture' in window) {
        const track = stream.getVideoTracks()[0];
        if (track) this.imageCapture = new ImageCapture(track);
      }
    } catch (e) {
      this.imageCapture = null;
    }

    if (this.audioOn) this._setupAudio(stream);
    return stream;
  }

  /** 建立音频分析链：MediaStream -> Splitter -> 左右声道 Analyser */
  _setupAudio(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      const src = this.audioCtx.createMediaStreamSource(stream);
      const splitter = this.audioCtx.createChannelSplitter(2);
      this.analysers = [];
      for (let i = 0; i < 2; i++) {
        const a = this.audioCtx.createAnalyser();
        a.fftSize = 512;
        a.smoothingTimeConstant = 0.55;
        this.analysers.push(a);
      }
      src.connect(splitter);
      splitter.connect(this.analysers[0], 0, 0);
      splitter.connect(this.analysers[1], 1, 0);
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    } catch (e) {
      this.analysers = null;
    }
  }

  /**
   * 读取左右声道电平（0~1）。单声道麦克风时右声道镜像左声道。
   * @returns {[number, number]}
   */
  getLevels() {
    if (!this.analysers) return [0, 0];
    const read = (a) => {
      const buf = new Uint8Array(a.fftSize);
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      return Math.min(1, rms * 3.4);
    };
    const l = read(this.analysers[0]);
    let r = read(this.analysers[1]);
    if (r < 0.01 && l >= 0.01) r = l; // 单声道镜像
    return [l, r];
  }

  /** 用 ImageCapture 拍原始照片（最高质量） */
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

  /** 设置对焦（单点对焦 / 手动 / 连续） */
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

  /** 闪光灯（torch）开关，不支持返回 false */
  async setTorch(on) {
    if (!this.stream) return false;
    const track = this.stream.getVideoTracks()[0];
    if (!track) return false;
    try {
      const cap = track.getCapabilities ? track.getCapabilities() : {};
      if (cap.torch) {
        await track.applyConstraints({ advanced: [{ torch: !!on }] });
        this.torchOn = !!on;
        return true;
      }
      if (this.imageCapture && typeof this.imageCapture.setOptions === 'function') {
        await this.imageCapture.setOptions({ fillLightMode: on ? 'on' : 'off' });
        this.torchOn = !!on;
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  supportsTorch() {
    if (!this.stream) return false;
    const track = this.stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return false;
    const cap = track.getCapabilities();
    return !!cap.torch || !!(this.imageCapture && typeof this.imageCapture.setOptions === 'function');
  }

  /** 变焦（若设备支持） */
  async setZoom(z) {
    if (!this.stream) return false;
    const track = this.stream.getVideoTracks()[0];
    if (!track) return false;
    try {
      const cap = track.getCapabilities ? track.getCapabilities() : {};
      if (cap.zoom) {
        await track.applyConstraints({ advanced: [{ zoom: z }] });
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 麦克风音轨（用于录影混入音频） */
  audioTracks() {
    if (!this.stream || !this.audioOn) return [];
    return this.stream.getAudioTracks();
  }

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

  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('未处于录制状态'));
        return;
      }
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || 'video/webm';
        resolve(new Blob(this.recordedChunks, { type }));
        this.recording = false;
      };
      this.recorder.stop();
    });
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (e) { /* ignore */ }
      this.audioCtx = null;
    }
    this.analysers = null;
    this.imageCapture = null;
    this.audioOn = false;
  }
}

/** 选择浏览器支持的录影 MIME 类型 */
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
