## 变更说明

<!-- 用一两句话说明这个 PR 做了什么、为什么 -->

关联 Issue：<!-- 如 Closes #12 -->

## 变更类型

- [ ] feat 新功能
- [ ] fix 缺陷修复
- [ ] docs 文档
- [ ] test 测试
- [ ] refactor 重构（不改变行为）
- [ ] chore 构建 / 工具链

## 影响范围

- [ ] `packages/shared`
- [ ] `packages/server`
- [ ] `packages/desktop`
- [ ] 数据库迁移
- [ ] CI / 工具链
- [ ] 仅文档

## 检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 未破坏 Phase 1 / 2 / 3 既有功能
- [ ] 未硬编码任何密钥、Token、凭据
- [ ] 新增外部调用已写审计日志
- [ ] 危险操作已做二次确认
- [ ] 涉及数据库时，已同时提供 `.sql` 与 `.down.sql`
- [ ] 已更新 `CHANGELOG.md`（用户可见变更）
- [ ] 已更新相关 `docs/`（行为或接口变化）

## 回滚方案

<!-- 说明如何回滚：功能开关名 / revert 该提交 / 执行哪个 down 脚本 -->
