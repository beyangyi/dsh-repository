# dsh-astro-plan · 星野计划

[![npm](https://img.shields.io/npm/v/dsh-astro-plan?label=npm)](https://www.npmjs.com/package/dsh-astro-plan)
[![license](https://img.shields.io/badge/license-MIT-3da639)](LICENSE)
[![guide](https://img.shields.io/badge/用户指南-docs-d8b46a)](https://github.com/SiriusYANG91/dsh-astro-plan/blob/main/docs/user-guide.md)

星野计划（by Sirius YANG）：按 18 类天象与深空目标、全国 173 站、最长一年检索，结合光污染、方位、月相、星历事件与 7 天天气，给出推荐排序、地景、焦段与曝光；每条结果附 Stellarium 风格 3D 天球画面模拟（真实银河等值线、真实月相、实测天际线）。

![查询区与页头](https://raw.githubusercontent.com/SiriusYANG91/dsh-astro-plan/main/docs/images/01-overview.png)

## 功能速览

| 能力 | 规模 / 说明 |
|---|---|
| 目标类型 | **18 类**，两级菜单：星野 6（银河/流星雨/彗星/星轨/黄道光/极光）· 日月 2 · 行星 4（单个行星/冲日/大距/合）· 深空 5（全部深空/星系/星云/星团/行星状星云） |
| 站点库 | **173 个**，覆盖 **34 个省级行政区**、8 个地区，含海拔、波特尔指数、实测天际线 |
| 时间跨度 | 单次最长 **365 天**（夜的定义：当日 15:00 至次日 09:00） |
| 地图选点 | 地形底图上点 173 个站点直接选中（显示地名、不关闭），空白处落点当自定义拍摄地；选省份/地点时地区会自动补齐 |
| 天气 | 未来 **7 天内**接入逐时预报，三源自动择优：**MET Norway → Open-Meteo → 7Timer**；取不到就降级为纯天文排序 |
| 评分 | 五维加权：天象 0.4 · 天气 0.2 · 地景 0.2 · 光污染 0.1 · 月相 0.1，缺维度按参与权重归一 |
| 画面模拟 | 立体投影 3D 天球、真实银河等值线、真实日月大小与月相、实测天际线、5°–180° 缩放、地平/赤道双坐标 |
| 运行时依赖 | **零**（星历用 vendored astronomy-engine，星表/银河为构建期快照） |

## 安装

三种方式任选其一，装完**重启 DSH 桌面应用**。

**1）插件市场**：侧边栏「插件」→「发现」→ 添加索引

```
https://raw.githubusercontent.com/SiriusYANG91/dsh-astro-plan/main/docs/market-index.json
```

**2）npm**

```bash
dsh plugin --profile desktop add dsh-astro-plan@0.2.3
```

**3）本地目录（开发）**

```bash
dsh plugin --profile desktop add "<本目录绝对路径>"
```

验证：`curl http://127.0.0.1:<端口>/astro-plan/api/meta`

## 打开

| 入口 | 位置 |
|---|---|
| 会话 Tab | 侧边栏「星野计划」 |
| 独立页面 | `http://127.0.0.1:<端口>/astro-plan/` |
| 工具 | 对话里让模型调用 `astro_plan` |

页面参数：`?theme=light|dark` 强制配色、`?withSim=0` 关闭画面模拟。

## 用法（对话里）

1. 「这周末海坨山能拍什么？」
2. 「今年 8 月英仙座流星雨，华北哪个站点最好？」
3. 「明年 3 月去西藏拍深空，推荐 3 个目标，要星系」
4. 「10 月 14 日北京日食能看到吗？」
5. 「下个月有没有适合拍银河的暗夜窗口？」
6. 「M42 和 M31 哪个更适合我这周去拍？」
7. 「给我一条青海冷湖的整夜时间轴」
8. 「这几个目标的焦距和曝光分别是多少？」

| action | 作用 |
|---|---|
| `search` | 按条件检索推荐（默认） |
| `window` | 某站某夜逐小时时间轴 |
| `meta` | 数据概览（类型、地区、站点数、天气覆盖） |
| `events` | 天象事件（流星雨、银河季节窗口等） |
| `params` | 某目标的拍摄参数（`targetId`，如 `m42`） |

常用参数：`eventType`、`location`（站点/城市/省份/`lat,lon`/「全国」）、`region`、`province`、`dateStart`、`dateEnd`、`minAltitude`、`maxBortle`、`limit`、`originLat`/`originLon`。

## 界面

**查询区**：三行。拍摄日期（跨度上限一年，前端校验）；目的地与出发地（地区→省份→站点三级联动，出发地默认「目前所在地」，定位失败先复用上次结果再按北京估算）；拍摄目标（18 类两级菜单、高度角 ≥ 默认 0°、波特尔 ≤ 默认 6）。「查询」「重置」，打开页面不自动检索。

**结果列表**：八列 —— `#`、推荐度、目标类型、目标、拍摄地点、日期、最佳时段、最高高度；按推荐度排序，**20 条/页**，序号跨页连续，可跳页。

**便签详情**：点行展开，七个区块 —— 目标、时间与月相、地点、方位与构图、拍摄参数、天气、推荐度明细与推荐理由。维度随题材变化（日食只算天象/天气/地景；月食不算月相；行星与深空不算地景），缺维度不扣分。**窄屏（< 1100px）时画面模拟排在最上面一行，其余便签移到它下方**，宽屏仍是「左七块 + 右模拟」。

**画面模拟**：便签右侧整列（或窄屏时置顶）。立体投影投满整幅画面，无圆形取景框；银河按 5 级等值线加色绘制，暗尘带是真空洞；日月按真实视直径、月球按真实相位（晨昏线椭圆、亮面朝太阳）；天际线来自实测高程（36 方位、1.5–140 km）；缩放 5°–180°，地平/赤道网格切换，HUD 给时间、坐标系、视野、高度/方位（赤道模式另给赤经赤纬）；播放覆盖最佳时段（最多 72 帧），带跟踪开关。

## 评分模型

| 维度 | 权重 | 说明 |
|---|---|---|
| 天象 | **0.4** | 可见性（高度、时长）与事件分值合并 |
| 天气 | **0.2** | 7 天内来自 Open-Meteo；更远不参与 |
| 地景 | **0.2** | 前景与目标的配合度、不可替代性 |
| 光污染 | **0.1** | 波特尔指数，越低越好 |
| 月相 | **0.1** | 月照度越低越好；月食/日食不参与 |

缺哪个维度就把它的权重从分母里去掉（不会把缺失当 0 分），最后换算成百分制：**≥80** 条件很好、**60–80** 值得去、**<60** 建议换目标或日期。

## 数据与更新

| 数据 | 规模 | 来源 |
|---|---|---|
| 站点 | 173 个 / 34 省 / 8 地区 | 自建（海拔、波特尔、天际线、地景标签） |
| 目标 | 71 个（深空 47：星系 12 / 星云 18 / 星团 11 / 行星状星云 6） | 自建 + 通用星表 |
| 彗星 | 103 颗 | MPC 轨道根数，**每周首次启动自动重建** |
| 天球 | 632 颗亮星（≤ 4.2 等）、76 星座、5 级银河、11 场流星雨 | d3-celestial（BSD-3-Clause），构建期快照 |

页面第一行小字显示彗星库最近一次成功重建时间；除天气外，插件运行时不联网。

## 截图

![便签详情](https://raw.githubusercontent.com/SiriusYANG91/dsh-astro-plan/main/docs/images/03-note.png)

![合月与真实月相](https://raw.githubusercontent.com/SiriusYANG91/dsh-astro-plan/main/docs/images/06-sim-moon.png)

完整图文说明（14 章、9 张截图）见 **[用户指南](docs/user-guide.md)**。

## 开发

```bash
node --test --test-isolation=none "tests/*.test.js"   # 全部测试
node scripts/validate-sites.mjs                       # 站点库校验
node tools/build-comets.mjs                           # 重建彗星库（需联网）
node tools/build-sky.mjs                              # 重建星表/星座/银河（需联网）
node tools/sync-sky-renderer.mjs                      # 改完 skyview.js 的 RENDER_SRC 后同步到 Tab
node tools/make-guide-images.mjs                      # 重出用户指南配图（需无头 Edge）
node tools/publish.mjs --check|--publish              # 发布 npm 并刷新市场索引
node tools/push-repo.mjs                              # 把代码推到 GitHub（需 --allow-push；默认只读）
node tools/check-secrets.mjs                          # 令牌/私钥扫描 + gitignore 覆盖检查
node tools/verify-repo-lock.mjs                       # 仓库写权限审计（只读，确认只有所有者可写）
node tools/push-repo.mjs --allow-push --prune         # 连同删除远端已移除的文件
```

仓库写权限与令牌轮换见 [docs/maintaining.md](docs/maintaining.md)。

```bash
```

> 沙箱环境里 `node --test` 会为每个测试文件 spawn 子进程并被拒绝（EPERM），用 `--test-isolation=none` 单进程跑。

## 目录

```
lib/index.js     宿主入口：astro_plan 工具 + /astro-plan 路由
lib/planner.js   检索 → 可见窗口 → 五维评分 → 排序 / 时间轴
lib/skyview.js   画面模拟：星表岁差、meta.sky、sim 数据与 3D 渲染器源码
lib/astro.js     星历（高度方位/升落/暮光/月相，含岁差与时角）
lib/events.js    天象事件现算（食/冲/大距/合·合月 + 站级可见性）
lib/comets.js    MPC 轨道根数 → 二体传播 + 亮度模型
lib/weather.js   Open-Meteo 抓取与评分（10 分钟缓存）
lib/webui.js     自包含页面        lib/client.js  会话 Tab（零构建）
lib/data/        站点 / 目标 / 参数 / 彗星 / 天际线 / 星表（+ NOTICE.md）
tools/ scripts/  构建、发布、配图与校验脚本      tests/  测试
```

## 许可

插件代码 MIT。`lib/vendor/astronomy-engine.js` 来自 [cosinekitty/astronomy](https://github.com/cosinekitty/astronomy)（MIT，Don Cross）；`lib/data/sky.json` 由 [d3-celestial](https://github.com/ofrohn/d3-celestial)（BSD-3-Clause，Olaf Frohn）的公开星表裁剪生成，详见 `lib/data/NOTICE.md`。
