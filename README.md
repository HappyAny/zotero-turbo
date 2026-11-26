# Zotero Turbo

**Zotero 一体化原生性能加速套件（v0.15.0）**（适用于 Zotero 7–10）——以**单个统一的 MuPDF 1.28.0 原生 C 动态库**，集成完整 `zotero-mupdf-engine` 渲染引擎与全部 6 大周边性能加速器。

## 7 大核心模块（单 DLL 统一驱动，均支持在设置面板独立开关）

1. **⚡ MuPDF 1.28.0 原生 PDF 渲染引擎 & 4K 120Hz 节奏感知自适应 HiDPI**（原 `zotero-mupdf-engine` 完整合入，**纯文献库 0 常驻按需秒启 + 关完自动休眠**）
   - 进程内无锁多线程 `ChromeWorker + js-ctypes` 光栅化（页面 + 侧栏缩略图离主线程 `OffscreenCanvas.convertToBlob` 异步编码 + **16ms 帧合并批刷**），全 DLL 统一 `FZ_LOCK_FREETYPE` 线程锁，保留 100% 原生高亮、批注、选字、护眼/暗色主题与第三方插件兼容；未打开 PDF 时零常驻 Worker，首次打开 PDF 瞬间并行拉起，关闭全部 PDF 静置 5 分钟自动休眠释放内存。
   - **节奏感知自适应 HiDPI（4K 屏幕默认开启）**：离屏预渲、滚轮翻页、**Ctrl+滚轮连续缩放**与边缘露出（`<35%`）页统一走 **3.6 MP 极速档**；慢翻驻留 **400ms**、快翻驻留 **1200ms**、缩放停稳 **250ms**（或在页面内点击/选字 **0ms 立即**）后，离屏渲染**无限制原生像素**并原子无闪烁替换主视图画布（自动迁移 `structTreeLayer`）；滑出视口的旧满像素页即时/600ms 后自动降级回收显存，配合 `ZOT_RENDER_FLAG_NO_BG_PRERENDER` 与 `32 MB` 复用上限确保 4K 显存/内存始终轻盈。
   - 4K 长文档 CSS 布局隔离（`contain: layout style`）与滚动期零 `mix-blend-mode` 重绘、滚动静置文本层延迟、`PDFView._updateViewStats` 滚动节流；256 项 L1 查表暗色/护眼 LUT、Skia 软件画布 120Hz 自适应 `rAF` 离屏分帧绘制、阅读器工具栏状态胶囊（**实时显示自适应 HiDPI 当前档位/升级与显存回收次数**、脏检查免冗余 DOM 写入、左键切换引擎、右键一键深度释放内存/休眠后台标签/直达设置）。
2. **📄 PDF 全文、拖入识别、批注检测、Ctrl+F 搜索、大纲 & Worker 内存治理**（共用同一 MuPDF DLL，**弹性 0↔1↔3 按需 Worker 池（突发空闲 60s 回收、全静置 5min 休眠至 0）** + 零循环 C++ 字符串解码）
   - **原生全文提取**：替换 `Zotero.PDFWorker.getFullText`，单篇/重建索引提速 **9–30×**。
   - **批量建索引并发流水线**：拦截 `Zotero.Fulltext.indexItems`，3 路原生 MuPDF 滑动窗口提前预取，批量导入/重建整库索引再快 **2–3×**。
   - **拖入 PDF 元数据识别 & 嵌入式批注秒测**：原生接管 `Zotero.PDFWorker.getRecognizerData` 与 `Zotero.PDFWorker.hasAnnotations`（`< 0.5 ms`）。
   - **阅读器文本层 & Ctrl+F 全书并行搜索**：原生加速 `getPageData`（单页降至 **1–5 ms**，内置零分配 ASCII/变音符快路径）；自动识别 `Ctrl+F` 顺序扫页并启动 **3 线程 +6 页前瞻预取**，且不唤醒 PDF.js Worker 爆内存；可见页/旋转页/扫描页自动无缝校验或回退。
   - **秒开侧栏文档大纲**：原生 `fz_load_outline` 接管 `getOutline2`（**< 0.5 ms**），无内嵌书签时自动回退 Zotero 智能标题识别。
   - **引用弹窗安全保护 & 滚动期零抢占**：默认完整保留 100% 文内引用弹窗，冷启动 45s 宽限期延迟 12s、常规延迟 1.5s，并**感知滚轮活动自动延后至停止滚动 1.5s 后执行**（绝不在翻页中途唤醒重型 PDF.js Worker），扫描完成后自动调用 `pdfDocument.cleanup(true)` 回收冗余堆内存。
3. **💤 智能后台标签页休眠器 & 原生直达文库启动**
   - **零劫持原生直达文库页**：开启后所有已打开的 PDF 标签页 100% 原样保留，但通过规范化 `session.json` 让每次启动**从第 0 毫秒原生落点在「我的文库」**（启动期绝不抢夺用户主动点开的 PDF 焦点），同时自动休眠未活跃的恢复后台 PDF 标签，冷启动极速丝滑。
   - 替换 Zotero 默认「24 小时空闲 / 5 标签上限」，改为可配置的 **2 标签驻留 + 10 分钟空闲自动休眠**，并响应系统 `memory-pressure`；后台标签休眠或切后台时联动裁剪离屏画布与驱逐 MuPDF 缓存，支持标签栏右键「休眠此标签页 / 休眠其他标签页」、`💤` 视觉提示，以及窗口最小化/切后台静置自动轻度瘦身。
4. **🔍 原生多线程全文扫描 & 搜索缓存**
   - 用多线程 C BMH 扫描器替换 `Zotero.FullText.findTextInItems` 串行 JS 扫描，短语/CJK/回退全文检索提速 **10–30×**。
   - 为 `Zotero.Search` 增加 64 项 LRU 缓存（感知 `recursiveCollections` 偏好），条目/分类/标签变更时通过 `Zotero.Notifier` 自动实时失效。
5. **📚 引文格式化 & Word 长文档刷新加速**
   - 为 `Zotero.Cite.System.prototype.retrieveItem` 增加深拷贝隔离的 4096 项 CSL-JSON LRU 缓存与期刊缩写缓存（实测 **3×**）。
   - 内置 Zotero 10 原生实验性 Rust `citeproc-rs` (WASM) 引擎一键开关，不兼容自定义样式自动回退 `citeproc-js`。
6. **🗄️ SQLite / FTS5 调优、🖼️ 笔记图片 WebP 瘦身 & 🩺 只读健康体检**
   - 将 SQLite 页缓存从 8 MB 提至 64 MB，启用 `temp_store=MEMORY` 与 `mmap_size=256 MB`（同步调优 `fulltext.sqlite`），启动期跳过诊断查询并将 `PRAGMA optimize` 延迟至 180s 后，支持一键「优化 SQLite & FTS5」与一键原子安全 `VACUUM` 紧缩。
   - 拦截新粘贴/导入的 PNG/BMP 笔记截图自动转 WebP，并内置「**先只读扫描 → 手动确认**」的历史笔记 PNG 批量转 WebP 瘦身工具（按 Zotero 原生事务保存，100% 兼容云/WebDAV 同步）。
   - 内置**只读数据目录 & 第三方插件健康体检**：一键扫描数据目录超大/孤儿 `.sqlite`、WAL 膨胀与已安装插件 XPI 体积排行，并提供「打开数据目录」入口；升级插件时自动清理旧版本残留 DLL 目录。
7. **🖱️ 主界面 120Hz 交互流畅度 & 双树虚拟滚动优化**
   - **连续快速切文献合并防抖**（`ZoteroPane.itemSelected`）：单击文献 0 延迟秒开，长按方向键或快速连点浏览时自动合并中间冗余的右侧栏与第三方插件重绘，仅渲染最终停住的条目。
   - **文献列表 + 左侧分类树双树虚拟滚动预渲调优 & 面板布局隔离**：同时提升 `itemsView` 与 `collectionsView` 的 `overscanCount`（默认 `6` 行），并为三栏主面板注入轻量 `contain: layout style` 布局隔离，显著缓解 120Hz 高刷屏快速滚轮下的掉帧与白块闪烁。

## 本地构建与验证

```bash
node scripts/build.mjs
node scripts/verify-plugin.mjs
```

## 开源协议

GNU AGPL-3.0（与上游 MuPDF 保持一致）。
