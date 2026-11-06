/**
 * 风与水 —— 演奏模式的 Canvas 2D 水面。
 *
 * 设计原则：风不可见，只画被风推的水。风是手指，水是弦的余响。
 * 所以这里没有粒子、没有飞舞的线，只有：
 *   水平水纹（远处细、近处宽）
 *   被指尖按下去的一小块涟漪
 *   扫弦的一次横向波痕
 *   低音在底部推着走的暗影
 *   长音/留白时聚拢的光斑
 *
 * 数据来源：由 visual/serve.mjs 用 src/audio/qinlang.js 解析 .qin 得到
 * 每个音的 t / dur / deg / oct / vel / sweep / last。本文件不编造音符。
 *
 * 对外（给页面和验收脚本用）：
 *   setTimeline(tl)   seek(t)   advanceTo(t)   tick(dt)   render()
 *   metrics()         motionProbe(t, dt)
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);
const hash = (n) => fract(Math.sin(n * 127.1 + 31.7) * 43758.5453123);

const FIFTH_INDEX = { 1: 0, 5: 1, 2: 2, 6: 3, 3: 4 };
const DEG_ORDER = { 1: 0, 2: 1, 3: 2, 5: 3, 6: 4 };

const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a.toFixed(4)})`;

export class Water {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onFrame = opts.onFrame || null;
    this.gl = opts.gl || null;
    this.label = '';
    this.playing = false;

    this.N = 26;
    this.W = 1;
    this.H = 1;
    this.dpr = 1;
    this.top = 0;
    this.lines = [];

    this.time = 0;
    this.timeline = null;
    this.duration = 0;
    this.events = [];
    this.evIndex = 0;
    this.phrase = null;

    this.ripples = [];
    this.rings = [];
    this.crest = null;

    this.bassX = 0.5;
    this.bassTarget = 0.5;
    this.prevDeg = null;
    this.flowTarget = 0;
    this.windSign = 1;
    this.windDirVis = 1;
    this.windPhase = 0;
    this.driftScreens = 0;
    this.driftRate = 0;
    // 水面相位的积分（世界米）。不能用「当前风速 × 绝对时间」，
    // 否则风一抖，整片水会前后抽动，横向位移就读不出来。
    this.flowAdv = 0;
    this.flowRate = 0;
    this.lastNoteAt = -99;

    this.env = this.freshEnv();
    // 给画面看的那一层包络：音符/标记会把 env 一步推到位，
    // 直接送进着色器就是「整片水一帧之内变了个样」。这里统一缓一小段。
    this.visEnv = this.freshEnv();
    this.resize();
  }

  // 每个量的时间常数（秒）。起音短一点，收尾跟着 env 自己的衰减走。
  visTau() {
    return { amp: 0.11, bass: 0.09, chop: 0.14, density: 0.14, calm: 0.16,
             close: 0.16, wind: 0.12, sweepPulse: 0.07, suspended: 0.25, spread: 0.12 };
  }

  updateVis(dt) {
    if (!this.visEnv) this.visEnv = this.freshEnv();
    const e = this.env, v = this.visEnv, tau = this.visTau();
    // ?vis=raw：回到「env 直接进着色器」的旧行为，用于 A/B 对照。
    if (typeof location !== "undefined" && /[?&]vis=raw/.test(location.search)) {
      for (const k in e) v[k] = e[k];
      return;
    }
    for (const k in tau) {
      const a = 1 - Math.exp(-dt / tau[k]);
      v[k] += ((e[k] ?? 0) - (v[k] ?? 0)) * a;
    }
    v.flow = e.flow;
  }

  freshEnv() {
    return {
      density: 0,
      chop: 0,
      amp: 0,
      spread: 0.045,
      calm: 1,
      close: 0,
      suspended: 0,
      bass: 0,
      flow: 0,
      sweepPulse: 0,
      wind: 0,
    };
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(240, window.innerHeight);
    this.dpr = dpr;
    this.W = w;
    this.H = h;
    this.top = h * 0.315;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    if (this.gl) this.gl.resize(w, h, dpr, this.top);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildLines();
    this.makeGrain();
    this.render();
  }

  buildLines() {
    this.lines = [];
    const top = this.top;
    const bottom = this.H + 3;
    for (let i = 0; i < this.N; i++) {
      const q = i / (this.N - 1);
      const d = Math.pow(q, 1.5);
      const y = top + (bottom - top) * Math.pow(q, 1.18);
      this.lines.push({
        i,
        q,
        d,
        y,
        phase: hash(i * 7.13 + 3.7) * TAU,
        presence: 0.2 + 0.8 * hash(i * 3.1 + 9.2),
        stops: Array.from({ length: 12 }, (_, k) => 0.2 + 0.9 * hash(i * 5.7 + k * 13.1 + 1.1)),
        width: 0.5 + 1.35 * Math.pow(d, 1.15),
        freqMul: 0.9 + 0.2 * hash(i * 2.7 + 7.7),
        speedMul: 0.7 + 0.65 * hash(i * 4.3 + 2.2),
        ambient: 0.7 + 0.6 * hash(i * 8.9 + 4.4),
      });
    }
  }

  // ---------- 时间轴 ----------

  setTimeline(tl, at = 0) {
    this.timeline = tl;
    this.events = tl && Array.isArray(tl.events) ? tl.events : [];
    this.duration = tl ? tl.totalSec : 0;
    this.seek(at);
  }

  setIdle() {
    this.timeline = null;
    this.events = [];
    this.duration = 0;
    this.evIndex = 0;
    this.phrase = null;
    this.env = this.freshEnv();
    this.ripples.length = 0;
    this.rings.length = 0;
    this.crest = null;
    this.bassX = 0.5;
    this.bassTarget = 0.5;
    this.windSign = 1;
    this.windDirVis = 1;
    this.windPhase = 0;
    this.driftScreens = 0;
    this.driftRate = 0;
    // 水面相位的积分（世界米）。不能用「当前风速 × 绝对时间」，
    // 否则风一抖，整片水会前后抽动，横向位移就读不出来。
    this.flowAdv = 0;
    this.flowRate = 0;
    this.lastNoteAt = -99;
  }

  reset(t) {
    this.time = Math.max(0, t);
    this.env = this.freshEnv();
    this.visEnv = this.freshEnv();
    this.ripples.length = 0;
    this.rings.length = 0;
    this.crest = null;
    this.bassX = 0.5;
    this.bassTarget = 0.5;
    this.prevDeg = null;
    this.flowTarget = 0;
    this.windSign = 1;
    this.windDirVis = 1;
    this.windPhase = 0;
    this.driftScreens = 0;
    this.driftRate = 0;
    // 水面相位的积分（世界米）。不能用「当前风速 × 绝对时间」，
    // 否则风一抖，整片水会前后抽动，横向位移就读不出来。
    this.flowAdv = 0;
    this.flowRate = 0;
    this.lastNoteAt = -99;
    this.phrase = null;
    this.evIndex = 0;
    // 跳过已经过去的事件；seek 时由 seek() 从 8 秒前开始重建余波。
    while (this.evIndex < this.events.length && this.events[this.evIndex].t < this.time - 1e-9) {
      this.evIndex++;
    }
    this.updatePhrase();
  }

  seek(t) {
    const from = Math.max(0, t - 8);
    this.reset(from);
    this.advanceTo(t);
    this.render();
  }

  advanceTo(t) {
    if (!Number.isFinite(t)) return;
    if (t < this.time - 0.05) {
      this.reset(Math.max(0, t - 8));
    }
    let guard = 0;
    while (this.time < t - 1e-6 && guard++ < 20000) {
      const dt = Math.min(1 / 30, t - this.time);
      this.step(dt);
    }
    this.updatePhrase();
  }

  tick(dt) {
    if (dt <= 0) return;
    this.step(Math.min(dt, 0.1));
    this.updatePhrase();
  }

  updatePhrase() {
    if (!this.timeline || !this.timeline.marks) {
      this.phrase = null;
      return;
    }
    const prev = this.phrase;
    let p = null;
    const marks = this.timeline.marks;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] <= this.time + 1e-6) p = i;
      else break;
    }
    this.phrase = p;
    // 没有 .qin、只有句界时：按句起手，给一个很小、很含蓄的动作。
    // 不假装知道音符，只是「这一句开始了」。
    if (
      this.timeline.fallback === 'phrase' &&
      prev != null &&
      p != null &&
      p !== prev
    ) {
      this.env.amp = Math.min(1.1, this.env.amp + 0.1);
      this.env.density = Math.min(2, this.env.density + 0.1);
      this.lastNoteAt = this.time;
      this.addRipple(0.5, 0.62, 0.45, false);
      if (p % 2 === 0) {
        this.addRing(0.5, 0.62, { rMax: this.W * 0.055, life: 2.4, alpha: 0.1 });
      }
    }
  }

  // ---------- 步进 ----------

  step(dt) {
    this.time += dt;
    this.processEvents(this.time);
    this.updateEnv(dt);
    this.updateBass(dt);
    this.updateVis(dt);
    if (this.ripples.length) {
      for (const r of this.ripples) r.x += this.driftRate * dt * 0.65;
      this.ripples = this.ripples.filter((r) => this.time - r.born < r.life * 1.35);
    }
    if (this.rings.length) {
      for (const r of this.rings) r.x += this.driftRate * dt * 0.65;
      this.rings = this.rings.filter((r) => this.time - r.born < r.life);
    }
    if (this.crest && this.time - this.crest.born > this.crest.life) this.crest = null;
  }

  processEvents(t) {
    while (this.evIndex < this.events.length && this.events[this.evIndex].t <= t + 1e-9) {
      const ev = this.events[this.evIndex++];
      this.onNote(ev);
    }
  }

  updateEnv(dt) {
    const e = this.env;

    // 快速串只提高「密」和「高度」，不提高「扩散」——暗潮要憋住。
    e.density *= Math.exp(-dt / 1.45);
    e.chop *= Math.exp(-dt / 2.2);
    e.amp *= Math.exp(-dt / 2.9);
    e.bass *= Math.exp(-dt / 7.5);
    e.sweepPulse *= Math.exp(-dt / 1.15);
    e.wind *= Math.exp(-dt / 2.6);

    // 曲子在走的时候，风一直在，只是大小不同；曲子停下才真正无风。
    // 起手前同样无风：谱子已加载但还没出声时，水面必须是静的。
    const marks = this.timeline && this.timeline.marks;
    const started = this.evIndex > 0 || (this.timeline && this.timeline.fallback === 'phrase' && this.phrase != null);
    const playingPiece =
      this.timeline &&
      marks &&
      marks.length &&
      started &&
      this.time >= marks[0] &&
      this.time < (this.timeline.bodyEnd || this.duration);
    if (playingPiece) e.wind = Math.max(e.wind, 0.1 + 0.18 * (1 - e.calm));

    // 风向要明确：乐句只决定「往左还是往右」，不决定「几乎不走」。
    // 过零点带迟滞，避免风向在零点附近来回抖。
    const fRaw = Math.tanh(e.flow * 2.4);
    if (fRaw > 0.18) this.windSign = 1;
    else if (fRaw < -0.18) this.windSign = -1;
    // 底速保证任何时刻都能读出横向流动；乐句只在上面加减。
    const wdir = this.windSign * (0.62 + 0.38 * Math.abs(fRaw));
    this.windDirVis = wdir;

    // 顺着同一股水流累计相位。风速变化只改变「接下来走多快」，
    // 已经走过的距离不会被改写——这是横向位移能被眼睛跟住的前提。
    // 没风就是真没风（静水时画面不许自己动）。
    //
    // 这里必须用平滑后的风（visEnv）。flowRate 直接进 uFlowSpeed，
    // 而着色器里涟漪中心是 A.xy + vec2(uFlowSpeed * age, 0) 反推出来的：
    // 一帧的阶跃会让所有还活着的涟漪整体瞬移 age*Δv，2 秒龄就是一帧挪十几像素。
    const vw = (this.visEnv || e).wind;
    const windActive = vw > 0.02;
    // 开关也做软：硬门限在 0.02 处会从 0.42 直接砍到 0，本身就是一次跳变。
    const g = Math.min(1, Math.max(0, (vw - 0.02) / 0.08));
    this.flowRate = (0.40 + 0.80 * vw) * (g * g * (3 - 2 * g));
    this.flowAdv += dt * this.flowRate * wdir;

    // 慢到眼睛能跟住：大约 4–12 秒扫过一屏，而不是一闪而过。
    const wspeed = 0.008 + 0.035 * e.chop + 0.016 * e.wind;
    this.windPhase += dt * TAU * wspeed * wdir;

    // 整个水面顺着水流横移。这个量是「画幅/秒」，不随涟漪频率变化。
    const driftSpeed = windActive ? (0.010 + 0.030 * e.wind + 0.010 * e.chop) * wdir : 0;
    this.driftScreens += dt * driftSpeed;
    this.driftRate = driftSpeed;
    e.suspended *= Math.exp(-dt / 7);

    if (e.close > 0) {
      e.close *= Math.exp(-dt / 3.4);
      if (e.close < 0.004) e.close = 0;
    }

    const quiet = this.time - this.lastNoteAt;
    let calmTarget = quiet > 1.35 ? 1 : quiet > 0.5 ? 0.34 : 0.06;
    if (e.close > 0.25) calmTarget = Math.max(calmTarget, 0.55 + 0.45 * e.close);
    if (e.suspended > 0.4) calmTarget = Math.min(calmTarget, 0.32);
    const calmTau = calmTarget > e.calm ? 0.85 : e.chop > 0.35 ? 0.45 : 1.7;
    e.calm += (calmTarget - e.calm) * (1 - Math.exp(-dt / calmTau));

    // 扩散范围：平时收着；扫弦时炸开一次；悬置时慢慢散；落 1 时合拢。
    let spreadTarget = 0.045;
    let spreadTau = 2.1;
    if (e.suspended > 0.4) {
      spreadTarget = 0.2 + 0.16 * e.suspended;
      spreadTau = 2.8;
    }
    if (e.close > 0.15) {
      spreadTarget = 0.02;
      spreadTau = 0.7 + 1.4 * (1 - e.close);
    }
    e.spread += (spreadTarget - e.spread) * (1 - Math.exp(-dt / spreadTau));

    // 五度链走向 -> 水流方向
    e.flow += (this.flowTarget - e.flow) * (1 - Math.exp(-dt / 2.4));
  }

  updateBass(dt) {
    const e = this.env;
    const rate = 0.008 + 0.024 * e.bass; // 每秒最多走多少画幅：慢，但不能看不出来
    const delta = this.bassTarget - this.bassX;
    this.bassX += clamp(delta, -rate * dt, rate * dt);
    if (e.bass < 0.08) {
      const idleTarget = 0.5 + 0.045 * Math.sin(this.time * 0.085);
      this.bassX += (idleTarget - this.bassX) * (1 - Math.exp(-dt / 7));
    }
  }

  onNote(ev) {
    const v = ev.vel / 127;
    const fast = ev.dur <= 150;
    const e = this.env;
    this.lastNoteAt = this.time;

    e.density = Math.min(2.6, e.density + (fast ? 0.62 : 0.1));
    if (fast) e.chop = Math.min(1.18, e.chop + 0.042 + 0.05 * v);
    e.amp = Math.min(1.5, e.amp + (fast ? 0.024 : 0.115) + (fast ? 0.05 : 0.08) * v);
    e.wind = Math.min(1, e.wind + (fast ? 0.035 : 0.1) + 0.05 * v);

    const x = this.xOf(ev.deg, ev.oct);
    const d = this.dOf(ev.deg, ev.oct);
    // 音高的归一值（0 = 最低，1 = 最高），和 xOf 的 p 同一套格子：
    // 所以「高音更亮」在画面上就是「右边那一带的涟漪更亮」，不是另一套坐标。
    const pitch = clamp(((DEG_ORDER[ev.deg] ?? 0) + (ev.oct || 0) * 5 + 5) / 14, 0, 1);

    this.updateFlow(ev);

    if (ev.oct === -1 && ev.dur >= 500) {
      e.bass = Math.min(1, e.bass + 0.72 + 0.28 * v);
      this.bassTarget = clamp(0.5 + (x - 0.5) * 0.58, 0.28, 0.72);
      this.addRing(x, Math.min(0.96, d + 0.06), {
        rMax: this.W * (0.13 + 0.07 * v),
        life: 4.4,
        alpha: 0.34,
      });
    }

    if (ev.sweep) {
      this.fireSweep(ev, x, d, v);
    } else {
      this.addRipple(x, d, v, fast, pitch);
      if (!fast && ev.dur >= 600) {
        this.addRing(x, d, {
          rMax: this.W * (0.04 + 0.085 * e.spread + 0.04 * v),
          life: 2.9 + 0.9 * e.spread,
          alpha: 0.28 + 0.12 * v,
        });
      }
    }

    if (!ev.last) {
      // 已经落下的句子，如果新的一句马上又进来，水面要重新被推开。
      e.close *= fast ? 0.42 : 0.9;
      if (e.close < 0.008) e.close = 0;
    }

    if (ev.last) {
      e.suspended = 0;
      if (ev.deg === 1) {
        // 落 1（宫）：水面合拢。不是全屏闪一下，而是把已经铺开的余波收回来。
        e.close = 1;
        e.chop *= 0.62;
        e.amp *= 0.82;
        e.spread *= 0.86;
        e.calm = Math.min(1, e.calm + 0.22);
      }
      if (ev.open) e.suspended = 1;
    }
  }

  updateFlow(ev) {
    const idx = FIFTH_INDEX[ev.deg];
    if (idx == null) return;
    if (this.prevDeg != null) {
      const prev = FIFTH_INDEX[this.prevDeg];
      if (prev != null) {
        const step = (idx - prev + 5) % 5;
        const dir = step === 0 ? 0 : step <= 2 ? 1 : -1;
        this.flowTarget = clamp(this.flowTarget * 0.72 + dir * 0.28, -1, 1);
      }
    }
    this.prevDeg = ev.deg;
  }

  addRipple(x, d, v, fast, pitch = 0.5) {
    const e = this.env;
    const amp = fast ? 2.0 + 2.6 * v : 1.8 + 2.6 * v;
    const sigma = fast
      ? 0.016 + 0.015 * v
      : 0.048 + 0.028 * v + 0.052 * e.spread;
    const life = fast ? 0.30 + 0.15 * v : 1.05 + 0.55 * v;
    if (this.ripples.length > 30) this.ripples.shift();
    this.ripples.push({
      born: this.time,
      x,
      d,
      amp,
      sigma,
      // 力度和音高各留一份原值下去：渲染那边要用它决定「这滴能扩多大」「这滴多亮」。
      // 别在这里就折算成尺寸——扩散大小是画面的事，不是水的事。
      vel: v,
      pitch,
      k: TAU * (fast ? 8.5 : 3.1) * (0.85 + 0.45 * e.spread),
      omega: TAU * (fast ? 2.7 : 1.05),
      phase: hash(x * 91.7 + d * 37.3 + this.time * 13.1) * TAU,
      life,
      fast,
    });
  }

  addRing(x, d, { rMax, life, alpha }) {
    if (this.rings.length > 14) this.rings.shift();
    this.rings.push({
      born: this.time,
      x,
      d,
      r0: Math.max(6, this.W * 0.006),
      rMax,
      life,
      alpha,
    });
  }

  fireSweep(ev, x, d, v) {
    const e = this.env;
    e.spread = Math.min(1, Math.max(e.spread, 0.7 + 0.24 * v));
    e.sweepPulse = 1;
    e.wind = 1;
    e.chop = Math.min(1.18, e.chop + 0.13);
    e.amp = Math.min(1.5, e.amp + 0.2);
    const dir = ev.sweep.mode === 'down' ? -1 : 1;
    this.crest = {
      born: this.time,
      life: 1.45,
      dir,
      from: dir > 0 ? -0.1 : 1.1,
      to: dir > 0 ? 1.1 : -0.1,
      d: clamp(0.5 + (d - 0.6) * 0.35, 0.46, 0.66),
      amp: 22 + 22 * v,
      v,
    };
    this.addRing(clamp(x, 0.3, 0.7), d, {
      rMax: this.W * 0.3,
      life: 2.7,
      alpha: 0.26,
    });
  }

  // ---------- 映射 ----------

  xOf(deg, oct) {
    const p = (DEG_ORDER[deg] ?? 0) + (oct || 0) * 5;
    return clamp(0.12 + 0.76 * ((p + 5) / 14), 0.08, 0.92);
  }

  dOf(deg, oct) {
    const jitter = (hash(deg * 13 + (oct || 0) * 7 + 3) - 0.5) * 0.07;
    return clamp(0.64 - (oct || 0) * 0.2 + jitter, 0.26, 0.93);
  }

  yAtDepth(d) {
    const q = Math.pow(clamp(d, 0, 1), 1 / 1.5);
    return this.top + (this.H + 3 - this.top) * Math.pow(q, 1.18);
  }

  bandWidth() {
    return 0.115 + 0.5 * this.env.spread;
  }

  lineAmp(d) {
    const e = this.env;
    const band = Math.exp(-Math.pow(d - 0.6, 2) / (2 * Math.pow(this.bandWidth(), 2)));
    return (
      (0.4 + 8.8 * Math.pow(d, 1.35)) *
      (0.2 + 1.65 * e.amp) *
      (0.18 + 0.82 * band) *
      (1 - 0.55 * e.close) *
      (1 - 0.62 * e.calm)
    );
  }

  rippleDisp(u, d) {
    let y = 0;
    const sigD = 0.12 + 0.22 * this.env.spread;
    for (let i = 0; i < this.ripples.length; i++) {
      const r = this.ripples[i];
      const dd = d - r.d;
      if (dd > sigD * 2.4 || dd < -sigD * 2.4) continue;
      const age = this.time - r.born;
      if (age < 0 || age > r.life * 1.35) continue;
      const dx = u - r.x;
      if (dx > r.sigma * 3.4 || dx < -r.sigma * 3.4) continue;
      const envx = Math.exp(-(dx * dx) / (2 * r.sigma * r.sigma));
      const envd = Math.exp(-(dd * dd) / (2 * sigD * sigD));
      const fade = Math.exp(-(age / r.life) * 2.1);
      y += r.amp * envx * envd * fade * Math.cos(dx * r.k - age * r.omega + r.phase);
    }
    return y;
  }

  crestX() {
    if (!this.crest) return 0;
    const c = this.crest;
    const p = clamp((this.time - c.born) / c.life, 0, 1);
    return lerp(c.from, c.to, 1 - Math.pow(1 - p, 2.1));
  }

  crestDisp(u, d) {
    const c = this.crest;
    if (!c) return 0;
    const age = this.time - c.born;
    if (age < 0 || age > c.life) return 0;
    const p = age / c.life;
    const fade = Math.pow(1 - p, 1.35);
    const x = this.crestX();
    const sig = 0.06 + 0.07 * this.env.spread;
    const gx = Math.exp(-Math.pow(u - x, 2) / (2 * sig * sig));
    const gd = Math.exp(-Math.pow(d - c.d, 2) / (2 * 0.17 * 0.17));
    return c.amp * gx * gd * fade;
  }

  dispAt(u, d, line = null) {
    const e = this.env;
    const band = Math.exp(-Math.pow(d - 0.6, 2) / (2 * Math.pow(this.bandWidth(), 2)));
    const amp = this.lineAmp(d) * (line ? 0.82 + 0.36 * line.ambient : 1);
    const freq = (1.0 + 10.5 * e.chop + 0.6 * e.density) * (line ? line.freqMul : 1);
    const phase =
      (line ? line.phase : hash(d * 21.7) * TAU) +
      hash(u * 4.7 + d * 21.7) * 0.2 +
      this.time * (0.18 + 0.55 * e.chop) * (line ? line.speedMul : 1) +
      e.flow * 0.85 * u;

    const uu = u - this.driftScreens;
    let base =
      amp *
      (0.72 * Math.sin(TAU * freq * uu + phase) +
        0.28 * Math.sin(TAU * freq * 2.07 * uu - phase * 0.73 + 1.9));

    // 细密但不是更大幅度的颤动：暗潮里让人听见「手指快」，不看见「浪更大」。
    base += amp * 0.52 * e.chop * (0.25 + 0.75 * band) * Math.sin(TAU * freq * 2.65 * uu + phase * 1.7 + d * 3.1);

    // 风的方向：一片更粗糙的水（风的印子）顺着五度链的走向横着走。
    // 风还是不画，只让水在它经过的地方起伏得更明显。
    let y = base;

    // 一点点不动的斜面/弯曲：水不是一叠等距的梳齿。
    y += (0.6 + 3.2 * d) * Math.sin(TAU * (0.62 * u + 0.15 * d) + 1.1);

    if (e.wind > 0.02) {
      const windMod =
        1 +
        1.05 *
          e.wind *
          Math.sin(TAU * 0.33 * u - this.windPhase + d * 1.15 + (line ? line.phase * 0.15 : 0));
      y *= windMod;
      // 再叠一道很宽、很慢的涌，给一个明确的「往前推」。
      y +=
        amp *
        (0.22 + 0.45 * e.wind) *
        (0.3 + 0.7 * band) *
        Math.sin(TAU * 0.4 * u - this.windPhase + d * 1.4 + (line ? line.phase * 0.1 : 0));
    }

    // 深水的慢速底流：只在低音出现时，把靠近观众的水面慢慢推一下。
    if (d > 0.58) {
      const deep = (d - 0.58) / 0.42;
      y += e.bass * (0.7 + 2.4 * deep) * deep * Math.sin(TAU * 0.31 * u + this.time * 0.42 + d * 2.6);
    }

    y += this.rippleDisp(u, d);
    y -= this.crestDisp(u, d);
    return y;
  }

  // ---------- 绘制 ----------

  render() {
    if (this.gl) {
      this.gl.draw(this);
      if (this.onFrame) this.onFrame(this.metrics());
      return;
    }
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    this.drawBackground(ctx, W, H);
    this.drawBassMass(ctx, W, H);
    this.drawPools(ctx, W, H);
    this.drawWater(ctx, W, H);
    this.drawWindSheen(ctx, W, H);
    this.drawRings(ctx);
    this.drawCrest(ctx, W);
    this.drawGrain(ctx, W, H);
    this.drawVignette(ctx, W, H);

    if (this.onFrame) this.onFrame(this.metrics());
  }

  drawBackground(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1719');
    g.addColorStop(0.28, '#132a2c');
    g.addColorStop(0.55, '#152c2e');
    g.addColorStop(0.82, '#112425');
    g.addColorStop(1, '#0c1b1d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 远处的水平微光，像夜色里分不清是水还是雾的一条线。
    const hz = ctx.createRadialGradient(W * 0.5, this.top, 0, W * 0.5, this.top, W * 0.62);
    hz.addColorStop(0, 'rgba(118,168,172,0.14)');
    hz.addColorStop(0.42, 'rgba(62,102,106,0.05)');
    hz.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hz;
    ctx.fillRect(0, 0, W, H);

    // 地平线上方一层极淡的雾，别让上半屏只剩一条渐变。
    const mist = ctx.createLinearGradient(0, H * 0.1, 0, H * 0.36);
    mist.addColorStop(0, 'rgba(92,132,132,0)');
    mist.addColorStop(0.62, 'rgba(92,132,132,0.028)');
    mist.addColorStop(1, 'rgba(92,132,132,0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, H * 0.1, W, H * 0.26);

    // 远处水面的薄光，让上半屏不是一块死黑。
    const wash = ctx.createLinearGradient(0, this.top - H * 0.03, 0, H * 0.72);
    wash.addColorStop(0, 'rgba(86,138,136,0)');
    wash.addColorStop(0.3, 'rgba(86,138,136,0.045)');
    wash.addColorStop(0.7, 'rgba(74,120,118,0.022)');
    wash.addColorStop(1, 'rgba(74,120,118,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, this.top - H * 0.03, W, H * 0.75 - this.top);
  }

  drawBassMass(ctx, W, H) {
    // 底部一层极淡的反光，暗影经过时才有东西可以遮住。
    const sheen = ctx.createLinearGradient(0, H * 0.78, 0, H);
    sheen.addColorStop(0, 'rgba(74,116,110,0)');
    sheen.addColorStop(0.58, 'rgba(74,116,110,0.085)');
    sheen.addColorStop(0.9, 'rgba(60,98,94,0.055)');
    sheen.addColorStop(1, 'rgba(60,98,94,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, H * 0.78, W, H * 0.22);

    const bx = this.bassX * W;
    const by = H * 0.9;
    const rx = W * (0.38 + 0.08 * this.env.bass);
    const ry = H * (0.13 + 0.04 * this.env.bass);
    ctx.save();
    ctx.translate(bx, by);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'rgba(0,3,4,0.9)');
    g.addColorStop(0.5, 'rgba(0,3,4,0.58)');
    g.addColorStop(0.78, 'rgba(0,3,4,0.22)');
    g.addColorStop(1, 'rgba(0,4,5,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawWater(ctx, W, H) {
    const e = this.env;
    const step = W / 150;
    const calmLight = 1 - 0.28 * e.calm;
    const quality = 1 + 0.25 * e.sweepPulse;

    for (let li = 0; li < this.lines.length; li++) {
      const line = this.lines[li];
      const d = line.d;
      const baseAlpha =
        (0.042 + 0.235 * Math.pow(d, 1.15)) *
        line.presence *
        calmLight *
        (0.95 + 0.3 * e.amp);

      // 水光的明暗本身也在走：亮的地方是风经过的水，暗的地方是墨断。
      // 如果明暗钉死在屏幕上，水形在动也会被人看成一张静态贴图。
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      const NS = 12;
      for (let k = 0; k < NS; k++) {
        const uA = k / (NS - 1);
        const edge = k === 0 || k === NS - 1 ? 0.3 : 1;
        const travel = uA - this.driftScreens * 0.9;
        const flowBand =
          0.45 + 0.55 * Math.sin(TAU * 1.05 * travel + line.phase * 0.6 + d * 2.1);
        const windBand =
          1 +
          0.95 *
            e.wind *
            Math.sin(TAU * 0.33 * travel - this.windPhase + d * 1.15 + line.phase * 0.08);
        const staticVar = 0.55 + 0.6 * line.stops[k % 6];
        const a = clamp(
          baseAlpha * staticVar * flowBand * windBand * edge * (k === 6 ? quality : 1),
          0,
          0.9
        );
        grad.addColorStop(uA, rgba(202, 230, 224, a));
      }

      ctx.beginPath();
      for (let x = -step; x <= W + step; x += step) {
        const u = x / W;
        const y = line.y + this.dispAt(u, d, line);
        if (x <= 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = grad;
      ctx.lineWidth = line.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 贴近观众的线多一层很淡的辉光，水才有厚度，不是钢丝。
      if (d > 0.34) {
        ctx.strokeStyle = rgba(166, 210, 204, baseAlpha * 0.24);
        ctx.lineWidth = line.width + 3.2 + 2.6 * d;
        ctx.stroke();
      }
    }
  }

  drawWindSheen(ctx, W, H) {
    const e = this.env;
    if (e.wind < 0.06) return;
    const cycle = 1 / 0.33;
    const raw = this.windPhase / (TAU * 0.33);
    const base = ((raw % cycle) + cycle) % cycle;
    const alpha = 0.07 * e.wind * (1 - 0.35 * e.calm);
    if (alpha < 0.002) return;
    const dir = e.flow >= 0 ? 1 : -1;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const off of [-cycle, 0, cycle]) {
      for (const [lag, mul, rr] of [[0, 1, 0.27], [-dir * 0.14, 0.32, 0.34]]) {
        const xn = base + off + lag;
        if (xn < -0.35 || xn > 1.35) continue;
        const x = xn * W;
        const y = H * 0.7 + this.dispAt(clamp(xn, 0, 1), 0.58, null) * 0.9;
        const a = alpha * mul;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, 0.42);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, W * rr);
        g.addColorStop(0, rgba(168, 214, 206, a));
        g.addColorStop(0.55, rgba(140, 190, 184, a * 0.5));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, W * rr, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawRings(ctx) {
    if (!this.rings.length) return;
    const e = this.env;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const age = this.time - r.born;
      if (age < 0 || age >= r.life) continue;
      const p = age / r.life;
      const grow = 1 - Math.pow(1 - p, 2.6);
      const rx = r.r0 + (r.rMax - r.r0) * grow * (1 - 0.55 * e.close);
      const ry = rx * 0.2;
      const y = this.yAtDepth(r.d);
      const alpha = r.alpha * Math.pow(1 - p, 1.8) * (1 - 0.55 * e.calm);
      if (alpha <= 0.001) continue;
      ctx.beginPath();
      ctx.ellipse(r.x * this.W, y, rx, ry, 0, 0, TAU);
      ctx.strokeStyle = rgba(196, 232, 226, alpha);
      ctx.lineWidth = 1.15;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCrest(ctx, W) {
    const c = this.crest;
    if (!c) return;
    const age = this.time - c.born;
    if (age < 0 || age > c.life) return;
    const p = age / c.life;
    const fade = Math.pow(1 - p, 1.25);
    const xn = this.crestX();
    const x = xn * W;
    const d = c.d;

    // 只画波痕附近的一段，是一道「横向波痕」，不是横贯全屏的亮线。
    const x0 = Math.max(0, x - W * 0.17);
    const x1 = Math.min(W, x + W * 0.17);
    const step = Math.max(2, W / 260);
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, rgba(232, 249, 243, 0.62 * fade));
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    const glow = ctx.createLinearGradient(x0, 0, x1, 0);
    glow.addColorStop(0, 'rgba(0,0,0,0)');
    glow.addColorStop(0.5, rgba(176, 226, 218, 0.14 * fade));
    glow.addColorStop(1, 'rgba(0,0,0,0)');

    const path = () => {
      ctx.beginPath();
      for (let px = x0; px <= x1; px += step) {
        const u = px / W;
        const y = this.yAtDepth(d) + this.dispAt(u, d) * 1.1;
        if (px === x0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
    };

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    path();
    ctx.strokeStyle = glow;
    ctx.lineWidth = 11;
    ctx.stroke();
    path();
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.35;
    ctx.stroke();

    // 波痕后面跟一条更淡的水脊，才像一整道波，不是一根亮线。
    ctx.save();
    ctx.translate(0, 9 + 5 * fade);
    path();
    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.0;
    ctx.stroke();
    ctx.restore();

    // 波痕前方的一点亮，像风把光推着走。位置随波痕，不另生粒子。
    const yy = this.yAtDepth(d) + this.dispAt(xn, d) * 1.1;
    const g = ctx.createRadialGradient(x, yy, 0, x, yy, Math.max(40, W * 0.08));
    g.addColorStop(0, rgba(210, 242, 236, 0.24 * fade));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - W * 0.1, yy - 60, W * 0.2, 120);
    ctx.restore();
  }

  drawPools(ctx, W, H) {
    const e = this.env;
    const t = this.time;
    const pools = [
      { bx: 0.22, y: 0.63, r: 0.14, a: 0.135, ph: 0.0, spd: 0.71 },
      { bx: 0.52, y: 0.72, r: 0.17, a: 0.145, ph: 2.1, spd: 0.53 },
      { bx: 0.79, y: 0.58, r: 0.12, a: 0.115, ph: 4.2, spd: 0.87 },
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const activity = clamp(e.chop * 1.2 + e.density * 0.35 + e.bass * 0.3, 0, 1);

    for (const p of pools) {
      const converge = clamp(e.calm * 0.85 + e.close * 0.35, 0, 1);
      const drift =
        (1 - converge) *
          (0.13 * Math.sin(t * 0.09 * p.spd + p.ph) +
            0.12 * e.flow +
            0.035 * Math.sin(t * (0.5 + 1.6 * activity) * p.spd + p.ph) * activity) +
        0.04 * Math.sin(t * 0.05 * p.spd + p.ph + 1.3) +
        e.sweepPulse * 0.018 * Math.sin(t * 2.6 + p.ph);
      const x = (lerp(p.bx, 0.5 + (p.bx - 0.5) * 0.28, converge) + drift) * W;
      // 光斑长在水上：跟着当地水面一起上下，不然像贴上去的。
      const surfaceY = this.dispAt(clamp(x / W, 0, 1), 0.58, null);
      const y = lerp(p.y, 0.7 + (p.y - 0.7) * 0.72, converge) * H + surfaceY * 1.8;
      const spread = 1 + 0.95 * e.spread - 0.32 * converge;
      const rx = W * p.r * spread;
      const ry = Math.max(18, rx * 0.26);
      const breathe =
        1 +
        0.1 * Math.sin(t * 0.14 * p.spd + p.ph) +
        0.08 * Math.sin(t * (0.35 + 1.1 * activity) * p.spd + p.ph) * activity +
        0.18 * e.sweepPulse * Math.sin(t * 3.1 + p.ph);
      const alpha =
        p.a *
        (0.55 + 0.7 * converge) *
        (1 - 0.45 * e.spread + 0.15 * e.sweepPulse) *
        breathe;

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, rgba(190, 224, 216, alpha));
      g.addColorStop(0.35, rgba(160, 200, 194, alpha * 0.55));
      g.addColorStop(0.72, rgba(120, 160, 156, alpha * 0.16));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, TAU);
      ctx.fill();

      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 0.32);
      core.addColorStop(0, rgba(216, 240, 232, alpha * 1.15));
      core.addColorStop(0.55, rgba(170, 210, 202, alpha * 0.45));
      core.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, rx * 0.32, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  drawGrain(ctx, W, H) {
    if (!this.grainPattern) return;
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  makeGrain() {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 160;
    const g = c.getContext('2d');
    const img = g.createImageData(160, 160);
    let seed = 1337;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = 96 + (seed >>> 24) * 0.34;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.grainPattern = this.ctx.createPattern(c, 'repeat');
  }

  drawVignette(ctx, W, H) {
    const v = ctx.createRadialGradient(
      W * 0.5,
      H * 0.54,
      Math.min(W, H) * 0.24,
      W * 0.5,
      H * 0.54,
      Math.max(W, H) * 0.8
    );
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(0.72, 'rgba(0,0,0,0.08)');
    v.addColorStop(1, 'rgba(0,0,0,0.36)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    // 顶部压暗，保证曲名/句数永远可读（文字是 DOM，不进 canvas）
    const top = ctx.createLinearGradient(0, 0, 0, H * 0.3);
    top.addColorStop(0, 'rgba(2,5,6,0.46)');
    top.addColorStop(1, 'rgba(2,5,6,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, H * 0.3);
  }

  // ---------- 量尺 ----------

  metrics() {
    const e = this.env;
    const near = this.lines[this.lines.length - 3];
    const mid = this.lines[Math.round(this.lines.length * 0.66)];
    return {
      t: Math.round(this.time * 1000) / 1000,
      title: this.timeline ? this.timeline.title : this.label,
      phrase: this.phrase,
      phraseCount: this.timeline ? this.timeline.phrases.length : null,
      playing: this.playing,
      density: +e.density.toFixed(4),
      chop: +e.chop.toFixed(4),
      ampEnv: +e.amp.toFixed(4),
      spread: +e.spread.toFixed(4),
      bandWidth: +this.bandWidth().toFixed(4),
      rippleFreq: +(1.0 + 10.5 * e.chop + 0.6 * e.density).toFixed(3),
      calm: +e.calm.toFixed(4),
      close: +e.close.toFixed(4),
      suspended: +e.suspended.toFixed(4),
      bass: +e.bass.toFixed(4),
      flow: +e.flow.toFixed(4),
      driftScreens: +this.driftScreens.toFixed(4),
      flowAdv: +this.flowAdv.toFixed(3),
      wind: +e.wind.toFixed(4),
      windDir: +this.windDirVis.toFixed(3),
      windPhase: +this.windPhase.toFixed(3),
      bottomShiftPx: Math.round((this.bassX - 0.5) * this.W * 10) / 10,
      bassX: +this.bassX.toFixed(4),
      lineAmpMid: +this.lineAmp(mid ? mid.d : 0.6).toFixed(3),
      lineAmpNear: +this.lineAmp(near ? near.d : 1).toFixed(3),
      crestAge: this.crest ? Math.round((this.time - this.crest.born) * 1000) / 1000 : null,
      ripples: this.ripples.length,
      rings: this.rings.length,
      render: this.gl ? 'gl' : 'lines',
    };
  }

  /**
   * 故意用「真实像素差」量静水，而不是只看参数。
   * 在 t 渲染一张，前进 dt 再渲染一张，返回两者平均绝对差（0..255）。
   */
  motionProbe(t, dt = 0.6) {
    this.seek(t);
    this.render();
    const c = this.canvas;
    const a = this.gl ? this.gl.readPixels() : this.ctx.getImageData(0, 0, c.width, c.height).data;
    this.advanceTo(t + dt);
    this.render();
    const b = this.gl ? this.gl.readPixels() : this.ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let n = 0;
    const stride = 4 * 7;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += stride) {
      sum += Math.abs(a[i] - b[i]);
      n++;
    }
    return Math.round((sum / Math.max(1, n)) * 1000) / 1000;
  }
}
