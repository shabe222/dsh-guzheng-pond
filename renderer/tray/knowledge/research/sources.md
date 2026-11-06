# sources.md — 已核实书目

> 约定：可信度 = 高（传世通行本，可交叉核对）/ 中（有校本分歧或仅在二手引用中见到原文）/ 低（未见原文，仅转述）。本地副本在 _raw/。
>
> **核对方法（2026-10-26 引文复核后统一）**：引文与底本比对一律先「去标点 + 繁简归一（zhconv 转 zh-cn）+ 异体归并（閒→間 等）」，再做**最长连续子串**匹配；只有连续命中长度不足、且各段都短于 15 字时才判「找不到」。此前 `_audit.py` 只取引文前 12 字做严格子串比对，遇繁简混排必假阴性（详见 `_audit-report-v2.md`）。
>
> **底本录文讹字**：与古斋琴谱、琴旨等 OCR 录文有个别讹字/造字（如 𦔼=叶、𢼣=故、抂=在、𭆤=參、夏=取、人紧=入紧、吱结=收结），各卡文末「校记」逐条说明；未见影印本，不据理校改字。

| 书·篇 | 版本 / 链接 | 抓取日期 | 可信度 | 备注 |
|---|---|---|---|---|
| 礼记·乐记 | 维基文库《禮記/樂記》 https://zh.wikisource.org/wiki/禮記/樂記 （繁体全文） | 2026-10-26 | 高 | 本地副本 _raw/yueji-wikisource.txt；通行十一篇之首篇「乐本」即开篇段。ctext.org/liji/yue-ji/zh 有 Cloudflare 反爬（提示订阅），未抓正文 |
| 礼记·乐记 | ctext.org/liji/yue-ji/zh | 2026-10-26 | 中 | 仅确认可访问、被反爬拦（"Please ask your institution to subscribe"），未能取到正文 |
| 谿山琴况（明·徐上瀛） | 维基文库 https://zh.wikisource.org/wiki/谿山琴况 （pageid=9460） | 2026-10-26 | 高 | B1 已用；正文节本 _raw/xishan-clean.txt；旧档 _research/xishan-wikisource.txt 有个别异文（如恬况「自撓/自擾」），以 API 现抓版为准 |

## 待核实（下一步 / 已知缺口）
- 与古斋琴谱**影印本**：识典仅提供 OCR 录文，本卡引文中的「定固执」「人紧」「吱结」等讹字无影印可校；书格有扫描本 PDF（未下载）。若要彻底校勘，需要扫描件对照。
- 声无哀乐论（嵇康）、毛诗序、荀子·乐论：均已在下方表中登记为「高」，2026-10-26 复核已用其本地副本核对（A2/A3/A4 引文全部命中）。
| 与古斋琴谱（清·祝凤喈撰） | 识典古籍 https://www.shidianguji.com/book/CADAL02095087/ （咸丰刊本，卷一~四+补义+后跋） | 2026-10-26 | 高 | B4 已用；本地 _raw/yuguzhai-*.txt；维基文库/中华典藏/kanripo 均无全文，书格仅扫描本 |
| 与古斋琴谱·补义·琴曲收音起句考 | 识典古籍单节页 https://www.shidianguji.com/zh/mid-page/7555623563425841203 | 2026-10-26 | 高 | **D3 ① 的独立复核件**：服务端渲染，含「如收宫起徴，收徵起商…」全段，与 _raw/yuguzhai-houba.txt 第 243-244 行同文。本地副本 _raw/shidianguji_ygqp_shouyin-qiju.txt。此前 `_audit-report.md` 判其「编造」系繁简比对失配所致（见 _audit-report-v2.md） |
| 管子·地员（三分损益最早记载） | 维基文库 https://zh.wikisource.org/wiki/管子/第58篇地員 | 2026-10-26 | 高 | C1 已用；本地 _raw/guanzi-diyuan.txt |
| 吕氏春秋·音律 | 维基文库 https://zh.wikisource.org/wiki/呂氏春秋/卷六 （音律篇） | 2026-10-26 | 高 | C1 已用；本地 _raw/lvchunqiu-v6text.txt |
| 白石道人歌曲·凄凉犯小序（宋·姜夔） | 维基文库四库本 https://zh.wikisource.org/wiki/白石道人歌曲_(四庫全書本)/卷4 | 2026-10-26 | 高 | C3 已用；「犯调」术语最权威自述；本地 _raw/baishi-v4.txt |
| 乐律全书·卷十二（明·朱载堉） | 维基文库四库本 https://zh.wikisource.org/wiki/樂律全書_(四庫全書本)/卷12 | 2026-10-26 | 高 | C4 已用；「移宫换羽」定义句；本地 _raw/lvlu-q12.txt |
| 琴旨·卷下（清·王坦） | 维基文库四库本 https://zh.wikisource.org/wiki/琴旨_(四庫全書本)/卷下 | 2026-10-26 | 高 | C4 已用；移宫换羽琴上实现与映射表；本地 _raw/qinzhi-x2.txt |
| 古今词话（引乔梦符作乐府三法） | 维基文库 https://zh.wikisource.org/wiki/古今詞話_(清) | 2026-10-26 | 高 | D2 已用；凤头猪肚豹尾；本地 _raw/gujincihua.txt |
| 诗法家数（元·杨载） | 维基文库 https://zh.wikisource.org/wiki/詩法家數 | 2026-10-26 | 高 | D2 已用；起承转合诗法八条；本地 _raw/shifajia.txt |
| 西圃词说（引沈东江论对句） | 维基文库 https://zh.wikisource.org/wiki/西圃詞說 | 2026-10-26 | 高 | D3 已用；词中对句论述；本地 _raw/xipu.txt |
| 词旨（陆辅之，引张炎词源过片论） | 维基文库 https://zh.wikisource.org/wiki/詞旨 | 2026-10-26 | 高 | D4 已用；过片不要断了曲意；本地 _raw/cizhi.txt |
| 毛诗序（诗大序） | 维基文库《诗经/序》 https://zh.wikisource.org/wiki/詩經/序 | 2026-10-26 | 高 | A3 已用；与乐记同文互证；本地 _raw/maoshi-xu.txt |
| 荀子·乐论 | 维基文库 https://zh.wikisource.org/wiki/荀子/樂論篇 | 2026-10-26 | 高 | A4 已用；乐者乐也/乐合同；本地 _raw/xunzi-yuelun.txt |
