/**
 * 绰注（滑音）—— PCM 层重采样实现
 *
 * Tone.Sampler 在 v15 里拿不到 playbackRate，所以绕开它，直接对 PCM 做变速率读取。
 *
 * 绰（chao）：从低处往上滑落在目标音。急、短。
 * 注（zhu） ：从高处往下滑落在目标音。缓、深。
 *
 * 关键：滑的是「起手」，不是「收尾」。
 * 声音一出来就在移动，落到目标音才安定 —— 这是"取音"的方式，不是装饰。
 */

const SR = 44100;

/**
 * 变速率读取采样，实现滑音。
 *
 * @param {Float32Array} src   原始采样 PCM
 * @param {number} startCents  起始音分偏移（负=偏低，正=偏高）
 * @param {number} glideSec    滑到原位所需时间
 * @param {number} totalSec    整段时长
 * @param {number} curvePower  缓动指数（越大越"慢慢停住"）
 * @returns {Float32Array}
 */
export function renderWithGlide(src, startCents, glideSec, totalSec, curvePower = 2.2) {
  const outLen = Math.floor(totalSec * SR);
  const out = new Float32Array(outLen);

  let readPos = 0;
  const step = 1 / SR;   // 每个输出样本推进的时间

  for (let i = 0; i < outLen; i++) {
    const t = i / SR;

    // 当前应该是多少音分偏移
    let cents;
    if (t <= glideSec) {
      const k = t / glideSec;
      // S 形缓动（smoothstep）：慢起 -> 中途快 -> 将到目标渐缓
      // 这才像手按弦滑过去，而不是一开始猛冲
      const ease = k * k * (3 - 2 * k);
      cents = startCents * (1 - ease);
    } else {
      cents = 0;
    }

    // 音分 -> 播放速率倍数
    const rate = Math.pow(2, cents / 1200);

    // 读取源（线性插值）
    const idx = Math.floor(readPos);
    if (idx >= src.length - 1) break;
    const frac = readPos - idx;
    out[i] = src[idx] * (1 - frac) + src[idx + 1] * frac;

    readPos += rate;
  }

  // 尾部淡出，避免截断爆音
  const fade = Math.floor(0.15 * SR);
  for (let i = 0; i < fade && i < outLen; i++) {
    out[outLen - 1 - i] *= i / fade;
  }
  return out;
}

/**
 * 按音：从原位**按上去**到目标音分，然后停住（古筝得 4、7 的方法）。
 *
 * 与绰（从远处滑到本位）相反：按音是「本位起，按出去」。
 * @param {Float32Array} src
 * @param {number} cents   升多少音分（3→4 是 +100，6→7 是 +200）
 * @param {number} riseSec 按下去用多久（0.08-0.25 秒）
 * @param {number} totalSec
 */
export function renderPress(src, cents, riseSec = 0.12, totalSec = 3.0) {
  const outLen = Math.floor(totalSec * SR);
  const out = new Float32Array(outLen);
  let readPos = 0;
  for (let i = 0; i < outLen; i++) {
    const t = i / SR;
    let c;
    if (t <= riseSec) {
      const k = t / riseSec;
      c = cents * (k * k * (3 - 2 * k));   // 先慢后快再缓，像手指压下去
    } else {
      c = cents;
    }
    const rate = Math.pow(2, c / 1200);
    const idx = Math.floor(readPos);
    if (idx >= src.length - 1) break;
    const frac = readPos - idx;
    out[i] = src[idx] * (1 - frac) + src[idx + 1] * frac;
    readPos += rate;
  }
  const fade = Math.floor(0.15 * SR);
  for (let i = 0; i < fade && i < outLen; i++) out[outLen - 1 - i] *= i / fade;
  return out;
}

/**
 * 拟一个自然的滑音参数。
 * @param {'chao'|'zhu'} kind
 * @param {number} strength 0..1
 */
export function slideParams(kind, strength = 0.5) {
  if (kind === "chao") {
    // 绰：从低往上，急（0.18-0.32s），幅度 150-250 音分
    return {
      cents: -(150 + strength * 100),
      glideSec: 0.32 - strength * 0.14,
      curvePower: 2.6,
    };
  }
  // 注：从高往下，缓（0.35-0.6s），幅度 200-350 音分
  return {
    cents: 200 + strength * 150,
    glideSec: 0.35 + strength * 0.25,
    curvePower: 1.8,
  };
}

export { SR };
