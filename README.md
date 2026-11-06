# dsh-guzheng-pond

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 写的一个插件：**点一下按钮，屏幕上就有一首古筝，脚边浮起一汪跟着声音起伏的水。**

> 水是纯装饰层，四角穿透，不接事件，拖动随意。原有对话一个字都不受影响。

---

## 它到底做了什么

```
你点输入框下面那颗按钮
        │
        ▼
   当前对话派出一个子会话
        │
        ├─ 读 pond_knowledge()   ← 工具自带的中国音乐 know-how（乐记、溪山琴况、绰注吟猱…）
        ├─ 按「琴语言」写谱
        └─ 交回 pond_play(score)
                │
                ▼
        离线渲染成 wav → 入队
                │
                ▼
        右下角那汪水跟着响，再点一下暂停
```

整套东西只有**两种交互**：一个按钮，一汪水。不弹窗、不加面板、不改对话。

---

## 三个部分

| 部分 | 路径 | 干什么 |
|---|---|---|
| **宿主插件** | `index.js` | cordis 插件。注册 `pond_knowledge` / `pond_play` 两个工具、`/api/pond/*` 一组路由、派子会话 |
| **客户端** | `client.js` | 挂两个插槽：`shell.overlay` 放水，`conversation.composer.dock` 放按钮 |
| **水** | `assets/water.js`、`assets/gl-water.js` | 冻结的成片实现，只从 `/api/pond/asset/` 加载 |
| **渲染器** | `renderer/` | 琴语言解析 + Web Audio 合成，在 headless Chrome 里离线渲成 wav |
| **乐理手册** | `renderer/tray/knowledge/` | 子会话写谱的唯一依据 |

---

## 安装

### 0. 前置

- DSH（0.1.x 或 0.2.x 都行）
- Node.js ≥ 18（**必须是真 node，不能是 Electron 里的**——见下面「为什么不能省 nodeExe」）
- 本机装了 Chrome 或 Edge（渲染器借浏览器的 Web Audio 做离线合成）

### 1. 装渲染器依赖

渲染器自己是一个小项目，只有**一个**依赖（`playwright-core`，约 15MB，不含浏览器）：

```sh
cd renderer
npm install
```

### 2. 装插件本体

```sh
npm pack                                    # 得到 dsh-guzheng-pond-0.3.0.tgz
dsh plugin --profile web add ./dsh-guzheng-pond-0.3.0.tgz
```

`dsh plugin add` 只往 profile 的 `dependencies` 里写一行，**`dsh.profile.bundles` 得自己加**：

```json
{
  "dependencies": {
    "dsh-guzheng-pond": "link:/path/to/dsh-guzheng-pond"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-guzheng-pond"]
    }
  }
}
```

本地开发用 `link:` + 绝对路径最省事。装好重启 DSH 进程。

### 3. 验证

```sh
curl --noproxy '*' http://127.0.0.1:3080/api/pond/state
```

返 **200 且 `"knowledge": true`** 才算真装好。

| 现象 | 含义 |
|---|---|
| 200 + `knowledge: true` | 一切正常 |
| 200 + `knowledge: false` | 插件挂上了，但找不到 `renderer/tray/knowledge/CORE.md` |
| 裸 400 | handler 抛异常（宿主吞掉了堆栈，只写日志） |
| 404 | 插件根本没挂上，看启动日志里的 `plugin tree failed to load` |

---

## 配置项

都能在 profile 的 `cordis.patch.yml` 里按 id 覆盖（这是**覆盖**，不是新增挂载）：

```yaml
- id: guzheng-pond
  config:
    projectDir: /path/to/my-guzheng      # 默认 = 包内自带的 renderer/
    nodeExe: C:/Program Files/nodejs/node.exe
    servePort: 8792
    maxQueue: 24
```

| 键 | 默认 | 说明 |
|---|---|---|
| `projectDir` | `<包根>/renderer` | 渲染器与知识手册的根目录 |
| `nodeExe` | `""`（自动探测） | 跑渲染用的**真** node 可执行文件 |
| `servePort` | `8792` | 静态服务端口（渲染器要把它当根） |
| `maxQueue` | `24` | 队列上限，超了丢最旧的 |

### 为什么不能省 nodeExe

DSH 自己是 Electron 应用，`process.execPath` 指向的是 **DSH 的 exe**，不是 node。拿它去跑 `dev/render-qin.mjs` 不会报错——它会把客户端再拉起来一次，然后渲染永远等不到结果，而且很难看出原因。

插件按这个顺序找真 node：配置项 → `GUZHENG_POND_NODE` 环境变量 → 常见安装路径 → `PATH` 里的 `node`。全找不到会明确报错，不静默降级。

环境变量版（不想改配置时）：

```sh
GUZHENG_POND_NODE=/usr/local/bin/node
GUZHENG_CHROME=/usr/bin/google-chrome
GUZHENG_SERVE_PORT=8792
```

---

## 接口

宿主侧（都挂在 `/api/pond`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | 队列、项目路径、手册是否读到 |
| POST | `/task` | `{sessionId, idea}` → 派子会话编曲 |
| POST | `/submit` | `{title, score}` → 直接交谱面，同步返回渲染结果 |
| POST | `/queue` | `{op:'played', id}` → 客户端播完把自己摘掉 |
| GET | `/audio/<id>.wav` | 音频流 |
| GET | `/asset/<name>` | 水层那两个库 |

工具侧（子会话看得见的）：

- **`pond_knowledge`** — 读乐理手册全文。子会话第一步必须调它。
- **`pond_play`** — 交谱面。同步渲染，返回时长、自查报告、技法统计。

---

## 琴语言（谱面格式）

子会话要写的是一种极简记谱：

```
@from 坐在窗边,风进来了
@to 合好窗扣,回到桌前
@turn 4
| 6/800 5/900 3/850 2/800 3/950 1/1000 ,3400
| 2/850 6/800 5/900 3/950 1/850 2/1000 ,3600
@2800
```

| 记号 | 含义 |
|---|---|
| `1 2 3 5 6` | 五声音级（宫商角徵羽），**没有 4 和 7** |
| `5.` / `5,` | 高/低八度（前缀也行：`.5` / `,5`） |
| `/800` | 时值毫秒 |
| `^` `^^` | 重音；`-` `--` 轻音 |
| `,3400` | 句尾空隙毫秒 |
| `1+5/833` | 撮（双音）；`1+3+5` 三音 |
| `r/400` | 休止，挂在**前一个音**上 |
| `~` `=` `?` | 吟猱/按音/悬句等技法修饰 |
| `@2800` | 全曲结尾留白 |

**每句行首必须有 `|`。** 没有 `|` 的行会被解析器静默跳过——不报错，但整份谱一个音都不剩。插件在渲染前会拦这种情况（0 句直接打回）。

完整语法见 [`renderer/tray/knowledge/QLANG.md`](renderer/tray/knowledge/QLANG.md)。

---

## 单独玩渲染器

不装 DSH 也能跑——它就是个静态页 + headless Chrome：

```sh
cd renderer
npm install

# 终端 1：起静态服务
npm run serve                 # http://127.0.0.1:8792

# 终端 2：渲一首
npm run render                # 用 dev/demo.js 里的示例谱
# → out/demo.wav
```

换自己的谱：把它写成 `dev/xxx.js`（导出 `TEXT`），然后

```sh
node dev/render-qin.mjs xxx.js my-song.wav
```

---

## 三条硬约束（踩过的坑）

**① 改 `index.js` 必须冷启进程。**
`cordis-plugin-hmr` 里写着 `if (job.url.includes('/node_modules/')) return` —— node_modules 下的模块直接跳过，而且它还要 `--expose-internals`。改完只能重启。

**② 改 `client.js` 只要刷新页面。**
前端 bundle 的 rev 是内容 sha1，改完刷浏览器就换新的。

**③ 包内 patch 的 `name` 只能是包名。**
`cordis.patch.yml` 由 profile boot 从**包根**解析。写成 `./node_modules/dsh-guzheng-pond/index.js` 会被拼成 `<包根>/node_modules/dsh-guzheng-pond/index.js` → `ERR_MODULE_NOT_FOUND`，**整棵插件树起不来**（不只是本插件失效）。写包名还有第二个作用：client-modules 扫描会据此找 `exports["./client"]`，把浏览器那一半送进 `/plugins/??…` 组合 URL。

另外：**profile 的 `cordis.patch.yml` 不要再写一遍 insert**。挂载由包自己的 `cordis.patch.yml` 完成，两边都写会挂两份。

---

## 已知限制

- **只支持五声音阶。** 谱面里出现 4 或 7 会直接解析失败。这不是 bug，是设计——古筝传统曲目本就是五声为体。
- **Windows 优先。** 浏览器探测表里 Windows 路径最多；macOS/Linux 走 `GUZHENG_CHROME` 或常见路径，没做穷举。
- **渲染一首要 20–60 秒。** headless Chrome 起页面 + 逐音合成，不追求快。
- **采样只有 29 个音。** 在 `renderer/samples/guzheng/`，缺的音会退化到邻近音高。

---

## 卸载

1. 从 profile 的 `package.json` 删掉 `dsh.profile.bundles` 里的包名；
2. `dsh plugin --profile web remove dsh-guzheng-pond`；
3. 重启。

插件目录留着不碍事，删了也不影响别的插件。

---

## License

MIT
