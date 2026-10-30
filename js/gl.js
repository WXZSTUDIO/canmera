// js/gl.js
// WebGL 渲染器：上下文创建、着色器编译、纹理上传、uniform 设置与渲染循环。
// 优先 WebGL2，回退 WebGL1；着色器统一使用 GLSL ES 1.00，两者兼容。
//
// 影调管线：上一帧混合(慢快门) -> 色彩矩阵 -> 色相 -> 色温 -> 色调 -> 曝光(ISO/快门/补偿)
//          -> 对比度 -> 饱和度 -> 高亮增益 -> SDR 肩部 -> 暗角 -> 颗粒

import { tempToRGB } from './looks.js';

const VERT_SRC = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_texCoord;
}
`;

const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_prevTex;
uniform mat3 u_matrix;
uniform vec3 u_offset;
uniform float u_hue;
uniform vec3 u_tempRGB;
uniform float u_tint;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_grain;
uniform float u_vignette;
uniform float u_time;
uniform vec2 u_uvScale;
uniform float u_trail;
uniform float u_highlight;
uniform float u_sdr;
uniform float u_zoom;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// 绕灰轴(1,1,1)旋转色相，保持明度不变
mat3 hueMatrix(float a) {
  float c = cos(a);
  float s = sin(a);
  float k = 1.0 / 3.0;
  float t = (1.0 - c) * k;
  float sq = s / 1.7320508;
  return mat3(
    c + t,  t + sq,  t - sq,
    t - sq, c + t,   t + sq,
    t + sq, t - sq,  c + t
  );
}

void main() {
  // 数字变焦 + cover 裁剪：先中心化 (v_uv - 0.5)、除以 zoom 收窄采样窗口、
  // 再乘 uvScale（cover 比例）、最后加 0.5。等价于 uv = 0.5 + (v_uv - 0.5) * u_uvScale / u_zoom。
  // zoom = 1 时精确退化回原 cover 公式 (v_uv - 0.5) * u_uvScale + 0.5。
  // 恒不越界：|v_uv - 0.5| <= 0.5，除以 zoom(>=1)、乘 uvScale(<=1) 后仍 <= 0.5，
  // 故 zoom >= 1 时下方越界填黑分支永不触发（保留以兜底异常输入）。
  vec2 uv = (v_uv - 0.5) / u_zoom;
  uv = uv * u_uvScale + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 cur = texture2D(u_tex, uv).rgb;
  vec3 prv = texture2D(u_prevTex, uv).rgb;
  // 慢快门：与上一帧混合，模拟运动模糊 / 长曝光
  vec3 color = mix(cur, (cur + prv) * 0.5, u_trail);

  // 1) 创意色彩矩阵 + lift
  color = u_matrix * color + u_offset;
  // 2) 色相旋转
  color = hueMatrix(u_hue) * color;
  // 3) 色温增益
  color *= u_tempRGB;
  // 4) 白平衡色调（正=洋红，负=绿）
  float tv = u_tint * 0.08;
  color.r += tv;
  color.b += tv;
  color.g -= tv;
  // 5) 曝光（含 ISO / 快门 / 曝光补偿）
  color *= u_exposure;
  // 6) 对比度（以 0.5 灰为中点）
  color = (color - 0.5) * u_contrast + 0.5;
  // 7) 饱和度
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma), color, u_saturation);

  // 8) 高亮增益（HDR 观感）：提升高光区域
  if (u_highlight > 0.0) {
    float hl = smoothstep(0.45, 1.0, luma);
    color += color * hl * u_highlight * 0.4;
  }
  // 9) SDR 肩部柔化：避免高光死白，提升 SDR 兼容性
  if (u_sdr > 0.0) {
    color = mix(color, color / (1.0 + max(color - 0.8, 0.0)), u_sdr);
  }

  // 10) 暗角
  vec2 d = v_uv - 0.5;
  float dist = length(d) * 1.41421356;
  float vig = 1.0 - u_vignette * smoothstep(0.35, 0.95, dist);
  color *= vig;
  // 11) 颗粒
  float n = (rand(v_uv * 100.0 + fract(u_time)) - 0.5) * u_grain;
  color += n;

  color = clamp(color, 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0);
}
`;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function colMajorFromRows(rows) {
  return new Float32Array([
    rows[0], rows[3], rows[6],
    rows[1], rows[4], rows[7],
    rows[2], rows[5], rows[8],
  ]);
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = {
      alpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
      premultipliedAlpha: false,
      depth: false,
      stencil: false,
    };
    const gl2 = canvas.getContext('webgl2', opts);
    if (gl2) {
      this.gl = gl2;
      this.isWebGL2 = true;
    } else {
      this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
      this.isWebGL2 = false;
    }
    if (!this.gl) throw new Error('当前浏览器不支持 WebGL');

    // WebGL 规范：texImage2D 上传图像时第一行（视觉顶部）存于 v=0。
    // 顶点缓冲将 v=0 映射到画布底部，故必须翻转 Y，否则画面上下颠倒。
    // 全局像素存储状态，设置一次对本文件全部 4 处 texImage2D 生效。
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);

    this.program = this._createProgram();
    this.gl.useProgram(this.program);

    this.quad = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quad);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
      this.gl.STATIC_DRAW
    );
    const stride = 4 * 4;
    this.aPos = this.gl.getAttribLocation(this.program, 'a_position');
    this.aUV = this.gl.getAttribLocation(this.program, 'a_texCoord');
    this.gl.enableVertexAttribArray(this.aPos);
    this.gl.vertexAttribPointer(this.aPos, 2, this.gl.FLOAT, false, stride, 0);
    this.gl.enableVertexAttribArray(this.aUV);
    this.gl.vertexAttribPointer(this.aUV, 2, this.gl.FLOAT, false, stride, 2 * 4);

    // 双纹理 ping-pong：texs[cur] 为本帧源，texs[1-cur] 保留上一帧（慢快门用）
    this.texs = [this._createTexture(), this._createTexture()];
    this.texIdx = 0;

    const u = (name) => this.gl.getUniformLocation(this.program, name);
    this.u = {
      tex: u('u_tex'),
      prevTex: u('u_prevTex'),
      matrix: u('u_matrix'),
      offset: u('u_offset'),
      hue: u('u_hue'),
      tempRGB: u('u_tempRGB'),
      tint: u('u_tint'),
      exposure: u('u_exposure'),
      contrast: u('u_contrast'),
      saturation: u('u_saturation'),
      grain: u('u_grain'),
      vignette: u('u_vignette'),
      time: u('u_time'),
      uvScale: u('u_uvScale'),
      trail: u('u_trail'),
      highlight: u('u_highlight'),
      sdr: u('u_sdr'),
      zoom: u('u_zoom'),
    };
    this.gl.uniform1i(this.u.tex, 0);
    this.gl.uniform1i(this.u.prevTex, 1);

    // 状态默认值
    this.source = null;
    this.sourceKind = null;
    this.needUpload = false;
    this.look = null;
    this.lookOffset = new Float32Array([0, 0, 0]);
    this.u_matrix = colMajorFromRows([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.hue = 0;
    this.contrast = 1;
    this.saturation = 1;
    this.grain = 0;
    this.vignette = 0;
    this.lookExposure = 0;

    this.expComp = 0;      // 用户曝光补偿（档）
    this.iso = null;       // null=自动；否则 ISO 数值
    this.shutter = null;   // null=自动；否则快门秒数
    this.tint = 0;         // 白平衡色调 -1(绿) ~ +1(洋红)
    this.highlight = 0;    // 高亮增益 0/1
    this.sdr = 0;          // SDR 肩部柔化 0/1
    this.temperature = 6500;
    this.totalExp = 1;
    this.trail = 0;
    this.zoom = 1;         // 数字变焦倍率（>=1，仅影响预览渲染）

    this.startTime = performance.now();
    this.running = false;
    this._raf = 0;
  }

  _createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 初始化为 1x1 黑色，保证纹理完整可采样（首帧上一帧为黑）
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255])
    );
    return tex;
  }

  _createProgram() {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  setSource(el, kind) {
    this.source = el;
    this.sourceKind = kind;
    this.needUpload = true;
  }

  setLook(look) {
    this.look = look;
    this.u_matrix = colMajorFromRows(look.matrix);
    this.lookOffset = new Float32Array(look.offset);
    this.hue = look.hue || 0;
    this.contrast = look.contrast != null ? look.contrast : 1.0;
    this.saturation = look.saturation != null ? look.saturation : 1.0;
    this.grain = look.grain != null ? look.grain : 0.0;
    this.vignette = look.vignette != null ? look.vignette : 0.0;
    this.lookExposure = look.exposure != null ? look.exposure : 0;
    this._updateExposure();
  }

  setExposure(v) {
    this.expComp = v;
    this._updateExposure();
  }

  /** ISO：null 表示自动 */
  setISO(iso) {
    this.iso = iso;
    this._updateExposure();
  }

  /** 快门速度（秒）：null 表示自动 */
  setShutter(sec) {
    this.shutter = sec;
    this._updateExposure();
  }

  setTint(t) {
    this.tint = t;
  }

  setHighlight(on) {
    this.highlight = on ? 1 : 0;
  }

  setSDR(on) {
    this.sdr = on ? 1 : 0;
  }

  setTemperature(k) {
    this.temperature = k;
  }

  /** 数字变焦倍率（WebGL 兜底路径）：>= 1，1 表示不变焦 */
  setZoom(f) {
    const v = typeof f === 'number' && isFinite(f) ? f : 1;
    this.zoom = clamp(v, 1, 8);
  }

  /** 合成总曝光：曝光补偿 · ISO 增益 · 快门增益，并推导慢快门拖影强度 */
  _updateExposure() {
    const isoGain = this.iso == null ? 1 : clamp(this.iso / 400, 0.2, 8);
    const sGain = this.shutter == null ? 1 : clamp(this.shutter / (1 / 48), 0.05, 6);
    this.totalExp = clamp(
      Math.pow(2, this.expComp + this.lookExposure) * isoGain * sGain,
      0.02,
      8
    );
    // 快门慢于 1/120s 起产生运动模糊，1/2s 达到最强
    const s = this.shutter;
    const raw = s == null ? 0 : (s - 1 / 120) / (0.5 - 1 / 120);
    this.trail = clamp(raw, 0, 1) * 0.85;
  }

  renderFrame() {
    const gl = this.gl;
    if (!this.source || !this.look) return;

    const isVideo = this.sourceKind === 'video';
    const cur = this.texs[this.texIdx];
    const prv = this.texs[1 - this.texIdx];

    const upload = (tex) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        if (isVideo) {
          if (this.source.readyState >= 2) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
          }
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
        }
      } catch (e) {
        /* 资源未就绪，下一帧重试 */
      }
    };

    if (isVideo) {
      upload(cur);
      this.needUpload = false;
    } else if (this.needUpload) {
      // 静态图：一次性写入两张纹理，上一帧与当前一致（拖影无副作用）
      upload(cur);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, prv);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
      } catch (e) { /* ignore */ }
      this.needUpload = false;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prv);

    gl.uniformMatrix3fv(this.u.matrix, false, this.u_matrix);
    gl.uniform3fv(this.u.offset, this.lookOffset);
    gl.uniform1f(this.u.hue, this.hue);
    const tRGB = tempToRGB(this.temperature);
    gl.uniform3f(this.u.tempRGB, tRGB[0], tRGB[1], tRGB[2]);
    gl.uniform1f(this.u.tint, this.tint);
    gl.uniform1f(this.u.exposure, this.totalExp);
    gl.uniform1f(this.u.contrast, this.contrast);
    gl.uniform1f(this.u.saturation, this.saturation);
    gl.uniform1f(this.u.grain, this.grain);
    gl.uniform1f(this.u.vignette, this.vignette);
    gl.uniform1f(this.u.time, (performance.now() - this.startTime) / 1000);
    gl.uniform1f(this.u.trail, this.trail);
    gl.uniform1f(this.u.highlight, this.highlight);
    gl.uniform1f(this.u.sdr, this.sdr);
    gl.uniform1f(this.u.zoom, this.zoom);

    // cover 裁剪比例
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const sw = this.source.videoWidth || this.source.naturalWidth || this.source.width || cw;
    const sh = this.source.videoHeight || this.source.naturalHeight || this.source.height || ch;
    const ca = cw / ch;
    const sa = sw / sh;
    let sx = 1;
    let sy = 1;
    if (sa > ca) {
      sx = ca / sa;
    } else {
      sy = sa / ca;
    }
    gl.uniform2f(this.u.uvScale, sx, sy);

    gl.viewport(0, 0, cw, ch);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 交换：本帧纹理下一年成为「上一帧」
    this.texIdx = 1 - this.texIdx;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.renderFrame();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  getStream(fps) {
    const fn = this.canvas.captureStream || this.canvas.mozCaptureStream;
    if (!fn) throw new Error('当前环境不支持 captureStream');
    return fn.call(this.canvas, fps || 30);
  }

  captureToCanvas() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    c.getContext('2d').drawImage(this.canvas, 0, 0);
    return c;
  }
}
