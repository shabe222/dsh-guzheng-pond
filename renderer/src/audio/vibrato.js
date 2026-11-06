/**
 * 吟猱（揉弦）—— 古琴左手的持续摆动
 *
 * 与绰注的区别：
 *   绰注 = 一次性滑向目标（单调收敛）
 *   吟猱 = 按住之后持续小幅摆动（振荡），像人声的颤动
 *
 * 古籍区分：
 *   吟 —— 幅度小、频率快，轻微晃动。（约 30-60 音分，5-7Hz）
 *   猱 —— 幅度大、频率慢，深沉摇曳。（约 60-120 音分，2-4Hz）
 *
 * 要点：
 *   1. 不是从头开始摆，是**音出来之后才慢慢起摆**（起手先定住）
 *   2. 摆动幅度随时间**衰减**（越来越安静）
 *   3. 不是纯正弦——带一点不规则，像手不是机器
 */

const SR = 44100;

/**
 * 生成吟或猱的变速率曲线。
 * @param {'yin'|'nao'} kind
 * @param {number} strength 0..1
 * @param {number[]} baseCents 每次采样的音分偏移（累积）
 */
export function vibratoCurve(kind, strength, totalSec) {
  const isNaO = kind === "nao";
  // 吟：快而小；猱：慢而大
  const depth = isNaO ? (60 + strength * 60) : (30 + strength * 30);
  const rate  = isNaO ? (2.6 + strength * 1.4) : (5.2 + strength * 1.8);
  // 起摆延迟：音出来先定住 0.15-0.3 秒
  const onset = 0.15 + strength * 0.12;
  // 衰减时间常数
  const decayTau = isNaO ? 1.6 : 1.1;

  const n = Math.floor(totalSec * SR);
  const cents = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (t < onset) { cents[i] = 0; continue; }
    const dt = t - onset;
    // 起摆渐入（smoothstep 前 0.2 秒）
    const fadeIn = Math.min(1, dt / 0.2);
    // 整体衰减
    const decay = Math.exp(-dt / decayTau);
    // 主振 + 一点次谐波，让它不那么机械
    const w = 2 * Math.PI * rate * dt;
    const wobble = Math.sin(w) + 0.18 * Math.sin(w * 0.5 + 0.7);
    cents[i] = depth * wobble * fadeIn * decay;
  }
  return cents;
}

/**
 * 把音分曲线应用到采样（变速率重采样）。
 */
export function renderVibrato(src, centsCurve, totalSec) {
  const n = Math.floor(totalSec * SR);
  const out = new Float32Array(n);
  let readPos = 0;
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(readPos);
    if (idx >= src.length - 1) break;
    const frac = readPos - idx;
    out[i] = src[idx] * (1 - frac) + src[idx + 1] * frac;
    const rate = Math.pow(2, (centsCurve[i] || 0) / 1200);
    readPos += rate;
  }
  const fade = Math.floor(0.12 * SR);
  for (let i = 0; i < fade && i < n; i++) out[n - 1 - i] *= i / fade;
  return out;
}

/** 一次调用：给采样加吟或猱 */
export function applyVibrato(src, kind, strength, totalSec) {
  const curve = vibratoCurve(kind, strength, totalSec);
  const out = renderVibrato(src, curve, totalSec);
  return { samples: out, curve };
}

export { SR };
