# 商店上架材料

两个商店需要的文案、字段和清单，都是可以直接粘贴的。发布前把 `https://github.com/morangsu/zenith-newtab` 换成实际地址。

产物：

| 平台 | 文件 | 说明 |
|---|---|---|
| Chrome / Edge | `dist/chrome-<version>.zip` | Chrome Web Store、Edge Add-ons 都收这个 |
| Firefox | `dist/firefox-<version>.xpi` | AMO 收 .xpi（本质是 zip） |
| 图标 | `src/icons/icon{16,32,48,96,128}.png` | 由 `node tools/render-icons.mjs` 从 `src/icon.svg` 生成 |
| 截图 | `docs/store/screenshot-*.png` | 1280×800，商店要求的最小尺寸 |

```bash
node build.mjs --zip          # 构建 + 打包 + 输出 sha256
node tools/render-icons.mjs   # 改了图标源文件后重新生成 PNG
```

---

## Chrome Web Store / Edge Add-ons

**名称**（≤45 字符）

```
Zenith 起始页
```

**摘要**（≤132 字符）

```
图标与小组件混排的本地新标签页：时钟、农历、待办、月历，可自由调大小和位置。默认不联网，零数据收集。
```

长度 132 字符上限，上面这段 58 个汉字左右，安全。

**详细描述**

```
Zenith 是一个「安静」的新标签页。没有资讯流，没有推荐位，没有账号，没有统计。

■ 图标和小组件在同一个网格里
网站图标、待办、月历、番茄钟、便签、计算器不是分开的两块区域，而是同一个网格里的平等元素。
可以任意换位置、切尺寸——图标能变成横向长条，组件能占半行或整行。

■ 八个本地小组件
待办 · 纪念日 · 月历（含农历）· 番茄钟 · 便签 · 计算器 · 大写金额 · 单位换算
全部在本地计算，没有一个需要联网。

■ 三档显示模式
普通模式、隐藏搜索栏、极简模式（只留时间和日期，点一下切换）。

■ 字号可调
85%–160%，时钟、搜索框、图标、组件一起缩放，不会出现「字大了图标还是小的」。

■ 深度本地化
农历日期、大写金额（壹仟贰佰叁拾肆元伍角陆分）、中文搜索引擎切换。

■ 不联网也可以同步
同步默认关闭。开启后只传配置，不传图片，发往你自己填的 WebDAV（坚果云 / Nextcloud / 群晖）或私有 GitHub 仓库。
冲突不自动合并——两边都改过时会问你要用哪个。

■ 隐私
不收集任何数据，不埋点，不上报崩溃，不含任何第三方脚本。
页面在构建期就检查过：除了同步内核，任何文件都不允许出现网络请求代码。
壁纸、图标缓存、待办便签全部存在本机，卸载即清除。

主页与说明：https://github.com/morangsu/zenith-newtab
```

**类别**

```
生产力工具
```

**语言**：中文（简体）

**单一用途说明（Single purpose）**

```
把浏览器新标签页替换成一个可自定义的本地起始页：显示时间与农历，并提供图标、小组件和本地搜索。
```

**权限理由（逐项填写）**

| 权限 | 填写内容 |
|---|---|
| `storage` | 保存用户的新标签页配置（布局、主题、字号）与小组件内容（待办、便签），全部为本地数据。 |
| `unlimitedStorage` | 用户上传的壁纸图片与网站图标缓存可能超过 5 MB，需要不限量存储。 |
| `favicon` | 通过浏览器的 `_favicon` 接口读取本地图标缓存，用于在网格中显示网站图标。不发起任何网络请求。 |
| `bookmarks`（可选） | 仅在用户点击「从书签导入」时申请，一次性读取书签列表生成图标，不上传。 |
| 主机权限（可选，`https://*/*`） | 仅在用户配置 WebDAV / GitHub 同步后申请，且用 `permissions.request()` 只申请用户填写的那个域名。用于向用户自己的服务器收发配置文件。 |

**远程代码**

```
否。扩展不加载、不执行任何远程代码，所有脚本都打包在扩展内，CSP 为 script-src 'self'。
```

**数据使用声明**

- 是否收集用户数据：**否**
- 是否向第三方出售/传输数据：**否**
- 是否用于与单一用途无关的目的：**否**

**隐私政策 URL**

需要托管后填写，例如 `https://<你的域名>/zenith/privacy.html`，内容用仓库根目录的 `PRIVACY.md`。

---

## Firefox AMO

**名称**（≤50 字符）

```
Zenith 起始页
```

**摘要**（≤250 字符）

```
图标与小组件混排的本地新标签页。八个本地小组件（待办、月历、番茄钟、便签、计算器等），字号与布局均可调，默认不联网、不收集数据；同步可选，只连你自己填的服务器。
```

**类别**：其他 / 生产力

**标签**：new tab, start page, widgets, productivity, offline

**最低版本**：Firefox 128（`optional_host_permissions` 从 128 开始支持）

**审核备注（Notes to reviewer）**

```
这是无构建步骤的扩展：src/ 下的文件按原样复制到 dist/，构建脚本只做三件事——复制文件、
把 manifests/*.json 序列化到 dist/*/manifest.json、生成含版本号的 js/version.js。
没有压缩、没有混淆、没有 transpile，dist/ 与 src/ 的 JS 内容逐字节相同（可 diff 验证）。

网络访问说明：默认零请求。只有用户在设置里配置 WebDAV 或 GitHub 同步并点击按钮时，
才向用户自己填写的地址发起请求（可选主机权限，按域名申请）。请求由 background 发出，
页面本身没有任何网络 API 调用。

隐私政策：https://github.com/morangsu/zenith-newtab/blob/main/PRIVACY.md
```

**源码提交**：AMO 若要求，直接把仓库 zip 上传（不需要额外构建）。

---

## 上架前检查清单

- [x] 图标 16 / 32 / 48 / 96 / 128（`src/icons/`）
- [x] 128×128 商店图标（用 `icon128.png`）
- [x] 截图 1280×800 ×4（`docs/store/`）
- [x] 隐私政策正文（`PRIVACY.md`）
- [ ] 隐私政策托管成公开 URL
- [ ] 仓库地址填进 `PRIVACY.md` 与本文件
- [ ] `dist/chrome-<v>.zip` 上传 Chrome Web Store
- [ ] `dist/firefox-<v>.xpi` 上传 AMO
- [ ] AMO 填审核备注
- [ ] 记录两个包的 sha256（`dist/*.sha256`），便于用户校验

## 版本号规则

`manifests/*.json` 是唯一真相，`package.json` 与 `js/version.js` 都从它派生（后者由构建生成）。
两个 manifest 的版本必须一致，否则构建会失败。
