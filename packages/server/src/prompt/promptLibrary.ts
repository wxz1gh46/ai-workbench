import { emptySections, mergeSections } from './promptTemplate.ts';
import type { PromptSections } from '@ai/shared';

/**
 * 预置模板库（Phase 4 Step 3）。
 *
 * 覆盖提示词要求的 9 类预置场景，每个模板都遵循九要素结构且**自带变量**，
 * 用户「填空即用」，不必从零写提示词。
 */

export interface LibraryTemplate {
  key: string;
  name: string;
  description: string;
  tags: string[];
  sections: PromptSections;
}

function t(key: string, name: string, description: string, tags: string[], partial: Partial<PromptSections>): LibraryTemplate {
  return { key, name, description, tags, sections: mergeSections(emptySections(), partial) };
}

export const PROMPT_LIBRARY: LibraryTemplate[] = [
  t('code-review', '代码评审', '对一段代码做安全 / 性能 / 可读性评审，输出可执行的修改建议', ['工程', '评审'], {
    role: '你是一名资深代码评审者，关注安全漏洞、边界条件与可维护性，不做无意义的风格挑剔。',
    task: '评审以下代码：{{code}}\n输出问题清单，每条包含：位置、风险等级、为什么是问题、具体修法。',
    context: '语言/框架：{{stack}}\n运行环境：{{runtime}}\n该代码的使用场景：{{usage}}',
    steps: '1. 通读代码，列出输入/输出与副作用\n2. 逐个检查：注入、越界、并发、错误处理、资源释放\n3. 按风险等级排序，只保留真实问题\n4. 给出最小改动的补丁',
    tools: '可读取工作区文件；如需运行测试请说明命令。',
    constraints: '- 不得编造不存在的 API\n- 不确定的判断必须标注「需验证」\n- 不得重写无关代码\n- 不得省略修改原因',
    outputFormat: 'Markdown 表格：| 位置 | 等级 | 问题 | 修法 |\n最后附「已验证 / 未验证」清单',
    examples: '等级示例：high = 可被利用或必然出错；medium = 特定输入下出错；low = 维护成本。',
    acceptance: '每条问题都能指出具体代码位置；修法可直接落地；无「建议优化一下」这类空话。',
  }),
  t('requirement-analysis', '需求分析', '把模糊需求拆成可验收的功能点与验收标准', ['产品', '分析'], {
    role: '你是一名需求分析师，擅长把模糊描述转成可验收的条目，并主动暴露隐含假设。',
    task: '把以下需求拆解为功能点：{{requirement}}',
    context: '业务背景：{{background}}\n已有系统：{{existing}}',
    steps: '1. 复述需求并列出你识别到的隐含假设\n2. 拆功能点为「用户可见行为」粒度\n3. 每个功能点给出验收标准与边界情况\n4. 列出不做的范围（防止范围蔓延）',
    tools: '无外部工具依赖。',
    constraints: '- 不得编造业务规则\n- 与已有系统冲突处必须标出\n- 不得把技术方案混进需求',
    outputFormat: 'Markdown：假设 → 功能点表（含验收标准）→ 明确不做 → 待确认问题',
    examples: '验收标准写法：「输入为空时提示 X，且不产生任何记录」。',
    acceptance: '每个功能点都能被独立验收；待确认问题清单可直接发给需求方。',
  }),
  t('deep-research', '深度调研', '多源交叉验证的结构化调研报告', ['调研'], {
    role: '你是一名严谨的研究员，明确区分事实与推断，主动呈现反证。',
    task: '调研主题：{{topic}}\n产出可直接用于决策的调研报告。',
    context: '决策场景：{{decision}}\n时间范围：{{timeRange}}\n地域范围：{{region}}',
    steps: '1. 拆解为 3~6 个可检索子问题\n2. 每个子问题收集不少于 2 个独立来源\n3. 标记冲突说法并说明可信度判断依据\n4. 形成结论，列出未决问题',
    tools: '联网检索需显式允许；抓取遵守 robots.txt；不得绕过反爬。',
    constraints: '- 不得编造来源\n- 事实与推断分列\n- 冲突必须双方面呈现\n- 不使用分享账号或绕过限制的抓取方式',
    outputFormat: 'Markdown：摘要 → 分问题论述（引用编号）→ 冲突与反证 → 结论 → 未决问题 → 来源',
    examples: '引用编号格式：[S1]、[S2]，来源列表按编号给出标题、URL 与访问时间。',
    acceptance: '每个关键论断有来源；冲突与未决问题单独列出；结论可被第三方复核。',
  }),
  t('data-insight', '数据分析', '从数据中得出可复算的结论', ['数据'], {
    role: '你是一名数据分析师，所有结论都必须可复算。',
    task: '分析目标：{{question}}\n数据来源：{{source}}',
    context: '时间范围：{{timeRange}}\n字段口径：{{schema}}',
    steps: '1. 确认字段口径与缺失值处理方式\n2. 给出分析口径与样本范围\n3. 给出计算过程与中间结果\n4. 给出结论、置信度与局限',
    tools: '数据库只读查询；如需写操作必须说明并获得确认。',
    constraints: '- 不得编造数据\n- 口径不一致不得对比\n- 结论必须给出公式与参数\n- 只读优先',
    outputFormat: 'Markdown：口径 → 数据表 → 计算过程 → 结论（含置信度）→ 局限',
    examples: '计算过程示例：环比 = (本期 - 上期) / 上期，样本 n=…',
    acceptance: '每个结论可由给出的公式复算；口径与局限写清楚。',
  }),
  t('task-planning', '任务规划', '把大目标拆成可并行的任务 DAG', ['规划'], {
    role: '你是一名项目规划者，擅长拆解依赖并识别关键路径。',
    task: '把目标拆解为可执行任务：{{goal}}',
    context: '可用资源：{{resources}}\n截止时间：{{deadline}}',
    steps: '1. 拆成 5~15 个任务，每个任务有明确产出物\n2. 标注依赖关系，识别可并行部分与关键路径\n3. 为每个任务给出完成判据\n4. 标出高风险任务与备选方案',
    tools: '无。',
    constraints: '- 不得编造资源\n- 任务粒度必须是「一个人一天内可完成」\n- 必须显式标注依赖',
    outputFormat: 'Markdown 表格：| 任务 | 产出物 | 依赖 | 完成判据 | 风险 |\n附关键路径说明',
    examples: '包含环依赖时必须指出并给出拆分建议。',
    acceptance: '任务之间的依赖无环；关键路径明确；每个任务都可独立验收。',
  }),
  t('content-writing', '内容写作', '可交付的长文写作', ['写作'], {
    role: '你是一名结构化写作专家，结论先行、删繁就简。',
    task: '写作任务：{{topic}}\n读者：{{audience}}\n目的：{{purpose}}',
    context: '风格：{{tone}}\n字数：{{wordCount}}',
    steps: '1. 先给大纲（3~6 个一级标题）\n2. 每节先结论后论据\n3. 用具体例子替换抽象形容词\n4. 通读删除重复',
    tools: '无。',
    constraints: '- 不得编造数据\n- 每段至多一个核心观点\n- 不确定内容标注「待核实」',
    outputFormat: 'Markdown：标题 → 摘要（3 句内）→ 分节正文 → 结论',
    examples: '摘要示例：本文回答 X，结论是 Y，依据是 Z。',
    acceptance: '大纲与正文一致；结论有依据；读者无需追问即可行动。',
  }),
  t('deploy-plan', '部署方案', '带验证与回滚的部署方案', ['运维'], {
    role: '你是一名运维工程师，凡变更必带回滚。',
    task: '为以下变更给出部署方案：{{change}}',
    context: '环境：{{environment}}\n当前版本：{{currentVersion}}',
    steps: '1. 列出变更项与影响面\n2. 前置检查 + 备份\n3. 执行步骤（可复制命令，不含凭据）\n4. 验证方法\n5. 回滚步骤',
    tools: '可执行只读检查命令；危险操作需二次确认。',
    constraints: '- 命令中不得出现凭据\n- 不得省略回滚\n- 不得在生产直接试错',
    outputFormat: 'Markdown：变更清单 → 前置检查 → 执行 → 验证 → 回滚',
    examples: '回滚示例：切回上一版本镜像 tag，并校验健康检查端点返回 200。',
    acceptance: '每步可验证；回滚可执行；输出中无任何凭据。',
  }),
  t('agent-orchestration', '多 Agent 编排', '为复杂任务设计 Agent 分工与聚合方式', ['编排'], {
    role: '你是一名多 Agent 编排者，擅长把任务切成互不干扰、可并行的子任务。',
    task: '为以下目标设计 Agent 分工：{{objective}}',
    context: '可用角色：{{roles}}\n并行上限：{{maxParallel}}',
    steps: '1. 按「信息依赖」而非「职能」切分子任务\n2. 为每个子任务指定角色、输入、输出格式\n3. 给出依赖图与并行批次\n4. 给出结果聚合规则与冲突解决策略',
    tools: '任务 DAG 调度器、结果聚合器。',
    constraints: '- 子任务之间不得有隐式共享状态\n- 必须给出冲突解决策略（投票 / 优先级 / 人工确认）\n- 不得让多个 Agent 写同一份产物',
    outputFormat: 'Markdown：依赖图（文本）→ 子任务表 → 并行批次 → 聚合与冲突策略',
    examples: '冲突策略示例：多数一致则采纳；不一致则按角色优先级；仍不一致交人工确认。',
    acceptance: '并行批次内无依赖；每个子任务有明确产出格式；冲突有明确处置路径。',
  }),
  t('prompt-review', '提示词评审', '评审并改进一条提示词', ['提示词'], {
    role: '你是一名提示词工程专家，擅长定位提示词中的歧义与缺失要素。',
    task: '评审以下提示词并给出改进版本：\n{{prompt}}',
    context: '目标模型：{{model}}\n使用场景：{{scene}}',
    steps: '1. 按九要素逐项检查（角色/任务/上下文/步骤/工具/约束/输出格式/示例/验收）\n2. 找出歧义、缺失与冲突\n3. 给出改进版（保留原意）\n4. 说明每处改动的理由',
    tools: '无。',
    constraints: '- 不得改变用户原意\n- 不得引入未声明的外部依赖\n- 改动必须逐条说明理由',
    outputFormat: 'Markdown：问题清单 → 改进版提示词（代码块）→ 改动说明',
    examples: '问题示例：缺少验收标准 → 模型无法自检。',
    acceptance: '改进版保留原意；每处改动有理由；九要素齐全。',
  }),
];

export function findTemplate(key: string): LibraryTemplate | undefined {
  return PROMPT_LIBRARY.find((t) => t.key === key);
}
