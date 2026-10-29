// js/gl.js
// WebGL 渲染器：负责上下文创建、着色器编译、纹理上传、uniform 设置与渲染循环。
// 优先 WebGL2，回退 WebGL1；着色器统一使用 GLSL ES 1.00，两者兼容。

import { tempToRGB } from './looks.js';

// 顶点着色器：全屏四边形
const VERT_SRC = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_texCoord;
}
`;

// 片元着色器：影调调色管线
// 处理顺序：色彩矩阵 -> 色相旋转 -> 色温增益 -> 曝光 -> 对比度 -> 饱和度 -> 暗角 -> 颗粒
const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform mat3 u_matrix;
uniform vec3 u_offset;
uniform float u_hue;
uniform vec3 u_tempRGB;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_grain;
uniform float u_vignette;
uniform float u_time;
uniform vec2 u_uvScale;

// 伪随机噪声，用于颗粒（随时间变化避免静止）
float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// 绕灰轴(1,1,1)旋转色相，保持明度不变
mat3 hueMatrix(float a) {
  float c = cos(a);
  float s = sin(a);
  float k = 1.0 / 3.0;
  float t = (1.0 - c) * k;
  float sq = s / 1.7320508; // 1/sqrt(3)
  return mat3(
    c + t,  t + sq,  t - sq,
    t - sq, c + t,   t + sq,
    t + sq, t - sq,  c + t
  );
}

void main() {
  // cover 裁剪：把源画面按比例裁切铺满画布
  vec2 uv = (v_uv - 0.5) * u_uvScale + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 color = texture2D(u_tex, uv).rgb;

  // 1) 创意色彩矩阵 + lift
  color = u_matrix * color + u_offset;
  // 2) 色相旋转
  color = hueMatrix(u_hue) * color;
  // 3) 色温增益（RGB 乘性校正）
  color *= u_tempRGB;
  // 4) 曝光
  color *= u_exposure;
  // 5) 对比度（以 0.5 灰为中点）
  color = (color - 0.5) * u_contrast + 0.5;
  // 6) 饱和度
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma), color, u_saturation);
  // 7) 暗角
  vec2 d = v_uv - 0.5;
  float dist = length(d) * 1.41421356;
  float vig = 1.0 - u_vignette * smoothstep(0.35, 0.95, dist);
  color *= vig;
  // 8) 颗粒
  float n = (rand(v_uv * 100.0 + fract(u_time)) - 0.5) * u_grain;
  color += n;
  // 限幅
  color = clamp(color, 0.0, 1.0);

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * 将行主序 3x3 矩阵转为列主序（WebGL uniformMatrix3fv 期望列主序）。
 * @param {number[]} rows 9 个数，[r0c0,r0c1,r0c2, r1c0,r1c1,r2c2...]
 * @returns {Float32Array}
 */
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

/**
 * WebGL 渲染器类。
 */
export class GLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas 显示用画布（会被填充为调色后画面）
   */
  constructor(canvas) {
    this.canvas = canvas;
    const opts = {
      alpha: false,
      preserveDrawingBuffer: true, // 便于截图 / 录屏读取像素
      antialias: false,
      premultipliedAlpha: false,
      depth: false,
      stencil: false,
    };
    // 优先 WebGL2，回退 WebGL1
    const gl2 = canvas.getContext('webgl2', opts);
    if (gl2) {
      this.gl = gl2;
      this.isWebGL2 = true;
    } else {
      this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
      this.isWebGL2 = false;
    }
    if (!this.gl) {
      throw new Error('当前浏览器不支持 WebGL');
    }

    this.program = this._createProgram();
    this.gl.useProgram(this.program);

    // 全屏四边形（位置 + 纹理坐标，交织存储）
    this.quad = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quad);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 0,
        1, -1, 1, 0,
        -1, 1, 0, 1,
        1, 1, 1, 1,
      ]),
      this.gl.STATIC_DRAW
    );
    const stride = 4 * 4; // 4 个 float
    this.aPos = this.gl.getAttribLocation(this.program, 'a_position');
    this.aUV = this.gl.getAttribLocation(this.program, 'a_texCoord');
    this.gl.enableVertexAttribArray(this.aPos);
    this.gl.vertexAttribPointer(this.aPos, 2, this.gl.FLOAT, false, stride, 0);
    this.gl.enableVertexAttribArray(this.aUV);
    this.gl.vertexAttribPointer(this.aUV, 2, this.gl.FLOAT, false, stride, 2 * 4);

    // 纹理（NPOT 安全：CLAMP + LINEAR，无 mipmap）
    this.texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);

    // 缓存 uniform 位置
    const u = (name) => this.gl.getUniformLocation(this.program, name);
    this.u = {
      tex: u('u_tex'),
      matrix: u('u_matrix'),
      offset: u('u_offset'),
      hue: u('u_hue'),
      tempRGB: u('u_tempRGB'),
      exposure: u('u_exposure'),
      contrast: u('u_contrast'),
      saturation: u('u_saturation'),
      grain: u('u_grain'),
      vignette: u('u_vignette'),
      time: u('u_time'),
      uvScale: u('u_uvScale'),
    };
    this.gl.uniform1i(this.u.tex, 0);

    // 状态默认值
    this.source = null;
    this.sourceKind = null; // 'video' | 'image'
    this.needUpload = false;
    this.look = null;
    this.exposure = 0;
    this.temperature = 6500;
    this.lookExposure = 0;
    this.startTime = performance.now();
    this.running = false;
    this._raf = 0;
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
      const log = gl.getProgramInfoLog(prog);
      throw new Error('着色器链接失败: ' + log);
    }
    return prog;
  }

  /** 设置渲染源（video 或 image 元素） */
  setSource(el, kind) {
    this.source = el;
    this.sourceKind = kind;
    this.needUpload = true;
  }

  /** 设置当前影调预设 */
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
  }

  /** 用户曝光补偿（-2 ~ +2 档） */
  setExposure(v) {
    this.exposure = v;
  }

  /** 用户白平衡色温（K） */
  setTemperature(k) {
    this.temperature = k;
  }

  /** 绘制一帧（内部调用） */
  renderFrame() {
    const gl = this.gl;
    if (!this.source || !this.look) return;

    // 上传纹理：video 每帧更新，image 仅首次
    if (this.needUpload || this.sourceKind === 'video') {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      try {
        if (this.sourceKind === 'video') {
          if (this.source.readyState >= 2) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
          }
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
        }
        this.needUpload = false;
      } catch (e) {
        // 资源尚未就绪，下一帧重试
      }
    }

    // 设置 uniform
    gl.uniformMatrix3fv(this.u.matrix, false, this.u_matrix);
    gl.uniform3fv(this.u.offset, this.lookOffset);
    gl.uniform1f(this.u.hue, this.hue);
    const tRGB = tempToRGB(this.temperature);
    gl.uniform3f(this.u.tempRGB, tRGB[0], tRGB[1], tRGB[2]);
    const totalExp = Math.pow(2, this.exposure + this.lookExposure);
    gl.uniform1f(this.u.exposure, totalExp);
    gl.uniform1f(this.u.contrast, this.contrast);
    gl.uniform1f(this.u.saturation, this.saturation);
    gl.uniform1f(this.u.grain, this.grain);
    gl.uniform1f(this.u.vignette, this.vignette);
    gl.uniform1f(this.u.time, (performance.now() - this.startTime) / 1000);

    // cover 裁剪比例
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    let sw = this.source.videoWidth || this.source.naturalWidth || this.source.width || cw;
    let sh = this.source.videoHeight || this.source.naturalHeight || this.source.height || ch;
    const ca = cw / ch;
    const sa = sw / sh;
    let sx = 1;
    let sy = 1;
    if (sa > ca) {
      sx = ca / sa; // 源更宽，裁左右
    } else {
      sy = sa / ca; // 源更高，裁上下
    }
    gl.uniform2f(this.u.uvScale, sx, sy);

    gl.viewport(0, 0, cw, ch);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** 启动渲染循环 */
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

  /** 停止渲染循环 */
  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  /**
   * 获取画布的实时视频流（用于 MediaRecorder 录屏）。
   * @param {number} fps
   * @returns {MediaStream}
   */
  getStream(fps) {
    const fn = this.canvas.captureStream || this.canvas.mozCaptureStream;
    if (!fn) throw new Error('当前环境不支持 captureStream');
    return fn.call(this.canvas, fps || 30);
  }

  /**
   * 把当前调色后画面绘制到一张 2D 画布（用于拍照/导出）。
   * @returns {HTMLCanvasElement}
   */
  captureToCanvas() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0);
    return c;
  }
}
