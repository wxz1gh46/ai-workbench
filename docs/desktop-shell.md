# 桌面版壳层（Desktop Shell）

> 把 Phase 1~4 的全部能力收进一个桌面应用该有的壳里：侧边栏 + 多标签工作区 + 命令面板 + 状态栏。

## 1. 为什么要做这层

Phase 1~4 累积了 17 个功能页。此前的入口是一个**平铺的按钮列表**，问题有三个：

1. **找不到**：17 个入口一长条排在左边，没有分组、没有搜索，用户只能靠眼力扫。
2. **回不去**：没有标签栏，从「部署中心」跳到「定时任务」再回部署中心，得重新点一次，跨页对比日志根本没法做。
3. **不像桌面软件**：没有 `Ctrl/Cmd+K`、没有状态栏、没有可折叠导航 —— 用起来像网页，不像装在本机的工具。

另外导航与页面是**手写 if/else 链**，加页面要改 `App.tsx` 的两个地方（TABS 数组 + 渲染分支），漏改就出现「侧边栏有入口、点了空白」。

## 2. 分层结构

```
nav/nav-config.ts          ← 功能清单（唯一数据源）
  ├─ NAV_ITEMS             17 个功能：key/label/icon/group/keywords/summary
  ├─ navItemsByGroup()     按「工作台 / 智能体 / 交付与自动化 / 生态与集群 / 系统」分组
  └─ searchNav()           命令面板的模糊匹配（标签 > 关键词 > 分组 > 说明）

pages/registry/index.tsx   ← 功能 → 页面组件，显式 Record<TabKey, ComponentType>

components/shell/
  ├─ Sidebar.tsx           可折叠分组 + 展开(240px)/窄栏(56px) 两种形态
  ├─ TabBar.tsx            多标签工作区（渲染）
  ├─ tab-state.ts          标签纯逻辑（openTab / removeTab / nextActiveAfterClose / cycleTab）
  ├─ CommandPalette.tsx    Ctrl/Cmd+K 命令面板
  ├─ StatusBar.tsx         底部状态栏：连接 / 降级 / Agent 数 / 工作区 / 当前功能
  ├─ PageHeader.tsx        统一页头：功能名 + 用途说明 + 右侧动作
  └─ use-shell.ts          壳层状态（标签、侧边栏、最近使用），localStorage 持久化

App.tsx                    ← 只负责组装
```

**关键约束**：`PAGES` 是 `Record<TabKey, ComponentType>` 而不是 `Record<string, ...>`。
少写一个页面 TS 直接编译报错，从类型层面消灭「入口点了没反应」。

## 3. 桌面手感清单

| 能力 | 快捷键 | 说明 |
| --- | --- | --- |
| 命令面板 | `Ctrl/Cmd + K` | 中英文/关键词模糊搜索，↑↓ 选择，Enter 打开，Esc 关闭 |
| 关闭当前标签 | `Ctrl/Cmd + W` | 关闭后自动激活右邻居，没有右侧则左邻居 |
| 标签轮换 | `Ctrl/Cmd + Tab` | `Shift` 反向 |
| 直选第 N 个标签 | `Ctrl/Cmd + 1..9` | 对齐浏览器习惯 |
| 中键关闭标签 | 鼠标中键 | 对齐浏览器习惯 |
| 侧边栏收/放 | 点击标题栏图标 | 窄栏形态只留图标 + tooltip，小屏多出 180px 正文宽 |

**状态全部持久化**（`localStorage`）：已打开的标签、当前标签、侧边栏形态、分组折叠状态、最近使用 5 项。
重开应用回到上次的现场，而不是每次都从默认页开始。

## 4. 视觉语言

沿用已有的深色 token（`--bg / --panel / --border / --fg / --muted / --brand`），色值**未改动**，
保证与 Phase 2/3/4 已交付页面（`WidgetCard`、`DeployLogView` 等）视觉一致。

层级色差：

- 侧边栏 / 页头 / 状态栏 = `panel`（比正文亮一档，形成"外壳"感）
- 正文区 = `bg`（最深，内容最突出）
- 激活项 = `brand/15~20` 底色 + `brand` 图标
- 危险提示统一 `rose`，警告统一 `amber`，与既有 `Badge` tone 对齐

## 5. 测试

`packages/desktop/src/nav/nav-config.test.ts` —— **功能集合的守门测试**：

- 17 个能力标签逐个断言存在（防止功能悄悄从导航消失：**用户看不到入口 = 功能不存在**）
- key 唯一、可索引、必须有分组/图标/关键词/说明（不留半成品）
- 分组视图不丢项、不出空分组
- 命令面板：空查询有推荐且不超上限；中文名/英文名/关键词都能命中；标签命中优先于说明；无匹配返回空数组

`packages/desktop/src/components/shell/tab-state.test.ts` —— 标签栏纯逻辑：

- 重复打开不产生重复标签
- 关闭当前标签优先右邻居、末尾回退左邻居
- 关掉最后一个标签保留兜底页（不留空白工作区）
- 关闭非当前标签不影响当前标签
- `cycleTab` 正反向环绕、单标签原地不动

纯逻辑刻意抽到 `.ts`（而非留在 `.tsx`）：`node --test` 不能直接加载 `.tsx`，
混在一起会让整个测试文件报 `ERR_UNKNOWN_FILE_EXTENSION`。

## 6. 运行

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm --filter @ai/desktop typecheck
pnpm --filter @ai/desktop test
pnpm --filter @ai/desktop build

pnpm dev:server     # 终端 1
pnpm dev:desktop    # 终端 2 → http://localhost:5183
```

## 7. 已下线的简版页面

Phase 1 遗留的 4 个简版页面从导航移除，能力由 Phase 3/4 的正式页面完整承担：

| 下线页面 | 取代者 |
| --- | --- |
| `DashboardPage`（看板·简版） | `DashboardEditorPage`（拖拽布局 + 7 类组件 + 自然语言创建） |
| `SchedulePage`（定时任务·简版） | `ScheduleManagerPage`（cron 解析 + 执行日志 + 退避重试） |
| `PluginsPage`（插件·简版） | `PluginMarketPage`（MCP 市场 + 权限授权 + 调用日志） |
| `PromptPage`（提示词·简版） | `PromptWorkbenchPage`（模板 + 优化 + 版本 + A/B + 评估） |

文件仍保留在仓库中（不删代码、可回滚），只是不再占导航位 —— 避免出现两套入口让用户不知道该点哪个。
