/**
 * 风与水 · WebGL2 水面（实验）
 *
 * 和线版共用同一个 Water 状态机：env / ripples / crest / bassX / driftScreens
 * 全部来自谱面解析，不在这里编音符。这里只换画法：
 *   世界坐标的平面 + 透视投影 → 近处横移快、远处慢；
 *   大尺度「猫爪」风斑横向漂移；
 *   低频涌浪负责方向，高频毛细波负责碎光。
 *
 * 页面通过 ?render=gl 启用；WebGL2 不可用时自动留在 A 线版。
 */

const TAU = Math.PI * 2;

// 透亮模式的相机参数。必须和 clearMain / camPlane 里那组常量逐字一致，
// 因为涟漪、水脊的世界坐标要靠同一套投影反算回来。
const CAM_H = 6.0;
const CAM_SIN = 0.9613;
const CAM_COS = 0.2756;
const CAM_F = 1.178;

// 「这一汪」在 world 坐标里的中心与半径（米）。
// 必须和 clearMain 里 pondC / pondR 一致——不一致的后果不是画面错，
// 是涟漪一滴一滴落在圈外，水汪里一片死水，而你看不出是哪个数写错了。
const POND_CX = 0.10;
const POND_CZ = 1.85;
const POND_R = 2.25;
// 落点压缩系数。音符的横向位置是按整幅（宽约 9.4m）摊开的，
// 水汪只有 3.9m 宽，不压的话六成的水滴落在汪外，看不见。
// 横向压到 0.36、纵深压到 0.62 是照「两个方向上水汪各占画面多少」配的，
// 压完横竖的落点密度才是均匀的；两个方向同一个系数会让水汪横着瘦一条。
const POND_KX = 0.42;
const POND_KZ = 0.62;
// 前缘速度也得跟着缩一次。落点被上面两个系数压进汪里了，波速却还是
// 「整幅 9.4m」时代定的 1.6m/s：跑 2 秒是 3.2m，而汪半径只有 2.25m——
// 环有一大半辈子在岸上化掉，肉眼里只剩它出生那半秒。这是「最常见的力度
// 反而最像没有涟漪」的真正原因：不是不够亮，是它早就跑出水面了。
// 0.50：中位那档的终径 1.6m（约占汪半径七成），走完还留在水里；
// 最重那档 2.28m，末端正好压在岸上化掉——「撞岸」本身就是最大的那种读法。
// 再往小里收（试过 0.39）环只剩一个巴掌大的靶心，汪那么大，画面就空了。
const POND_WS = 0.50;
// 满屏时汪的放宽倍数，必须与着色器 pondR 里的 `grow` 完全一致（3.7）。
//
// 为什么是 3.7 而不是「刚好盖住画幅」。汪的边界不是硬边：pond / wet 两条
// 衰减曲线从 0.42/0.28 起一路收到 1.02/0.96，也就是说**半径的七成以内才是满水**。
// 要是把半径放到刚好等於画幅半宽，满水区就只有画幅中间那七成，
// 四周全落进衰减带——满屏看过去就是「中间一坨、四边发白」，还是那个老问题。
// 放到 3.7 倍，半径 8.3m 远超画幅（半宽 5.0m / 顶边 7.9m），衰减带整个跑到画外，
// 屏幕上就是一片完整的水：中间最实、四角略薄，但没有"边界"。
const POND_GROW_MAX = 3.7;
// 满屏展开的起点/终点（VS）。这三只数在着色器里是插值进去的，JS 侧 _fullAt 也用它们，
// 不是两处各写一遍——写两遍迟早会有一个改漏，而漏了不报错，只是「某几档看着怪」。
const VIEW_FROM = 1.2;
const VIEW_TO = 2.8;

// 力度归一化。不能拿 v = vel/127 直接当 0~1 用。
// 谱面里的轻重只有四档（^^ 100 / ^ 88 / 无 64 / - 44 / -- 30），
// 而且 64 是默认值——秋这一首 136 个涟漪里 120 个是 64，超过它的只有 4 个（dev/_vh.mjs 实测）。
// 按 MIDI 满量程归一，所有音的 v 都挤在 0.50±0.15，画面里根本看不出差别。
// 所以按「这套谱实际用到的区间」拉满：44 → 0.19，64 → 0.47，88 → 0.81，100 → 0.98。
// 换一首谱如果力度记号和这里不一样，改的是这两个端点，不是下面的倍率。
const VEL_LO = 0.24;   // ≈ vel 30
const VEL_HI = 0.80;   // ≈ vel 100
const velNorm = (v) => Math.min(1, Math.max(0, (v - VEL_LO) / (VEL_HI - VEL_LO)));

// 音高的归一值由 water.js 的 onNote 算好塞进 ripple（和 xOf 共用同一套格子），
// 这里不再复制一份公式——两份映射迟早会走岔，而走岔的表现是「亮的地方和音高的位置对不上」，
// 很难看出来，又要花一轮去查。

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTop;
uniform float uTime;
uniform float uWind;
uniform float uCalm;
uniform float uAmp;
uniform float uChop;
uniform float uDensity;
uniform float uClose;
uniform float uSuspended;
uniform float uWindDir;
uniform float uDrift;
uniform float uFlowAdv;
uniform float uFlowSpeed;
uniform float uBass;
uniform float uBassX;
uniform float uSweep;
// 视野展开倍数（1 = 430×320 的基准画幅）。池子拉大时不是把同一块水放大，
// 而是把相机抬高 —— 屏幕上每米还是那么多像素，画幅里多出来的那部分是新水面。
uniform float uView;

// x,z,born,amp   /   sigma,k,life,frontSpeed
uniform vec4 uRipA[8];
uniform vec4 uRipB[8];
// worldX, width, amp, foam
uniform vec4 uCrest;

uniform sampler2D uNoise;
uniform sampler2D uNormal;
// 取证用：法线贴图的 mip 偏移（?nb=1.5）。用于判定近景闪烁是否来自采样混叠。
uniform float uNBias;
// 近景法线细层的 mip 下限（?lf=2.5）。
// 屏幕底部那一条的 uv 导数正好落在 0.77 纹素/像素、LOD≈0，
// 而水流又正好把贴图推成约 1 纹素/帧 —— 时间上刚好踩在奈奎斯特边界，
// 每个像素逐帧换一个完全不同的纹素，进高光就变成几个点在闪。
// 只有那一带的自动 LOD 低于这个下限，所以只糊那一条，中远场一点不动。
uniform float uNLodFloor;
// 菲涅尔法线里保留多少“纹理高频”（0 = 全部滤掉，1 = 原样）。
uniform float uFresMix;
// 高光形状微调：x = 低指数那层的权重，y = 低指数，z = 高指数
uniform vec3  uSh;

const float TAU = 6.28318530718;

vec3 skyCol(vec3 R){
  float y = clamp(R.y, 0.0, 1.0);
  vec3 horizon = vec3(0.080, 0.142, 0.142);
  vec3 zenith  = vec3(0.022, 0.048, 0.051);
  vec3 c = mix(horizon, zenith, pow(y, 0.55));
  vec3 moonDir = normalize(vec3(-0.34, 0.30, 0.90));
  float md = max(dot(R, moonDir), 0.0);
  c += vec3(0.035, 0.052, 0.048) * pow(md, 5.0);
  return c;
}

float waveN(vec2 P, vec2 dir, float lambda, float amp, float speed, float phase,
            inout float dhx, inout float dhz){
  float k = TAU / lambda;
  // 相位跟着同一股水流走：浪脊和纹理同速平移，眼睛才能把形状跟住。
  float ph = dot(P, dir) * k - uFlowAdv * k + phase;
  float s = sin(ph);
  float c = cos(ph);
  dhx += amp * k * dir.x * c;
  dhz += amp * k * dir.y * c;
  return amp * s;
}

// 音符涟漪：只留很轻的坡。被水流拉长成顺风的椭圆，
// 不再是一圈圈同心圆——近景里那会读成气泡。
vec2 rippleSlopes(vec2 P){
  vec2 slope = vec2(0.0);
  float ringNoise = texture(uNoise, vec2((P.x - uFlowAdv * 0.6) * 0.11, P.y * 0.11)).r;
  for (int i = 0; i < 8; i++){
    vec4 A = uRipA[i];
    vec4 B = uRipB[i];
    if (A.w <= 0.0001) continue;
    float age = uTime - A.z;
    if (age < 0.0 || age > B.z) continue;

    vec2 dv = P - (A.xy + vec2(uFlowSpeed * age, 0.0));
    dv.x /= 1.9;                              // 顺风拉长
    float dist = length(dv);
    float front = age * B.w;
    float sig = max(0.70, B.x + age * 0.50);
    float q = (dist - front) / sig;
    float g = exp(-q * q) * exp(-age / max(0.2, B.z) * 1.45);
    float ph = B.y * (dist - front) - age * 1.2;
    float cs = cos(ph);
    float sn = sin(ph);
    float ringAmp = A.w * (0.35 + 0.50 * ringNoise);
    float dg = -2.0 * q / sig * g;
    float dhd = ringAmp * (dg * cs - g * B.y * sn);
    vec2 dir = dv / max(dist, 1e-4);
    slope += vec2(dhd * dir.x / 1.9, dhd * dir.y);
  }
  return slope;
}

// 一滴水落进水里，出来的是一列向外跑的环形波。
//
// 环形波是轴对称的，所以它的 Hessian 不能拿「坡度方向」当成一个秩一矩阵去近似。
// 上一版就是这么接的：rd⊗rd 乘坡度 —— 等于把一圈圆波当成一条直线波，
// 于是涟漪在焦散里只是一团糊斑，读不出「圈」。
//
// 轴对称的 h(r) 有二阶导的现成式子：
//   ∂²h/∂x² = h_rr·nx² + (h_r/r)·ny²
//   ∂²h/∂x∂y = (h_rr − h_r/r)·nx·ny
//   ∂²h/∂y² = h_rr·ny² + (h_r/r)·nx²
// 写对了以后，这圈波在焦散里会自己变成一亮一暗的同心环：
// 波峰把光挤到一处成亮环，波谷把光摊开成暗环。
// 这才是「滴一滴水」该有的样子——不是画上去的白圈，是光被这圈波改了路。
void rippleHess(vec2 P, float adv, float SP, inout float hxx, inout float hxy, inout float hyy){
  for (int i = 0; i < 8; i++){
    vec4 A = uRipA[i];
    vec4 B = uRipB[i];
    if (A.w <= 1e-7) continue;
    float age = uTime - A.z;
    if (age < 0.0 || age > B.z) continue;

    // 落点随水流漂一点点。水滴的环主要在自己扩散，漂移是次要的，
    // 给多了会读成「一个圈被水推走」，那是另一回事。
    // A 和 B 里的长度都是真实米（JS 侧给的），这里统一折进 SP 坐标。
    vec2 dv = P - (A.xy + vec2(adv * 0.09, 0.0)) * SP;
    float r = max(length(dv), 1e-3);
    vec2 nr = dv / r;

    float front = age * B.w * SP;
    float sig = (B.x + age * 0.06) * SP;       // 色散：波列越跑越宽
    float q = (r - front) / sig;
    if (q > 2.2 || q < -2.2) continue;         // 前缘之外没波，省掉 exp

    // 包络 g = exp(-q²)，连同它对 r 的一、二阶导
    float g   = exp(-q * q);
    float gr  = g * (-2.0 * q / sig);
    float grr = g * (4.0 * q * q / (sig * sig) - 2.0 / (sig * sig));

    // 波列 h = a·g·sin(φ)，φ = k(r − front) − ω·age
    // 相位偏 90°，让 r = front 处正好是波峰：最外圈是一道亮环，边界才清楚。
    // 不偏的话前缘落在零点上，环的外沿是糊的，看不出「扩散到哪里了」。
    float k = B.y / SP;
    float ph = k * (r - front) + 1.5708 - age * 1.35;
    float s = sin(ph), c = cos(ph);
    float a = A.w;
    float h_r  = a * (gr * s + g * k * c);
    float h_rr = a * (grr * s + 2.0 * gr * k * c - g * k * k * s);
    float h_t  = h_r / r;                      // 切向：h_r/r

    // 落点那一滴：刚入水的一瞬有个小鼓包，很快被环吞掉。
    // 有它，「滴」才有起点；没有它，一圈环是凭空出现的。
    float cw = (0.035 + age * 0.42) * SP;
    float core = exp(-(r * r) / (cw * cw)) * exp(-age * 5.0);
    h_rr += a * core * (4.0 * r * r / (cw * cw * cw * cw) - 2.0 / (cw * cw));
    h_t  += a * core * (-2.0 / (cw * cw));      // h_r/r，r→0 时也有限

    // 远了就淡：能量摊在周长上，物理上就是 1/√r。
    // 时间上按 lifeK 的 1.5 次方衰减，不是平方：平方在寿命后三分之一会掉到 10%，
    // 而焦散要看见环得让 det 穿过零——10% 就等于「环没了」，可它还占着两个点的寿命，
    // 中间这一段就是「明明有涟漪参数、画面上什么都没有」。
    // 1.5 次方在寿命前 30% 和平方几乎没差（0.9³ ≈ 平方的 0.9² 差 3%），
    // 只在尾巴上把环多留一会儿，散掉的观感不变。
    float fall = inversesqrt(1.0 + r * 0.95 / SP);
    float lifeK = clamp(1.0 - age / B.z, 0.0, 1.0);
    float ampK = fall * lifeK * sqrt(lifeK);

    hxx += (h_rr * nr.x * nr.x + h_t * nr.y * nr.y) * ampK;
    hxy += (h_rr - h_t) * nr.x * nr.y * ampK;
    hyy += (h_rr * nr.y * nr.y + h_t * nr.x * nr.x) * ampK;
  }
}

// ================== 透亮水体（镜头全部对着水面）==================
// 构图：整幅都是水。没有天空，没有地平线，没有岸。
// 相机在 6m 高处、偏离铅直 16°——几乎是俯视，所以顶/底只差 1.28 倍的缩放。
// 这一点决定了它能不能「不劣质」：旧版那套「地平线在画面 31.5% 处、z = 7/s」
// 的投影，顶部一个像素横跨几百米，法线贴图的等相位线被压成从地平线放射的
// 竖丝——那正是「揉皱的锡纸」的生理来源。俯视之后这个成因根本不存在，
// 也不需要靠 mip 下限、LOD 偏置去糊它。
const float CAM_H   = 6.0;      // 相机离水面高度（m）
const float CAM_SIN = 0.9613;   // sin(74°)，即俯角距铅直 16°
const float CAM_COS = 0.2756;
const float CAM_F   = 1.178;    // 焦距，单位是画幅高（fov_y ≈ 46°）

// 屏幕坐标 → 水面（y = 0 平面）。JS 侧有一份同式实现（_planeAt），
// 涟漪和水脊要靠它落到正确位置，两边必须逐字对齐。
// 返回值 z 分量是沿视线的参数，用来换算「屏幕上一个像素等于多少米」。
vec3 camPlane(vec2 frag){
  float dyf = ((uRes.y * 0.5 - frag.y) / uRes.y) / CAM_F;
  float dxf = ((frag.x - uRes.x * 0.5) / uRes.y) / CAM_F;
  float inv = max(1e-3, CAM_SIN - dyf * CAM_COS);
  float t = CAM_H / inv;
  return vec3(t * dxf, t * (dyf * CAM_SIN + CAM_COS), t);
}

// 一条小波对 Hessian 的贡献。
// 高度 h = amp·sin(k·(p·dir) − adv·k + φ)，二阶导是
//   h'' = −amp·k²·sin(…)·dir⊗dir
// amp 直接用坡度给（坡度 = amp·k），因为焦散只跟坡度有关，不跟绝对波高有关。
void hwave(vec2 p, vec2 dir, float lambda, float slope, float phase,
           inout float hxx, inout float hxy, inout float hyy){
  float k = TAU / lambda;
  // 0.42 这个系数是量出来的，不是拍的：全套相位速度 1.0 时，
  // 逐帧平均差是 4.35——细丝在像素上搅得太快，读起来是「急」不是「游」。
  // 压到 0.42 才落回 1.8 左右，和上一版软光的速度对得上。
  float a = dot(p, dir) * k - uFlowAdv * k * 0.42 + phase;
  float s2 = sin(a) * slope * k;      // amp·k²·sin
  hxx -= s2 * dir.x * dir.x;
  hxy -= s2 * dir.x * dir.y;
  hyy -= s2 * dir.y * dir.y;
}

void clearMain(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 sp = frag / uRes;
  vec3 cp = camPlane(frag);
  // ---- 视野展开：池子变大 = 相机抬高，不是把同一块水放大 ----
  // 原来 camPlane 的 xy 是以 uRes.y 归一出来的世界米，画幅多高都框住同样多的米。
  // 于是 1440×1072 的池子和 430×320 的池子看到的是**同一片水面**，
  // 只是被像素拉伸了一遍 —— 这就是「只是把局部水花放大了」的根。
  // 乘 VS 之后，屏幕像素不变、每米对应的像素数不变，画幅里装进去的米数按 VS 增长：
  // 大池子里那片是本来没进过画面的新水面，波是自己长出来的，不是插值放大的。
  float VS = max(uView, 0.35);
  // 波长不能跟 VS 一比一（那就是等比放大，白改）：按 VS^0.72 放缓。
  // 结果满屏时屏幕波长缩到约 0.7 倍 —— 浪略细一点，浪的**根数**翻倍，
  // 这才是「更波澜」：不是一条浪变大，是整片水里多出一倍的浪。
  float WK = pow(VS, 0.72);
  // 着色器内部统一用一套「折叠过的米」：视野展开的 VS 与波长放大的 WK 合成 SP。
  // 这样下面所有波、噪声、涟漪的写法一个字都不用动，只有 pond 半径要跟着乘 SP。
  float SP = VS / WK;
  vec2 P = cp.xy * SP;
  float energy = clamp(uAmp / 1.5, 0.0, 1.0) * (1.0 - 0.55 * uCalm);
  float windAmt = 0.30 + 0.70 * uWind;
  float s = clamp(sp.y, 0.004, 1.0);        // 0 顶（远） → 1 底（近）
  float adv = uFlowAdv;

  // ---- 一、水底：纯色渐变，没有一处细节 ----
  // 「水底纯色或者渐变模糊处理」——这里就是一整块色，只有明度和一点点色相的偏移。
  // 刻意不给它任何纹理：底下只要有东西可以抓，就不叫“无所依”了。
  //
  // 但从这一版起，它不再「亮」。BODY_K 是这版唯一的开关：
  //   1.0 = 上一版，一整片浅色水面，光加在它上面 —— 对比只有 2 倍多；
  //   0.10 = 把水抽走，只留一层几乎看不见的雾 —— 同一束光，对比变成 10 倍以上。
  // 「光效更明显」不是把光调亮，是**把挡在光前面的那层颜色拿走**。
  // 光本身一点没动，因为光一动就顶到焦散的封顶，亮脊会从「细线」变成「平顶」。
  // 目标观感是「一束光打在屏幕上」：屏幕自己的底色还在，只是被光盖住一部分。
  #ifndef BODY_K
  #define BODY_K 0.06
  #endif
  // 光要补回来。上面那层底色是**平铺**的，它不只垫在水下，也垫在每一条亮脊底下：
  // 实测同一帧的最亮像素，body=1 时是 183/255，抽掉底色后掉到 102/255。
  // 也就是说「去掉底色」当场带走了三成亮度。所以这里补一层增益，
  // 补的是光本身，不是把黑布调成灰布——底色仍然是页面底色。
  //
  // 2.05 是量出来的，对着同一帧（qiu-oranges 99.4s）比出来的：
  //   light=1.75  峰值 173 / p99 144 / p90 13   —— 峰值没回位，整体偏暗
  //   light=2.05  峰值 201 / p99 167 / p90 14   ← 峰值与 body=1 的 201 完全一致
  //   light=2.35  峰值 229 / p99 191 / p90 14   —— 开始往白块走
  // 关键在 p90：旧观感 p90 是 92，这三档都在 14 上下。峰值一样高、中间那层灰全没，
  // 这才是「更明显」——不是把光调亮，是把光的**对比**拉开。
  // 上限也在这儿：再往上，焦散那 4.2 的封顶会把亮脊压成平顶，光就变成色块了。
  #ifndef LIGHT_K
  #define LIGHT_K 4.60
  #endif
  // 最低可见度（veil）。这条是为了回答一个问题：屏幕调暗、或者页底偏亮时，
  // 脊间那片 0 会不会跟背景分不开，整块效果直接消失？
  //
  // ---- 实测结论：默认关掉（0.000），不是没做，是做了没用 ----
  // 三种底色合成后量（96.19s，只在水汪内取）：
  //   暗底 #030607  p95-p50 = 24.9      → 清楚
  //   中灰 #2b3033  p95-p50 = 20.5      → 清楚
  //   浅底 #e9e7e2  p95-p50 =  1.1      → 等于看不见
  // 浅底那一档是物理死局，不是参数：出口是预乘 alpha 的加法光，rgb ≤ a，
  // 拿去盖白底只能是 out = rgb + bg(1-a) ≥ bg，永远压不出对比。
  // 想在这种底上看见，只能让画面**变暗**（低 rgb、高 a 的「墨」），
  // 那就不是「一束光打在屏幕上」了，是另一套观感，要单独做。
  //
  // 暗屏（整体 ×0.35 再量化 8bit）那一档：加地板前后可读对比 9 → 10，
  // 一档灰度，换来的却是下面的代价。缩小观看本来就不是问题：
  // 1280px→160px，p95-p50 是 24.9→31.4（脊并成亮块，反而更清楚）。
  //
  // 代价（对照图 out/veil3-cmp.png）：任何「把整片抬起来」的写法，
  // 都会让水汪读成一个**边界清楚的半透明球**——要看见暗部就得画出形状，
  // 画了形状就有边，而那圈边正是透明化时特意拆掉的「容器」。
  // 中间试过两版：铺满型（与 lum 无关）盘边最重；
  // 乘 wet 的版本又画了一遍径向衰减，球感更硬；去掉 wet 稍好，但仍是一颗球。
  //
  // 留着这个开关是让它可复现：?veil=0.060 就是「轻微抬一层」，
  // 想要「更亮、更像一颗水球」时一句话就能开，不必改代码。
  #ifndef VEIL_K
  #define VEIL_K 0.000
  #endif
  vec3 cNear = vec3(0.1450, 0.2330, 0.2390);
  vec3 cFar  = vec3(0.1720, 0.2560, 0.2520);
  vec3 col = mix(cFar, cNear, smoothstep(0.0, 1.0, s)) * BODY_K;

  // 大块模糊的深浅：很低频，慢到几乎看不出在动，但底色不会呆住。
  vec2 wq = vec2(P.x * 0.050 + 1.7, (P.y - adv * 0.9) * 0.038 + 0.4);
  float wash = textureLod(uNoise, wq, 1.6).r * 0.66
             + textureLod(uNoise, wq * 2.6 + 5.1, 1.6).r * 0.34;
  col *= 0.94 + 0.12 * wash;

  // 漂移的大片光：半透明水体里散射开的那层亮度，整块横移。
  // 「游光浮动」的另一半在这里——不只底下有光网，水体本身也在缓缓变亮变暗。
  float poolA = textureLod(uNoise, vec2(P.x * 0.080 + 2.3, (P.y - adv) * 0.058 + 6.1), 1.2).r;
  float pool = smoothstep(0.36, 0.84, poolA);
  col += vec3(0.0400, 0.0560, 0.0520) * pool * (0.55 + 0.45 * windAmt) * BODY_K;

  // ---- 一·五、这一汪：水只摊在这一小片里 ----
  // 在「世界坐标」里划圈，不是在屏幕上划。
  // 相机是俯视（偏铅直 16°），水面上的一个圆落到屏幕上本来就是个上窄下宽的椭圆，
  // 那就是「一小汪摊在地上」该有的透视。要是在屏幕空间画圆，得到的是
  // 一圈正圆的亮斑——读起来是射灯，不是水。
  // 半径（米）。pondR=2.25 是**半径**，落在屏幕上是一汪直径约 4.4m 的椭圆，
  // 约占画幅中间四成宽、七成高。（老注释写的 3.9m×3.7m 是按直径算错的，已更正。）
  // 音乐一来水会稍微铺开一点（±3%），像水面自己被推了一下，
  // 但幅度必须小，大了就成了「镜头在推」。
  float pondK = 0.985 + 0.05 * energy;
  // 汪的范围乘 SP：P 就是「基准画幅的米」乘 SP，所以半径乘 SP 之后，
  // 水洼在任何尺寸下都占画幅同样的比例——基准档那口有边的小水洼原样保留。
  //
  // 满屏时这个比例不对：「整片都是水」的时候不该还有一圈干地。
  // grow 从 1 涨到 POND_GROW_MAX（3.7），半径 2.25→8.3m，把画幅整个包进去，
  // 衰减带（rr 0.42→1.02）也就跟着跑到画外——屏幕上剩的是一片没有边界的水。
  // 用 smoothstep 而不是线性：中间那几档（比默认大一点）不至于水边还在、
  // 水已经涨出画幅，两条线同时到、观感才是连续的一个动作。
  float grow = mix(1.0, ${POND_GROW_MAX.toFixed(2)}, smoothstep(${VIEW_FROM.toFixed(2)}, ${VIEW_TO.toFixed(2)}, VS));
  vec2  pondC = vec2(0.10, 1.85) * SP;
  vec2  pondR = vec2(2.25, 2.25) * pondK * grow * SP;
  float rr = length((P - pondC) / pondR);
  // 边不能是圆规画的：地面上一点起伏、一缕草、一块浅滩，就能把水边切掉一块。
  // 低频噪声把等值线推开 ±0.17，边界才不规则；用高频会变成锯齿。
  float wob = textureLod(uNoise, vec2(P.x * 0.34 + 5.3, P.y * 0.31 + 2.8), 0.6).r - 0.5;
  rr += wob * 0.10;
  // 1 = 水心，0 = 汪外。
  // 写成 1-smoothstep(小,大)，不用 smoothstep(大,小)：后者在 GLSL 里是未定义行为，
  // 各家驱动给的结果不一样——本项目只在 Chromium 上看过，不能赌。
  //
  // 带宽从 0.86→1.0 拉宽到 0.42→1.02，这一版最要紧的一处。
  // 上一版这 14% 的斜坡之所以没被看见，是因为它后面还接着一层水色：
  // 光网先在 0.86 处散掉，水色再在更外面化进黑里，两级退场叠起来才够宽。
  // 底色抽走之后底色那一级没了，这条 14% 的斜坡就成了**整个画面里唯一的一条边**——
  // 实测它只有 16 像素宽，于是那一汪被读成一个圆盘的轮廓线。
  // 「一束光」不该有轮廓：光斑从来不是圆加边，是从中心往外一路稀薄下去。
  // 所以现在不要「圆内的水 + 圆的边」，只留一条从水心到汪外、跨越六成半径的衰减曲线。
  // 中心那片仍然顶满（rr<0.42 全是 1），所以光网的核心没有被啃掉。
  float pond = 1.0 - smoothstep(0.42, 1.02, rr);

  // ---- 二、波面：域扭曲 + 六条小波，解析给出二阶导 ----
  // 域扭曲是必须的。六条正弦叠出来的零集虽然已经是连通的光网，
  // 但它仍然是准周期的——不加扭曲，亮脊会一行行等距排开，一眼就是壁纸。
  // 两级，先大后小，两级用不同的旋转，避免扭出同一个方向。
  vec2 w1 = vec2(
    textureLod(uNoise, vec2(P.x * 0.055 + 4.3, (P.y - adv) * 0.047 + 1.9), 1.3).r,
    textureLod(uNoise, vec2(P.x * 0.055 + 11.7, (P.y - adv) * 0.047 + 7.4), 1.3).r) - 0.5;
  vec2 Q = P + w1 * 1.5;
  vec2 w2 = vec2(
    textureLod(uNoise, vec2(Q.x * 0.112 + Q.y * 0.071, Q.y * 0.112 - Q.x * 0.071) + 0.37, 1.0).r,
    textureLod(uNoise, vec2(Q.x * 0.098 - Q.y * 0.083, Q.y * 0.098 + Q.x * 0.083) + 5.11, 1.0).r) - 0.5;
  Q += w2 * 0.45;

  // 坡度（amp·k）直接给。之前那组的 amp/λ 只有 0.7%，太缓：
  // 折射后光线几乎不偏，底下根本不会有焦散。现在是 2%~8%。
  //
  // 但真正要命的是另一件事：焦散只认二阶导 h''≈slope·k，
  // 所以「同样坡度」在短波上被 k 放大一次，等于短波吃掉一切。
  // 旧参数下 slope·k 随频率单调上涨——2.45m 那条 0.185，0.34m 那条 0.388，
  // 差 2.1 倍。格子大小于是完全由最细的那条波决定：
  // 满屏等大的小环、每根线一样粗。那不是水，是细胞切片、是等高线图。
  // 现在按频率往下配权重（0.40 / 0.46 / 0.34 / 0.24 / 0.15 / 0.10），
  // 长波定格子大小，短波只在脊线上加毛边，尺度层次才出得来。
  float hxx = 0.0, hxy = 0.0, hyy = 0.0;

  // 一片水里总有聚光处和散光处。这是「自然」和「程序味」的分界：
  // 如果整幅每一处都在起焦散，读到的就是一张网格图；
  // 真实的浅水是一丛一丛的——这一片亮着，隔壁一片是平的、什么都没有。
  // 所以坡度本身要随这层很缓的场走：场弱的地方 D·h'' 够不着 1，
  // det 离不开 1，光网在那儿根本不存在，露出来的是干净的水。
  float pat = textureLod(uNoise, vec2(P.x * 0.062 + 7.7, (P.y - adv) * 0.055 + 3.1), 1.0).r;
  pat = smoothstep(0.22, 0.92, pat);
  // 坡度再乘一层「水深」。这一项是这一版最要紧的接法：
  // 水汪边上水浅，浅到一定程度光就折不起来了——D·h'' 够不到 1，
  // det 离不开 1，焦散在那儿自然消失，只剩一层浅浅的水色。
  // 要是只把颜色按圈擦淡，边上是「一整套光网被橡皮擦掉」，看得出是一块遮罩；
  // 先让焦散自己散掉，再让水色退去，才是水浅下去的样子。
  //
  // 这一版改成直接按 rr 落，不再经过 pond。理由：pond 的斜坡就是那条圆的轮廓，
  // 让 wet 挂在它上面，等于把「光网什么时候散」和「汪在哪儿结束」绑成一件事，
  // 于是再怎么调，边界总会回到 pond 那条曲线上。脱开之后两件事各管各的：
  // pond 管「光到哪儿就没了」，wet 管「光网从哪儿开始变稀」，
  // 交接处不再重合，那条轮廓线就没有地方可以成形。
  //
  // 带宽 0.28→0.96，占六成多半径：光网从七成半径处就开始一根根变软、变短、断开，
  // 一路稀到汪外。六成半径 ≈ 325 像素的过渡，一个圆周上是画不出「线」来的。
  float wet = 1.0 - smoothstep(0.28, 0.96, rr);
  float steep = (0.72 + 0.28 * energy * windAmt) * (0.38 + 0.95 * pat) * (0.06 + 0.94 * wet);

  // 六条波的方向必须摊开。每条都朝纵深的话，脊线就都横躺，
  // 焦散会变成一行行等距的横纹——这是最容易露程序味的地方。
  // 六条波的方向必须摊开。每条都朝纵深的话，脊线就都横躺，
  // 焦散会变成一行行等距的横纹——这是最容易露程序味的地方。
  //
  // 但六条不够。只有六个方向时，det 的零集是几块肥厚的团，
  // 而「三个 X 形一模一样」这种母题重复也躲不掉——独立周期太少。
  // 这是加波最容易被误会的地方：之前加厘米级碎波确实出了光栅，
  // 但那是频带太窄（全堆在 0.13~0.20m）造成的。
  // 加主频带内、方向铺满一圈、波长互不通约的波，结果正好相反：
  // 干涉谱变密，零集从「团」拉成「线」，母题也不再重复。
  // 十一条，权重随频率递减，保证短波只是毛边、不反客为主。
  hwave(Q, normalize(vec2( 0.55, 1.00)), 1.20, 0.0267 * steep, 0.7, hxx, hxy, hyy);
  hwave(Q, normalize(vec2(-0.90, 1.00)), 1.05, 0.0267 * steep, 2.9, hxx, hxy, hyy);
  hwave(Q, normalize(vec2( 1.00, 0.42)), 0.88, 0.0252 * steep, 4.4, hxx, hxy, hyy);
  hwave(Q, normalize(vec2(-0.40, 1.00)), 0.75, 0.0227 * steep, 1.7, hxx, hxy, hyy);
  hwave(Q, normalize(vec2( 1.00,-0.15)), 0.62, 0.0178 * steep, 3.3, hxx, hxy, hyy);
  hwave(Q, normalize(vec2( 0.15, 1.00)), 0.52, 0.0132 * steep, 5.1, hxx, hxy, hyy);
  hwave(Q, normalize(vec2(-1.00,-0.30)), 0.44, 0.0098 * steep, 0.2, hxx, hxy, hyy);
  hwave(Q, normalize(vec2( 0.80,-0.85)), 0.37, 0.0071 * steep, 4.9, hxx, hxy, hyy);
  hwave(Q, normalize(vec2(-0.65, 0.75)), 0.31, 0.0049 * steep, 2.2, hxx, hxy, hyy);
  hwave(Q, normalize(vec2( 0.30,-1.00)), 0.26, 0.0033 * steep, 6.0, hxx, hxy, hyy);
  hwave(Q, normalize(vec2(-1.00, 0.40)), 0.22, 0.0021 * steep, 1.3, hxx, hxy, hyy);

  // ---- 音符涟漪：每个音符往水里滴一滴 ----
  // 接在 Hessian 上（不是位移上）：位移只会让整片光网平移，
  // 看不出「被拨的」；接在二阶导上，涟漪经过的地方光才会真的聚、真的散。
  // 上一版用一个秩一矩阵近似（rd⊗rd 乘坡度），等于把圆波当直线波，
  // 涟漪在焦散里只是一团糊斑。这一版按轴对称环形波来算，见 rippleHess。
  rippleHess(P, adv, SP, hxx, hxy, hyy);
  // 这里刻意不再加更细的平面波。试过：五条厘米级碎波叠出来的不是细丝，
  // 是一个菱形光栅——平面波相加永远出晶格，加得越多越像揉皱的保鲜膜。
  // 细丝改由下面的 D 收：|det|<ε 对应的带宽随 D² 收缩，
  // D 一大，同一组波自己就收成细丝，不会引入新的方向。

  // ---- 三、焦散：算光真的聚到哪里 ----
  // 平行光被起伏的水面折射后落到水底，落点映射是
  //   X = x + D·∇h(x)
  // 底上的亮度就是 1/|det(∂X/∂x)|：
  //   det = (1 + D·hxx)(1 + D·hyy) − (D·hxy)²
  // det 趋近 0 的地方，几条光线被挤到同一点，那是真亮；
  // det 变大的地方，光线被摊开，那是真暗。
  //
  // 「空游无所依」就落在这件事上：底上什么都没有，
  // 你看到的每一条亮脊，都是光自己走出来的，不是画上去的。
  // 也正因为它是从一个无周期的三维波场算出来的，
  // 不存在「一屏一次重复」，也不存在等距格子。
  //
  // 取 |det| 而不是 max(det, 0)：det 的零集是一条曲线，
  // 用 max 会把整片 det<eps 压成同一个值，只剩几个「几条波正好汇合」的点——
  // 那就是最早说的「几个光点在跳」。取绝对值，亮度才沿着零曲线连成脊。
  float D = 2.75 + 0.55 * energy;
  float ax = D * hxx, ay = D * hyy, ac = D * hxy;
  float det = (1.0 + ax) * (1.0 + ay) - ac * ac;

  // 封顶从 2.75 抬到 4.2：2.75 会把所有 |det| < 0.31 的像素压成同一个值，
  // 亮脊中心于是变成一块平顶（试过放开到 3.30/无封顶，整幅会散成碎冰屑，
  // 那是另一头）。4.2 只是把平顶削掉，不改变网的结构。
  float I = min(1.0 / (abs(det) + 0.055), 4.20);
  float caus = I * 1.05;

  // 大块的聚散：不再用它决定「有没有光网」（那已经交给 pat 了），
  // 只让已经亮着的那一片本身有明暗起伏——光才「游」得动，而不是一张静图在平移。
  caus *= 0.62 + 0.62 * pat;

  // 亮度映射：要的是亮脊细、脊间暗。
  //
  // 这里原来用 caus 归一化：clamp((caus - 0.50) / 1.90, 0, 1)。问题出在夹紧——
  // caus 在 2.4 就夹到 1.0，而 caus=2.4 对应 |det|≈0.49。
  // 于是整个 |det|<0.49 的连通区域被压成同一个亮度：一片有面积、边界闭合的面。
  // 读出来是「发光的墨迹」，不是「焦散网」。实测 96.19s 那一帧，
  // 15~40/255 的中间灰占 6.9%，而且分布是块不是线。
  //
  // 改回 det 本身做变量：亮脊本来是 |det|→0 的零集，天生是一条曲线。
  // 0.075 是带宽（det 到 0.075 时亮度掉到 6%），4.0 次方让线内还有落差，
  // 中心不会变成平顶。这比抬 caus 的指数管用：抬指数只把面整体压暗，形状不变。
  // 带宽（RIDGE_B）决定线有多粗：det 到带宽值时亮度掉到 1/(2^p) 倍。
  // 陡度（RIDGE_P）：太小整片连面，太大只剩几个像素。
  #ifndef RIDGE_B
  #define RIDGE_B 0.100
  #endif
  #ifndef RIDGE_P
  #define RIDGE_P 2.000
  #endif
  // ---- 试过的一条死路，别再来一遍 ----
  // 把 |det|→0 的零集直接当亮脊（ridge = B / (|det| + B)，再取幂）：
  // 物理上对，画面上不可行。实测 96.19s 那一帧，band=0.10/rp=2.0 时
  // 90/255 以上的像素只剩 0.0%，整幅几乎全黑；band 放到 0.20 就涨到 18.6% 的灰。
  // 不是参数没调好：这个波场只有十一条低波数的波（波长 0.22~0.44m，水汪 3.9m），
  // det 的零集本来就只圈得出几个大节点，收窄之后连不成线。
  // 加高频碎波也不行——注释里记过，平面波叠加只会出菱形光栅。
  // 所以「块」不是靠收窄能解决的，要改的是块**内部**的层次。
  float ridge = RIDGE_B / (abs(det) + RIDGE_B);
  #ifdef USE_RIDGE
  float lumN = min(pow(ridge, RIDGE_P) * (0.65 + 0.55 * pat), 1.0);
  #else
  // 「减法 + 夹紧」这种归一化怎么调都消不掉平顶，原因是数学上的：
  // caus 的实际上限是 4.41（封顶 4.2 × 1.05），而 (caus - a) / b 一旦在
  // 上限以内就够得着 1.0，那以上的整片区域必然是同一个亮度。
  // 分母 1.90 时夹点在 caus=2.40（对应 |det|≈0.49）；分母 2.60 时夹点在
  // caus=3.10（对应 |det|≈0.28）。之前在这两个分母之间来回挪，
  // 平顶只是在 |det| 0.49 与 0.28 之间平移——
  // **调分母永远调不掉平顶，只能调它在哪。**
  //
  // 正解是换成「按上限归一化，再做幂」：caus 4.41 → 0.735、3.83 → 0.638、
  // 2.75 → 0.458、1.76 → 0.293，取 2.2 次方后是 0.505 / 0.371 / 0.176 / 0.063。
  // 脊是亮的、脊间是真的暗，而且每一档都有独立的值——这才叫渐变。
  float lumN = clamp(caus / 6.00, 0.0, 1.0);
  #endif
  // 峰值压到 0.41 而不是 1.0：原来 0.435×LIGHT_K(2.05)=0.89 已经贴着 1.0，
  // 再补就截断成白块。压低峰值、抬高增益，才能线性放大而不是削平顶。
  // 2.2 次方是为了杀掉脊间那层灰雾：它在 lumN≈0.3 处只有 0.06，
  // 面积一大就读成「一团暗色物质」，而不是「没光的地方」。
  // 0.80 是配 LIGHT_K=4.00 定的：峰值 0.505×0.80=0.40 线性，落回 174/255 左右。
  float lum  = pow(lumN, 2.2) * 0.92;
  // 晕：只贴脊带一圈。权重 0.08，再高就又摊成一整层灰。
  float halo = pow(lumN, 1.5);

  float litFloor = 0.44 * (0.86 + 0.28 * wash);
  float litGlow  = 0.08 * halo * (0.86 + 0.28 * wash);

  // 环境散射：**跟着光走，不铺满水盆**。默认 VEIL_K=0.000，这一项不参与渲染，
  // 打开（?veil=0.060）才会生效，理由与实测见上面 VEIL_K 那段。
  // 写法是乘 pow(lumN, 0.55)：暗处 lumN→0 时它跟着回 0，不凭空造出亮圆。
  // 而且**不再乘 wet**——试过 *(0.35+0.65*wet)，结果水汪读成一个半透明圆球，
  // 因为 wet 是第二条独立的径向衰减，等于把盘子的边又画了一遍；
  // 光场自己就随 wet 淡出（steep 里有 0.06+0.94*wet），不需要再乘一次。
  // 只留 pat 做疏密：0.50+0.90*pat → 疏处 50%、密处 140%，起伏 2.8 倍，有浑浊感。
  float veil = VEIL_K * pow(lumN, 0.55) * (0.50 + 0.90 * pat);

  // 安静段落也不能没有光，否则整幅就是一块色。「游光浮动」是底色，不是点缀。
  // 地板从 0.62 抬到 0.70：安静 = 起伏小（交给 steep / 波幅 / D 去表达），不 = 光少。
  // 原来 energy→0 时这一项掉到 0.56，跟下面 dimK 一起把整幅压掉两成。
  float cAmp = (0.70 + 0.40 * energy) * (0.72 + 0.28 * windAmt);
  col += vec3(0.2050, 0.2760, 0.2560) * litFloor * cAmp * BODY_K;
  col += vec3(0.2050, 0.2760, 0.2560) * veil * cAmp * LIGHT_K;
  col += vec3(0.2050, 0.2760, 0.2560) * litGlow * cAmp * LIGHT_K;
  col += vec3(0.3450, 0.4350, 0.3900) * lum * cAmp * LIGHT_K;

  // ---- 四、音乐 ----
  // 低音：整块水变深，像云影从底下过去。
  // uBassX / uCrest.x 也是真实米，一并折进 SP。
  float bassMask = exp(-pow((P.x - uBassX * SP) / (4.6 * SP), 2.0));
  // 三个压暗乘子叠起来最狠能到 0.67——安静段落整幅掉两成亮度，
  // 那就不叫「透亮」了。幅度各自收三成、地板从 0.84 提到 0.90：
  // 音乐该有起伏，但起伏不该表现为「灯被调暗了」。
  float dimK = (1.0 - 0.10 * uBass * bassMask) * (1.0 - 0.06 * uCalm) * (1.0 - 0.08 * uClose);
  col *= max(dimK, 0.90);

  // 扫弦：一小片光被推着扫过去（不是竖光柱，那在俯视图里没有意义）。
  if (uCrest.z > 0.0005){
    float dxc = P.x - uCrest.x * SP;
    float cwk = (1.6 + 1.1 * uCrest.y) * SP;
    float pk = exp(-dxc * dxc / (2.0 * cwk * cwk)) * uCrest.z * 2.4;
    col += vec3(0.0420, 0.0660, 0.0610) * pk * LIGHT_K;
  }

  // ---- 五、收边：光只活在这一汪里 ----
  // 上一版是「让颜色退到页面底色 #030607 上」，三级退场（水→薄水→湿地面→干地）。
  // 那套是为了一块「有面的水」设计的：只要水还是一块颜色，就必须给它画出边。
  // 现在水已经被抽掉（BODY_K），边就没人来画了——也不该再画：
  // **一块颜色退场总会留下「被橡皮擦过」的轮廓，光退场不会。**
  // 所以收边改成乘在光上：光在水边自己暗下去，水就没有边，只有「光到这儿没了」。
  //
  // 这一条现在是**兜底**，不再是画边的主力。真正的退场交给两处：
  // pond 自己的斜坡（0.42→1.02，跨六成半径）和 wet 的 0.28→0.96。
  // 留它是因为水面以上的零散项（litFloor、扫弦光）不跟 wet 走，
  // 它们得有个东西收，否则汪外会挂着一层没来由的微光。
  // 带宽 0.02→0.50 落在 rr 0.99→0.72，比 wet 更靠外，所以它只啃汪的最外沿，
  // 不参与「光网怎么散」——两件事分开，边界才不会有地方成形。
  col *= smoothstep(0.02, 0.50, pond);

  // 暗角（很轻：压重了就不“透亮”了）+ 颗粒
  vec2 vv = (sp - vec2(0.5, 0.52)) * vec2(1.10, 0.92);
  col *= 1.0 - 0.16 * dot(vv, vv);
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += grain * 0.0045;
  col = clamp(col, 0.0, 1.0);

  // 出口：一层**预乘 alpha 的光**，不是一块不透明的画布。
  // alpha = 1 的时候，黑就是一块黑布铺在页面上——底色再怎么压也只是「更黑的黑」；
  // 换成 alpha = 最亮通道，暗处 alpha 趋近 0，页面就从那儿直接透过来。
  // 这才是「一束光打在屏幕上」：屏幕自己的颜色还在，只是被这束光盖住了一部分。
  // 顺带给了「若隐若现」一个物理上的说法——光弱的地方本来就半透，
  // 背后的东西会跟着透出来一点，两层的边界因此永远定不死。
  //
  // rgb ≤ a 必须逐通道成立：浏览器按预乘解释，色比 alpha 亮的地方会被配成脏色。
  // 取三通道最大值当 alpha，这条不等式就恒成立，而且不用额外算亮度。
  float aOut = max(col.r, max(col.g, col.b));
  outColor = vec4(col, aOut);
}

void legacyMain(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 sp = frag / uRes;
#ifdef DBG_LOD
  float dbgLod = 0.0;
#endif

  // ---- 天空 ----
  if (frag.y < uTop){
    float v = clamp(frag.y / max(uTop, 1.0), 0.0, 1.0);
    vec3 c = mix(vec3(0.032, 0.062, 0.065), vec3(0.062, 0.112, 0.114),
                 smoothstep(0.0, 1.0, v));
    c += vec3(0.016, 0.030, 0.030) * exp(-pow((v - 0.90) / 0.20, 2.0));
    c += vec3(0.014, 0.026, 0.026) * exp(-pow((sp.x - 0.42) / 0.42, 2.0))
         * smoothstep(0.35, 1.0, v);
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    c += grain * 0.006;
    float cloud = texture(uNoise, vec2(sp.x * 0.33 + 0.2, v * 0.13)).r;
    c += vec3(0.007, 0.012, 0.012) * (cloud - 0.5);
    outColor = vec4(c, 1.0);
    return;
  }

  // ---- 平面世界坐标（真正的透视）----
  float s = clamp((frag.y - uTop) / max(uRes.y - uTop, 1.0), 0.004, 1.0);
  float z = 7.0 / s;                       // 底边 7m，地平线无穷远
  float x = (sp.x - 0.5) * z * 2.6;
  vec2 P = vec2(x, z);

  float detail = smoothstep(0.012, 0.17, s);   // 远处渐隐高频，避免混叠
  float energy = clamp(uAmp / 1.5, 0.0, 1.0) * (1.0 - 0.55 * uCalm);
  float windAmt = 0.30 + 0.70 * uWind;

  // 风场：顺流拉长的大块明暗。整块横移，眼睛跟得住。
  // 拉长方向也朝纵深——“顺风”就是顺着 z，暗块在屏幕上被压成竖向的推浪块，
  // 跟浪脊（横躺）交叉，才不会和浪抢同一个方向。
  float sgn = uWindDir >= 0.0 ? 1.0 : -1.0;
  float adv = uFlowAdv;
  vec2 qa = vec2(P.x * 0.052, (P.y - adv) * 0.016);
  vec2 qb = vec2(P.x * 0.115 + 3.7, (P.y - adv) * 0.047 + 1.3);
  float nA = texture(uNoise, qa).r;
  float nB = texture(uNoise, qb).r;
  float gustN = nA * 0.62 + nB * 0.38;
  float gust = smoothstep(0.40, 0.66, gustN) * detail * (0.45 + 0.55 * windAmt);
  // 前缘：风斑“还没到”的一侧更亮，扫过去时像一层皱水推过来。
  float ahead = texture(uNoise, qa + vec2(0.0, 0.030 * sgn)).r;
  float gustEdge = max(0.0, ahead - nA) * 3.2 * detail;
  // 中尺度风纹：比风斑细、比碎光粗，补一层能读的块面
  float gMid = texture(uNoise, vec2(P.x * 0.21 + 7.3, (P.y - adv) * 0.095 + 2.7)).r;
  float gustMid = smoothstep(0.42, 0.64, gMid) * detail;

  // ---- 波高与斜率 ----
  float dhx = 0.0, dhz = 0.0, h = 0.0;
  float low = 0.35 + 0.65 * detail;

  // 低频涌浪：波沿视线方向推进（风朝远处吹），浪脊横躺。
  // 原来这里全是 (1.0, ±0.1)：波横着走，脊线就顺着视线排；
  // 透视一投影，它们从地平线放射下来，成了一束竖丝——看着像揉皱的锡纸。
  // 脊线垂直于视线之后，远景才会被压成一层一层水平的亮暗带，那才是水的样子。
  float swell = 0.0;
  swell += waveN(P, normalize(vec2(0.22, 1.0)), 26.0, 0.280 * energy * windAmt, 1.70, 0.7, dhx, dhz);
  swell += waveN(P, normalize(vec2(-0.10, 1.0)), 16.5, 0.190 * energy * windAmt, 2.40, 2.3, dhx, dhz);
  // 近景必须能看见完整波面：10.5m 那层原来只有 0.095，屏幕上只剩碎纹，
  // 读不出“水在起伏”，只读出“表面被划花了”。
  swell += waveN(P, normalize(vec2(0.38, 1.0)), 10.5, 0.125 * energy * windAmt, 2.30, 3.9, dhx, dhz);
  h += swell;
  // 交叉浪：真实短波本来就各个方向都有，留一部分横向的做交叉，
  // 否则浪脊排得太整齐，会看出程序味（一排排等距的横线）。
  h += waveN(P, normalize(vec2(1.0, 0.22)), 17.0, 0.030 * energy * low, 0.95, 2.8, dhx, dhz);
  h += waveN(P, normalize(vec2(-1.0, 0.31)), 11.0, 0.024 * energy * low, 1.25, 5.4, dhx, dhz);
  // 低通坡度：只取涌浪 + 交叉浪。油光用它算——
  // 短波的坡度在屏幕上每帧能跳好几度，一进高光就变成忽明忽暗的碎点。
  vec2 lowSlope = vec2(dhx, dhz);
  // 中短波：坡陡、棱面清楚，负责“水面有实体感”，不是一块绸子。
  // 方向跟着涌浪走、角度逐层散开，短波才会“骑”在长波上，而不是另开一摊。
  h += waveN(P, normalize(vec2(0.50, 1.0)), 6.9, 0.090 * energy * windAmt, 1.0, 1.3, dhx, dhz);
  h += waveN(P, normalize(vec2(-0.48, 1.0)), 4.6, 0.052 * energy * windAmt * low, 1.0, 4.4, dhx, dhz);
  h += waveN(P, normalize(vec2(0.72, 1.0)), 3.2, 0.026 * energy * windAmt * low * detail, 1.0, 0.9, dhx, dhz);

  // 低音：底部一块缓慢移动的深水暗影，同时抬一点慢波
  float bassMask = exp(-pow((P.x - uBassX) / 15.0, 2.0)) * smoothstep(0.28, 0.76, s);
  h += uBass * 0.070 * bassMask * sin(P.x * 0.19 + uTime * 0.45);
  dhx += uBass * 0.070 * bassMask * 0.19 * cos(P.x * 0.19 + uTime * 0.45);
  dhz += uBass * 0.012 * bassMask;

  // 扫弦：不是一条竖光柱，而是一片被推起来的碎浪。
  // 包络顺着 x 扫过去，浪脊横躺，扫过时整片水面短暂变皱。
  float crestFoam = 0.0;
  if (uCrest.z > 0.0005){
    float dxc = P.x - uCrest.x;
    float cw = 5.0 + 2.5 * uCrest.y;
    float packet = exp(-dxc * dxc / (2.0 * cw * cw));
    float pk = uCrest.z * 1.7 * packet;
    float phc = P.y * 0.62 + P.x * 0.28 - uTime * 1.7;
    h += pk * sin(phc);
    dhx += pk * 0.28 * cos(phc);
    dhz += pk * 0.62 * cos(phc);
    float fn = texture(uNoise, vec2((P.x - adv) * 0.060 + 2.3, P.y * 0.135 + 0.9)).r;
    crestFoam = uCrest.w * packet * smoothstep(0.48, 0.76, fn);
  }

  // 音符涟漪：真实扩散，但被水流压扁、拉长。
  // 单独留一份坡度：它参与明暗，但不参与碎钻——
  // 否则一次快串就会在近景撒下一片“白噪点”。
  vec2 rip = rippleSlopes(P);
  dhx += rip.x;
  dhz += rip.y;

  // 顺流浪纹：同一张定向浪纹贴图分三层滚动，速度完全一致。
  // 平移量必须加在 y 上：浪现在是朝纵深推进的，纹理要是还横着走，
  // 就会出现“浪往前推、纹往右爬”两套方向——这正是最容易被眼睛识破的破绽。
  // 贴图跟着浪走之后，近处涌得快、远处涌得慢，透视本身就成了运动的一部分。
  vec2 uv0 = vec2((P.x - adv * 0.22) / 26.0, (P.y - adv) / 26.0);
  vec2 uv1 = vec2((P.x - adv * 0.22) / 9.5 + 0.37, (P.y - adv) / 9.5 + 0.61);
  vec2 uv2 = vec2((P.x - adv * 0.22) / 3.6 + 0.71, (P.y - adv) / 3.6 + 0.19);
  // 自动 LOD 的解析式：把 uv 导数换算成纹素数再取 log2。
  // 用 bias 而不是 textureLod，是为了保住各向异性过滤（地平线一带是强各向异性的）。
  vec2 d1x = dFdx(uv1) * 512.0, d1y = dFdy(uv1) * 512.0;
  vec2 d2x = dFdx(uv2) * 512.0, d2y = dFdy(uv2) * 512.0;
  float lod1 = log2(max(length(d1x), length(d1y)) + 1e-6);
  float lod2 = log2(max(length(d2x), length(d2y)) + 1e-6);
  vec2 d0x = dFdx(uv0) * 512.0, d0y = dFdy(uv0) * 512.0;
  float lod0 = log2(max(length(d0x), length(d0y)) + 1e-6);
  // 三层的纹素密度差 7 倍（26m / 9.5m / 3.6m）。近景底部一个像素跨
  // 0.28 / 0.77 / 2.0 个纹素 —— 后两层已经越过奈奎斯特，mip 0 采出来就是混叠。
  // 而斜投影下混叠的等相位线正好沿视线放射，屏幕上就成了满地竖丝，
  // 看着像揉皱的锡纸。这才是“不自然”的真身，不是波浪形状。
  // 下限必须逐层给：只抬到刚好不欠采样，多抬一层就多糊一层。
  // （统一给 3 就是之前那版：uv0/uv1 一起糊掉，中景交叉网纹跟着没了。）
  // uNLodFloor < 0 是取证用的“回到 mip0”开关，交付路径不会走到。
  float f1 = uNLodFloor < 0.0 ? 0.0 : max(uNLodFloor, 0.55);
  float f2 = uNLodFloor < 0.0 ? 0.0 : max(uNLodFloor, 1.35);
  float b0 = 0.0;                       // 26m 那层 0.28 纹素/px，本来就够
  float b1 = max(0.0, f1 - lod1);
  float b2 = max(0.0, f2 - lod2);
  vec4 t0 = texture(uNormal, uv0, uNBias + b0);
  vec4 t1 = texture(uNormal, uv1, uNBias + b1);
  vec4 t2 = texture(uNormal, uv2, uNBias + b2);
  vec3 n0 = t0.xyz * 2.0 - 1.0;
  vec3 n1 = t1.xyz * 2.0 - 1.0;
  vec3 n2 = t2.xyz * 2.0 - 1.0;
#ifdef DBG_LOD
  // 取证：画出实际生效的 LOD（含下限抬升），0 = 最锐，8 = 完全糊。
  dbgLod = min(lod1 + b1, lod2 + b2);
#endif
  float nearOnly = smoothstep(0.10, 0.55, s);
  float nstr = (0.22 + 0.38 * gust + 0.22 * gustMid + 0.30 * gustEdge) * (0.40 + 0.60 * detail);
#ifdef NO_NORM0
  n0 = vec3(0.0);
#endif
#ifdef NO_NORM1
  n1 = vec3(0.0);
#endif
#ifdef NO_NORM2
  n2 = vec3(0.0);
#endif
  // 细层单独留一份：它们每帧正好走 1 个纹素，是唯一会“逐帧换脸”的坡度来源。
  // 法线本身还要用（水面得有纹理），但菲涅尔那个 5 次方不许吃它。
  // 必须放在上面清零之后算 —— 否则 ?n1=0 时 dhx 已经少了这一项，
  // 菲涅尔还会再减一次，等于双重扣除，取证数据就失真了。
  // 26m 那层也按距离收一点。它在近景只覆盖贴图一小块，是平滑的大色块；
  // 到了百米外，一行像素横跨几米贴图，就摊成一排等距的细条纹（像百叶窗）。
  // 真实远景只看得见大浪，看不见毛细纹，所以这里衰减一半多，不是全关。
  float n0Fade = 0.35 + 0.65 * detail;
  vec2 texFine = vec2(
    n1.x * 0.40 * nearOnly + n2.x * 0.18 * nearOnly * detail,
    n1.z * 0.40 * nearOnly + n2.z * 0.18 * nearOnly * detail) * nstr;
  dhx += (n0.x * 0.42 * n0Fade + n1.x * 0.40 * nearOnly + n2.x * 0.18 * nearOnly * detail) * nstr;
  dhz += (n0.z * 0.42 * n0Fade + n1.z * 0.40 * nearOnly + n2.z * 0.18 * nearOnly * detail) * nstr;
  // 稀疏的泡沫条：真实风浪里顺风拉长的白沫丝。
  // 它是有形状、能一直被眼睛跟住的东西——整条横着滑过去。
  float foamStreak = 0.0;
  float streakCore = 0.0;
  float span = 46.0;
  for (int k = 0; k < 5; k++){
    float fk = float(k);
    float zk = 7.9 + fk * 3.6;
    float ph = fract(sin((fk + 1.0) * 12.9898) * 43758.5453) * span;
    float xc = mod(ph + adv + span * 0.5, span) - span * 0.5;
    float len = 0.9 + 1.6 * fract(sin((fk + 3.0) * 78.233) * 43758.5453);
    float th = 0.070 + 0.065 * fract(sin((fk + 7.0) * 39.425) * 43758.5453);
    float dx = (P.x - xc) / len;
    // 白沫不是直尺，顺着浪脊带一点弧度
    float zc = zk + 0.30 * sin(dx * 1.6 + fk * 2.1);
    float d2 = dx * dx + (P.y - zc) * (P.y - zc) / (th * th);
    float fall = exp(-d2 * 1.7);
    float taper = 1.0 - smoothstep(0.45, 1.0, abs(dx));
    // 用低通过的噪声来决定“这条丝在这里断开”。
    // 直接拿原始噪声过阈值不行：它每帧平移几个纹素，阈值边缘上的像素
    // 就在“有沫/没沫”之间成片翻面，眼睛看到的就是一排光点在跳。
    // textureLod 取较高的 mip，等于先把噪声糊开，断点变成大块、变化也慢。
    float fiber = textureLod(uNoise, vec2((P.x - adv) * 0.42 + fk * 1.7, fk * 0.9), 3.2).r;
    // 衰减是连续的：最淡也有 0.4，不会整段凭空消失
    float body = mix(0.40, 1.0, smoothstep(0.18, 0.82, fiber));
    float fade = 1.0 - 0.08 * fk;
    foamStreak += fall * taper * body * fade;
    streakCore += exp(-d2 * 3.0) * taper * body * fade;
  }
  float streakOn = smoothstep(0.010, 0.060, s) * (0.30 + 0.70 * uWind);
  foamStreak *= streakOn;
  streakCore *= streakOn;

  // ---- 法线与光照 ----
  vec3 N = normalize(vec3(-dhx * 2.8, 1.0, -dhz * 2.8));
  // 低通法线：只含涌浪和交叉浪，不吃法线贴图的 1 纹素级高频。
  // 菲涅尔是 (1-ndv)^5，掠射时导数极大；浪脊还在，但纹素级抖动不许进这个 5 次方。
  vec3 Nf = normalize(vec3(-lowSlope.x * 2.8, 1.0, -lowSlope.y * 2.8));
  vec3 cam = vec3(0.0, 2.0, 0.0);
  vec3 V = normalize(cam - vec3(P.x, 0.0, P.y));
  vec3 I = -V;
  vec3 R = reflect(I, N);
  vec3 L = normalize(vec3(-0.30, 0.42, 0.50));
  vec3 Hv = normalize(L + V);
  float ndl = max(dot(N, L), 0.0);
  // 菲涅尔用的法线：把细层坡度按 uFresMix 抽掉，其余（粗纹理、涌浪、涟漪、扫弦）全留。
  // 0 = 原来那一版；1 = 细层完全不进菲涅尔。亮度结构基本不动，只去掉会闪的那部分。
  vec3 Nfs = normalize(vec3(
    -(dhx - texFine.x * uFresMix) * 2.8, 1.0,
    -(dhz - texFine.y * uFresMix) * 2.8));
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(Nfs, V), 0.0), 5.0);
  // 只让大浪的迎光面泛一层很淡的油光。不做细碎高光——
  // 那些 1–2 像素的白点会像撒盐，近看是噪点，不是水。
  // 用低通坡度：同一片浪脊会在连续几十帧里一直亮着，慢慢移位，
  // 而不是今天亮明天灭地“跳”。两层指数叠出宽度，读成一片有面积的油光。
#ifdef OLD_SHEEN
  // 旧算法：全坡度 + 22 次幂的窄高光，阈值门直接吃带短波的 h。
  // 亮点会在相邻帧间“有/无”切换，眼睛看到的就是跳。
  float sheen = pow(max(dot(N, Hv), 0.0), 22.0);
#else
  // 新算法：法线只用低通坡度（26/16.5/10.5/17/11 米那几层），
  // 短波不进高光 —— 短波在屏幕上只有一两个像素，进来就是渣。
  // 低通法线是连续的，所以即使指数很高，亮的区域也是一条跟着浪走的窄带，
  // 而不是一堆互不相连的碎点。
  vec3 Nlow = Nf;
  float sl = max(dot(Nlow, Hv), 0.0);
  float sheen = uSh.x * pow(sl, uSh.y) + (1.0 - uSh.x) * pow(sl, uSh.z);
#endif

  vec3 sky = skyCol(R);
  vec3 col = vec3(0.010, 0.026, 0.028) * (0.30 + 1.70 * ndl);
  // 风斑：暗的是被压下去的水面，亮的是推起来的前缘
  col *= 1.0 - 0.20 * gust;
  col += vec3(0.013, 0.022, 0.020) * gustEdge * 1.4;
  col += vec3(0.009, 0.015, 0.014) * gustMid * 0.5;
  // 天空反射：掠射角把起伏的浪脊染亮，形成一条条横向亮带
  col += sky * fres * (1.05 + 0.20 * uWind);
  // 浪脊迎光的一面才有油光，浪谷和远处没有。
  // 门限也用 swell（低频涌浪）而不是全高 h：h 里带短波，门限会跟着抖。
#ifdef OLD_SHEEN
  float gGate = smoothstep(0.04, 0.20, h) * smoothstep(0.035, 0.12, s);
  float glint = sheen * gGate * (0.35 + 0.65 * detail);
#else
  float gGate = smoothstep(0.0, 0.24, swell) * smoothstep(0.030, 0.110, s);
  float glint = sheen * gGate * (0.42 + 0.58 * detail);
#endif
#ifdef NO_GLINT
  glint = 0.0;
#endif
  col += vec3(0.34, 0.44, 0.42) * glint * (0.55 + 0.45 * gust) * 1.15;
  // 浪顶本身比浪谷亮，给实体感
  float crestH = smoothstep(0.02, 0.24, h) * (0.45 + 0.55 * windAmt);
  col += vec3(0.028, 0.044, 0.041) * crestH;
  col *= 1.0 - 0.30 * smoothstep(0.0, 0.22, -h) * detail;
  // 贴图里的浪脊白沫：只留近处、只挑最高的脊尖
  float cap = smoothstep(0.74, 0.92, t2.a) * smoothstep(0.25, 0.55, s)
            * detail * (0.35 + 0.65 * uWind);
  col += vec3(0.060, 0.090, 0.085) * cap * 0.24;
  // 顺风白沫丝
  col += vec3(0.150, 0.210, 0.200) * foamStreak * 0.40;
  col += vec3(0.300, 0.390, 0.370) * streakCore * 0.26;
  // 扫弦碎浪的白沫
  col += vec3(0.095, 0.145, 0.135) * crestFoam * 0.60;
#ifdef DBG_FOAM
  // 取证：只画白沫几项，看它们是不是“一闪一灭”的来源
  {
    float f = foamStreak * 0.40 + streakCore * 0.26 + crestFoam * 0.60 + cap * 0.24;
    outColor = vec4(vec3(clamp(f * 4.0, 0.0, 1.0)), 1.0);
    return;
  }
#endif
  // 低频涌浪压一层大块明暗，整块随水走。
  // 三层涌浪方向都接近纯纵深，脊线就成了一把直尺，明暗交界是一条硬带。
  // 真实浪脊会被短波绕射、被水流推歪，所以这里叠一层很慢的噪声把边界揉弯。
  // 噪声不随 uTime 走，只随位置变——不会闪，也不会在帧间换脸。
  float bandWarp = texture(uNoise, vec2(P.x * 0.021 + 5.1, P.y * 0.009 + 2.7)).r - 0.5;
  float band = clamp(swell * 2.6 + bandWarp * 0.55, -1.0, 1.0);
  col *= 1.0 + 0.26 * band;

  // 暗影
  float sh = uBass * bassMask;
  col *= vec3(1.0 - 0.32 * sh, 1.0 - 0.29 * sh, 1.0 - 0.29 * sh);

  // 留白：只把水整体压暗一点，不再放光斑
  col *= 1.0 - 0.10 * uCalm;

  // 合拢/收住时水更暗更平
  col *= 1.0 - 0.18 * uClose;

  // 大气透视：一百米开外就该慢慢往天空色靠。原来系数 16 只肯在 40m 内融合，
  // 再远的水面一直保持原色，于是地平线成了一条又直又硬的边——
  // 一眼就能看出是“贴了一张纸”，这是最显廉价的地方。
  float hzN = texture(uNoise, vec2(P.x * 0.018 + 0.37, 0.5)).r;
  float hz = exp(-s * (7.5 + 3.5 * hzN));
  vec3 skyHz = vec3(0.062, 0.112, 0.114);
  col = mix(col, skyHz, hz);

  // 暗角 + 颗粒
  vec2 vv = (sp - vec2(0.5, 0.62)) * vec2(1.15, 0.95);
  col *= 1.0 - 0.30 * dot(vv, vv);
  // 最底边压暗，藏住近景放大的糊边。
  // 原来压到 0.72，画面底部会出现一条看得出起止的暗带，像贴边；
  // 留一点就够藏糊边，压太重反而暴露它是“画出来的”。
  col *= mix(0.86, 1.0, smoothstep(0.0, 0.070, 1.0 - s));
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += grain * 0.005;

#ifdef DBG_LOD
  outColor = vec4(vec3(clamp(dbgLod / 8.0, 0.0, 1.0)), 1.0);
  return;
#endif
#ifdef DBG_GLINT
  // 取证：只把高光项画成灰度，其余全部丢掉。
  // 这样逐帧比对时，水面的整体流动不会掩盖“亮点什么时候亮、什么时候灭”。
  outColor = vec4(vec3(clamp(glint * 7.0, 0.0, 1.0)), 1.0);
  return;
#endif

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}

void main(){
#ifdef LOOK_CLEAR
  clearMain();
#else
  legacyMain();
#endif
}
`;

function fractalField(size, octaves, seed0) {
  let seed = seed0 || 1337;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const grids = octaves.map((o) => {
    const g = new Float32Array(o.f * o.f);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return g;
  });
  const smooth = (t) => t * t * (3 - 2 * t);
  const out = new Float32Array(size * size);
  let ampSum = 0;
  for (const o of octaves) ampSum += o.a;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let k = 0; k < octaves.length; k++) {
        const { f, a } = octaves[k];
        const g = grids[k];
        const fx = (x / size) * f;
        const fy = (y / size) * f;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = smooth(fx - x0);
        const ty = smooth(fy - y0);
        const xa = ((x0 % f) + f) % f;
        const ya = ((y0 % f) + f) % f;
        const xb = (xa + 1) % f;
        const yb = (ya + 1) % f;
        const i00 = ya * f + xa;
        const i10 = ya * f + xb;
        const i01 = yb * f + xa;
        const i11 = yb * f + xb;
        const top = g[i00] + (g[i10] - g[i00]) * tx;
        const bot = g[i01] + (g[i11] - g[i01]) * tx;
        v += (top + (bot - top) * ty) * a;
      }
      out[y * size + x] = v / ampSum;
    }
  }
  return out;
}

// 取证开关：?mip=old 关掉 mipmap 与各向异性过滤，回到会闪的旧行为
const MIP_OLD = typeof location !== 'undefined' && /[?&]mip=old/.test(location.search);
let anisoExt = null;
let anisoMax = 1;

// 掠射角下的水面，屏幕像素在贴图上是一条被拉得很长的椭圆。
// 只做三线性会让它在长轴方向欠采样，于是整片近景“爬格子”。
// 各向异性过滤就是为这个角度准备的。
function applyAniso(gl, level = 8) {
  if (MIP_OLD) return;
  if (anisoMax <= 1) return;
  gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(level, anisoMax));
}

function makeNoiseTexture(gl) {
  const size = 512;
  const f = fractalField(size, [
    { f: 5, a: 0.52 },
    { f: 13, a: 0.30 },
    { f: 31, a: 0.18 },
  ], 1337);
  const data = new Uint8Array(size * size);
  for (let i = 0; i < f.length; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  if (MIP_OLD) {
    // 旧行为：无 mipmap。贴图高频部分缩小采样时会乱跳，
    // 白沫丝的断开处会一帧亮一帧灭。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  } else {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    applyAniso(gl, 8);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

/**
 * 顺流浪纹：高度场由一组“浪脊接近竖直”的正弦浪叠成，再拿周期噪声做域扭曲。
 * RGB = 法线，A = 高度（局部浪顶越高，A 越亮）。
 * 和旧的各向同性噪声相比，它天生带方向：浪脊一条条排开，
 * 整张贴图横移时，眼睛能直接顺着浪脊读出“水在往哪边走”。
 */
function makeNormalTexture(gl) {
  const size = 512;
  // 波矢朝纵深、脊线横躺。相位是 (a*X + b*Y)：a 是 x 向频率、b 是 y 向频率，
  // 等值线（浪脊）垂直于 (a,b)。原来主分量是 (a=4, b=1)，即 x 向变化快 4 倍，
  // 脊线沿 y 拉长；贴到地面上就是沿纵深的长脊，透视后被拉成从地平线放射的竖丝，
  // 整片看着像揉皱的锡纸。全套 a >> b 都是这个问题，现在统一换成 b >> a。
  // 保留两层 a 偏大的（斜向分量），做交叉网，免得变成一排排等距的横线。
  const waves = [
    { a: 1, b: 4, amp: 0.44, ph: 0.3, sh: 1.3 },
    { a: -2, b: 7, amp: 0.34, ph: 1.9, sh: 1.5 },
    { a: 3, b: 11, amp: 0.24, ph: 4.1, sh: 1.6 },
    { a: -5, b: 16, amp: 0.15, ph: 2.5, sh: 1.9 },
    { a: 8, b: 23, amp: 0.09, ph: 5.2, sh: 1.4 },
    { a: 9, b: 6, amp: 0.11, ph: 1.1, sh: 1.3 },
    { a: -13, b: 9, amp: 0.08, ph: 3.3, sh: 1.3 },
  ];
  const warp = fractalField(size, [
    { f: 3, a: 0.58 },
    { f: 7, a: 0.42 },
  ], 777);
  const patchy = fractalField(size, [
    { f: 3, a: 0.64 },
    { f: 6, a: 0.36 },
  ], 5150);
  const rough = fractalField(size, [
    { f: 7, a: 0.52 },
    { f: 19, a: 0.30 },
    { f: 41, a: 0.18 },
  ], 31337);
  const smooth01 = (t) => {
    const u = Math.max(0, Math.min(1, t));
    return u * u * (3 - 2 * u);
  };
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // 域扭曲让浪脊弯曲、粗细不均，避免“梳齿”
      const wx = (warp[i] - 0.5) * 110.0;
      const wy = (warp[((y + 137) % size) * size + ((x + 271) % size)] - 0.5) * 110.0;
      const X = x + wx;
      const Y = y + wy;
      let v = 0;
      for (let k = 0; k < waves.length; k++) {
        const w = waves[k];
        // 每个分量只在自己那片区域出现，水面才不是一张均匀的梳子
        const pi = ((y + k * 53) % size) * size + ((x + k * 97) % size);
        const pm = 0.25 + 0.75 * smooth01((patchy[pi] - 0.24) / 0.52);
        const ph = (TAU * (w.a * X + w.b * Y)) / size + w.ph;
        const s = 0.5 + 0.5 * Math.sin(ph);
        v += w.amp * pm * Math.pow(s, w.sh);
      }
      v += (rough[i] - 0.5) * 0.10;
      h[i] = v;
    }
  }
  // 归一到 0..1，存进 A 通道
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  const inv = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) * inv;

  const data = new Uint8Array(size * size * 4);
  const gscale = 22.0;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const gx = (h[y * size + xp] - h[y * size + xm]) * gscale;
      const gy = (h[yp * size + x] - h[ym * size + x]) * gscale;
      let nx = -gx;
      let ny = 1.0;
      let nz = -gy;
      const n = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= n; ny *= n; nz *= n;
      const p = (y * size + x) * 4;
      data[p] = Math.round((nx * 0.5 + 0.5) * 255);
      data[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[p + 3] = Math.round(h[y * size + x] * 255);
    }
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  return tex;
}

export class GLWater {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      // alpha 必须开：底色抽掉之后（见 BODY_K），这一层要能跟下面的东西合成，
      // 而不是拿一块不透明的画布把页面盖死。
      // premultipliedAlpha 保持默认 true——着色器出口给出的就是预乘后的颜色。
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    // 取证用开关：?sheen=old 编回旧的高光算法，其余完全一致，
    // 这样新旧两版只差这一项，可以直接逐像素对照。
    this.oldSheen = /[?&]sheen=old/.test(location.search);
    // 画法：默认 clear（整幅水面、俯视、透亮）。?look=sea 回到老那版有地平线的海面，
    // 留着是为了不把上一轮调好的东西丢掉，而不是交付路径。
    this.look = /[?&]look=sea/.test(location.search) ? 'sea' : 'clear';
    this.dbgGlint = /[?&]dbg=glint/.test(location.search);
    const nbM = location.search.match(/[?&]nb=(-?[\d.]+)/);
    this.nBias = nbM ? Number(nbM[1]) : 0;
    const lfM = location.search.match(/[?&]lf=(-?[\d.]+)/);
    this.nLodFloor = lfM ? Number(lfM[1]) : 0;
    const fmM = location.search.match(/[?&]fm=([\d.]+)/);
    this.fresMix = fmM ? Number(fmM[1]) : 1;
    let frag = FRAG;
    const defs = [];
    if (this.look === 'clear') defs.push('#define LOOK_CLEAR 1');
    if (this.oldSheen) defs.push('#define OLD_SHEEN 1');
    if (this.dbgGlint) defs.push('#define DBG_GLINT 1');
    if (/[?&]dbg=foam/.test(location.search)) defs.push('#define DBG_FOAM 1');
    if (/[?&]nog=1/.test(location.search)) defs.push('#define NO_GLINT 1');
    // 取证用：逐个关掉法线细层，隔离“近景单像素翻面”的来源。
    if (/[?&]n0=0/.test(location.search)) defs.push('#define NO_NORM0 1');
    if (/[?&]n1=0/.test(location.search)) defs.push('#define NO_NORM1 1');
    if (/[?&]n2=0/.test(location.search)) defs.push('#define NO_NORM2 1');
    if (/[?&]n12=0/.test(location.search)) defs.push('#define NO_NORM1 1\n#define NO_NORM2 1');
    if (/[?&]dbg=lod/.test(location.search)) defs.push('#define DBG_LOD 1');
    // 取证用：?body=1 回到「一整片水」那版，?body=0 只剩光，其余完全一致。
    // 只差 BODY_K 这一项，可以直接并排比「拿走底色」到底改了什么。
    const bodyM = location.search.match(/[?&]body=([\d.]+)/);
    // 必须补成浮点字面量。GLSL ES 3.00 不做隐式转换，`* 1` 是 float×int，
    // 编译直接失败——表现不是报错，是画布停在 300×150 的白板，
    // 因为 GLWater 构造抛了、index.html 那边退回 2D 兜底。
    if (bodyM) defs.push('#define BODY_K ' + Number(bodyM[1]).toFixed(3));
    const lightM = location.search.match(/[?&]light=([\d.]+)/);
    if (lightM) defs.push('#define LIGHT_K ' + Number(lightM[1]).toFixed(3));
    // 最低可见度。?veil=0 完全关掉，用来并排比「这层散射到底帮上忙没有」。
    const veilM = location.search.match(/[?&]veil=([\d.]+)/);
    if (veilM) defs.push('#define VEIL_K ' + Number(veilM[1]).toFixed(3));
    // 亮脊带宽与陡度。脊线是 |det|→0 的零集，带宽决定「线有多粗」：
    // 太粗 = 连成面（发光的墨迹），太细 = 只剩几个像素点（几乎全黑）。
    // 同样必须是浮点字面量，理由见上面的 BODY_K。
    const bandM = location.search.match(/[?&]band=([\d.]+)/);
    if (bandM) defs.push('#define RIDGE_B ' + Number(bandM[1]).toFixed(3));
    const rpM = location.search.match(/[?&]rp=([\d.]+)/);
    if (rpM) defs.push('#define RIDGE_P ' + Number(rpM[1]).toFixed(3));
    if (defs.length) frag = frag.replace('#version 300 es', '#version 300 es\n' + defs.join('\n'));
    this.program = this._program(VERT, frag);
    gl.useProgram(this.program);

    const vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    const names = [
      'uRes', 'uTop', 'uTime', 'uWind', 'uCalm', 'uAmp', 'uChop', 'uDensity',
      'uClose', 'uSuspended', 'uWindDir', 'uDrift', 'uFlowAdv', 'uFlowSpeed', 'uBass', 'uBassX', 'uSweep',
      'uRipA', 'uRipB', 'uCrest', 'uNoise', 'uNormal', 'uSh', 'uNBias', 'uNLodFloor', 'uFresMix', 'uView',
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(this.program, n);
    // 高光形状：褶边权重 0.15 / 低指数 14 / 高指数 52。
    // 这组是扫出来的：亮块平均 3100 px、同屏约 4 块、每帧亮灭翻转 544 px
    // （旧版 98 个小碎点、翻转 927 px）。可用 ?sh=w,e1,e2 现场改。
    this.shTune = [0.15, 14, 52];
    const shm = /[?&]sh=([\d.]+),([\d.]+),([\d.]+)/.exec(location.search);
    if (shm) this.shTune = shm.slice(1).map(Number);
    // 各向异性能力要在建纹理之前拿到，否则噪声贴图拿不到过滤等级
    anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    anisoMax = anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    gl.uniform1i(this.u.uNoise, 0);
    gl.uniform1i(this.u.uNormal, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, makeNoiseTexture(gl));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, makeNormalTexture(gl));
    gl.activeTexture(gl.TEXTURE0);

    this.ripA = new Float32Array(32);
    this.ripB = new Float32Array(32);

    this.cssW = 1;
    this.cssH = 1;
    this.top = 0;
    this.dpr = 1;
    this.view = 1;
    this._ready = false;
  }

  // 满屏展开的进度 0..1。GLSL 的 smoothstep 是 t*t*(3-2t)，这里手写同一个式子：
  // 着色器里 pondR 的 grow 用它，涟漪落点的压缩系数也用它——两边但凡差一点，
  // 涟漪的落点分布和水面就不是同一套尺度（水倒是看不出来，环会落在岸外）。
  _fullAt(v) {
    const t = Math.min(1, Math.max(0, (v - VIEW_FROM) / (VIEW_TO - VIEW_FROM)));
    return t * t * (3 - 2 * t);
  }

  // 落点压缩系数。基准档是 POND_KX/KZ（把整幅 9.4m 的落点压进这一小汪），
  // 满屏时汪铺满了画幅，就不该再压——压到 0.95 只是留一点余量，
  // 让最边上那滴水不贴死画框。中间按同一条 smoothstep 过去。
  _spreadAt(v) {
    const d = this._fullAt(v);
    return {
      kx: POND_KX + (0.95 - POND_KX) * d,
      kz: POND_KZ + (0.95 - POND_KZ) * d,
    };
  }

  // 屏幕坐标（0..1）→ 水面世界坐标。与着色器里的 camPlane 同式。
  // 返回 x/z（米）与 t（沿视线的参数，用来换算「整幅宽多少米」）。
  //
  // 这里给的是**基准米**（camPlane 那一套，与画幅大小无关），不是「展开后」的米。
  // 着色器拿到 A.xy / uCrest.x 之后自己乘 SP 折进 P 坐标，汪心 pondC 也是 POND_CX*SP——
  // 两边说同一种米，落点才不会被视野倍数乘两遍。乘两遍的后果很具体：
  // 池子越大涟漪越偏，满屏时一颗颗全落在汪外，画面里一片死水。
  _planeAt(u, v) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dyf = (0.5 - v) / CAM_F;
    const dxf = ((u - 0.5) * (W / H)) / CAM_F;
    const inv = Math.max(1e-3, CAM_SIN - dyf * CAM_COS);
    const t = CAM_H / inv;
    return { x: t * dxf, z: t * (dyf * CAM_SIN + CAM_COS), t };
  }

  // 某一行像素横跨多少米。涟漪半径、水脊宽度都得按这个折算。
  _spanAt(v) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dyf = (0.5 - v) / CAM_F;
    const inv = Math.max(1e-3, CAM_SIN - dyf * CAM_COS);
    const t = CAM_H / inv;
    return (2.0 * t * ((0.5 * W) / H)) / CAM_F;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    return p;
  }

  resize(cssW, cssH, dpr, top) {
    const gl = this.gl;
    this.cssW = cssW;
    this.cssH = cssH;
    this.top = top;
    // 视野倍数 = 画幅相对 430×320 放大了多少。基准画幅那一档是 1，
    // 拉大时相机跟着抬高（看见新水面），缩小时最多退到 0.8（再退波纹就过粗了）。
    this.view = Math.max(0.8, cssH / 320);
    this.dpr = Math.min(1.5, dpr || 1);
    this.canvas.width = Math.max(2, Math.round(cssW * this.dpr));
    this.canvas.height = Math.max(2, Math.round(cssH * this.dpr));
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._ready = true;
  }

  readPixels() {
    const gl = this.gl;
    gl.finish();
    const buf = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  draw(water) {
    if (!this._ready) return;
    const gl = this.gl;
    // ?vis=raw 关掉起振缓入，配合 water.js 的开关做旧/新对照。
    const NO_ATK = /[?&]vis=raw/.test(location.search);
    // 用「给画面看的那层包络」：音符把 env 一步推到位的量，
    // 在这里已经缓过一小段，不会出现整片水一帧换脸的闪。
    const e = water.visEnv || water.env;
    gl.useProgram(this.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    // 透亮模式整幅都是水，没有天空带——uTop 给 0，天空分支永远不会进。
    gl.uniform1f(this.u.uTop, this.look === 'clear' ? 0 : this.top * this.dpr);
    if (this.u.uView) gl.uniform1f(this.u.uView, this.view || 1);
    gl.uniform1f(this.u.uTime, water.time);
    gl.uniform1f(this.u.uWind, e.wind);
    gl.uniform1f(this.u.uCalm, e.calm);
    gl.uniform1f(this.u.uAmp, e.amp);
    gl.uniform1f(this.u.uChop, e.chop);
    gl.uniform1f(this.u.uDensity, e.density);
    gl.uniform1f(this.u.uClose, e.close);
    gl.uniform1f(this.u.uSuspended, e.suspended);
    gl.uniform1f(this.u.uWindDir, Math.tanh(e.flow * 2.4));
    if (this.u.uSh) gl.uniform3f(this.u.uSh, this.shTune[0], this.shTune[1], this.shTune[2]);
    if (this.u.uNBias) gl.uniform1f(this.u.uNBias, this.nBias);
    if (this.u.uNLodFloor) gl.uniform1f(this.u.uNLodFloor, this.nLodFloor);
    if (this.u.uFresMix) gl.uniform1f(this.u.uFresMix, this.fresMix);
    gl.uniform1f(this.u.uDrift, water.driftScreens);
    // flowAdv 是积分过的位移（米）：风变化时不会把已经走过的路倒回去。
    // driftScreens 本身带方向，不能再乘一次 windDir。
    gl.uniform1f(this.u.uFlowAdv, water.flowAdv + water.driftScreens * 20.0);
    gl.uniform1f(this.u.uFlowSpeed, water.flowRate * water.windDirVis);
    gl.uniform1f(this.u.uBass, e.bass);
    // 低音暗影的横向位置：俯视模式下画幅只有 ~9.4m 宽，不能沿用海面的 31m。
    gl.uniform1f(this.u.uBassX, (water.bassX - 0.5) * (this.look === 'clear' ? 9.4 : 31.0));
    gl.uniform1f(this.u.uSweep, e.sweepPulse);

    // 涟漪：屏幕坐标换成世界坐标；只取最近 8 个还活着的。
    const A = this.ripA;
    const B = this.ripB;
    A.fill(0);
    B.fill(0);
    let slot = 0;
    for (let k = water.ripples.length - 1; k >= 0 && slot < 8; k--) {
      const r = water.ripples[k];
      const age = water.time - r.born;
      let life = e.suspended > 0.4 ? r.life * 1.7 : r.life;
      const clear = this.look === 'clear';

      // 力度 → 这滴最后扩多大。
      // 「扩散大小」在画面里就是环的半径 = 前缘速度 × 它还活着的时间。
      // 这里只让速度跟力度走，寿命交给 water.js 的 1.05+0.55v（力度越大本来活得略久），
      // 不再额外乘 sizeK。乘上去的代价很具体：同一个钟点上，小力度的环已经走到
      // 自己寿命的更后面，lifeK 衰减得更狠——结果是占九成的那一档最先看不见，
      // 画面里只剩几个大力的环在那儿显眼，读起来像「随机大小」，不像「轻重」。
      const vn = velNorm(r.vel ?? 0.5);
      // 0.74~1.26：实测终径 1.29 / 1.62 / 2.30 m（轻 / 中 / 重），差 1.8 倍。
      // 为什么不敢拉更开——汪半径 2.25m，环的前缘一过岸就化掉，
      // 再大也读不出「更大」，只读成「没画出来」。
      // 中位那档（vel 64，占谱面九成）落在 ≈0.98，基本不动已经认可的那一版。
      const sizeK = 0.74 + 0.52 * vn;
      // 音高 → 亮一点点。抬的是波高，不是颜色：焦散亮度是 1/|det|，
      // det 穿零的深浅由 D·h_rr 定，所以「亮」在这里只能等于「波更陡」。
      // 要是去提整片的色或曝光，那就是整个水汪变亮，不是这一个音变亮。
      // 幅度 0.26 是量的，不是挑的：同一帧只改这一个系数、和「0 版」相减取峰值差——
      //   中音那滴（pitch 0.43）：14% → 43/255，30% → 63/255
      //   高音那滴（pitch 0.93）：14% → 62/255，26% → 73/255
      // 14% 在并排静帧上几乎分不出来（等于没做）；26% 才是「看得出、但它只发生在环上」。
      // 别指望更多：这一项乘的是波高，环一亮就顶到焦散的饱和去了。
      const brightK = 1.0 + 0.26 * (r.pitch ?? 0.5);

      if (clear) {
        // 寿命必须先算、再剔除。着色器里这圈环活的是 B.z 秒；
        // 这里如果还按 r.life 剔，环会在还剩三成亮度的时候「啪」一下消失。
        // 一滴水的环能跑两秒上下。原来 1.05~1.6s 太短，环还没散开就没了。
        life = Math.min(3.6, life * 1.55);
      }
      if (age < 0 || age > life) continue;
      // 涟漪起振也要一点时间：一帧之内把坡按下去，近景会像闪了一下。
      const atk = NO_ATK ? 1 : Math.min(1, age / 0.09);
      if (clear) {
        // 透亮模式：一个音符 = 一滴水。
        // 屏幕点反算到水面，存进去的是「波高（米）」和「波数」，
        // 不是海面那套坡度——着色器那边按轴对称环形波算二阶导。
        const p = this._planeAt(r.x, r.d);
        // 落点压进水汪里（见 POND_KX/KZ）。压缩是绕汪心做的线性缩放，
        // 所以音符之间「高音在右、低音在左」的相对关系还在，
        // 只是整幅的位置图被缩到这一汪水里——听起来才是「同一片水面」。
        // 汪心不乘 view：着色器那边 pondC 也是 POND_CX*SP，两边都用基准米。
        // 压缩系数随满屏进度放到接近 1（见 _spreadAt）：小窗里落点被压进这一小汪，
        // 满屏时水面铺满了画幅，落点就该跟着摊开——否则池子大了、
        // 涟漪还挤在中间那一小圈里，看着像水面没变、只是镜头退了。
        const sp2 = this._spreadAt(this.view || 1);
        const cx = POND_CX, cz = POND_CZ;
        const px = cx + (p.x - cx) * sp2.kx;
        const pz = cz + (p.z - cz) * sp2.kz;
        A[slot * 4] = px;
        A[slot * 4 + 1] = pz;
        A[slot * 4 + 2] = r.born;
        // 波高：真实水滴的毛细波是亚毫米级，这里给 0.25~0.65mm。
        // 这个值不是随手抬的：焦散要看见「环」，必须让 D·h_rr 够到 1，
        // 也就是 det 真的穿过零。给 1e-4 量级时 det 只是整体被压低，
        // 环就变成一团「整体提亮」的糊斑——试过，正是上一版的样子。
        // 短音符（dur≤150）是小雨点：浅、快、寿命短。
        // 波高不再乘 sizeK^k 去补贴「大力度的环跑得远所以变淡」：
        // 波速按水汪缩到 0.50 以后，各档的终径都在 1.3~2.3m，1/√r 那点衰减差不到 10%，
        // 补贴反而变成一条「力度→亮度」的暗线，抢掉音高那 26% 的戏。
        // 于是亮度只由音高决定，两件事各管一头，调哪一个都不会串。
        A[slot * 4 + 3] =
          (0.00026 + 0.00040 * (r.amp / 4.6)) *
          (r.fast ? 0.60 : 1) * brightK * atk;
        // 波列包络宽（米）。2.2σ 就是环带的半宽：给 0.42 时环里能数出十来圈，
        // 读成弹簧；收到 0.28 上下只剩三圈，才是水滴的样子。
        B[slot * 4] = 0.14 + 0.05 * (r.amp / 4.6);
        // k = 2π/λ。取到 λ≈0.12~0.17m：再短在屏幕上糊成一片，再长读成涌浪。
        // 这里刻意不跟音高联动：波长一变，环里的圈数就跟着变，
        // 高音会变成「更细密的一团」，读起来是另一种效果，不是「更亮」。
        B[slot * 4 + 1] = r.fast ? 54.0 : 40.0;
        B[slot * 4 + 2] = life;
        // 前缘速度（m/s）。0.50 是把「整幅 9.4m」时代的 1.6m/s 折算到这一汪水里
        // （见 POND_WS）：中位那档跑两秒到 1.62m，铺满汪心还没到岸；
        // 最重那档 2.30m，末端正好压在岸上化掉。
        // 再快就变成「一圈光扫过去」，那是扫灯不是涟漪。
        B[slot * 4 + 3] = (r.fast ? 2.6 : 1.6) * sizeK * POND_WS;
        slot++;
        continue;
      }
      let wx, z, sig;
      {
        z = Math.max(6.5, 7.0 / Math.max(0.06, r.d));
        wx = (r.x - 0.5) * z * 2.6;
        sig = Math.min(3.6, Math.max(0.5, r.sigma * z * 2.6));
      }
      A[slot * 4] = wx;
      A[slot * 4 + 1] = z;
      A[slot * 4 + 2] = r.born;
      // 涟漪只是“按下去的一点坡”，不能让近景整片变成气泡圈
      A[slot * 4 + 3] = Math.min(0.06, r.amp * 0.005) * atk;
      B[slot * 4] = sig;
      B[slot * 4 + 1] = r.fast ? 2.2 : 1.3;
      B[slot * 4 + 2] = life;
      B[slot * 4 + 3] = r.fast ? 3.0 : 1.75;
      slot++;
    }
    gl.uniform4fv(this.u.uRipA, A);
    gl.uniform4fv(this.u.uRipB, B);

    // 扫弦水脊
    const c = water.crest;
    if (c) {
      const age = water.time - c.born;
      const p = age / c.life;
      if (age >= 0 && age < c.life) {
        const zref = this.look === 'clear'
          ? this._planeAt(water.crestX(), c.d).x
          : (water.crestX() - 0.5) * (7.0 / Math.max(0.06, c.d)) * 2.6;
        const fade = Math.pow(1 - p, 1.35);
        // 起脊同理：给 0.14 秒长起来，别一帧就立起一道浪
        const atk = NO_ATK ? 1 : Math.min(1, age / 0.14);
        gl.uniform4f(this.u.uCrest, zref, 0.60 + 2.0 * e.spread, 0.26 * fade * atk, 0.9 * fade * atk);
      } else {
        gl.uniform4f(this.u.uCrest, 0, 1, 0, 0);
      }
    } else {
      gl.uniform4f(this.u.uCrest, 0, 1, 0, 0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
