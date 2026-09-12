import { useState } from 'react';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Panel } from '@/components/ui';

const FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'] as const;

/** 文件页：Office 生成 + 工作区根目录配置提示 */
export function FilesPage() {
  const workspace = useAppStore((s) => s.workspace);
  const setWorkspaceRoot = useAppStore((s) => s.setWorkspaceRoot);
  const pushToast = useAppStore((s) => s.pushToast);
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('docx');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string[]>([]);
  const [rootInput, setRootInput] = useState('');

  async function generate() {
    if (!workspace || !title.trim()) return;
    setBusy(true);
    try {
      const res = await api.generateOffice({ workspaceId: workspace.id, format, title: title.trim(), content });
      setGenerated((g) => [res.path, ...g]);
      pushToast({ level: 'success', message: `已生成 ${res.path}` });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full grid-cols-[1fr_320px] gap-3">
      <Panel title="生成 Office 文件">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">格式</span>
            {FORMATS.map((f) => (
              <Button key={f} variant={format === f ? 'primary' : 'default'} onClick={() => setFormat(f)}>
                {f}
              </Button>
            ))}
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文档标题"
            className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            placeholder={'Markdown 内容，例如：\n# 摘要\n\n- 要点一\n- 要点二'}
            className="w-full resize-none rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void generate()} disabled={busy || !title.trim()}>
              {busy ? '生成中…' : '生成'}
            </Button>
            {!workspace?.rootPath && <span className="text-[11px] text-amber-400">请先在右侧设置工作目录</span>}
          </div>
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="工作目录">
          <p className="mb-2 text-[11px] text-muted">
            文件与 Office 产物只允许写入该目录内（路径穿越会被拒绝）。
            {workspace?.rootPath ? `当前：${workspace.rootPath}` : '当前未设置，文件功能不可用。'}
          </p>
          <div className="flex gap-2">
            <input
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="/path/to/workspace"
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-brand"
            />
            <Button onClick={() => void setWorkspaceRoot(rootInput.trim() || null)}>保存</Button>
          </div>
        </Panel>

        <Panel title="最近生成" className="min-h-0 flex-1">
          {generated.length === 0 ? (
            <p className="text-xs text-muted">暂无</p>
          ) : (
            <ul className="space-y-1">
              {generated.map((g) => (
                <li key={g} className="flex items-center gap-2 text-xs">
                  <Badge tone="ok">已生成</Badge>
                  <span className="truncate">{g}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
