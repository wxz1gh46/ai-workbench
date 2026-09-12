# 提示词工程文档

> 目标读者：想系统化管理提示词的开发者与内容团队。

## 1. 九要素结构

每条提示词由 9 个章节构成（Phase 1 已定义，Phase 4 补全工具链）：

| 章节 | 权重 | 写什么 | 常见错误 |
| --- | --- | --- | --- |
| `role` | 15 | 身份 + 专业边界 | 「你是一个 helpful assistant」（等于没写） |
| `task` | 25 | 输入是什么、要产出什么 | 「优化一下」（无法验收） |
| `context` | 5 | 背景、边界条件 | 把技术方案混进背景 |
| `steps` | 15 | 编号执行步骤 | 一段流水话，无法逐步校验 |
| `tools` | 2 | 可用工具与调用约定 | 列了工具但没说什么时候用 |
| `constraints` | 15 | 硬约束（不编造/不硬编码密钥/来源可追溯） | 只写「注意准确」 |
| `outputFormat` | 10 | 输出格式（含字段名） | 「输出 JSON」但没给字段 |
| `examples` | 3 | 输入输出锚点示例 | 示例与要求不一致 |
| `acceptance` | 10 | 可核查的验收标准 | 「质量高一些」 |

质量评分（`scoreSections`，0~100）按上述权重加权，并考虑内容长度（写 3 个字和写 3 句话效果差很多）。

## 2. 变量与占位符

语法：`{{变量名}}`（字母或下划线开头，后接字母数字下划线）。

```text
## 任务
调研 {{topic}} 在 {{timeRange}} 的市场格局，覆盖 {{region}}。
```

- `extractVariables()` 按出现顺序去重提取
- `inferVariableSpec()` 按名字推断类型：含 `count/limit/数量` → `number`；`is/has/enable/是否` → `boolean`；其余 `string`
- 未填的变量**保留占位**（渲染成 `{{topic}}`），不会变成空串 —— 用户能一眼看出哪没填
- `renderWithCheck()` 返回 `{ ok, missing, unknown, rendered }`：
  - `missing`：必填但未提供且无默认值的变量
  - `unknown`：传了模板里不存在的变量（通常是调用方拼错了）

## 3. 生成器（`promptGenerator.ts`）

从一句话目标生成九要素骨架。**规则引擎负责骨架，模型负责润色**：

| 意图 | 触发词 | 模板特点 |
| --- | --- | --- |
| `code` | 代码/实现/函数/接口/重构/缓存/算法/测试 | 最小实现 + 边界分支 + 验证命令 |
| `document` | 文档/报告/方案/总结/写作 | 结论先行 + 分节 + 删空话 |
| `data-analysis` | 数据/分析/指标/统计/趋势 | 口径说明 + 可复算公式 |
| `research` | 调研/研究/文献/竞品/市场 | 多源交叉验证 + 冲突呈现 |
| `deploy` | 部署/上线/发布/运维 | 变更清单 + 验证 + 回滚 |
| `general` | 其余 | 理解确认 + 计划 + 自检 |

**无模型密钥时仍然可用**（`degraded: true`），`notes` 会说明「使用内置规则模板」。

## 4. 优化器（`promptOptimizer.ts`）

优化维度覆盖提示词要求：消除歧义 · 补全约束 · 结构化 · 边界条件 · 失败处理 · 评估标准。

### 歧义检测（只提示，不擅自改写用户意图）

| 模式 | 提示 |
| --- | --- |
| `尽量/可能/也许/大概/差不多` | 无法验收，改成可量化表述 |
| `等等/之类的/什么的` | 开放式结尾，模型无法判断范围 |
| `好一点/优化一下/改好` | 目标不可测量 |
| `随便/你看着办/都行` | 结果不可控，建议给锚点示例 |

### 自动补全

- 缺 `role` → 补「你是一名严谨的领域专家，只对你确认过的事实负责。」
- 缺 `outputFormat` → 补「Markdown（含小标题、要点列表与结论段）」
- 缺 `acceptance` → 补「输出必须可被第三方复核 —— 结论、证据、计算过程三者齐全。」
- 缺硬约束 → 补「不得编造事实 / 不得硬编码密钥 / 来源可追溯」（不重复添加已有项）
- 缺边界条件 → 补「空输入、超长输入、非法格式、超大数量、并发冲突时给出可读错误」
- 缺失败处理 → 补「明确说明缺什么、尝试过什么，并给出下一步建议；不要返回空内容」
- `steps` 非编号 → 规范化为 `1. / 2. / 3.`（模型对编号列表遵循度显著更高）

### 模型增强的兜底

模型返回的 JSON 里**空章节自动用规则结果补齐**：
否则「优化完反而变差」（模型漏写了一节，优化后的提示词就缺了那一节）。

## 5. 预置模板库（`promptLibrary.ts`）

9 个模板，每个都自带变量：

| key | 名称 | 变量示例 |
| --- | --- | --- |
| `code-review` | 代码评审 | `code`, `stack`, `runtime`, `usage` |
| `requirement-analysis` | 需求分析 | `requirement`, `background`, `existing` |
| `deep-research` | 深度调研 | `topic`, `decision`, `timeRange`, `region` |
| `data-insight` | 数据分析 | `question`, `source`, `timeRange`, `schema` |
| `task-planning` | 任务规划 | `goal`, `resources`, `deadline` |
| `content-writing` | 内容写作 | `topic`, `audience`, `purpose`, `tone`, `wordCount` |
| `deploy-plan` | 部署方案 | `change`, `environment`, `currentVersion` |
| `agent-orchestration` | 多 Agent 编排 | `objective`, `roles`, `maxParallel` |
| `prompt-review` | 提示词评审 | `prompt`, `model`, `scene` |

「使用」= 创建到工作区（同名则新增版本，不覆盖用户改过的内容）。

## 6. 版本管理

- 每次保存 → 新版本（`version` 递增，`parentId` 指向上一版）
- 同名模板在列表里只显示为一条，带 `versions: [1,2,3]`
- `GET /prompts/v4/:name?version=N` 可看任意历史版本
- **回滚 = 生成新版本**（v3 = v1 的内容），历史全部保留 —— 回滚本身也可追溯
- `createdBy` 记录来源：`user` / `library` / `rollback:v2`

## 7. A/B 测试与效果评估

### 指标设计

| 类别 | 指标 | 范围 | 说明 |
| --- | --- | --- | --- |
| 人工 | `accuracy` / `clarity` / `usefulness` | 1~5 | 需要人看结果打分 |
| 自动 | `structure` | 0~5 | 九要素覆盖率 |
| 自动 | `length` | 0~5 | 长度合理性（偏离理想长度扣分） |
| 自动 | `variableCoverage` | 0~5 | 变量覆盖率 |

综合分 = 人工均值 × **0.75** + 自动均值 × **0.25**。
最终看的是「有没有用」，不是「工整不工整」。

`POST /prompts/abtests/:id/auto-evaluate` 一键跑三项自动指标，不需要人工输入。

### 胜负判定（`decide`）

| 情况 | 结果 |
| --- | --- |
| 双方都无人工评分 | 按自动指标判定，但 `reason` 明确写「建议补充人工评分后再定稿」 |
| 人工样本 < 2 | 给出暂时领先者，`reason` 写「样本不足，结论仅供参考」 |
| 分差 < 0.15 | `winner: null`，说明「差异不显著，建议保持现状或继续采样」 |
| 双方人工评分相同且无自动指标 | `winner: null` |
| 其他 | 综合分高者胜，`reason` 写出 A/B 分值 |

**为什么这么设计**：样本不足时给出「确定赢家」，用户会按噪声做决策。
宁可不给结论，也不能给错误结论。

### 服务端强校验

- 人工指标 1~5，自动指标 0~5，越界 → **400**（避免「评分 100 分」把平均值带偏）
- `sampleSize` 必须是 ≥1 的整数
- 测试已结束（`finished`）后不能继续评分 → **409**

## 8. 一键复制

`POST /prompts/copy` 服务端渲染，返回可直接粘贴的 Markdown：

```markdown
# 调研提示词

<!-- 由 AI 工作台·提示词工作台生成；未填写的变量保留为 {{var}} -->

## 角色
...

## 任务
分析 {{unknown}} 的 ...
```

返回 `{ markdown, rendered, missingRequired, unknownVariables, ok }`：
`ok=false` 表示还有必填变量未填（仍会复制，只是明确告知）。

## 9. 端到端示例

```bash
WS=<workspaceId>

# 1) 从模板库创建
curl -X POST "http://127.0.0.1:8787/prompts/library/deep-research" \
  -H 'content-type: application/json' -d "{\"workspaceId\":\"$WS\"}"

# 2) 生成（离线也能用，degraded=true）
curl -X POST http://127.0.0.1:8787/prompts/generate \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"goal\":\"调研 2026 年储能行业政策\"}"

# 3) 优化（返回 issues + score + notes）
curl -X POST http://127.0.0.1:8787/prompts/optimize-v4 \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"current\":{\"task\":\"写点东西，尽量好一点\"}}"

# 4) 保存两个版本
curl -X POST http://127.0.0.1:8787/prompts/v4 -d "{\"workspaceId\":\"$WS\",\"name\":\"调研\",\"sections\":{\"task\":\"v1\"}}"
curl -X POST http://127.0.0.1:8787/prompts/v4 -d "{\"workspaceId\":\"$WS\",\"name\":\"调研\",\"sections\":{\"task\":\"v2\"}}"

# 5) A/B + 自动评估 + 人工评分
AB=$(curl -s -X POST http://127.0.0.1:8787/prompts/v4/abtest \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"templateName\":\"调研\",\"versionA\":1,\"versionB\":2}" | jq -r .data.id)
curl -X POST "http://127.0.0.1:8787/prompts/abtests/$AB/auto-evaluate?workspaceId=$WS"
curl -X POST "http://127.0.0.1:8787/prompts/abtests/$AB/evaluate" \
  -d "{\"workspaceId\":\"$WS\",\"version\":\"A\",\"metric\":\"accuracy\",\"value\":4,\"sampleSize\":3}"
curl "http://127.0.0.1:8787/prompts/abtests/$AB?workspaceId=$WS"   # 报告含 winner + reason
```

## 10. 写提示词的实用建议

1. **验收标准先行**：先想「我怎么知道它做对了」，再写任务
2. **约束写死，别写软**：`不得编造事实` 比 `请确保准确` 有效得多
3. **给一个示例胜过三段描述**：`examples` 的权重低但效果高
4. **步骤可独立校验**：每步都能单独判断「这步做完了吗」
5. **失败路径要写**：不写的话模型遇到缺数据就给你编一个
6. **用变量而不是复制粘贴**：同一套逻辑复用到不同主题
