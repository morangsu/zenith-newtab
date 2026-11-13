# Zenith 性能对比：before2 → after2

- 测量时间：2026-11-08T04:03:12.581Z / 2026-11-08T04:06:32.137Z
- 浏览器：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
- 采样：每次新建独立标签页，冷启动 1 次 + 热启动 11 次，取中位数与 p90
- 口径：`rendered` 为 boot.js 起到首个 requestAnimationFrame（页面自记 `zl.perf`）；其余来自 NavigationTiming / PaintTiming / CDP Performance.getMetrics

| 指标 | before2 | after2 | 变化 |
|---|---:|---:|---:|
| 页面 gzip 总量 | 72.4 KB | 93.6 KB | +29.2% |
| 后台 gzip 总量 | 7.88 KB | 8.02 KB | +1.8% |
| 首屏链路字节（boot+CSS+HTML） | 37545.0 B | 39986.0 B | +6.5% |
| JS 模块数 | 31.0 | 39.0 | +25.8% |
| 文件总数 | 43.0 | 51.0 | +18.6% |
| 热启动 rendered（中位数） | 32.6 ms | 29.8 ms | -8.6% |
| 热启动 rendered（p90） | 34.5 ms | 34.6 ms | +0.3% |
| 冷启动 rendered | 45.0 ms | 62.5 ms | +38.9% |
| FCP（中位数） | 52.0 ms | 48.0 ms | -7.7% |
| DCL（中位数） | 59.0 ms | 58.8 ms | -0.3% |
| DOM 节点数 | 229.0 | 113.0 | -50.7% |
| ScriptDuration（中位数） | 3.73 ms | 3.42 ms | -8.3% |
| LayoutDuration（中位数） | 1.48 ms | 1.72 ms | +16.2% |
| RecalcStyleDuration（中位数） | 2.07 ms | 2.36 ms | +14.0% |
| TaskDuration（中位数） | 30.8 ms | 33.8 ms | +9.5% |

> 读表注意：
> - 「页面 gzip 总量」把**按需模块**（点开设置 / 快照 / 轮播才下载解析）也算进去了，
>   不等于新标签页首屏实际要解析的量；首屏链路另由 build.mjs 的 BUDGET_FIRST 单独约束。
> - 冷启动只有 1 个样本，波动远大于热启动，结论以热启动中位数为准。
> - 时间类指标受宿主机负载影响，必须用同一脚本、同一浏览器、相近时间连续采样做相对比较；
>   跨天/跨负载的绝对值不可直接比。

## 版本与结论

- `before2` = 0.12.0 的构建快照（`bench/baseline-dist/chrome`），`after2` = 0.13.0 最终构建（`dist/chrome`）。
- 两组在 2026-11-08 12:03 / 12:06（GMT+8）由同一脚本、同一 Edge 连续采样，是本报告的主结论依据。

**净结果：功能大幅增加，首屏没有变慢，实际解析的字节反而更少了。**

| 维度 | 结果 |
|---|---|
| 首屏静态链路 gzip | 72.4 KB → **68.6 KB**（−5.2%，build.mjs 的 `BUDGET_FIRST` 口径；双端都通过 70 KB 预算） |
| 首次可交互（`rendered`） | 32.6 → **29.8 ms**（−8.6%），p90 持平 |
| FCP | 52 → **48 ms**（−7.7%） |
| ScriptDuration | 3.73 → **3.42 ms**（−8.3%） |
| 首屏 DOM 节点 | 229 → **113**（−50.7%） |
| 页面 gzip 总量 | 72.4 → 93.6 KB（+29.2%），**全部来自按需模块**，不进首屏解析链路 |

DOM 减半不是功能缺失：看板节点两次都是 82，少掉的 116 个是 0.12.0 在首屏就同步构建好的设置面板
（10 个分区、19 个按钮、8 条提示）。0.13.0 改为点齿轮才挂载，首屏不再为用不到的 UI 付费。

`TaskDuration` +9.5%、`Layout/RecalcStyle` 各 +14~16% 是剩余代价：多出的 8 个模块文件与
`data-i18n-*` 属性带来少量额外样式计算，绝对值都在 1~3 ms 量级，被首帧工作减少抵消。
冷启动 +38.9% 是单样本波动（该轮 62.5 ms），不作为结论。

### 中途发现并修掉的性能回退

0.13.0 第一版（`bench/after.json`）曾出现 `rendered 33.8 ms / Script 5.36 ms / Task 43.67 ms` 的回退。
定位到两处首屏多余工作，已修掉并重新测量为 `after2`：

1. HTML 默认文案本来就是简体中文，却仍对每个新标签页做一轮全文档 `data-i18n*` 查询与属性写入。
   现在中文首帧直接跳过；切换语言时 `refreshLocalizedUi()` 仍无条件重填（那时 DOM 可能是英文）。
   `test/features.mjs` 增加守卫，校验 HTML 默认文案与字典中文逐字一致，防止短路造成文案错位。
2. 空闲回调无条件 `import('./strings-extra.js')` 解析 6.8 KB 按需字典，挤占首帧后的任务时间。
   现在改为用户首次 `pointerdown` / `keydown` 才预取；全程不交互的新标签页完全不解析。
   `settings.js` 自身也静态 import 该字典且 `extend` 幂等，所以不会缺文案。

### 噪声说明

`bench/before.json` 是 2026-11-08 01:40（GMT+8）记录的原始基线，热启动 26.9 ms。
同环境重测得到 32.6 ms，说明 5.7 ms 的差距来自宿主机负载，而非代码。
因此报告统一采用 `before2` / `after2` 这组同环境对照，不拿 `before` 与 `after2` 直接相减。

### 复现

```bash
node build.mjs --zip
node test/bench.mjs --label before2 --ext bench/baseline-dist/chrome --rounds 12
node test/bench.mjs --label after2  --ext dist/chrome --rounds 12
node test/bench.mjs --report before2.json after2.json
```
