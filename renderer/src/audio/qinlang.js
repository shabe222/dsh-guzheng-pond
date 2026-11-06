/**
 * 琴语（QinLang）v2 —— 见 QLANG.md
 * 谱上写什么就是什么。不智能，不随机。
 *
 * 吟猱语法（据丁承运《吟猱指法类解》）：
 *   ~  吟（默认见声吟：弹完停一下再揉）
 *   ~d 落指吟（一落弦就揉）      ~c 承声吟（接上就揉）
 *   ~x 歇吟（弹过后才揉，取余声） ~w 无意猱（声将尽才揉）
 *   ~s 少吟（二转）  ~l 长吟（八九转）  ~g 定吟（微动不露形迹）
 *   =  猱（默认缓猱）、=j 急猱、=d 落指猱、=l 长猱、=g 定猱
 *
 * 绰注（据《悟雪山房琴谱》《大绰》）：
 *   c 绰（自下而上，音往上走时用）  z 注（自上而下，音往下走时用）
 *   一律「从远引至」，不是本位小斜按
 *
 * 扫弦（据《今虞琴刊》）：
 *   s 上扫  f 下拂  S 大圆（滚拂连用，入调后用）
 */

const DEG = { '1':1, '2':2, '3':3, '5':5, '6':6 };

function parseVib(flag) {
  // flag 形如 '~' '~d' '=' '=j'
  const ch = flag[0];
  const mod = flag.slice(1);
  if (ch === '~') {
    const kind = mod === 'l' ? 'chang' : (mod === 's' ? 'shao' : 'yin');
    let timing = 'jian';        // 见声吟（默认）
    if (mod === 'd') timing = 'luo';    // 落指
    if (mod === 'c') timing = 'cheng';  // 承声
    if (mod === 'x') timing = 'xie';    // 歇吟
    if (mod === 'w') timing = 'wuyi';   // 无意
    const size = mod === 'g' ? 'ding' : (mod === 'l' ? 'chang' : (mod === 's' ? 'shao' : 'zhong'));
    return { type:'yin', kind, timing, size };
  }
  if (ch === '=') {
    const kind = mod === 'j' ? 'ji' : (mod === 'l' ? 'chang' : 'huan');
    const size = mod === 'g' ? 'ding' : (mod === 'l' ? 'chang' : 'zhong');
    return { type:'nao', kind, timing:'jian', size };
  }
  return null;
}

function sweepOf(ch, spreadMs, gain) {
  if (ch === 's') return { mode:'up',    dir: 1, spreadMs: spreadMs ?? 12, gain: gain ?? 0.40 };
  if (ch === 'f') return { mode:'down',  dir:-1, spreadMs: spreadMs ?? 12, gain: gain ?? 0.40 };
  if (ch === 'S') return { mode:'round', dir: 1, spreadMs: spreadMs ?? 16, gain: gain ?? 0.34, round:true };
  return null;
}

export function parseQin(text) {
  const lines = String(text).split(/\r?\n/);
  let title = '', tail = 2500, from = '', to = '', turn = 0;
  const phrases = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { title = line.slice(1).trim(); continue; }
    if (line.startsWith('@from ')) { from = line.slice(6).trim(); continue; }
    if (line.startsWith('@to '))   { to   = line.slice(4).trim(); continue; }
    if (line.startsWith('@turn ')) { turn = parseInt(line.slice(6),10) || 0; continue; }
    if (line.startsWith('@')) { tail = parseInt(line.slice(1), 10) || 2500; continue; }
    if (!line.startsWith('|')) continue;

    let body = line.slice(1);
    let gap = 900;
    let lead = 0;
    // 兼容两种写法：`... ,950 ?`（问号在空隙后）和 `... ? ,950`（问号在空隙前）
    let open = false;
    const gapQ = body.match(/,\s*(\d+)\s*\?\s*$/);
    if (gapQ) {
      gap = parseInt(gapQ[1], 10);
      body = body.slice(0, gapQ.index);
      open = true;
    } else {
      const gapM = body.match(/,\s*(\d+)\s*$/);
      if (gapM) { gap = parseInt(gapM[1], 10); body = body.slice(0, gapM.index); }
      open = /\?\s*$/.test(body);
      body = body.replace(/\?\s*$/, '');
    }
    body = body.replace(/([^\s])\s+\//g, '$1/');

    const tokens = body.split(/\s+/).filter(t => t && t !== '/');
    const notes = [];
    for (const tk of tokens) {
      // 休止：`r/280` = 停 280ms 再出下一个音（挂在**前一个音**上，落音前留一拍空）
      if (/^r(\/\d+)?$/.test(tk)) {
        const rd = tk.includes('/') ? parseInt(tk.split('/')[1], 10) : 500;
        if (notes.length) {
          const prev = notes[notes.length - 1];
          prev.hold = (prev.hold || 0) + rd;
        } else {
          lead = (lead || 0) + rd;
        }
        continue;
      }
      // 多音（撮/双音）：`1+5/833`、`1+3+5/1667` —— 时值/技法写在整个和弦的末尾
      let parts = tk.split('+');
      if (parts.length > 1) {
        // 把最后一段尾巴上的「技法/时值/参数」挪到第一段，后面就只剩音级
        const lastPart = parts[parts.length - 1];
        const sm = lastPart.match(/^([.,]?[1-6][.,]?)((?:[a-zA-Z~=]*)(?:\/\d+)?(?::\d+)?(?::[0-9.]+)?(?::[0-9.]+)?)$/);
        if (sm) {
          parts[parts.length - 1] = sm[1];
          parts[0] = parts[0] + sm[2];
        }
      }
      const head = parts.shift().replace(/((?::[0-9.]+)+)(\/\d+)$/, '$2$1');
      // 八度记号两种写法都认：`5.` / `5,`（后缀），`,5` / `.5`（前缀，QLANG.md 用的这种）
      const m = head.match(/^([\^\-]{0,2})([.,]?)([1-6])([.,]?)([a-zA-Z~=0-9]*)(?:\/(\d+))?(?::(\d+))?(?::([0-9.]+))?(?::([0-9.]+))?$/);
      if (!m) throw new Error('琴语解析失败，看不懂这个音: ' + tk);
      const [, pre, octPre, degCh, octSuf, mid, durStr, spreadStr, gainStr, secStr] = m;
      if (!DEG[degCh]) throw new Error('音级只有 1 2 3 5 6，收到: ' + degCh);
      const octSym = octSuf || octPre;
      const oct = octSym === '.' ? 1 : (octSym === ',' ? -1 : 0);
      const extra = parts.map((part) => {
        const em = part.match(/^([.,]?)([1-6])([.,]?)$/);
        if (!em) throw new Error('多音的第二音写法不对（只写音级，如 1+5/833）: ' + tk);
        if (!DEG[em[2]]) throw new Error('音级只有 1 2 3 5 6，收到: ' + em[2]);
        const sym = em[3] || em[1];
        return { deg: DEG[em[2]], oct: sym === '.' ? 1 : (sym === ',' ? -1 : 0) };
      });
      const dur = durStr ? parseInt(durStr, 10) : 800;
      const flags = pre + mid;
      let vel = 64;
      // 轻重：^ 重 88、^^ 更重 100；- 轻 44、-- 更轻 30
      const heavies = (flags.match(/\^/g) || []).length;
      const lights = (flags.match(/-/g) || []).length;
      if (heavies >= 2) vel = 100;
      else if (heavies === 1) vel = 88;
      else if (lights >= 2) vel = 30;
      else if (lights === 1) vel = 44;

      let slide = null, vibrato = null, sweep = null, press = null, yao = null;
      let rest = mid;
      // 摇指：Y 或 Y80（80ms 一次），单弦快速反复，长音的「活」
      const ym = rest.match(/Y(\d+)?/);
      if (ym) {
        yao = { rate: ym[1] ? parseInt(ym[1], 10) / 1000 : 0.08 };
        rest = rest.replace(ym[0], '');
      }
      // 按音：3p100 = 按 3 弦升 100 音分（= 4）；6p200 = 按 6 弦升 200 音分（= 7）
      // 慢按：3p100s400 = 用 400ms 慢慢按上去（押し上げ的从容感）
      const pm = rest.match(/p(\d+)(?:s(\d+))?/);
      if (pm) {
        press = {
          cents: parseInt(pm[1], 10),
          riseSec: pm[2] ? Math.min(1.2, parseInt(pm[2], 10) / 1000) : 0.12,
        };
        rest = rest.replace(pm[0], '');
      }
      // 先抓吟猱（可能带修饰字母）
      const vm = rest.match(/[~=][a-z]?/);
      if (vm) { vibrato = parseVib(vm[0]); rest = rest.replace(vm[0], ''); }
      for (const ch of rest) {
        const sw = sweepOf(ch, spreadStr?parseInt(spreadStr,10):undefined, gainStr?parseFloat(gainStr):undefined);
        if (sw) sweep = sw;
        else if (ch === 'c') slide = 'chao';
        else if (ch === 'z') slide = 'zhu';
        else if (ch === 'l') slide = 'li';
        else if (ch === 'y') slide = 'youyi';
        else if (ch === 'q') slide = 'qi';
        else if (ch === 'o') slide = 'yan';
      }
      // 第四个参数 = 扫弦持续秒数（来回渐弱的那个「洗」）
      if (sweep && secStr) {
        sweep.durSec = Math.max(0.3, parseFloat(secStr));
      }
      notes.push({ deg: DEG[degCh], oct, vel, dur, slide, vibrato, sweep, press, yao, extra: extra.length ? extra : null });
    }
    if (!notes.length) continue;
    phrases.push({ notes, gap, open, line, lead });
  }
  return { title, tail, phrases, from, to, turn };
}

export function validateQin(score, opts = {}) {
  const problems = [];
  // 出口必须先定（第三十二章）
  if (!score.from || !score.to) problems.push('没有声明出口：写 @from <从哪来> 和 @to <到哪去>。答不出来就别写。');
  if (score.turn && (score.turn < 1 || score.turn > score.phrases.length)) problems.push('@turn 指定的转折句超出范围');
  const landings = opts.landings || [1, 2];
  let openCount = 0;
  const lightOpen = score.phrases.filter(p=>p.notes[0].vel===44).length;
  for (let i=0;i<score.phrases.length;i++) {
    const p = score.phrases[i];
    const last = p.notes[p.notes.length-1].deg;
    if (p.open) openCount++;
    else if (!landings.includes(last)) problems.push('第'+(i+1)+'句没落（结在'+last+'），改落点或标 ?');
    // 绰注方向检查：句首音比第二音高却写了绰（应该写注）
    const a = p.notes[0], b = p.notes[1];
    if (b && a.slide === 'chao' && a.deg > b.deg) problems.push('第'+(i+1)+'句句首用绰但音是往下走的，应改注');
    if (b && a.slide === 'zhu' && a.deg < b.deg) problems.push('第'+(i+1)+'句句首用注但音是往上走的，应改绰');
  }
  if (openCount > (opts.maxOpen != null ? opts.maxOpen : Math.max(3, Math.ceil(score.phrases.length * 0.85)))) {
    problems.push('故意不落只能用 ' + (opts.maxOpen != null ? opts.maxOpen : Math.max(3, Math.ceil(score.phrases.length * 0.85))) + ' 处，现在 ' + openCount + ' 处');
  }
  if (score.tail > 3000) problems.push('结尾留白 '+score.tail+'ms 超过 3000ms');
  if (lightOpen >= score.phrases.length*0.7) problems.push('轻起 '+lightOpen+'/'+score.phrases.length+' 句，太多——头几句要敢开口');
  // 句形检查（据《良宵引》实测）
  {
    const shapes = score.phrases.map(p=>{
      const ps = p.notes.map(n=>n.deg + n.oct*5);
      if (ps.length<3) return 'short';
      const up = ps[ps.length-1]-ps[0];
      return Math.abs(up)<1 ? 'flat' : (up>0 ? 'up' : 'down');
    }).filter(s=>s!=='short');
    const total = shapes.length;
    const down = shapes.filter(s=>s==='down').length;
    const up = shapes.filter(s=>s==='up').length;
    const flat = shapes.filter(s=>s==='flat').length;
    if (total>=4 && up===0) problems.push('全曲没有一句上行收尾 — 一路叹气。每 4 句至少一句上行。');
    if (total>=4 && flat/total < 0.05) problems.push('「平」的句子只占 '+(flat/total*100).toFixed(0)+'%，真实琴曲约 48%');
    // 峰位置
    const peaks = score.phrases.map(p=>{
      const ps = p.notes.map(n=>n.deg + n.oct*5);
      if (ps.length<4) return null;
      return ps.indexOf(Math.max(...ps))/(ps.length-1);
    }).filter(x=>x!==null);
    if (peaks.length>=3){
      const med = peaks.slice().sort((a,b)=>a-b)[Math.floor(peaks.length/2)];
      if (med > 0.65) problems.push('句子最高点中位 '+med.toFixed(2)+' 太靠后 — 真实琴曲约 0.27，先上去再落');
    }
  }
  // 同音连击检查：一句内连续 >=3 个同音，若力度和时长完全一致 → 判为笨拙
  for (let i=0;i<score.phrases.length;i++){
    const ns = score.phrases[i].notes;
    let run = [ns[0]];
    for (let k=1;k<=ns.length;k++){
      const same = k<ns.length && ns[k].deg===run[0].deg && ns[k].oct===run[0].oct;
      if (same) { run.push(ns[k]); continue; }
      if (run.length>=3){
        const velSame = run.every(n=>n.vel===run[0].vel);
        const durSame = run.every(n=>n.dur===run[0].dur);
        if (velSame && durSame) problems.push('第'+(i+1)+'句有 '+run.length+' 个连续同音且轻重时长完全一样 — 听着就是笨，至少改一样');
      }
      if (k<ns.length) run=[ns[k]];
    }
  }
  // 整句重复检查：逐位音序重合 >70% 判为重复
  // 只在「相邻 4 句内」判重复。长曲子（40 句）隔 20 句回头说一件事是正常的，
  // 全篇两两比对会把所有长曲子判死。
  for (let i=0;i<score.phrases.length;i++){
    for (let j=i+1;j<score.phrases.length && j<=i+1;j++){
      // 曲模式下 A/A' 是「结构位置的重复」，不算错（每 4 句一次的那种）
      if (opts.structuralEvery && (j - i) % opts.structuralEvery === 0) continue;
      // 不同八度算不同的句子（降八度的重复是变奏，不是复读）
      const a = score.phrases[i].notes.map(n=>n.deg + n.oct*5);
      const b = score.phrases[j].notes.map(n=>n.deg + n.oct*5);
      const L = Math.min(a.length,b.length);
      // 短动机（≤3 音）允许原样重复——钩子必须被听见
      if (L < 4) continue;
      let same = 0;
      for (let k=0;k<L;k++) if (a[k]===b[k]) same++;
      if (same/L > 0.7) problems.push('第'+(i+1)+'句与第'+(j+1)+'句逐位重合 '+(same/L*100).toFixed(0)+'% — 整句重复，换一句别的');
    }
  }
  // 句长检查
  const lens = score.phrases.map(p=>p.notes.length);
  const avg = lens.reduce((a,b)=>a+b,0)/lens.length;
  if (avg < 4) problems.push('平均每句 '+avg.toFixed(1)+' 个音，太短（真实琴曲中位 6–11 个音）');
  return problems;
}