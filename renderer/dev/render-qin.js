const L=document.getElementById('log');
const log=(...a)=>{L.textContent+=a.map(String).join(' ')+String.fromCharCode(10);};
function toWav(ab){
  const nch=ab.numberOfChannels,sr=ab.sampleRate,len=ab.length,bps=2;
  const dl=len*nch*bps,b=new ArrayBuffer(44+dl),v=new DataView(b);
  const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  w(0,'RIFF');v.setUint32(4,36+dl,true);w(8,'WAVE');w(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,nch,true);
  v.setUint32(24,sr,true);v.setUint32(28,sr*nch*bps,true);v.setUint16(32,nch*bps,true);
  v.setUint16(34,16,true);w(36,'data');v.setUint32(40,dl,true);
  const ch=[];for(let c=0;c<nch;c++)ch.push(ab.getChannelData(c));
  let o=44;
  for(let i=0;i<len;i++)for(let c=0;c<nch;c++){let s=Math.max(-1,Math.min(1,ch[c][i]));v.setInt16(o,s<0?s*0x8000:s*0x7FFF,true);o+=2;}
  return b;
}
try{
  const Tone=window.Tone;
  const SRC = await import('/dev/'+ (new URLSearchParams(location.search).get('score')||'score-qin.js'));
  const { parseQin, validateQin } = await import('/src/audio/qinlang.js');
  const { renderWithGlide, renderPress, slideParams } = await import('/src/audio/slides.js');
  const { applyVibrato } = await import('/src/audio/vibrato.js');

  const score = parseQin(SRC.TEXT);
  const probs = validateQin(score);
  if (probs.length) {
    log('【自查报告，不阻断演奏】');
    probs.forEach(p=>log('  · '+p));
    log('');
  }

  // 采样真实音高（2026-10-26 用 ffmpeg+自相关实测，别再按文件名猜）：
  //   C1..C5 = D2 D3 D4 D5 D6（宫）｜D1..D4 = E2 E3 E4 E5（商）｜E1..E4 = F#2 F#3 F#4 F#5（角）
  //   G1..G4 = A2 A3 A4 A5（徵）｜A1..A4 = B2 B3 B4 B5（羽）
  // oct=0 落在 D3..B3（古筝最常用的低中音区）；oct=-1 才是真正的低音 D2..B2。
  const FILES={
    1:['C1','C2','C3','C4','C5'],
    2:['D1','D2','D3','D4'],
    3:['E1','E2','E3','E4'],
    5:['G1','G2','G3','G4'],
    6:['A1','A2','A3','A4'],
  };
  const nameOf=(deg,oct)=>{
    const list=FILES[deg]||FILES[1];
    const idx=Math.max(0, Math.min(list.length-1, (oct||0)+1));
    return list[idx];
  };
  // 低到高，扫弦用（D2 一直到 D5）
  const ORDER=['C1','D1','E1','G1','A1','C2','D2','E2','G2','A2','C3','D3','E3','G3','A3','C4'];
  const pcm={};
  const allNames=new Set(ORDER);
  for(const d of [1,2,3,5,6]) for(const n of FILES[d]) allNames.add(n);
  for(const n of allNames){const b=await Tone.ToneAudioBuffer.fromUrl('/samples/guzheng/'+n+'.mp3');pcm[n]=b.getChannelData(0);}

  const SR=44100;
  const raw=[]; const sweeps=[];
  let t=1.0;
  for(let pi=0; pi<score.phrases.length; pi++){
    const ph=score.phrases[pi];
    t += (ph.lead||0)/1000;
    for(let i=0;i<ph.notes.length;i++){
      const n=ph.notes[i];
      const name = nameOf(n.deg, n.oct);
      const base = {degree:n.deg,oct:n.oct,vel:n.vel,durMs:n.dur,atSec:t,noteName:name,
        index:i,total:ph.notes.length,isPhraseStart:i===0,isPhraseEnd:i===ph.notes.length-1,
        phraseIndex:pi,sectionName:'句'+(pi+1),sectionKind:'s',
        slide:n.slide, vibrato:n.vibrato, press:n.press, yao:n.yao,
        isFinalNote:(pi===score.phrases.length-1&&i===ph.notes.length-1)};
      raw.push(base);
      // 多音（撮/双音）：同一个起音点上再叠几根弦，错开 10ms，像手指先后落
      if(n.extra && n.extra.length){
        n.extra.forEach((e,k)=>{
          // 错开 35ms：真实撮弦不是同时响，10ms 会造成梳状滤波（听着发空、像电子音）
          raw.push({...base, degree:e.deg, oct:e.oct, atSec:t+(k+1)*0.035,
            noteName:nameOf(e.deg,e.oct), slide:null, vibrato:null});
        });
      }
      // 扫弦跟着这个音走（以前只认每句第一个，所以等于没有）
      if(n.sweep) sweeps.push({atSec:t, ...n.sweep});
      t += (n.dur + (n.hold||0))/1000;
    }
    t += ph.gap/1000;
  }

  const TOTAL = t + score.tail/1000;
  const totalSamples=Math.floor(TOTAL*SR);
  const L2=new Float32Array(totalSamples),R2=new Float32Array(totalSamples);

  log('《'+(score.title||'无题')+'》  '+score.phrases.length+' 句  '+raw.length+' 音  结尾留白 '+score.tail+'ms');

  let chao=0,zhu=0,yin=0,nao=0,pressed=0,yaoN=0;
  for(let i=0;i<raw.length;i++){
    const n=raw[i];
    const src=pcm[n.noteName]; if(!src) continue;
    // 余音长度：正常 3.06 秒；但「急」的段落（100-200ms 一个音）要自动收短，
    // 否则几十个音叠在一起就糊成一片 —— 手指按下去是要断的，不是一直响。
    const durSec = n.durMs <= 220
      ? Math.max(0.38, Math.min(3.06, (n.durMs / 1000) * 3.0))
      : 3.06;
    let r;
    // 按音优先：本位起、按到 +cents 停住（4 = 3p100，7 = 6p200）
    if(n.press && n.press.cents){
      r=renderPress(src, n.press.cents, n.press.riseSec||0.12, Math.max(durSec,0.7));
      pressed++;
    } else if(n.slide && slideParams(n.slide,0.6)){
      const pp=slideParams(n.slide,0.85);   // 「从远引至」，不用本位小斜按
      r=renderWithGlide(src,pp.cents,pp.glideSec,Math.max(durSec,pp.glideSec+0.5),pp.curvePower);
      if(n.slide==='chao')chao++; else if(n.slide==='zhu')zhu++;
    } else r=src.slice(0,Math.floor(durSec*SR));
    // 被截断的采样要在切口处淡出（30ms），否则就是「咔」一声
    if (durSec < 3.0){
      const fadeN = Math.floor(0.03*SR);
      for(let k=0;k<fadeN && k<r.length;k++) r[r.length-1-k] *= k/fadeN;
    }
    if(n.vibrato){
      const v = n.vibrato;
      // 幅度：定(0.25) 少(0.5) 中(1.0) 长(1.2)
      const sizeMul = v.size==='ding'?0.25:(v.size==='shao'?0.5:(v.size==='chang'?1.2:1.0));
      // 时机：落指 0s / 承声 0.08s / 见声 0.3s / 歇 0.6s / 无意 1.2s
      const delayMap = { luo:0, cheng:0.08, jian:0.30, xie:0.60, wuyi:1.20 };
      const delay = delayMap[v.timing] ?? 0.30;
      const kind = v.type==='nao' ? (v.kind==='ji' ? 'nao_fast' : 'nao') : 'yin';
      const vr = applyVibrato(r, kind==='nao_fast'?'nao':kind, Math.min(1,0.6*sizeMul), durSec);
      r = vr.samples;
      // 延迟：把前 delay 秒压成干声（未揉）
      if (delay>0){
        const pre = Math.floor(delay*SR);
        const rawPiece = (n.slide && slideParams(n.slide,0.6)) ? null : pcm[n.noteName].slice(0, Math.min(pre, pcm[n.noteName].length));
        if (rawPiece) for(let k=0;k<rawPiece.length && k<r.length;k++) r[k]=rawPiece[k];
      }
      if(v.type==='yin')yin++; else nao++;
    }

    const gain=(0.34+(n.vel/127)*0.60)*0.78;
    const st2=Math.floor(n.atSec*SR);
    let sup=totalSamples;
    for(let j=i+1;j<raw.length;j++){ if(raw[j].noteName===n.noteName){ sup=Math.floor(raw[j].atSec*SR); break; } }
    for(let k=0;k<r.length;k++){
      const idx=st2+k; if(idx>=totalSamples) break;
      let e=1; if(idx>=sup){ const ov=(idx-sup)/SR; e=Math.exp(-ov*10); if(e<0.001) break; }
      L2[idx]+=r[k]*gain*e; R2[idx]+=r[k]*gain*e;
    }
    // 摇指：在长音上做周期性的轻重起伏（不是重拨！重拨会把起音叠成「突突突」）
    // rate = 一次起伏的间隔（60ms≈16Hz 急，140ms≈7Hz 缓）
    if(n.yao){
      const rate = n.yao.rate || 0.08;
      const f = 1 / rate;
      const depth = 0.45;          // 起伏深度：0=平，0.45 明显但不机械
      for(let k=0;k<r.length;k++){
        const tt = k / SR;
        r[k] *= 1 - depth * 0.5 * (1 + Math.cos(2 * Math.PI * f * tt));
      }
      yaoN++;
    }
  }
  for(const sw of sweeps){
    const list = sw.mode==='round' ? [ORDER, ORDER.slice().reverse()] : (sw.dir>0?[ORDER]:[ORDER.slice().reverse()]);
    const passDur = list.length * ORDER.length * sw.spreadMs/1000;
    // durSec 给了就来回扫这么多秒，每一遍更轻 —— 就是「渐弱的来回滑弦」
    const target = sw.durSec ? sw.durSec : passDur;
    let t0 = sw.atSec, pass = 0;
    while (t0 - sw.atSec < target - 0.02 && pass < 8) {
      let bi = 0;
      for(const seq of list){
        for(let i=0;i<seq.length;i++){
          const s=pcm[seq[i]]; if(!s) continue;
          const tt=t0 + (bi*seq.length + i)*sw.spreadMs/1000;
          const st4=Math.floor(tt*SR); if(st4<0||st4>=totalSamples) continue;
          const cb=1-Math.abs(i-seq.length/2)/(seq.length*0.9);
          const g=sw.gain*(0.55+cb*0.45)*Math.pow(0.58, pass);
          for(let k=0;k<s.length;k++){const idx=st4+k;if(idx>=totalSamples)break;L2[idx]+=s[k]*g;R2[idx]+=s[k]*g;}
        }
        bi++;
      }
      t0 += passDur;
      pass++;
    }
  }
  log('技法（全部来自谱面）: 绰'+chao+' 注'+zhu+' 吟'+yin+' 猱'+nao+' 扫'+sweeps.length+' 按'+pressed+' 摇'+yaoN);

  const taps=[[0.029,0.26],[0.053,0.22],[0.083,0.18],[0.121,0.14],[0.181,0.11],[0.263,0.08],[0.367,0.06],[0.503,0.04]];
  const wL=new Float32Array(totalSamples),wR=new Float32Array(totalSamples);
  for(const [dd,gg] of taps){const off=Math.floor(dd*SR);for(let i=off;i<totalSamples;i++){wL[i]+=L2[i-off]*gg;wR[i]+=R2[i-off]*gg;}}
  const MIX=0.46;
  for(let i=0;i<totalSamples;i++){L2[i]=L2[i]*(1-MIX)+(L2[i]+wL[i])*MIX;R2[i]=R2[i]*(1-MIX)+(R2[i]+wR[i])*MIX;}

  let pk=0;for(let i=0;i<totalSamples;i++)pk=Math.max(pk,Math.abs(L2[i]),Math.abs(R2[i]));
  const g=pk>0?0.85/pk:1;
  const fi=Math.floor(0.8*SR), fo=Math.floor(Math.min(2.0,score.tail/1000)*SR);
  for(let i=0;i<totalSamples;i++){let gg=g;if(i<fi)gg*=i/fi;const rm=totalSamples-i;if(rm<fo)gg*=rm/fo;L2[i]*=gg;R2[i]*=gg;}

  const ac=new OfflineAudioContext(2,totalSamples,SR);
  const ab=ac.createBuffer(2,totalSamples,SR);
  ab.copyToChannel(L2,0);ab.copyToChannel(R2,1);
  const wav=toWav(ab);
  const u8=new Uint8Array(wav);let bin='';
  for(let i=0;i<u8.length;i+=8192)bin+=String.fromCharCode.apply(null,u8.subarray(i,i+8192));
  window.__wavB64=btoa(bin);
  log('OK');
}catch(e){log('ERR '+(e&&e.stack||e));}