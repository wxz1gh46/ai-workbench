import { useCallback, useEffect, useState } from 'react';
import type { NotifyChannel, ScheduleRunRecord, ScheduleTask } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';
import { CronEditor, type CronPreview } from '@/components/phase3/CronEditor';
import { JobHistory } from '@/components/phase3/JobHistory';

const TASK_TYPES = [
  { value: 'goal', label: '目标模式（自主推进目标）' },
  { value: 'research', label: '深度研究（输出报告）' },
  { value: 'office', label: '生成文档（docx/xlsx/pptx/pdf）' },
  { value: 'deploy', label: '部署网站（重新上线）' },
  { value: 'db-query', label: '数据查询（只读 SQL）' },
  { value: 'custom', label: '自定义（仅触发通知/Webhook）' },
];

/**
 * 定时任务管理（Step 7）。
 *
 * 交互要点：
 *   - 支持「模板 → 填空」快速创建，也支持从零配置；
 *   - cron 编辑后立即预览下次执行时间（避免「0 0 * * * 到底几点」的误解）；
 *   - 执行历史带成功率统计、重试次数与错误原文。
 */
export function ScheduleManagerPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);

  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunRecord[]>([]);
  const [stats, setStats] = useState<{ total: number; succeeded: number; failed: number; successRate: number; avgDurationMs: number } | undefined>();
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [templates, setTemplates] = useState<{ name: string; label: string; description: string; taskType: string; suggestedCron: string; placeholders: { key: string; label: string; example: string; required: boolean }[] }[]>([]);
  const [presets, setPresets] = useState<{ label: string; expression: string; note: string }[]>([]);
  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [expression, setExpression] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [taskType, setTaskType] = useState('goal');
  const [templateName, setTemplateName] = useState('');
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [configText, setConfigText] = useState('{\n  "objective": "整理本周工作要点"\n}');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);

  const loadTasks = useCallback(async () => {
    if (!workspace) return;
    const res = await api.listSchedulesV3(workspace.id);
    setTasks(res.schedules);
    setSelected((prev) => prev ?? res.schedules[0]?.id ?? null);
  }, [workspace]);

  useEffect(() => {
    void loadTasks().catch(() => undefined);
    if (!workspace) return;
    void api.listNotifyChannels(workspace.id).then((r) => setChannels(r.channels)).catch(() => undefined);
    void api.scheduleTemplates().then((r) => {
      setTemplates(r.templates as typeof templates);
      setPresets(r.presets);
    }).catch(() => undefined);
  }, [loadTasks, workspace]);

  const loadRuns = useCallback(async () => {
    if (!workspace || !selected) return;
    const res = await api.listScheduleRunsV3(selected, workspace.id);
    setRuns(res.runs);
    setStats(res.stats);
  }, [workspace, selected]);

  useEffect(() => {
    void loadRuns().catch(() => undefined);
  }, [loadRuns]);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!workspace || !name.trim()) {
      pushToast({ level: 'error', message: '请填写任务名称' });
      return;
    }
    await guard(async () => {
      let taskConfig: Record<string, unknown> | undefined;
      if (!templateName) {
        try {
          taskConfig = JSON.parse(configText) as Record<string, unknown>;
        } catch {
          pushToast({ level: 'error', message: '任务参数不是合法 JSON' });
          return;
        }
      }
      const res = await api.createScheduleV3({
        workspaceId: workspace.id,
        name: name.trim(),
        trigger: 'cron',
        expression,
        timezone,
        taskType: templateName ? undefined : taskType,
        taskConfig: templateName ? undefined : taskConfig,
        template: templateName || undefined,
        templateValues: templateName ? templateValues : undefined,
        channelIds: selectedChannels,
      });
      setName('');
      setTemplateName('');
      setTemplateValues({});
      await loadTasks();
      setSelected(res.schedule.id);
      pushToast({ level: 'success', message: `任务已创建，下次执行：${res.schedule.nextRunAt ? new Date(res.schedule.nextRunAt).toLocaleString('zh-CN') : '—'}` });
    });
  }

  if (!workspace) return <Empty>正在加载工作区…</Empty>;
  const current = tasks.find((t) => t.id === selected) ?? null;
  const tpl = templates.find((t) => t.name === templateName);

  return (
    <div className="grid h-full grid-cols-[1fr_1fr_1fr] gap-3">
      <Panel title="新建任务">
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="任务名称，如 每日行业简报"
            className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />

          <select
            value={templateName}
            onChange={(e) => {
              setTemplateName(e.target.value);
              const t = templates.find((x) => x.name === e.target.value);
              if (t) {
                setExpression(t.suggestedCron);
                setTaskType(t.taskType);
              }
            }}
            className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px]"
          >
            <option value="">（不用模板，手动配置）</option>
            {templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label} — {t.description}
              </option>
            ))}
          </select>

          {tpl ? (
            <div className="space-y-1">
              {tpl.placeholders.map((p) => (
                <input
                  key={p.key}
                  value={templateValues[p.key] ?? ''}
                  onChange={(e) => setTemplateValues({ ...templateValues, [p.key]: e.target.value })}
                  placeholder={`${p.label}${p.required ? ' *' : ''}（如 ${p.example}）`}
                  className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
                />
              ))}
            </div>
          ) : (
            <>
              <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px]">
                {TASK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <textarea
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                rows={5}
                className="w-full resize-none rounded border border-border bg-bg p-2 font-mono text-[10px] outline-none focus:border-brand"
              />
            </>
          )}

          <CronEditor
            expression={expression}
            timezone={timezone}
            presetList={presets}
            preview={preview}
            onExpressionChange={setExpression}
            onTimezoneChange={setTimezone}
            onPreview={async (expr, tz) => setPreview(await api.previewCron(expr, tz))}
          />

          <div>
            <div className="mb-1 text-[10px] text-muted">完成后推送到（留空则推送到全部启用渠道）</div>
            <div className="flex flex-wrap gap-1">
              {channels.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedChannels((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                  className={`rounded border px-1.5 py-0.5 text-[10px] ${selectedChannels.includes(c.id) ? 'border-brand bg-brand/15' : 'border-border text-muted'}`}
                >
                  {c.name}
                </button>
              ))}
              {channels.length === 0 && <span className="text-[10px] text-muted">还没有通知渠道（可在「通知设置」中创建）</span>}
            </div>
          </div>

          <Button variant="primary" className="w-full" onClick={() => void create()} disabled={busy}>
            创建任务
          </Button>
        </div>
      </Panel>

      <Panel title={`任务列表（${tasks.length}）`} actions={<Button onClick={() => void loadTasks()}>刷新</Button>}>
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setSelected(t.id)}
                className={`w-full rounded border px-2 py-1.5 text-left text-[11px] ${selected === t.id ? 'border-brand bg-brand/10' : 'border-border hover:border-brand/60'}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate">{t.name}</span>
                  <Badge tone={t.enabled ? 'ok' : 'default'}>{t.enabled ? '启用' : '停用'}</Badge>
                </div>
                <div className="font-mono text-[9px] text-muted">
                  {t.expression} · {t.timezone} · {t.taskType}
                </div>
                <div className="text-[9px] text-muted">
                  {t.nextRunAt ? `下次 ${new Date(t.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : '未安排'}
                </div>
              </button>
            </li>
          ))}
          {tasks.length === 0 && <Empty>还没有定时任务</Empty>}
        </ul>
      </Panel>

      <Panel
        title={current ? `执行历史 · ${current.name}` : '执行历史'}
        actions={
          current && (
            <>
              <Button onClick={() => void loadRuns()}>刷新</Button>
              <Button onClick={() => guard(async () => {
                const r = await api.updateScheduleV3(current.id, workspace.id, { enabled: !current.enabled });
                await loadTasks();
                pushToast({ level: 'success', message: r.schedule.enabled ? '已启用' : '已停用' });
              })} disabled={busy}>
                {current.enabled ? '停用' : '启用'}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  if (!triggerConfirm(`确认立即执行「${current.name}」？\n\n这会触发真实动作（${current.taskType}），并可能产生外部调用费用。`)) return;
                  void guard(async () => {
                    const r = await api.runScheduleNow(current.id, workspace.id);
                    await loadRuns();
                    await loadTasks();
                    pushToast({ level: r.run.status === 'succeeded' ? 'success' : 'error', message: `执行${r.run.status === 'succeeded' ? '成功' : '失败'}：${r.run.log}` });
                  });
                }}
              >
                立即执行
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (!triggerConfirm(`确认删除任务「${current.name}」？执行历史也会一并删除。`)) return;
                  void guard(async () => {
                    await api.deleteScheduleV3(current.id, workspace.id);
                    setSelected(null);
                    await loadTasks();
                  });
                }}
              >
                删除
              </Button>
            </>
          )
        }
      >
        {!current ? (
          <Empty>请选择任务</Empty>
        ) : (
          <div className="space-y-2">
            <div className="rounded border border-border bg-bg p-2 text-[10px]">
              <div className="flex items-center gap-2">
                <Badge tone="info">{current.taskType}</Badge>
                <span className="font-mono">{current.expression}</span>
                <span className="text-muted">{current.timezone}</span>
              </div>
              <pre className="mt-1 overflow-auto text-[9px] text-muted">{JSON.stringify(current.taskConfig, null, 2)}</pre>
              <div className="mt-1 text-[9px] text-muted">
                重试策略：最多 {current.retryPolicy.maxRetry} 次，基准 {current.retryPolicy.baseDelayMs}ms，倍数 {current.retryPolicy.factor}
              </div>
            </div>
            <JobHistory runs={runs} stats={stats} />
          </div>
        )}
      </Panel>
    </div>
  );
}
