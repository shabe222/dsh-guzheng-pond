// 质量门：把「自查报告」分成硬错和口味。
//
// 依据是我们 2026-10-26 定下的两档规矩：
//   硬错（必须拦）：没落 / 缺 @from@to / 留白超 / 连续同落音 / 都节外音
//   口味（只提示）：级进率、家族率、模进、句长 SD、密度、平句、峰位、句太短
//
// 插件只拦硬错。理由：检查器擅长防错，不擅长教好——拿口味当门槛，
// AI 就会把「好」理解成「过检」，所有曲子长成一个样。

/** 硬错的正则。加一条就意味着「这种谱不许进队列」。 */
export const HARD_RULES = [
  { re: /没落（结在/, why: '句子没落：落在非落点又没标 ?' },
  { re: /没有声明出口|缺 \@from|缺 \@to|@from \/ @to/, why: '谱面缺 @from / @to，渲染会报没有声明出口' },
  { re: /留白\s*\d+\s*ms\s*超过/, why: '结尾留白超过 3000ms' },
  { re: /连续\s*\d+\s*句落在同一个音/, why: '同一落音连续过多（上限 2 句）' },
  { re: /不在都节里/, why: '都节音阶外音（只许 2 / 2p100 / 5 / 6 / 6p100）' },
  { re: /解析失败|看不懂这个音/, why: '琴语解析失败' },
];

/**
 * 从 renderScore 抓到的 verdict 文本里挑出硬错。
 * @param {string} verdict  形如 "【自查报告，不阻断演奏】\n  · 第1句没落（结在6），改落点或标 ?"
 * @returns {{line: string, why: string}[]}
 */
export function hardErrors(verdict) {
  const text = String(verdict || '');
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[·\-*]\s*/, '').trim();
    if (!line) continue;
    const hit = HARD_RULES.find((r) => r.re.test(line));
    if (hit) out.push({ line, why: hit.why });
  }
  return out;
}

/** 给人看的一句话结论。 */
export function verdictSummary(verdict) {
  const hard = hardErrors(verdict);
  if (hard.length) return { pass: false, hard, text: `硬错 ${hard.length} 处：` + hard.map((h) => h.line).join('；') };
  return { pass: true, hard: [], text: verdict ? '无硬错（口味建议不拦）' : '未自查' };
}
