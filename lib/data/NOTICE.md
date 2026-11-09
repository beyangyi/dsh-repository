# 第三方数据说明

## 亮星、星座连线与银河（lib/data/sky.json）

由 `tools/build-sky.mjs` 从 **d3-celestial 0.7.35** 的公开数据文件生成：

- 来源：https://github.com/ofrohn/d3-celestial （npm: `d3-celestial`，经 jsDelivr 拉取）
- 用到的文件：`data/stars.6.json`（星等 ≤ 6 的恒星）、`data/constellations.lines.json`（星座连线）、
  `data/starnames.cn.json`（恒星中文名）、`data/mw.json`（银河五级亮度等值线）
- 许可证：BSD-3-Clause，Copyright (c) Olaf Frohn
- 本仓库只保留 mag ≤ 4.2 的亮星（632 颗）与 dec > −55° 的星座连线（76 个），
  字段转成 `[ra, dec, mag, 中文名]` 与 `{ id, n, paths }`，属于对原数据的裁剪与格式转换。
- 银河：`mw.json` 的 5 级亮度等值线（约 3 万点、110 KB）用 Douglas–Peucker 抽稀到 0.25°，
  保留「外环 + 洞」的多边形结构（5 级、202 环、2677 点），渲染时逐环做近平面裁剪后
  用 even-odd 一次填充 —— 暗尘带就是真正的洞，不是另画的深色。

星座中文名（IAU 88 个译名）写在 `tools/build-sky.mjs` 的 `CONSTELLATION_CN` 表里，
因为 d3-celestial 的 `constellations.cn.json` 是「三垣二十八宿」而不是 IAU 译名。

星表坐标是 J2000，运行时按当天日期做岁差（`lib/skyview.js` 的 `ofDateCatalog`），
精度约 0.01°；银河云团同样是 J2000 + 岁差。仅用于画面示意，不作测光/天体测量用途。
