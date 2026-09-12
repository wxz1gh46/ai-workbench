# 更新日志

本项目的所有重要变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- **Phase 4 生态与集群**：实验性多节点集群、精选插件（MCP 优先）、付费数据库接入、AI 提示词工程、企业安全与审计。

---

## [0.1.0] - 2026-09-12

首个可运行版本，覆盖 Phase 1 ~ Phase 3。

### Added — Phase 1：MVP 骨架

- Tauri 2 + React + Vite 桌面壳，左侧导航九大页面
- 基础聊天：多轮对话、消息持久化
- 模型接入：OpenAI 兼容协议，支持本地模型与中转网关；未配置密钥时进入离线兜底模式
- SQLite + Drizzle ORM，自研迁移执行器（幂等 + 可回滚）
- 文件上传与版本历史（同路径自动递增版本）
- 基础 Agent：任务执行、工具调用、运行追踪
- 基础设置：工作区配置、模型配置

### Added — Phase 2：核心能力

- **百万 Token 分层上下文**：六分区 Token 预算、滚动摘要、事实抽取、向量 + 关键词混合召回、溯源
- **目标模式**：目标即验收标准，`Planner → TaskQueue(DAG) → Executor → Critic` 闭环编排，支持反思与停滞检测
- **多 Agent 并行与实验性集群**：任务 DAG 纯函数调度（ready/blocked/环检测/进度）、Agent 节点图、任务看板
- **Office 文件处理**：docx/xlsx/pptx/pdf 解析、OOXML 原地编辑、生成、LibreOffice 可选转换、zip 零依赖读写
- **深度研究**：robots.txt 合规、限流抓取、论断级多源交叉验证、引用一致性校验、Mermaid 图表、结构化报告

### Added — Phase 3：交付与自动化

- **网站生成与一键部署**：自然语言 → 页面 + 后端 API + 数据库 Schema；支持 Vercel / Cloudflare Pages / Netlify / 本地预览
- **自定义域名与访问控制**：DNS 记录指引、HTTPS 状态、口令（scrypt）/ 邮箱白名单 / IP 白名单
- **加密环境变量管理**：AES-256-GCM 存储，部署时注入，日志无明文
- **部署日志与回滚**：WS 实时流式日志、落库回放、回滚到历史部署（可追溯 `rollbackOf`）
- **Neon / Supabase 数据库接入**：连接测试、Schema 生成、版本化迁移（可回滚）、只读查询、备份
- **定制化看板**：自然语言建 7 类小组件、拖拽布局、布局回滚、固定到桌面、实时刷新
- **定时任务**：Cron（含时区）/ 周期 / 一次性 + 6 类任务 + 模板 + 日志 + 指数退避重试
- **推送通知**：桌面 / 邮件 / Webhook / 飞书 / 钉钉 / 企业微信 + 发送日志 + 重试

### Security

- 密钥零硬编码：仅从环境变量 / OS Keychain 读取
- 危险操作服务端强制二次确认（`428 CONFIRM_REQUIRED`），14 类危险动作全覆盖
- 只读优先的数据库访问：静态 SQL 校验 + `BEGIN READ ONLY` + 强制 LIMIT
- 文件工具路径穿越防护
- 生成产物密钥形态扫描（命中常见凭据模式直接拒绝写入）
- 分域审计日志，`detail` 自动脱敏
- 插件 manifest 合规红线校验（拒绝绕过反爬 / 共享账号 / 破解授权）

### Tests

- 438 个服务端测试用例 + 4 个桌面端用例，全部通过
- 覆盖单元、集成、端到端、安全、性能

### Documentation

- `docs/architecture.md`、`docs/phase2-*.md`、`docs/phase3-*.md`
- `DECISIONS.md` 架构决策记录（含真实缺陷复盘）

---

[Unreleased]: https://github.com/wxz1gh46/ai-workbench/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wxz1gh46/ai-workbench/releases/tag/v0.1.0
