/**
 * dsh-guzheng-pond — 浏览器端。
 *
 * 两件事：
 *   1. `shell.overlay` 上常驻那一汪水（右下角、可拖、透明到能看见后面的字）。
 *   2. 主对话输入框下面一个按钮：点了就派子会话去编一曲。
 *
 * 水这一层是命令式的（WebGL + canvas + rAF），React 只负责给它一个容器和
 * 生命周期；所有清理都挂在组件卸载上。样式全部收在 `#gz-pond` 前缀里，
 * 不往 document 上写 DOM、不改别人的样式。
 *
 * 水层两个库（water.js / gl-water.js）从 `/api/pond/asset/` 动态 import ——
 * 它们是项目里冻结过的成片实现，一个字没改，只是换了个加载地址。
 */
window.__ModuleLoader__.load({
  id: 'dsh-guzheng-pond',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var h = react.createElement;

    var POND_W = 430;
    var POND_H = 320;
    var TOPR = 0.20;      // 水面抬高一档：水汪本来就矮，0.315 会把水挤成一小条
    var POND_GAIN = 1.00; // 小窗增益（全屏的能量摊在 1440×900 上，缩到 430×320 会糊成一块白斑）
    var SS = 2;           // 超采样：着色器的丝状细节按物理像素算，小窗只有全屏 1/9 的像素
    // 尺寸下限 = 上面这个 430×320 的一半。上限不是常数：视口有多大就能多大，
    // 由 sizeMaxK() 现算（cover 语义，宽高各算一次取大的，保证盖满屏幕）。
    var SIZE_MIN = 0.5;
    var SIZE_KEY = 'gz-pond-size-k';

    // ── 样式 ───────────────────────────────────────────────────────────────
    // 「一片水」的水底（放大的档位用）。和小窗那一套（两个偏心椭圆、中心亮边缘虚）
    // 是两种画法，不是一个东西的缩放：同一个径向渐变面积越大越显平，中心那点
    // 高 alpha 摊到全屏就是一块平蓝天，界面读不出来、也没有水的层次。
    //
    // 这组渐变有一条硬规矩：**必须自己往 0 收**。背景只画在元素自己的盒子内，
    // 拿一套「到边还剩 .44」的渐变铺上去，盒子边缘就是一条直角的蓝边 ——
    // 比原来那条椭圆水缘更糟（实测 946 档：右侧一条笔直的竖边，一眼看出是个块）。
    // 所以最后那 6% 的行程收到完全透明，半径给到盒子的 105%。
    //
    // 但要说清楚：105% 只是让淡出**接近**盒边，不是让它落在盒外 ——
    // 径向渐变的百分半径是相对整个盒子宽高的，105% 等于半个盒子再撑出去一点，
    // 而盒子的半宽只有 50%。所以盒子边上仍然剩着一点 alpha，实测 946/1161 两档
    // 照样是一条矩形硬边，整块水读成一个规规矩矩的方块。
    // 收口不能靠这个渐变（见下面 FADE_MASK），这里只负责「水往画外去」的浓度分布。
    var DEEP_FAR_DARK =
      'radial-gradient(ellipse 105% 100% at 47% 48%,' +
      'rgba(64,134,146,.26) 0%,rgba(54,122,134,.23) 38%,rgba(38,90,104,.19) 68%,' +
      'rgba(22,58,70,.10) 88%,rgba(10,26,34,0) 100%)';
    var DEEP_FAR_LIGHT =
      'radial-gradient(ellipse 105% 100% at 47% 48%,' +
      'rgba(64,150,206,.62) 0%,rgba(96,178,220,.55) 36%,rgba(132,196,230,.46) 64%,' +
      'rgba(160,210,238,.30) 84%,rgba(180,224,242,.10) 95%,rgba(180,224,242,0) 100%)';
    // 四条边的淡出带。上面那套渐变只是「几乎」铺满盒子，到盒子边上还剩一点
    // alpha；background 只画在元素自己的盒子内，于是盒子边界就是一条笔直的硬切
    // （实测 946 档：整块水就是个规规矩矩的矩形，左边那条竖边横穿侧栏 —— 比原来
    // 那条椭圆水缘还糟）。改渐变治不了：任何单个椭圆都做不到四条直边同时归零，
    // 把半径收到边内就退回一个小椭圆，又成了盘子。
    //
    // 所以逐边给淡出带，长度由 applySize 按「盒子这一边离屏幕边还有多远」写进
    // --gz-fl/fr/ft/fb，四条线性渐变取交集削出软边。已出画的那一侧给 0px，
    // 渐变退化成 0→0 的硬停（整层不透明），满屏那档因此和原来一模一样。
    var FADE_MASK =
      'linear-gradient(to right,transparent 0,#000 var(--gz-fl,0px)),' +
      'linear-gradient(to left,transparent 0,#000 var(--gz-fr,0px)),' +
      'linear-gradient(to bottom,transparent 0,#000 var(--gz-ft,0px)),' +
      'linear-gradient(to top,transparent 0,#000 var(--gz-fb,0px))';
    var CSS =
      // 容器：fixed 定点，四角穿透。
      '#gz-pond{position:fixed;right:34px;bottom:104px;width:' + POND_W + 'px;height:' + POND_H + 'px;' +
      'z-index:40;touch-action:none;pointer-events:none;contain:layout style;--gz-sp:0;--gz-mk:1}' +
      // 2D 层建的 context 是 {alpha:false}——不透明黑底。全屏版里它正好是底色，
      // 放进水汪就是一块挡住界面的黑布。有 GL 层时 2D 只做数据不上屏。
      '#gz-pond .gz-water{opacity:0}' +
      '#gz-pond canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}' +
      // 水是「光」，不是「板」：GL 出口是预乘光，亮处 alpha≈1，普通 alpha 合成会把
      // 这些地方盖成白纸。screen 叠 = 往水底加光，暗处几乎不贡献。
      // .5px 模糊补 1440→430 降采样后过利的丝状边缘。
      // 涟漪只该活在这一汪里。GL 层的水洼是着色器里的世界坐标（pondC/pondR +
      // POND_KX/KZ 落点压缩），和眼睛看到的椭圆从来不是同一个几何；截取成小窗之后，
      // 波峰、光网就画到水外去了（改前截图：中间一团深青，外面罩着一整圈发白光晕，
      // 连画布底边都被切断）。assets 是冻结实现，所以在合成这一步上做软遮罩。
      //
      // 两件事一起做，缺一件都不对：
      // 【一】范围要铺满。着色器把落点压在汪半径的 0.42 上，涟漪足迹实测只占
      //   水洼中间 45% 宽 —— 外面那圈"水"是 .gz-deep 的 CSS 渐变，一点波纹都没有。
      //   用户看到的就是「涟漪只在中间，边上一圈是干的」，于是读作「涟漪跑外面去了，
      //   在外面看不见」。把这一层按 1.5 倍铺开：足迹 45%→67%，够顶到水缘。
      //   放大只能用 transform，不能改 left/width —— GL 的 resize() 会带一个
      //   屏幕偏移量算投影，布局尺寸一变它就跟着重算，画面整体错到左上角
      //   （实测 bbox 从 31~76% 跳到 1~52%，outside 60%）。transform 不改布局盒，
      //   clientWidth 不变，resize 一次都不会重跑，投影还是原来那套。
      //   遮罩也一起被 transform 缩放，所以半径要预先除以 1.5 再收一点
      //   （45→28、40→25）：缩完视觉半径落在 42%/37.5%，正好卡在水缘 41%/36% 里侧。
      // 【二】边界要收干净。遮罩几何 = 水缘 .gz-rim（inset 9%/15%/9%/13% →
      //   宽 82% 高 72%、心 (50%,51%)、半径 41%/36%）。0~82% 全不透明，
      //   88/93/97 三段收，100% 归零 —— 归零点略在水缘内，越出量为 0。
      // 这样「看得见的那一汪」「能点的那一汪」「涟漪铺开的那一汪」是同一个椭圆。
      '#gz-pond .gz-gl{' +
      'transform:scale(1.5);transform-origin:50% 51%;' +
      // 遮罩半径乘 --gz-mk（1 → 1.17，随尺寸展开，见下面「放大即展开」那段）。
      // 不乘的话遮罩永远是盒子的 42%/37.5%，水已经按画幅铺开了、涟漪却被圈在
      // 中间那块椭圆里 —— 屏幕上一半是浪、一半是"圈子外没水"，比不改还怪。
      // 上限只到 1.17：再大椭圆就要出画布，尾巴那几段（88%~100%）收不干净，
      // 会在盒子边上留一圈硬切口。
      '-webkit-mask-image:radial-gradient(ellipse calc(28% * var(--gz-mk,1)) calc(25% * var(--gz-mk,1)) at 50% 51%,' +
      '#000 0%,#000 82%,rgba(0,0,0,.93) 88%,rgba(0,0,0,.60) 93%,rgba(0,0,0,.24) 97%,rgba(0,0,0,0) 100%);' +
      'mask-image:radial-gradient(ellipse calc(28% * var(--gz-mk,1)) calc(25% * var(--gz-mk,1)) at 50% 51%,' +
      '#000 0%,#000 82%,rgba(0,0,0,.93) 88%,rgba(0,0,0,.60) 93%,rgba(0,0,0,.24) 97%,rgba(0,0,0,0) 100%);' +
      'mix-blend-mode:screen;filter:blur(.5px);opacity:.52}' +
      // ── 浅色主题：换整套配色，不是调亮度 ─────────────────────────────────
      // 暗底那张图是「水=暗、光=亮」，加光就成立；白底反过来，加法只能把画面
      // 顶向白纸。所以浅色主题把两件事拆开画：
      //   水 = .gz-deep 自己画的天蓝（不用青绿：日光下的浅水是蓝的）；
      //   光 = GL 只出明暗，不出颜色。
      //
      // 高光是白的，不是金。试过一整套金色方案（color 混合 + sepia/hue-rotate，
      // 金是真出来了，见 git 前的记录），但那块金压在蓝上发土、像浮萍，
      // 读不出「阳光」。白才对：白是「亮」，蓝是「水」，两个都不带色相，
      // 视线不会在暖冷之间打架。所以这里 grayscale(1) 把着色器自带的青绿
      // 洗掉，screen 只往水上加白 —— 涟漪的环、波峰的碎光就是日光。
      //
      // contrast/brightness 这一对是必须的，不是口味问题：screen 会把中灰
      // 也当光加进去，而 GL 的水体本身就在 0.5 亮度，灰度化后一 screen 等于
      // 给整片水糊一层 50% 白 —— 特写里那团「牛奶雾」就是这么来的。
      // 1.6 / .82 把中间调压下去、只放波峰过去，白丝就剩薄薄一层，是天光不是奶。
      // 试过 2.6/.66：环是锐了，但中灰被放大成脏痕（水底发灰发闷）；
      // 试过 soft-light：整片洗掉，几乎没有明暗。1.6 是"干净"和"有对比"的分界。
      '#gz-pond.gz-light .gz-gl{mix-blend-mode:screen;' +
      // contrast/brightness 也挂到 --gz-sp 上：满屏那档本来就是 1.75/.8，
      // 小窗是 1.6/.82。原来靠 .gz-full 那条覆盖，中间那几档（比默认大、又没
      // 满屏）就停在 1.6 上 —— 水面摊开之后波峰的丝变细、中灰变多，1.6 不够，
      // 整片看着发闷。这里让它跟着展开进度连续地过去，两头都还是原来那组数。
      'filter:grayscale(1) contrast(calc(1.6 + var(--gz-sp,0) * .15)) ' +
      'brightness(calc(.82 - var(--gz-sp,0) * .02)) blur(.3px);opacity:.9}' +
      '#gz-pond.gz-light .gz-deep{background:' +
      'radial-gradient(ellipse 42% 38% at 44% 50%,rgba(64,150,206,.96) 0%,rgba(104,182,224,.84) 46%,rgba(152,208,236,.55) 70%,rgba(196,231,246,0) 90%),' +
      'radial-gradient(ellipse 31% 27% at 61% 60%,rgba(52,138,194,.58) 0%,rgba(96,172,216,.36) 55%,rgba(0,0,0,0) 84%),' +
      'radial-gradient(ellipse 58% 52% at 47% 52%,rgba(255,255,255,0) 58%,rgba(120,178,208,.14) 84%,rgba(0,0,0,0) 96%)}' +
      // 水缘：暗底那圈青白高光在白纸上会读成碗沿，浅底只留贴边的接触影，
      // 悬停时加一层内白 —— 是「水被光照到」，不是「水被框住」。
      '#gz-pond.gz-light .gz-rim{box-shadow:inset 0 -2px 7px -1px rgba(28,86,120,.30)}' +
      '#gz-pond.gz-light.gz-hot .gz-rim{box-shadow:inset 0 -2px 7px -1px rgba(28,86,120,.30),' +
      'inset 0 6px 16px -6px rgba(255,255,255,.62)}' +
      // 唤醒提示：深底那颗暗药丸放到白底上是一块脏斑，浅底反过来做。
      '#gz-pond.gz-light .gz-wake{background:rgba(255,255,255,.86);' +
      'border-color:rgba(122,170,198,.55);color:#3c5a6e;' +
      'box-shadow:0 2px 10px rgba(52,104,136,.16)}' +
      // 水底：两个偏心椭圆（正圆会读成盘子，偏心才像一汪），比界面略亮、偏青。
      // clear 模式的着色器底色极暗，全屏版靠水底星空补光，小窗没有星空，必须自带落点。
      '#gz-pond .gz-deep{position:absolute;inset:0;pointer-events:none;background:' +
      'radial-gradient(ellipse 42% 38% at 44% 50%,rgba(72,146,156,.235) 0%,rgba(56,116,126,.150) 52%,rgba(34,72,80,.060) 74%,rgba(0,0,0,0) 88%),' +
      'radial-gradient(ellipse 31% 27% at 61% 60%,rgba(64,132,142,.150) 0%,rgba(44,96,106,.080) 55%,rgba(0,0,0,0) 82%),' +
      'radial-gradient(ellipse 58% 52% at 47% 52%,rgba(2,8,11,0) 58%,rgba(2,8,11,.22) 82%,rgba(2,8,11,0) 96%)}' +
      // 水缘只留「水压着地面」的接触影，不画亮弧——亮弧近看是一根细圆圈，
      // 读成碗沿。这块同时是命中区：只在这一汪的椭圆里接事件，四角穿透。
      // ── 尺寸分档：水底和涟漪都得跟着尺寸换一套 ──────────────────────────
      // 上面那套渐变是照着 430×320 调的。等比撑到 1440×1072 之后，中心那个
      // 蓝椭圆就成了铺满屏幕的一团雾：界面读不出来，也没有「水」的层次
      // （同一个径向渐变，面积越大越显平，浓淡都被摊薄了）。
      // 大尺寸换成「一片水」的画法：整体压淡让界面透出来，靠大范围的柔光
      // 拉开深浅，而不是靠一个小椭圆的中心亮、边缘虚。
      //
      // 中大档的水底：单独一层，靠 --gz-sp 淡入（见下面「放大即展开」）。
      // 用水层交叉淡入，而不是把上面那团蓝放大 —— 放大只会得到一块平蓝天，
      // 而这里换的是"画法"：从"一汪的中心亮"换成"一整片水的柔光"。
      //
      // 满屏档不再单列一套渐变：sp 到 1 时这层本来就该是它（半径 105%，
      // 淡出圈在屏幕外），同一套渐变铺在 1440 上就是这个效果。原来那两条
      // `.gz-full .gz-deep{background:…}` 因此删掉了 —— 留着也是被上面
      // 「放大即展开」里的 opacity 0 挡住，永远不显，属于最难查的死代码。
      '#gz-pond .gz-far{position:absolute;inset:0;pointer-events:none;' +
      'opacity:var(--gz-sp,0);background:' + DEEP_FAR_DARK + ';' +
      // 软边界：见 FADE_MASK 那段注释。这一层是「一片水」的主体，也是大档位里
      // 唯一真正铺到盒子边上的东西（消隐实测：946 档遮住它之后，右边那条硬边
      // 整条消失，而 canvas 里的水本来就是渐变收的），所以软边只要挂它。
      // 挂在 .gz-deep 上没用（它的径向 88%~96% 就归零了，摸不到盒边），
      // 挂在 #gz-pond 上更不行 —— 小窗那档左边离屏幕 976px，一刀 96px 的
      // 淡出带会把过了验收的小水洼削掉一块。
      // 不套父层做统一遮罩：mask 会自成一个隔离组，.gz-gl 的 screen 就只跟组内
      // 那几层混，加不到页面底上 —— 光会整片变闷。
      '-webkit-mask-image:' + FADE_MASK + ';mask-image:' + FADE_MASK + ';' +
      'mask-composite:intersect}' +
      '#gz-pond.gz-light .gz-far{background:' + DEEP_FAR_LIGHT + '}' +
      // 满屏时水缘那条椭圆不能画：容器比视口高，水缘停在屏幕中间，那圈内阴影
      // 会被读成「屏幕里放了个大椭圆的盘子」。命中区照旧（点水还得靠它），
      // 只是不画 —— 整片都是水的时候，本来就没有"边"这回事。
      '#gz-pond.gz-full .gz-rim,#gz-pond.gz-full.gz-hot .gz-rim{box-shadow:none}' +
      // 满屏时整片都是水，命中区也就盖住了整个中央区域 —— 界面按钮、输入框
      // 全被它吃掉（elementFromPoint 在输入框位置返回的是 .gz-rim）。
      // 所以满屏档让水彻底穿透，另在右下角留一颗水珠当把手：点一下播放/暂停，
      // 右键开菜单。水珠是 34px 的一小颗，也只在这时候出现。
      //
      // 这颗水珠挂在 document.body 上，不在 #gz-pond 里。原因是层叠上下文：
      // 容器自己是 z-index:40，里面任何东西 z-index 给到 99999 也跳不出 40，
      // 满屏时照样被宿主的正文盖住（实测 elementFromPoint 在把手位置返回的是
      // 正文元素，点它没反应）。右键菜单一直好使，正是因为菜单也在 body 上。
      '#gz-pond.gz-full .gz-rim{pointer-events:none}' +
      '.gz-grip{display:none}' +
      '.gz-grip.on{display:block;position:fixed;z-index:99998;right:26px;bottom:22px;' +
      'width:34px;height:34px;border-radius:50%;pointer-events:auto;cursor:pointer;' +
      'opacity:.5;transition:opacity .2s,transform .2s;' +
      'background:radial-gradient(circle at 50% 38%,rgba(255,255,255,.95),' +
      'rgba(150,205,232,.55) 70%,rgba(120,180,215,.22));' +
      'box-shadow:0 2px 12px rgba(24,80,116,.22),inset 0 -2px 4px rgba(20,70,100,.18)}' +
      '.gz-grip.on:hover{opacity:.92;transform:scale(1.06)}' +
      // 深色底反过来：暗处的一颗冷光
      '.gz-grip.on.gz-dark{background:radial-gradient(circle at 50% 38%,' +
      'rgba(190,245,250,.78),rgba(80,160,175,.34) 70%,rgba(40,100,115,.2))}' +
      // 满屏时唤醒提示本来浮在 56% 上，正压着界面中央；挪到水珠上方
      '#gz-pond.gz-full .gz-wake{position:fixed;left:auto;right:26px;top:auto;bottom:64px;' +
      'transform:none}' +
      // 曲名/提示原本挂在容器上下沿之外，满屏时容器比屏幕高，挂到屏幕外了。
      // 这两行改成相对视口，满屏才看得见。
      //
      // 但容器带着 contain:layout —— 按规范它会让容器成为 fixed 后代的包含块，
      // position:fixed 就退化成了「相对容器」。满屏时容器 1440×1072、上沿在
      // -86，于是 top:14px 落到 y=-72、bottom:14px 落到 y=1000，全在屏幕外。
      // 所以满屏档把 contain 摘掉：这时容器已经写死宽高，没有「内容撑开容器」
      // 的问题，contain 只剩省那一点重排的好处，而水是 canvas 动画、本来就不动布局。
      '#gz-pond.gz-full{contain:none}' +
      // 这两行文字原本写在容器外沿、压在页面底色上，用的三级灰正合适。
      // 满屏后它们浮在水面上，同一档灰在浅蓝水里几乎读不出来，抬到二级。
      '#gz-pond.gz-full .gz-now{position:fixed;top:14px;' +
      'color:var(--dsw-alias-label-secondary,#39465a);opacity:.92}' +
      '#gz-pond.gz-full .gz-hint{position:fixed;bottom:14px;' +
      'color:var(--dsw-alias-label-secondary,#39465a)}' +
      // 涟漪线宽在着色器里按物理像素算，铺到大屏后相对更细，得抬一点才不虚
      '#gz-pond.gz-full .gz-gl{opacity:.62}' +
      '#gz-pond.gz-light.gz-full .gz-gl{' +
      'filter:grayscale(1) contrast(1.75) brightness(.8) blur(.4px);opacity:.96}' +
      // 小尺寸（宽 ≤ 310）：水面只剩 215 宽，涟漪环本来就细，给足对比才看得清
      '#gz-pond.gz-light.gz-sm .gz-gl{' +
      'filter:grayscale(1) contrast(1.75) brightness(.84) blur(.2px);opacity:1}' +
            '.gz-menu{position:fixed;z-index:99999;display:flex;flex-direction:column;gap:2px;' +
      'min-width:132px;padding:6px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(120,140,160,.32));' +
      'background:rgba(18,24,32,.9);backdrop-filter:blur(10px);box-shadow:0 12px 30px rgba(0,0,0,.35);' +
      'color:var(--dsw-alias-label-primary,#e7eef8);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      '.gz-menu .gz-mi{display:block;width:100%;padding:6px 10px;border:0;border-radius:8px;background:transparent;' +
      'color:inherit;font:inherit;text-align:left;cursor:pointer}' +
      '.gz-menu .gz-mi:hover{background:rgba(120,170,255,.18)}' +
      '.gz-menu .gz-msep{height:1px;margin:4px 6px;background:rgba(140,160,180,.25)}' +
      '.gz-menu .gz-mabout{padding:2px 10px 4px;opacity:.55;font-size:12px;white-space:nowrap}' +
      // 尺寸滑块。菜单本身挂在 body 上（不在 #gz-pond 里），所以这几条是全局类名。
      '.gz-sizebox{display:flex;flex-direction:column;gap:5px;padding:5px 10px 3px;min-width:168px}' +
      '.gz-sizehd{display:flex;align-items:baseline;justify-content:space-between;gap:12px;' +
      'font-size:12px;opacity:.72}' +
      '.gz-sizeval{font-variant-numeric:tabular-nums;letter-spacing:.01em;opacity:.95}' +
      '.gz-sizends{display:flex;justify-content:space-between;font-size:11px;opacity:.45;' +
      'margin-top:-3px;user-select:none}' +
      '.gz-range{-webkit-appearance:none;appearance:none;width:100%;height:14px;margin:0;' +
      'background:transparent;cursor:pointer}' +
      '.gz-range::-webkit-slider-runnable-track{height:3px;border-radius:2px;' +
      'background:rgba(130,170,205,.42)}' +
      '.gz-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;' +
      'margin-top:-4.5px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3f9bd6);' +
      'box-shadow:0 1px 4px rgba(0,0,0,.35)}' +
      '.gz-range::-moz-range-track{height:3px;border-radius:2px;background:rgba(130,170,205,.42)}' +
      '.gz-range::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;' +
      'background:var(--dsw-alias-brand-primary,#3f9bd6)}' +
      '.gz-range:focus-visible{outline:2px solid rgba(120,180,240,.55);outline-offset:3px;border-radius:6px}' +
'#gz-pond .gz-rim{position:absolute;left:9%;top:15%;right:9%;bottom:13%;border-radius:50%;' +
      'pointer-events:auto;cursor:grab;transition:box-shadow .25s;' +
      'box-shadow:inset 0 -2px 6px -1px rgba(0,5,8,.45)}' +
      '#gz-pond.gz-dragging .gz-rim{cursor:grabbing}' +
      // ── 放大即「展开」，不是「把水洼吹大」 ────────────────────────────────
      // 用户原话：「它只是把局部的水花放大了而已……我希望看到更加波澜的水花，
      // 就像满屏的水花截了一部分」。着色器那一侧已经按画幅展开了（SP / WK / grow，
      // 见 gl-water.js 的 pondR），但 CSS 这一侧的水体、水缘、遮罩全是**盒子百分比**：
      // 盒子放大 2.7 倍，那条椭圆水缘就跟着放大 2.7 倍，屏幕上于是出现一只
      // 1161 宽的大盘子，水面还是盘子中间的那一小汪 —— 放大得越多越像摆件。
      //
      // 所以放出 --gz-sp（0..1，由 applySize 按画幅算，和着色器 pondR 的 grow
      // 是同一条曲线）。三件事跟着它连续地做，不是切类名 —— 切类名会在滑块
      // 拖过阈值那一格的时候"啪"地跳一下，而这是个要慢慢拖的滑块：
      //   水缘 opacity 1-sp      边是"小水洼"的语言。水一铺开就不该有边，
      //                          留一条椭圆线在外面，读起来就是盘子的沿。
      //                          用 opacity 而不是把四条 box-shadow 都改成
      //                          rgba(...,calc())：透明度一盖全盖，悬停态、
      //                          浅色态、满屏态那七八条规则不用各改一遍。
      //   水底 opacity 1-sp*1.45 小窗那团"中心亮、边缘虚"的蓝退场；
      //   水底 scale 1+sp*.45    退场时顺手涨一点，接住 .gz-far 的淡入，
      //                          不然两层之间会有一格"水变淡了"的错觉。
      //   .gz-far 淡入           「一片水」那套渐变从 0 涨到 1（见上面那条），
      //                          换的是画法：从"一汪"变成"水面的一角"。
      //   遮罩半径 ×(1+sp*.17)    涟漪的可见范围同步推到盒子边上（--gz-mk，
      //                          见上面 .gz-gl 那条）。
      // 命中区不动：opacity 不影响 elementFromPoint，放大后照样能点、能拖，
      // 只是那一圈"边"看不见了 —— 边是装饰，点击是功能，两件事得分开。
      '#gz-pond .gz-rim{opacity:max(0,calc(1 - var(--gz-sp,0) * 3.2))}' +
      // max(0,…) 是必须的：sp 到 1 时 1-3.2 是负数，而 opacity 不接受负值，
      // 计算值一旦非法就整条作废、退回默认的 1 —— 那这团蓝会"越放大越回来"。
      // 乘 3.2：原先 1.55 时 k=1.8（sp=0.295）还留 0.543，实测那圈椭圆轮廓
      // 读成"浮在水上的一个圈"。3.2 让它在 k≈1.7 就基本归零（sp=0.31 → 0.01），
      // 而 k=1.4（sp=0.005）仍有 0.984，最小那两档的"盘子沿"一点没动。
      '#gz-pond .gz-deep{opacity:max(0,calc(1 - var(--gz-sp,0) * 1.45));' +
      'transform:scale(calc(1 + var(--gz-sp,0) * .45));transform-origin:50% 51%}' +
      // 满屏那档 .gz-deep 已经淡到 0（sp=1），这条只是把变换归位，别让一个
      // 不可见的层还挂着缩放上下文。
      // 满屏那档 .gz-deep 已经淡到 0（sp=1），这条只是把变换归位，别让一个
      // 不可见的层还挂着缩放上下文。
      '#gz-pond.gz-full .gz-deep{transform:none}' +
      '#gz-pond.gz-hot .gz-rim{box-shadow:inset 0 -2px 6px -1px rgba(0,5,8,.45),' +
      'inset 0 4px 14px -6px rgba(140,210,220,.22)}' +
      // 拖动提示：悬停才浮出来。常驻在角落会变成界面里的一句噪音，
      // 而这一汪水本来就是「不该说话」的东西。
      '#gz-pond .gz-hint{position:absolute;left:0;right:0;bottom:-17px;text-align:center;' +
      'font-size:11.5px;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#4d5b6e);' +
      'user-select:none;opacity:0;transition:opacity .22s;pointer-events:none}' +
      '#gz-pond.gz-hot .gz-hint,#gz-pond.gz-dragging .gz-hint{opacity:1}' +
      // 队列/曲名：跟水一起挪，但只在有曲子在播时出现
      '#gz-pond .gz-now{position:absolute;left:0;right:0;top:-20px;text-align:center;font-size:11px;' +
      'letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#5d6a7d);pointer-events:none;' +
      'opacity:0;transition:opacity .4s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#gz-pond.gz-playing .gz-now{opacity:.78}' +
      // 出声提示：浏览器拦了自动播放才出现。
      // pointer-events:none —— 它正好压在水心，原来会把「点水」的那一下吃掉，
      // 用户点在正中间反而没反应。它只是句提示，不该是个按钮。
      '#gz-pond .gz-wake{position:absolute;left:50%;top:56%;transform:translate(-50%,-50%);' +
      'pointer-events:none;font-size:11.5px;padding:5px 11px;border-radius:999px;' +
      'border:1px solid var(--dsw-alias-border-l2,rgba(150,190,200,.28));' +
      'background:rgba(10,16,20,.55);color:var(--dsw-alias-label-secondary,#aab7c7);' +
      'backdrop-filter:blur(3px);display:none}' +
      '#gz-pond.gz-silent .gz-wake{display:block}' +
      // ── 按钮（输入框下方那一颗）────────────────────────────────────────
      '.gz-dock{display:flex;align-items:center;gap:8px;padding:2px 2px 0;flex-wrap:wrap}' +
      '.gz-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(120,140,160,.3));' +
      'background:transparent;color:var(--dsw-alias-label-secondary,#9fb0c6);border-radius:999px;' +
      'padding:3px 11px 3px 9px;font:inherit;font-size:12px;line-height:1.6;cursor:pointer;transition:all .18s}' +
      '.gz-btn:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-label-primary,#dbe6f4)}' +
      '.gz-btn[disabled]{opacity:.5;cursor:default}' +
      '.gz-dot{width:5px;height:5px;border-radius:50%;background:#4bb8c4;box-shadow:0 0 7px rgba(75,184,196,.8);flex:none}' +
      '.gz-btn.gz-on .gz-dot{animation:gz-pulse 2.4s ease-in-out infinite}' +
      '@keyframes gz-pulse{0%,100%{opacity:.5}50%{opacity:1}}' +
      '.gz-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7a8e)}' +
      // 暂停态：点还是那一点，换成一盏暖灯，跟「水在响」区分开
      '.gz-btn.gz-pause .gz-dot{background:#d9a05b;box-shadow:0 0 7px rgba(217,160,91,.85);animation:none}' +
      '.gz-more{width:22px;height:22px;flex:none;padding:0;line-height:1;cursor:pointer;' +
      'border:1px solid var(--dsw-alias-border-l2,rgba(120,140,160,.3));background:transparent;' +
      'color:var(--dsw-alias-label-tertiary,#7b8a9e);border-radius:50%;font-size:13px;font-family:inherit;' +
      'transition:all .18s}' +
      '.gz-more:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-label-primary,#dbe6f4)}' +
      '.gz-idea{border:1px solid var(--dsw-alias-border-l2,rgba(120,140,160,.3));background:transparent;' +
      'color:var(--dsw-alias-label-primary,#dbe6f4);border-radius:999px;padding:3px 11px;font:inherit;' +
      'font-size:12px;width:230px;outline:none}' +
      '.gz-idea:focus{border-color:var(--dsw-alias-state-business-primary,#3964fe)}' +
      '.gz-msg{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7a8e)}' +
      '.gz-msg.gz-err{color:var(--dsw-alias-state-error-primary,#f85149)}';

    var TAG_ID = 'dsh-guzheng-pond/main.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-guzheng-pond';
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 播放状态 ───────────────────────────────────────────────────────────
    /**
     * 按钮和水层挂在两个不同的 slot 上，是两棵互不相识的组件树，
     * 但它们说的是同一件事：现在有没有声音。所以这条状态得放在模块级。
     *
     * 水层持有 <audio>，是唯一能真正暂停的人，所以它把三个动作挂到 ctl 上；
     * 按钮只读 st、只调 ctl，不碰 audio。
     */
    var player = {
      ctl: null,
      st: { playing: false, paused: false, hasTrack: false, title: '' },
      subs: [],
      set: function (patch) {
        // 必须换一个新对象：React 用 Object.is 比较，原地改属性它认不出来，
        // 按钮就会一直显示上一次的文案（暂停按下去不变成「继续」）。
        var next = {};
        for (var k in player.st) next[k] = player.st[k];
        var changed = false;
        for (var p in patch) {
          if (patch[p] !== next[p]) { next[p] = patch[p]; changed = true; }
        }
        if (!changed) return;
        player.st = next;
        for (var i = 0; i < player.subs.length; i++) {
          try { player.subs[i](next); } catch (e) { /* 订阅者自己炸，别连累别人 */ }
        }
      },
      sub: function (fn) {
        player.subs.push(fn);
        return function () {
          var i = player.subs.indexOf(fn);
          if (i >= 0) player.subs.splice(i, 1);
        };
      },
    };
    // 一颗调试用的小把手：`__gzPond.st` 看状态、`__gzPond.ctl.playQueue()` 之类
    // 手动驱使。按钮和水在页面上离得远，「点了没反应」时只有这个能一眼看到底
    // 是按钮没派出去、还是水没接住。只读地挂一层，不改任何行为。
    if (typeof window !== 'undefined') window.__gzPond = player;

    // ── 水 ─────────────────────────────────────────────────────────────────
    /**
     * 把 pond.html 里验过的那套搬进一个容器。
     *
     * audios 是两只 <audio>（同一个容器里，一主一备）。曲与曲之间要交叉淡入，
     * 就得有一个「已经在响」的和一个「正在淡入」的；单只元素只能硬切，中间
     * 必然有一段空。两只都接进同一张音频图：各自 gain → 共用的 analyser →
     * destination，水看不到换曲，只看到能量接续。
     */
    function mountPond(root, audios, hooks) {
      var cWater = root.querySelector('.gz-water');
      var cGL = root.querySelector('.gz-gl');
      var rim = root.querySelector('.gz-rim');
      hooks = hooks || {};

      // 当前尺寸倍数（1 = 430×320）。声明必须在这儿：下面绑事件时就要按它
      // 落一次盒子，而 function 声明会提升、var 不会 —— 放到后面会读到
      // undefined，直接把水算成 NaN 尺寸。
      var sizeK = 1;
      try {
        var sk0 = parseFloat(localStorage.getItem(SIZE_KEY));
        if (isFinite(sk0) && sk0 > 0) sizeK = sk0;
      } catch (e) { /* 隐私模式禁了 localStorage，退回默认大小 */ }

      // 满屏档的水珠把手。挂在 body 上而不是容器里，理由见 CSS 那一段：
      // 容器的 z-index:40 是个逃不出去的层叠上下文。
      var grip = document.createElement('div');
      grip.className = 'gz-grip';
      grip.title = '点一下播放/暂停 · 右键设置大小';
      document.body.appendChild(grip);
      function syncGrip() {
        // 只在真满屏时出现。中等尺寸水是可点的，不需要这颗把手。
        grip.classList.toggle('on', root.classList.contains('gz-full'));
      }

      var els = (audios || []).filter(Boolean);
      if (!els.length) throw new Error('没有 audio 元素');
      var gains = [];
      var act = 0;                        // 正在出声的那一只
      var fading = null;                  // { from, to, until } —— 交叉淡入进行中
      var busy = false;                   // 正在换曲（从 setGain 那一刻起，到斜坡走完）
      var fadeTimer = 0;
      // 尾巴多长就开始接下一首。古筝曲的收音本来就有自然衰减，
      // 2.8 秒够两段斜坡交错，又不至于把上一首的余韵提前掐掉。
      var XFADE = 2.8;

      function curEl() { return els[act]; }
      function altI() { return els.length > 1 ? (act + 1) % els.length : act; }
      function altEl() { return els[altI()]; }
      function anyPlaying() {
        for (var i = 0; i < els.length; i++) if (!els[i].paused) return true;
        return false;
      }

      var water = null;
      var glWater = null;
      var analyser = null;
      var freq = null;
      var audioCtx = null;
      var raf = 0;
      var dead = false;
      var last = performance.now();
      var AUD = { slow: 0, cool: 0, cen: 0.5 };

      // 主题感知：screen 只对深底成立。按页面实际背景亮度给 root 挂 gz-light，
      // 浅底走 multiply（否则就是一坨白雾，验收里明确算失败）。
      function themeWatch() {
        function lum(css) {
          var m = /rgba?\(([^)]+)\)/.exec(css || '');
          if (!m) return 0;
          var p = m[1].split(',').map(Number);
          if (p.length > 3 && p[3] === 0) return 0;
          return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
        }
        function apply() {
          if (dead) return;
          // 别跟外面那两只 <audio> 抢名字用 els
          var hosts = [document.body, document.documentElement];
          var best = 0;
          for (var i = 0; i < hosts.length; i++) {
            if (!hosts[i]) continue;
            best = Math.max(best, lum(getComputedStyle(hosts[i]).backgroundColor));
          }
          root.classList.toggle('gz-light', best > 0.5);
          // 水珠在容器外面，吃不到 #gz-pond.gz-light 那条选择器，得自己标一次
          grip.classList.toggle('gz-dark', !(best > 0.5));
        }
        apply();
        var mo = null;
        try {
          mo = new MutationObserver(apply);
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
          if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        } catch (e) { /* ignore */ }
        var mq = null;
        try {
          mq = window.matchMedia('(prefers-color-scheme: light)');
          if (mq.addEventListener) mq.addEventListener('change', apply);
        } catch (e) { /* ignore */ }
        return function stop() {
          if (mo) mo.disconnect();
          if (mq && mq.removeEventListener) mq.removeEventListener('change', apply);
        };
      }
      var stopTheme = themeWatch();

      var lastW = 0, lastH = 0, lastSS = 0, lastDpr = 0;
      var rezRaf = 0;
      // 尺寸变化的统一入口：同一帧最多重建一次。ResizeObserver、尺寸滑块、
      // 窗口缩放三处都会喊「变了」，各自直接调 resize 的话，拖一次滑块
      // 要重建两三遍画布（buildLines + makeGrain 都不便宜）。
      function scheduleResize() {
        if (rezRaf) return;
        rezRaf = requestAnimationFrame(function () { rezRaf = 0; resize(); });
      }

      function resize() {
        if (!water) return;
        var r = root.getBoundingClientRect();
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var w = Math.max(2, Math.round(r.width));
        var ht = Math.max(2, Math.round(r.height));
        // 超采样按面积给：小窗只有全屏 1/9 的像素，2 倍才顶得住丝状细节；
        // 满屏（1440×1071）像素本来就多，再乘 2 是拿 5M 像素换看不出的一点点锐。
        var ss = w >= 1100 ? 1 : (w >= 720 ? 1.5 : SS);
        // 尺寸没变就什么都别做。菜单弹出、主题切换、字体回流都会惊动
        // ResizeObserver，全量重建一遍白烧几毫秒。
        if (w === lastW && ht === lastH && ss === lastSS && dpr === lastDpr) return;
        lastW = w; lastH = ht; lastSS = ss; lastDpr = dpr;
        water.dpr = dpr;
        water.W = w;
        water.H = ht;
        water.top = ht * TOPR;
        water.canvas.width = Math.round(w * dpr);
        water.canvas.height = Math.round(ht * dpr);
        water.canvas.style.width = w + 'px';
        water.canvas.style.height = ht + 'px';
        water.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (glWater) {
          var pw = Math.round(w * ss);
          var ph = Math.round(ht * ss);
          glWater.cssW = w;
          glWater.cssH = ht;
          glWater.top = water.top;
          glWater.dpr = ss;
          glWater.canvas.width = pw;
          glWater.canvas.height = ph;
          glWater.canvas.style.width = w + 'px';
          glWater.canvas.style.height = ht + 'px';
          if (glWater.gl) glWater.gl.viewport(0, 0, pw, ph);
          glWater._ready = true;
        }
        water.buildLines();
        water.makeGrain();
        water.render();
      }

      function audioDrive(dt) {
        if (!analyser) { water.tick(dt); return; }
        analyser.getByteFrequencyData(freq);
        var n = freq.length;
        var band = function (a, b) {
          var m = 0;
          for (var i = a; i < b; i++) if (freq[i] > m) m = freq[i];
          return m / 255;
        };
        var low = band(1, (n * 0.035) | 0);
        var mid = band((n * 0.035) | 0, (n * 0.12) | 0);
        var high = band((n * 0.12) | 0, (n * 0.40) | 0);
        var lvl = Math.min(1, low * 0.55 + mid * 0.90 + high * 0.45);

        var sw = 0, s = 0;
        var top = (n * 0.5) | 0;
        for (var i = 1; i < top; i++) { var v = freq[i] * freq[i]; sw += v * i; s += v; }
        var cen = s > 0 ? Math.min(1, Math.sqrt(sw / s / top) * 1.7) : AUD.cen;
        AUD.cen += (cen - AUD.cen) * 0.25;

        var e = water.env;
        var g = POND_GAIN;
        e.amp = Math.max(e.amp, (0.18 + 0.85 * lvl) * g);
        e.wind = Math.max(e.wind, (0.10 + 0.24 * lvl) * g);
        e.density = Math.max(e.density, (0.45 + 1.45 * mid) * g);
        e.chop = Math.max(e.chop, Math.min(1.10, high * 1.8) * g);
        e.bass = Math.max(e.bass, Math.min(1, low * 1.4) * g);
        if (e.bass > 0.12) water.bassTarget = 0.5 + (AUD.cen - 0.5) * 0.5;

        AUD.cool -= dt;
        // 常驻的水不该一刻不停落涟漪：冷却拉长、强度压低，
        // 让它像「偶尔一滴」而不是「一直在敲」。
        if (lvl - AUD.slow > 0.075 && AUD.cool <= 0 && lvl > 0.05) {
          AUD.cool = 0.19;
          water.lastNoteAt = water.time;
          var sharp = high / (mid + 0.03) > 1.5;
          water.addRipple(
            Math.max(0.12, Math.min(0.88, 0.16 + AUD.cen * 0.68)),
            Math.max(0.30, Math.min(0.90, 0.76 - AUD.cen * 0.40)),
            Math.min(0.72, lvl * 1.05), sharp, AUD.cen
          );
        }
        AUD.slow += (lvl - AUD.slow) * (1 - Math.exp(-dt / 0.22));
        water.tick(dt);
      }

      // 空闲时水也要"活着"：没人弹琴的时候，它自己呼吸、偶尔落一滴。
      // 不靠音频——没有声音也得动，这是"一汪水"和"一张图"的区别。
      var IDLE = { t: Math.random() * 6, cool: 1.4 + Math.random() * 2 };
      function idleDrive(dt) {
        IDLE.t += dt;
        var breath = 0.5 + 0.5 * Math.sin(IDLE.t * 0.55);
        var breath2 = 0.5 + 0.5 * Math.sin(IDLE.t * 0.23 + 1.7);
        var e = water.env;
        var g = POND_GAIN;
        e.amp = Math.max(e.amp, (0.07 + 0.10 * breath) * g);
        e.wind = Math.max(e.wind, (0.030 + 0.045 * breath2) * g);
        e.density = Math.max(e.density, (0.14 + 0.10 * breath) * g);
        IDLE.cool -= dt;
        if (IDLE.cool <= 0) {
          IDLE.cool = 3.2 + Math.random() * 4.6;
          water.addRipple(
            0.18 + Math.random() * 0.64,
            0.32 + Math.random() * 0.42,
            0.09 + Math.random() * 0.10,
            Math.random() > 0.55,
            Math.random()
          );
        }
        water.tick(dt);
      }

      function frame(now) {
        if (dead) return;
        raf = requestAnimationFrame(frame);
        var t = now == null ? performance.now() : now;
        var dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
        last = t;
        if (!water) return;
        if (!anyPlaying()) idleDrive(dt);
        else audioDrive(dt);
        water.render();
      }

      // ── 音频 deck：两只 <audio>，一支在响、一支待命 ─────────────────────
      // 单只元素只能硬切，切的那一下必然有一段空；两只才能让能量接续。
      function setGain(i, v, rampSec) {
        var g = gains[i];
        if (g && audioCtx) {
          var t = audioCtx.currentTime;
          try {
            g.gain.cancelScheduledValues(t);
            if (rampSec) g.gain.linearRampToValueAtTime(v, t + rampSec);
            else g.gain.setValueAtTime(v, t);
          } catch (e) { try { g.gain.value = v; } catch (e2) { /* ignore */ } }
        } else if (els[i]) {
          // 没接上音频图（很少见）：退回元素音量。硬切，但至少不留空档。
          try { els[i].volume = Math.max(0, Math.min(1, v)); } catch (e) { /* ignore */ }
        }
      }

      function unlock() {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
      }

      // 装进当前这只，不播。用户按着暂停时换曲走这条：安静地换掉，仍是静的。
      function loadQuiet(url) {
        var a = curEl();
        a.dataset.pondUrl = url;
        if (a.getAttribute('src') !== url) a.src = url;
        try { a.currentTime = 0; } catch (e) { /* ignore */ }
        setGain(act, 1);
        // 另一只摁到 0：它可能刚淡出完，还挂着半段斜坡的尾巴。
        if (els.length > 1) setGain(altI(), 0);
      }

      function playActive() {
        unlock();
        var p;
        try { p = curEl().play(); } catch (e) { p = null; }
        if (!p || !p.catch) p = Promise.resolve();
        return p;
      }

      // 预装载：把下一首塞进待命那只，让它先把数据拉下来。
      // 不预载的话，交叉淡入开始时才去读文件，前 200~600ms 是一片静音。
      function prime(url) {
        // busy 从 crossfadeTo 的第一行就立起来（那时 fading 还没立）——
        // 否则 play() 还没 resolve 的这几十毫秒里，轮询会插进来改待命那只的
        // src，把刚播起来的新曲又推回 0 秒。
        if (busy || fading || els.length < 2 || !url) return;
        var a = altEl();
        if (!a || a.dataset.pondUrl === url) return;
        a.dataset.pondUrl = url;
        setGain(altI(), 0);
        a.src = url;
        try { a.load(); } catch (e) { /* ignore */ }
      }

      /**
       * 淡到一首新曲。返回 Promise<boolean>（true = 真的走了交叉淡入）。
       *
       * 两段斜坡同起同落、都是线性：旧的 1→0、新的 0→1，两者之和恒等于 1，
       * 听觉上是一条等能量曲线。不能「先停再起」—— 那就是用户说的
       * 「一首放完，静一下，再接下一首」。
       *
       * 不变量（比斜坡本身更容易被写坏，所以写在这儿）：
       *   任何时刻两路增益之和 ≈ 1。既不能是 2（两声叠在一起，换曲那一下
       *   能量突然翻倍），也不能是 0（中间断一拍）。淡完之后旧那只留在 0，
       *   不许「复原成 1 等着下次当淡出方」—— 那只元素此刻还挂着 src，
       *   一旦回到 1 就是两路同时满。
       */
      function crossfadeTo(url, ms) {
        if (els.length < 2 || fading || busy) return Promise.resolve(false);
        busy = true;
        var fromI = act, toI = altI();
        var from = els[fromI], to = els[toI];
        if (to === from) { busy = false; return Promise.resolve(false); }
        var d = Math.max(0.6, (ms || XFADE * 1000) / 1000);

        to.dataset.pondUrl = url;
        if (to.getAttribute('src') !== url) to.src = url;
        try { to.currentTime = 0; } catch (e) { /* ignore */ }
        setGain(toI, 0);
        unlock();

        var p;
        try { p = to.play(); } catch (e) { p = null; }
        if (!p || !p.then) p = Promise.resolve();

        return p.then(function () {
          // 等它真的出声了才推斜坡，否则开头那几百毫秒是「淡入一段静音」
          setGain(toI, 1, d);
          setGain(fromI, 0, d);
          act = toI;
          fading = { from: fromI, to: toI, until: Date.now() + d * 1000 };
          clearTimeout(fadeTimer);
          fadeTimer = setTimeout(function () {
            fading = null;
            busy = false;
            try { from.pause(); } catch (e) { /* ignore */ }
            // 只把它摁在 0，不「复原」。复位是下一次 prime()/loadQuiet() 的事：
            // 那时它才知道自己这一轮是淡入方还是淡出方。
            setGain(fromI, 0);
            try { from.removeAttribute('src'); from.load(); } catch (e) { /* ignore */ }
            from.dataset.pondUrl = '';
          }, d * 1000 + 140);
          return true;
        }).catch(function () {
          // 没播起来：场上仍是旧那只在响，把待命的摁回 0，别留两路满。
          busy = false;
          setGain(toI, 0);
          return false;
        });
      }

      function stopAll() {
        clearTimeout(fadeTimer);
        fading = null;
        busy = false;
        for (var i = 0; i < els.length; i++) {
          try { els[i].pause(); } catch (e) { /* ignore */ }
          // 静下来之后只留一只满 —— 全置 1 会在下次恢复时瞬间两声叠一起。
          setGain(i, i === act ? 1 : 0);
        }
      }

      // ── 拖动：监听挂在水缘（椭圆）上，不是容器 —— 容器四角是透明的，
      //    不该吃掉界面的点击。
      var drag = null;
      var tapAt = null;
      var onEnter = function () { if (!drag) root.classList.add('gz-hot'); };
      var onLeave = function () { if (!drag) root.classList.remove('gz-hot'); };
      var onDown = function (e) {
        // 只有左键能拖水。右键要开菜单，让它原样过去 ——
        // 顺手抢下来只会让「右键 → 弹一首」变成「右键 → 先把曲子暂停」。
        if (e.button !== 0) return;
        var r = root.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        tapAt = { x: e.clientX, y: e.clientY, t: Date.now() };
        root.classList.add('gz-dragging');
        try { rim.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
      };
      var onMove = function (e) {
        if (!drag) return;
        var w = root.offsetWidth, ht = root.offsetHeight;
        var iw = window.innerWidth, ih = window.innerHeight;
        var x = e.clientX - drag.dx;
        var y = e.clientY - drag.dy;
        // 比视口还大（满屏那一档）就没有「夹在视口内」这回事了，只能居中：
        // 否则两次 Math.min/max 一夹，x 会被钉成 8，水看着像卡在左上角。
        x = w >= iw ? Math.round((iw - w) / 2) : Math.max(8, Math.min(iw - w - 8, x));
        y = ht >= ih ? Math.round((ih - ht) / 2) : Math.max(8, Math.min(ih - ht - 8, y));
        // 用 left/top 而不是 transform：水层读的是 canvas 实际尺寸，
        // 被 transform 缩放会让水面发糊。
        root.style.left = x + 'px';
        root.style.top = y + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      };
      var onUp = function (e) {
        var t = tapAt;
        tapAt = null;
        drag = null;
        root.classList.remove('gz-dragging');
        try { rim.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        root.classList.remove('gz-hot');
        // 判「是哪个键」。pointerup 的 button 是松开的那个键：左键 0、右键 2；
        // pointercancel 是 -1（本来就不该算一次点）。
        //
        // 少这一行的时候，右键点水开菜单会先被当成一次左键点水：正在放的曲子
        // 被暂停，userPaused 也被置位，于是「右键 → 弹一首」之后的几分钟里
        // 轮询整段停止，新曲编好了也不接 —— 用户看到的就是「编完了，半天不响」。
        if (e.button !== 0) return;
        // 左键点水 = 播放/暂停（SPEC §5：水是唯一入口）。
        // 判决靠位移和时长：手抖 5px 以内、按下不到 500ms 才算「点」，
        // 否则拖到别处会顺手把音乐掐掉。
        if (t && Math.abs(e.clientX - t.x) < 5 && Math.abs(e.clientY - t.y) < 5 &&
            Date.now() - t.t < 500) {
          try { tapPond(); } catch (err) { /* ignore */ }
        }
      };
      rim.addEventListener('pointerenter', onEnter);
      rim.addEventListener('pointerleave', onLeave);
      rim.addEventListener('pointerdown', onDown);
      rim.addEventListener('pointermove', onMove);
      rim.addEventListener('pointerup', onUp);
      rim.addEventListener('pointercancel', onUp);

      // 满屏档的把手：水本身穿透了，这两个入口补回来
      var onGripTap = function (e) {
        e.stopPropagation();
        try { tapPond(); } catch (err) { /* ignore */ }
      };
      grip.addEventListener('click', onGripTap);
      grip.addEventListener('contextmenu', onContext);

      var ro = null;
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(function () { scheduleResize(); });
        ro.observe(root);
      }
      // 视口变了：上限跟着变。原来停在「满屏」的，缩到一个更小的窗口后
      // sizeK 会大于新上限，得按新上限重新落一次，否则水永远比窗口大一圈。
      window.addEventListener('resize', function () {
        var kmax = sizeMaxK();
        if (sizeK > kmax) applySize(kmax);
        else scheduleResize();
      });

      // 尺寸是「容器的事」，跟水层什么时候加载完无关：先把盒子按存档摆好，
      // 画布等 GL 就绪后那次 resize 自然跟上。
      if (sizeK !== 1) applySize(sizeK);

      // 两个库是冻结的成片实现，从宿主路由拿，原样加载
      Promise.all([
        import('/api/pond/asset/water.js'),
        import('/api/pond/asset/gl-water.js'),
      ]).then(function (mods) {
        if (dead) return;
        try {
          glWater = new mods[1].GLWater(cGL);
          water = new mods[0].Water(cWater, { gl: glWater });
        } catch (e) {
          console.warn('[guzheng-pond] 水层没起来（WebGL2 不可用？）', e);
          return;
        }
        resize();
        raf = requestAnimationFrame(frame);
        // 音频图：两只 <audio> 各自过一只 GainNode，汇到同一个 analyser 再出去。
        // 交叉淡入就靠这两只 gain —— 水看到的是「能量连续」，根本没发现换过曲。
        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.72;
          freq = new Uint8Array(analyser.frequencyBinCount);
          for (var gi = 0; gi < els.length; gi++) {
            var src = audioCtx.createMediaElementSource(els[gi]);
            var g = audioCtx.createGain();
            g.gain.value = 1;
            src.connect(g);
            g.connect(analyser);
            gains[gi] = g;
          }
          analyser.connect(audioCtx.destination);
        } catch (e) {
          console.warn('[guzheng-pond] 接不上音频图，水会安静地待着', e);
        }
      }).catch(function (e) {
        console.warn('[guzheng-pond] 水层加载失败', e);
      });

      // ── 两只 <audio> 各自的「报时」和「放完」 ─────────────────────────────
      // 都挂上，判决看 act：只有正在出声的那只说话。
      var elBindings = [];
      for (var bi = 0; bi < els.length; bi++) {
        (function (idx, el) {
          var onTime = function () {
            // 尾判：到剩 2.8 秒就把下一首淡进来。这是「曲与曲衔接」唯一的那一下。
            if (idx !== act || fading || el.paused) return;
            var d = el.duration;
            if (!d || !isFinite(d) || d < 1.2) return;
            var remain = d - el.currentTime;
            if (remain > XFADE + 0.4 || remain < 0.06) return;
            var nx = hooks.getNext ? hooks.getNext() : null;
            if (!nx || !nx.url) return;
            crossfadeTo(nx.url).then(function (ok) {
              if (ok && hooks.onFadeStart) {
                try { hooks.onFadeStart(nx); } catch (e) { /* ignore */ }
              }
            });
          };
          var onEnd = function () {
            // 淡出那只自己走完不算「这首放完了」——账已经在 onFadeStart 记过。
            if (idx !== act) return;
            if (hooks.onEnded) { try { hooks.onEnded(); } catch (e) { /* ignore */ } }
          };
          el.addEventListener('timeupdate', onTime);
          el.addEventListener('ended', onEnd);
          elBindings.push([el, onTime, onEnd]);
        })(bi, els[bi]);
      }

      // ── 右键菜单：水的全部操作都在这（不再另挂一个按钮）──────────────
      var menuEl = null;
      function closeMenu() {
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        menuEl = null;
      }
      function menuItem(label, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'gz-mi';
        b.textContent = label;
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          closeMenu();
          try { fn(); } catch (e) { console.warn('[guzheng-pond] 菜单动作失败', e); }
        });
        return b;
      }
      function composeOne() {
        var nowEl = root.querySelector('.gz-now');
        var say = function (t, ms) {
          if (!nowEl) return;
          nowEl.textContent = t;
          root.classList.add('gz-playing');
          setTimeout(function () { root.classList.remove('gz-playing'); }, ms || 3200);
        };
        say('正在编，等一下…', 8000);
        fetch('/api/pond/task', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: '', idea: '' }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (o) {
            if (!o.ok || !o.j || o.j.ok !== true) { say('没派出去：' + ((o.j && o.j.error) || '未知'), 4200); return; }
            // 曲一出来就切过去，不看它排在队列第几位。
            // 这句以前只在废弃的按钮里调过；水面右键这条路漏了，于是新曲
            // 老老实实排在队尾，队头那首放完之前永远轮不到它 ——
            // 用户看到的是「编完了，半天不响」。
            if (player.armNew) player.armNew();
            say(o.j.via === 'subagent-reuse' ? '常驻作曲会话接手了'
              : o.j.via === 'subagent' ? '子会话去写了'
                : '编好了', 2600);
          })
          .catch(function (e) { say('没派出去：' + String(e && e.message || e), 4200); });
      }
      // ── 尺寸：一半 ↔ 满屏 ──────────────────────────────────────────────
      // 刻度用对数，不用线性。「现在这么大」到「满屏」是 3 倍多，线性刻度下
      // 前八成的行程都挤在「只比现在大一点点」那一段里：手一滑就越过半个
      // 区间，停不住也回不细。取对数之后「放大一倍」和「再放大一倍」占同样
      // 的行程，两端都好停。
      // （sizeK 的状态声明在 mountPond 顶部，事件绑定之前就要用它落盒子。）

      // 上限现算：cover 语义 —— 宽、高各算一次倍数取大的，水一定盖得住整个
      // 视口。用 contain 的话总有一边留白，「覆盖整个屏幕」就成了「屏幕里
      // 放一个水洼」。
      function sizeMaxK() {
        var iw = window.innerWidth || 1440, ih = window.innerHeight || 900;
        return Math.max(iw / POND_W, ih / POND_H);
      }
      function kFromT(t) {
        var kmax = sizeMaxK();
        return SIZE_MIN * Math.pow(kmax / SIZE_MIN, Math.max(0, Math.min(1, t)));
      }
      function tFromK(k) {
        var kmax = sizeMaxK();
        if (k <= SIZE_MIN) return 0;
        if (k >= kmax) return 1;
        return Math.log(k / SIZE_MIN) / Math.log(kmax / SIZE_MIN);
      }

      /**
       * 尺寸落地的唯一入口。
       *
       * 锚点是「右下角」：放大往左上长、缩小往右下收，水永远待在自己那个角落。
       * 试过保持中心 —— 缩到一半时水就飘到页面正中间，压在输入框上，看着像
       * 「水跑了」而不是「水小了」。默认位置本来就在右下，右下角是它的家。
       *
       * 比视口还大时（满屏那一档必然如此——430:320 和 16:9 不是一个比例，
       * cover 之后高度会溢出去）就让它居中，两边一起溢出；否则会永远贴着
       * 一条边、另一条边空出来，读起来像画歪了。
       */
      function applySize(k, opt) {
        opt = opt || {};
        var kmax = sizeMaxK();
        k = Math.max(SIZE_MIN, Math.min(kmax, k));
        sizeK = k;
        var w = Math.round(POND_W * k), ht = Math.round(POND_H * k);
        var iw = window.innerWidth || 1440, ih = window.innerHeight || 900;
        var r = root.getBoundingClientRect();
        var left, top;
        if (r.width > 1) {
          left = Math.round(r.right - w);
          top = Math.round(r.bottom - ht);
        } else {
          // 首帧还没有布局时，按 CSS 里那套「右下角 34 / 104」落位
          left = iw - 34 - w;
          top = ih - 104 - ht;
        }
        left = w >= iw ? Math.round((iw - w) / 2) : Math.max(8, Math.min(iw - w - 8, left));
        top = ht >= ih ? Math.round((ih - ht) / 2) : Math.max(8, Math.min(ih - ht - 8, top));
        root.style.width = w + 'px';
        root.style.height = ht + 'px';
        root.style.left = left + 'px';
        root.style.top = top + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        // 展开进度 --gz-sp（0..1），CSS 那一侧的「放大即展开」全靠它（见样式里
        // 那三条）。和着色器 pondR 的 grow 是同一个意思，但门槛往后挪了一点：
        // grow 从 1.2 就开始涨，是因为满屏时衰减带必须整条出画；而 CSS 的水缘
        // 在 1.35 之前还不该退场 —— 那时候水面才刚顶到水缘，一开始就把它擦掉，
        // 得到的是一团没有形状的蓝雾，反而比现在更糊。
        // 1.35 → 2.6 走完全程：2.6 之后（≈832 高的盒子）屏幕上基本只剩水，
        // 到满屏那档正好接上 .gz-full 自己那套。
        var vs = ht / POND_H;
        var st = Math.min(1, Math.max(0, (vs - 1.35) / (2.6 - 1.35)));
        var sp = st * st * (3 - 2 * st);
        root.style.setProperty('--gz-sp', sp.toFixed(3));
        // 遮罩半径倍数 1 → 1.17（上面的 mask-image 拿它乘 28%/25%）
        root.style.setProperty('--gz-mk', (1 + sp * 0.17).toFixed(3));
        // 四条边的淡出带（见样式里 FADE_MASK）。规则只有一句：
        // **这一边离屏幕边还有多远，这条软边最多就能给多宽。**
        // 盒子已经出画的那一侧给 0 —— 屏幕外的事看不见，给了反而多算一次
        // 收缩，满屏那档的整片水会被削出一圈淡边。
        //
        // 再乘 sp：小窗那档的盒子边（976,476 起）全在屏幕里，不乘的话
        // 左/上两侧立刻各得一条 48px 的淡出带，把过了验收的小水洼削掉一块。
        // 乘上 sp 之后小窗是 0，一像素都不动。
        //
        // 带子宽度跟着盒子走（min 边长的 15%，48~160 之间夹住）：430 宽时是 48，
        // 946 时是 105，1161 时是 129 —— 相对盒子始终是六分之一那条淡出，
        // 换个尺寸不会突然变硬或糊成一片。
        var bandMax = Math.min(160, Math.max(48, Math.min(w, ht) * 0.15));
        var band = function (gap) { return Math.round(Math.min(bandMax, Math.max(0, gap)) * sp); };
        root.style.setProperty('--gz-fl', band(left) + 'px');
        root.style.setProperty('--gz-ft', band(top) + 'px');
        root.style.setProperty('--gz-fr', band(iw - (left + w)) + 'px');
        root.style.setProperty('--gz-fb', band(ih - (top + ht)) + 'px');
        // 「满屏」不是一个尺寸档，是一个状态：只有真的盖住整个视口才切。
        // 原来按 k >= 1.7 切，等于 731×544 就进入满屏模式 —— 水远没铺满，
        // 却已经把命中区关掉、换成一小颗水珠当把手：点水没反应，
        // 点在「水」上其实是点到了背后的正文，一拖就把字选中了。
        // 面板中间那段（比默认大、又没满屏）仍然是一口正常的水洼：
        // 能点、能拖、有边，只是水面更大、浪更多（着色器按画幅展开）。
        var full = w >= iw - 1 && ht >= ih - 1;
        root.classList.toggle('gz-full', full);
        root.classList.toggle('gz-sm', k <= 0.72);
        syncGrip();
        // 满屏档水的透明度变了，把手配色的基准跟着变一次
        grip.classList.toggle('gz-dark', !root.classList.contains('gz-light'));
        if (!opt.silent) {
          try { localStorage.setItem(SIZE_KEY, String(k)); } catch (e) { /* ignore */ }
        }
        // 画布要按新尺寸重建。ResizeObserver 也会来一次，两边都走
        // scheduleResize，同一帧只重建一次 —— 不然拖滑块会重建两遍。
        scheduleResize();
        return { w: w, h: ht };
      }

      /** 右键菜单里的「大小」一块：标题 + 实际像素 + 滑块。 */
      function sizeBlock() {
        var box = document.createElement('div');
        box.className = 'gz-sizebox';
        var hd = document.createElement('div');
        hd.className = 'gz-sizehd';
        var lb = document.createElement('span');
        lb.textContent = '大小';
        var val = document.createElement('span');
        val.className = 'gz-sizeval';
        hd.appendChild(lb);
        hd.appendChild(val);

        var rg = document.createElement('input');
        rg.type = 'range';
        rg.className = 'gz-range';
        rg.min = '0';
        rg.max = '1000';
        rg.step = '1';
        rg.setAttribute('aria-label', '水洼大小');

        var ends = document.createElement('div');
        ends.className = 'gz-sizends';
        var en1 = document.createElement('span'); en1.textContent = '小';
        var en2 = document.createElement('span'); en2.textContent = '全屏';
        ends.appendChild(en1);
        ends.appendChild(en2);

        function sync() {
          rg.value = String(Math.round(tFromK(sizeK) * 1000));
          var w = Math.round(POND_W * sizeK), ht = Math.round(POND_H * sizeK);
          val.textContent = sizeK >= sizeMaxK() - 0.002 ? '满屏' : w + ' × ' + ht;
        }
        // input 是拖动中连续的，change 是松手。拖动中只动画面不落盘 ——
        // 一次拖动能触发几百个 input，写几百次 localStorage 不值得。
        rg.addEventListener('input', function () {
          applySize(kFromT(parseInt(rg.value, 10) / 1000), { silent: true });
          sync();
        });
        rg.addEventListener('change', function () {
          try { localStorage.setItem(SIZE_KEY, String(sizeK)); } catch (e) { /* ignore */ }
        });
        // 滚轮微调：停在滑块上转一格 = 一个档位，比拖准得多
        rg.addEventListener('wheel', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          applySize(kFromT(tFromK(sizeK) + (ev.deltaY < 0 ? 0.02 : -0.02)));
          sync();
        }, { passive: false });

        box.appendChild(hd);
        box.appendChild(rg);
        box.appendChild(ends);
        sync();
        return box;
      }
      function openMenu(x, y) {
        closeMenu();
        var m = document.createElement('div');
        m.className = 'gz-menu';
        m.appendChild(menuItem(reallyPlaying() ? '暂停' : '继续', function () {
          // 走 player.ctl 而不是直接 pause()/<audio>：菜单也得把用户的意图
          // 记进 userPaused，否则按完菜单里的暂停，1.5 秒后轮询又把它顶开。
          // 判据和水上的点按同一套（reallyPlaying），菜单文案才不会写着
          // 「暂停」、点下去却变成「继续」。
          if (reallyPlaying()) {
            if (player.ctl && player.ctl.pause) player.ctl.pause();
            else stopAll();
          } else {
            tapPond();
          }
        }));
        m.appendChild(menuItem('弹一首', composeOne));
        var sep0 = document.createElement('div');
        sep0.className = 'gz-msep';
        m.appendChild(sep0);
        m.appendChild(sizeBlock());
        var sep = document.createElement('div');
        sep.className = 'gz-msep';
        m.appendChild(sep);
        var about = document.createElement('div');
        about.className = 'gz-mabout';
        about.textContent = '一汪水 · 点一下让它应声';
        m.appendChild(about);
        document.body.appendChild(m);
        var w = m.offsetWidth || 140, h = m.offsetHeight || 150;
        m.style.left = Math.min(Math.max(8, x), window.innerWidth - w - 8) + 'px';
        m.style.top = Math.min(Math.max(8, y), window.innerHeight - h - 8) + 'px';
        menuEl = m;
      }
      // 水上的短提示（标题行借用，3 秒后退场）
      function pondSay(t, ms) {
        var el = root.querySelector('.gz-now');
        if (!el) return;
        el.textContent = t;
        root.classList.add('gz-playing');
        setTimeout(function () { root.classList.remove('gz-playing'); }, ms || 3000);
      }

      function playerResume() {
        var a = curEl();
        if (!a) return;
        // 手里没有曲目（刚装好 / 刚被放空）→ 去队列头捞一首，别静默什么都不做。
        if (!a.src) {
          pondSay('正在取一首…', 2500);
          fetch('/api/pond/state', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (s) {
              var list = (s && s.queue) || [];
              if (!list.length) { pondSay('队列空了 —— 右键水 → 弹一首', 4200); return; }
              var t = list[0];
              loadQuiet(t.url);
              pondSay(t.title ? '《' + t.title + '》' : '正在放', 3000);
              playActive().catch(function (e) { pondSay('放不出来：' + (e && e.message || '被浏览器拦了'), 4200); });
              if (hooks.onManualLoad) { try { hooks.onManualLoad(t); } catch (e) { /* ignore */ } }
            })
            .catch(function () { pondSay('取不到队列', 3500); });
          return;
        }
        playActive().catch(function (e) { pondSay('放不出来：' + (e && e.message || '被浏览器拦了'), 4200); });
      }
      /**
       * 「真的在响」和「没暂停」不是一回事。
       *
       * 刚起播的头几百毫秒，<audio>.paused 已经是 false，但用户一点声音都
       * 还没听见。此时他点水，意思一定是「让它响」，不可能是「停」——
       * 按暂停读，就是「我点了一下，然后它半天不放，也不告诉我为什么」。
       *
       * 已知代价：想暂停一首刚开头的曲子，要等这 0.4 秒过去。
       * 比「点水把自己的播放停掉」轻得多。
       */
      var WARM = 0.4;
      function reallyPlaying() {
        for (var i = 0; i < els.length; i++) {
          if (!els[i].paused && els[i].currentTime > WARM) return true;
        }
        return false;
      }

      // 点一下水：有曲就播/停，没曲就去队头捞一首。
      // 这是整块水面上唯一的主动作 —— 之前只有右键菜单里有「暂停」，
      // 左键只挂了一个拖动，于是「我要它停」在界面上根本没有落点。
      function tapPond() {
        var a = curEl();
        if (!a) return;
        if (!a.src || a.error) { playerResume(); return; }
        if (player.ctl && player.ctl.pause && player.ctl.resume) {
          if (reallyPlaying()) player.ctl.pause();
          else player.ctl.resume();
          return;
        }
        if (reallyPlaying()) stopAll();
        else playerResume();
      }
      function onContext(e) {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }
      function onDocDown(e) {
        if (menuEl && !menuEl.contains(e.target)) closeMenu();
      }
      function onKey(e) { if (e.key === 'Escape') closeMenu(); }
      rim.addEventListener('contextmenu', onContext);
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onKey);

      return {
        resume: unlock,
        toggle: tapPond,
        play: playerResume,
        // ── deck 接口：水以外的东西（浮层里的 player.ctl）只走这几个 ──────
        el: curEl,
        els: els,
        playing: anyPlaying,
        hasSrc: function () { var a = curEl(); return !!(a && a.src); },
        loadQuiet: loadQuiet,
        loadNow: function (url) { loadQuiet(url); return playActive(); },
        start: playActive,
        prime: prime,
        // 已经响着就交叉淡入，否则直接换上去就播。
        swapTo: function (url) {
          if (anyPlaying()) return crossfadeTo(url);
          loadQuiet(url);
          return playActive().then(function () { return true; });
        },
        crossfade: crossfadeTo,
        stop: stopAll,
        destroy: function () {
          dead = true;
          try { if (stopTheme) stopTheme(); } catch (e) { /* ignore */ }
          cancelAnimationFrame(raf);
          clearTimeout(fadeTimer);
          for (var b = 0; b < elBindings.length; b++) {
            var pair = elBindings[b];
            try {
              pair[0].removeEventListener('timeupdate', pair[1]);
              pair[0].removeEventListener('ended', pair[2]);
            } catch (e) { /* ignore */ }
          }
          window.removeEventListener('resize', resize);
          if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
          rim.removeEventListener('pointerenter', onEnter);
          rim.removeEventListener('pointerleave', onLeave);
          rim.removeEventListener('pointerdown', onDown);
          rim.removeEventListener('pointermove', onMove);
          rim.removeEventListener('pointerup', onUp);
          rim.removeEventListener('pointercancel', onUp);
          rim.removeEventListener('contextmenu', onContext);
          grip.removeEventListener('click', onGripTap);
          grip.removeEventListener('contextmenu', onContext);
          try { grip.remove(); } catch (e) { /* ignore */ }
          document.removeEventListener('pointerdown', onDocDown, true);
          document.removeEventListener('keydown', onKey);
          closeMenu();
          try { if (audioCtx) audioCtx.close(); } catch (e) { /* ignore */ }
        },
      };
    }

    // ── 浮层组件 ───────────────────────────────────────────────────────────
    function PondOverlay() {
      var rootRef = react.useRef(null);
      // 两只 <audio>：一支在响、一支待命。曲与曲之间的接续靠它们交叉淡入，
      // 单只元素只能硬切，切的那一下必然有一段空。
      var audioARef = react.useRef(null);
      var audioBRef = react.useRef(null);
      var pondRef = react.useRef(null);
      var nowRef = react.useRef(null);
      var trackRef = react.useRef(null);
      var busyRef = react.useRef(false);

      react.useEffect(function () {
        var root = rootRef.current;
        var elA = audioARef.current;
        var elB = audioBRef.current;
        if (!root || !elA || !elB) return undefined;

        var alive = true;
        var timer = 0;
        // 「该响着」和「正在响」是两件事：前者是用户的意图，后者是浏览器的状态。
        // 只有前者为真时，才允许任何一次点击把声音带回来。
        var wantPlay = false;
        // userPaused 比 wantPlay 硬一档：用户亲手按下暂停之后，只有用户自己再点
        // 一下才能回到发声状态。轮询、换曲、点页面别处、队列被别的实例改写——
        // 一律不许把它顶开。这就是「过一会自己放起来」的正解。
        var userPaused = false;
        // 用户点了「编一曲」→ 新谱一出现就接过来，哪怕此刻正放着别的、或按着暂停。
        // 光靠队列顺序不行：新曲排在旧曲后面，暂停中的旧曲会一直挡着它。
        var wantNew = 0;
        var seenIds = Object.create(null);
        // 预取来的下一首。交叉淡入必须在曲末之前就知道答案 ——
        // 等 ended 了才去问队列，那段等待就是用户听见的空档。
        var nextTrack = null;

        // 水只认音频；记账（标题、队列、userPaused）全留在这个闭包里。
        // hooks 是个可变对象：mountPond 拿到的是同一个引用，后面再填上实现。
        var hooks = {};
        var ctl = mountPond(root, [elA, elB], hooks);
        pondRef.current = ctl;

        function skipFresh(list) {
          if (!wantNew) return null;
          if (Date.now() > wantNew) { wantNew = 0; return null; } // 五分钟还没编出来，作废
          for (var i = 0; i < list.length; i++) {
            if (!seenIds[list[i].id]) return list[i];
          }
          return null;
        }

        function takeNew(track) {
          wantNew = 0;
          return player.ctl.load(track);
        }
        // 按钮派曲成功后调用
        player.armNew = function () { wantNew = Date.now() + 5 * 60 * 1000; };
        // 「编完了却半天不响」有四道门，任一断了表现完全一样：点了编曲没反应、
        // 编好了也没反应。留一个只读把手，下次再出这个毛病能直接看出是哪一道：
        //   armNewLeft = 0 → 根本没人调 armNew（派曲那一步漏了）
        //   seen 一直涨但没换曲 → tick 在跑，skipFresh 没认出新的那首
        //   playing = false 且 track 没变 → load() 拿到的曲没播起来
        player.diag = function () {
          return {
            armNewLeft: wantNew ? Math.max(0, Math.round((wantNew - Date.now()) / 1000)) : 0,
            seen: Object.keys(seenIds).length,
            userPaused: userPaused,
            playing: ctl.playing(),
            track: trackRef.current ? trackRef.current.id : null,
          };
        };

        // 队列里「下一首是谁」：跳过手里这首。都跳完（队列只有一首）就是没有。
        function pickNext(list) {
          var cur = trackRef.current;
          for (var i = 0; i < list.length; i++) {
            if (!cur || list[i].id !== cur.id) return list[i];
          }
          return null;
        }

        function showTrack(track) {
          trackRef.current = track;
          var title = track && track.title ? '《' + track.title + '》' : '';
          player.set({ title: title, hasTrack: !!track });
          if (nowRef.current) nowRef.current.textContent = title;
          root.classList.add('gz-playing');
        }

        function publish() {
          var el = ctl.el();
          var on = ctl.playing();
          player.set({
            playing: on,
            paused: !on && !!(el && el.src),
            hasTrack: ctl.hasSrc(),
          });
        }

        // 这首算放过了。不记账的话队列头永远不动，下一轮 tick 会把同一首再放一遍。
        function markPlayed(id) {
          if (!id) return Promise.resolve();
          return fetch('/api/pond/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'played', id: id }),
          }).catch(function () { /* 记不上也继续，最多多放一次 */ });
        }

        // ── 给 mountPond 的回调（它在内部推进曲子，但不知道队列长什么样）──
        hooks.getNext = function () { return nextTrack; };
        // 交叉淡入真的开始了：账在这里记，别在 ended 里记 —— 淡出那只
        // 是被 pause() 掉的，永远不会有 ended。
        hooks.onFadeStart = function (track) {
          var prev = trackRef.current;
          nextTrack = null;
          showTrack(track);
          if (prev && prev.id !== track.id) markPlayed(prev.id);
          publish();
        };
        // 只有「正在出声的那只」自然放完才会走到这里（队列里再没有下一首）。
        hooks.onEnded = function () {
          var cur = trackRef.current;
          trackRef.current = null;
          setNow(null);
          player.set({ hasTrack: false, playing: false, paused: false, title: '' });
          if (!cur) return;
          markPlayed(cur.id).then(function () { return tick(); });
        };
        // 水自己去队头捞了一首（刚装好 / 刚被放空时的「点一下」）
        hooks.onManualLoad = function (track) { showTrack(track); };

        // 给按钮用的三个动作。按钮不下场碰 <audio>，一律走这里。
        player.ctl = {
          pause: function () {
            wantPlay = false;
            // 用户亲手按的暂停，记下来。tick() 每次轮询都要先看它。
            userPaused = true;
            ctl.stop();
            publish();
          },
          resume: function () {
            wantPlay = true;
            userPaused = false;
            // 手里还没装曲就 return，是「点了没反应」最干净的一种写法：
            // 不出声、不报错、连提示都没有。什么时候会没有曲？刚刷新、
            // act 那只还空着而另一只被 prime() 预载了、队列刚被别的实例
            // 改写。这些都不该让一次点击落空 —— 交给 ctl.play() 去队头
            // 捞一首，和 tapPond 的 no-src 分支走同一条路。
            var go = ctl.hasSrc() ? ctl.start() : ctl.play();
            return Promise.resolve(go).then(function () {
              root.classList.remove('gz-silent');
            }).catch(function () {
              root.classList.add('gz-silent');
            }).then(publish);
          },
          // 把一个新队列项塞进来。opts.auto === false 时只装载不开播 ——
          // 换曲不是「解除暂停」，用户按着暂停的时候换曲必须还是安静的。
          load: function (track, opts) {
            if (userPaused || (opts && opts.auto === false)) {
              showTrack(track);
              ctl.loadQuiet(track.url);
              publish();
              return Promise.resolve();
            }
            // 已经响着 → 交叉淡入。用户点了「编一曲」，新曲就该这么接过来。
            if (ctl.playing()) {
              var prev = trackRef.current;
              return ctl.swapTo(track.url).then(function (ok) {
                showTrack(track);
                if (ok && prev && prev.id !== track.id) markPlayed(prev.id);
                publish();
              });
            }
            showTrack(track);
            return ctl.loadNow(track.url).then(function () {
              root.classList.remove('gz-silent');
            }).catch(function () {
              root.classList.add('gz-silent');
            }).then(publish);
          },
          // 立刻从队头捞一首放起来（不管有没有装过曲）。按钮那边用：用户点了
          // 「编一曲」，新曲还要走「派会话 → 写谱 → 渲染 12 秒」这条路，这段时间
          // 不该是一片哑的 —— 有存货就先响，新曲出来自己淡进来。
          playQueue: function () {
            if (userPaused) return Promise.resolve(false);
            wantPlay = true;
            return ctl.play();
          },
        };
        // 真的出声了就把「点一下，让水应声」收起来。原来只在 resume() 的 then 里
        // 移除，别的起播路径（自动接播、右键菜单、取出新曲）都会让这块提示长期
        // 浮在水面上，而它自己又是一个 resume 按钮 —— 一点就响，用户读作「失灵」。
        var onPlay = function () {
          root.classList.remove('gz-silent');
          publish();
        };
        elA.addEventListener('play', onPlay);
        elB.addEventListener('play', onPlay);
        elA.addEventListener('pause', publish);
        elB.addEventListener('pause', publish);

        function setNow(title) {
          var el = nowRef.current;
          if (!el) return;
          if (title) {
            el.textContent = title;
            root.classList.add('gz-playing');
          } else {
            root.classList.remove('gz-playing');
          }
        }

        // 队列靠轮询，不靠推送：一个角落的装饰，不值得为它开一条通道。
        async function tick() {
          if (!alive || busyRef.current) return;
          try {
            var res = await fetch('/api/pond/state', { cache: 'no-store' });
            if (!res.ok) return;
            var state = await res.json();
            var list = Array.isArray(state.queue) ? state.queue : [];

            // 用户按着暂停：只把「排队里有几首」记住，绝不换曲、绝不开播。
            // 原来这里没有闸门，只要队头 id 和手里那首对不上（别的实例改了
            // queue.json、played 后重排、文件被过滤），每 2.5 秒就会重新开播一次。
            if (userPaused) {
              for (var up = 0; up < list.length; up++) seenIds[list[up].id] = 1;
              if (!list.length) setNow(null);
              return;
            }

            // 先把下一首找出来并塞进待命那只。1.5 秒一拍，等于一直在提前
            // 一个轮询周期备料 —— 淡入开始时不用等文件。
            nextTrack = pickNext(list);
            if (nextTrack) ctl.prime(nextTrack.url);

            // 再看待播新曲：它比队列顺序优先
            var fresh = skipFresh(list);
            if (fresh) {
              busyRef.current = true;
              try {
                await takeNew(fresh);
              } finally {
                busyRef.current = false;
              }
              for (var f = 0; f < list.length; f++) seenIds[list[f].id] = 1;
              return;
            }
            for (var s = 0; s < list.length; s++) seenIds[list[s].id] = 1;

            if (ctl.playing()) return;
            var next = list[0];
            if (!next) {
              setNow(null);
              player.set({ hasTrack: false, playing: false, paused: false, title: '' });
              return;
            }
            // 手里这一首还是队列头（可能正被用户暂停着）：不换曲，否则每 1.5 秒
            // 轮询一次就会把刚按下的暂停重新顶开。
            if (trackRef.current && trackRef.current.id === next.id) return;
            busyRef.current = true;
            try {
              await player.ctl.load(next);
            } finally {
              busyRef.current = false;
            }
          } catch (e) { /* 网络抖动，下一拍再试 */ }
        }

        // 任何一次真实点击都顺手解锁 AudioContext（自动播放策略），幂等。
        //
        // 这里绝对不许 play()。原来有一句 `if (wantPlay && audio.paused) play()`，
        // 而 pointerdown 在 pointerup 之前：一次点水 = 先在 pointerdown 起播、
        // 再在 pointerup 被 tapPond 判成「正在播 → 暂停」，一按一放净效果为零。
        // 用户读作「我要它放，半天不放」；从别处点一下又会被这句拉起来，读作
        // 「过一会自己放起来」。起播只有一个入口：tapPond（水）和右键菜单。
        var onPointer = function () {
          ctl.resume();
        };
        document.addEventListener('pointerdown', onPointer, true);

        tick();
        // 1.5 秒一拍：编完一首到出声之间的等待主要是这个轮询周期。
        // 2.5 秒在「点完按钮等着听」的场景里就是一段说不清的空白。
        timer = setInterval(tick, 1500);

        return function () {
          alive = false;
          clearInterval(timer);
          document.removeEventListener('pointerdown', onPointer, true);
          var both = [elA, elB];
          for (var i = 0; i < both.length; i++) {
            var el = both[i];
            el.removeEventListener('play', onPlay);
            el.removeEventListener('pause', publish);
            try { el.pause(); el.removeAttribute('src'); } catch (e) { /* ignore */ }
          }
          ctl.destroy();
          pondRef.current = null;
          player.ctl = null;
          player.armNew = null;
          player.set({ playing: false, paused: false, hasTrack: false, title: '' });
        };
      }, []);

      return h('div', { id: 'gz-pond', ref: rootRef },
        h('div', { className: 'gz-deep' }),
        // 「一片水」那层：小窗档完全透明，放大时按 --gz-sp 淡入（见样式）
        h('div', { className: 'gz-far' }),
        h('canvas', { className: 'gz-water' }),
        h('canvas', { className: 'gz-gl' }),
        h('div', { className: 'gz-rim' }),
        h('div', { className: 'gz-now', ref: nowRef }),
        h('div', { className: 'gz-hint' }, '拖动这一汪水'),
        h('div', {
          className: 'gz-wake',
          onClick: function () {
            // 走 water 的 toggle：它会解除 userPaused 并把 wantPlay 置真，
            // 直接调 player.ctl.resume() 在「还没装载曲目」时是空转。
            if (pondRef.current && pondRef.current.toggle) pondRef.current.toggle();
            else if (player.ctl) player.ctl.resume();
            if (rootRef.current) rootRef.current.classList.remove('gz-silent');
          },
        }, '点一下，让水应声'),
        h('audio', { ref: audioARef, preload: 'auto', crossOrigin: 'anonymous' }),
        h('audio', { ref: audioBRef, preload: 'auto', crossOrigin: 'anonymous' })
      );
    }

    // ── 主对话那颗按钮 ─────────────────────────────────────────────────────
    /**
     * 一颗按钮，三种状态：
     *   没声音   → 「编一曲」：派子会话去写谱，写完自动进队列、水就响了
     *   响着     → 「暂停」  ：停声，水退回静止的涟漪
     *   暂停着   → 「继续」  ：接着放
     *
     * 想指定「要什么样的曲子」按右边那颗小圆点，输入框才展开——主路径保持一击即中。
     */
    function ComposeButton(props) {
      var sessionId = props && props.sessionId ? props.sessionId : '';
      var [open, setOpen] = react.useState(false);
      var [idea, setIdea] = react.useState('');
      var [busy, setBusy] = react.useState(false);
      var [note, setNote] = react.useState('');
      var [err, setErr] = react.useState(false);
      var [count, setCount] = react.useState(0);
      var [st, setSt] = react.useState(player.st);
      var inputRef = react.useRef(null);

      // 水层是唯一碰 <audio> 的人，按钮只订阅它的结论
      react.useEffect(function () { return player.sub(setSt); }, []);

      react.useEffect(function () {
        var alive = true;
        var pull = function () {
          fetch('/api/pond/state', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) { if (alive && s) setCount(Array.isArray(s.queue) ? s.queue.length : 0); })
            .catch(function () {});
        };
        pull();
        var t = setInterval(pull, 4000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      react.useEffect(function () {
        if (open && inputRef.current) inputRef.current.focus();
      }, [open]);

      function fire() {
        if (busy) return;
        setBusy(true);
        setErr(false);
        setNote('正在派子会话…');
        // 先把存货响起来。新曲要经过「派会话 → 读手册 → 写谱 → 渲染」，
        // 十几秒起步；这段时间水不该是哑的。已经在响就什么都不做。
        if (!playing && !paused && count > 0 && player.ctl && player.ctl.playQueue) {
          player.ctl.playQueue();
        }
        fetch('/api/pond/task', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, idea: idea.trim() }),
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (out) {
            if (!out.ok || !out.j.ok) {
              setErr(true);
              setNote('没派出去：' + (out.j && out.j.error ? out.j.error : '未知错误'));
              return;
            }
            // subagent-reuse = 复用了池里那个常驻作曲会话，没再新建一遍
            var how = out.j.via === 'subagent-reuse'
              ? '常驻作曲会话接手了，它正照着上一首的路子写（写完自己交上来）'
              : out.j.via === 'subagent'
                ? '子会话已开，它正在读手册写谱（写完自己交上来）'
                : '已直接编好一首，进队列了';
            setNote(how);
            // 曲一出来就切过去，不看它排在队列第几位
            if (player.armNew) player.armNew();
            setIdea('');
            setOpen(false);
          })
          .catch(function (e) {
            setErr(true);
            setNote('没派出去：' + String(e && e.message || e));
          })
          .finally(function () { setBusy(false); });
      }

      var playing = !!st.playing;
      var paused = !playing && !!st.hasTrack;

      function onClick() {
        if (busy) return;
        if (playing) { if (player.ctl) player.ctl.pause(); return; }
        if (paused) { if (player.ctl) player.ctl.resume(); return; }
        fire();
      }

      var label = busy ? '正在派…' : playing ? '暂停' : paused ? '继续' : '编一曲';
      var cls = 'gz-btn' + (playing ? ' gz-pause' : (count > 0 || paused ? ' gz-on' : ''));
      var tip = playing
        ? '暂停这汪水里的曲子'
        : paused
          ? '接着放《' + (st.title || '').replace(/[《》]/g, '') + '》'
          : '派一个子会话去编一首古筝曲：它读手册、写谱、交上来，水就响了';

      var btn = h('button', {
        className: cls,
        type: 'button',
        title: tip,
        disabled: busy,
        onClick: onClick,
      },
        h('span', { className: 'gz-dot' }),
        label,
        count > 0 ? h('span', { className: 'gz-count' }, count + ' 首待播') : null
      );

      // 「说说要什么样的」——挂在按钮右边，不抢主路径
      var more = h('button', {
        className: 'gz-more',
        type: 'button',
        title: open ? '收起' : '说说要什么样的曲子（可选）',
        onClick: function (e) { e.stopPropagation(); setOpen(!open); },
      }, open ? '×' : '＋');

      var ideaInput = open ? h('input', {
        ref: inputRef,
        className: 'gz-idea',
        placeholder: '要什么样的曲子？回车交给子会话',
        value: idea,
        onChange: function (e) { setIdea(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); fire(); }
          if (e.key === 'Escape') { setOpen(false); }
        },
      }) : null;

      return h('div', { className: 'gz-dock' },
        btn,
        more,
        ideaInput,
        note ? h('span', { className: 'gz-msg' + (err ? ' gz-err' : '') }, note) : null
      );
    }

    // ── 插件 ───────────────────────────────────────────────────────────────
    var inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'guzheng-pond-overlay',
          order: 60,
        }, PondOverlay);
      });
      // 输入框下面那颗独立按钮已经并进水汪：点水 = 播放/暂停，右键水 = 全部操作。
      // 少一颗按钮，也少一处「装了没看见」的失败点。
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
