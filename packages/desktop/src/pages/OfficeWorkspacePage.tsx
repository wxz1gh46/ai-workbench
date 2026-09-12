import { useEffect, useState } from 'react';
import type { OfficePreview } from '@ai/shared';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { triggerConfirm } from '@/lib/confirm';
import { useAppStore } from '@/stores/app-store';
import { truncate } from '@/lib/utils';

type EditOp =
  | { op: 'append'; text: string }
  | { op: 'replace'; find: string; replace: string }
  | { op: 'setCell'; sheet: string; cell: string; value: string | number };

/**
 * Office 工作区（Step 5/7 UI）。
 * 文件列表 → 预览 → 编辑（追加/替换/单元格）→ 转换 → 版本历史与回滚 → 导出。
 */
export function OfficeWorkspacePage() {
  const { workspace, pushToast } = useAppStore();
  const [files, setFiles] = useState<{ id: string; path: string; size: number; version: number; ext: string }[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [preview, setPreview] = useState<OfficePreview | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [versions, setVersions] = useState<{ id: string; version: number; note: string; createdAt: string; size: number }[]>([]);
  const [genTitle, setGenTitle] = useState('工作报告');
  const [genContent, setGenContent] = useState('# 本周进展\n\n- 完成 Phase 2 开发\n- 待办：接入检索端点');
  const [genFormat, setGenFormat] = useState('docx');
  const [appendText, setAppendText] = useState('## 追加说明\n\n通过 Office 工作区追加的内容。');
  const [replaceFind, setReplaceFind] = useState('');
  const [replaceTo, setReplaceTo] = useState('');
  const [cellSheet, setCellSheet] = useState('Sheet1');
  const [cellRef, setCellRef] = useState('B2');
  const [cellValue, setCellValue] = useState('999');
  const [converter, setConverter] = useState<{ available: boolean; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!workspace) return;
    const [{ files: list }, status] = await Promise.all([api.listFiles(workspace.id), api.officeStatus()]);
    setFiles(list.filter((f: { ext: string }) => ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'markdown'].includes(f.ext)));
    setConverter(status);
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  async function loadPreview(p: string) {
    if (!workspace) return;
    setSelected(p);
    setBusy(true);
    try {
      const [prev, read] = await Promise.all([api.officePreview(workspace.id, p), api.officeRead(workspace.id, p)]);
      setPreview(prev);
      setWarnings(read.warnings);
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function loadVersions(fileId: string) {
    try {
      const r = await api.fileVersions(fileId);
      setVersions(r.versions);
    } catch {
      setVersions([]);
    }
  }

  async function doGenerate() {
    if (!workspace) return;
    setBusy(true);
    try {
      const r = await api.generateOffice({ workspaceId: workspace.id, format: genFormat, title: genTitle, content: genContent });
      pushToast({ level: 'success', message: `已生成 ${r.path}（v${(r as unknown as { version?: number }).version ?? 1}）` });
      await refresh();
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function doEdit() {
    if (!workspace || !selected) return;
    const ops: EditOp[] = [];
    if (appendText.trim()) ops.push({ op: 'append', text: appendText });
    if (replaceFind && replaceTo !== undefined) ops.push({ op: 'replace', find: replaceFind, replace: replaceTo });
    if (selected.endsWith('.xlsx') && cellRef) ops.push({ op: 'setCell', sheet: cellSheet, cell: cellRef, value: Number.isNaN(Number(cellValue)) ? cellValue : Number(cellValue) });
    if (ops.length === 0) {
      pushToast({ level: 'warn', message: '请至少填写一项编辑操作' });
      return;
    }
    if (!triggerConfirm(`将对 ${selected} 应用 ${ops.length} 项编辑（会自动备份版本），确认继续？`)) return;
    setBusy(true);
    try {
      const r = await api.officeEdit(workspace.id, selected, ops);
      pushToast({ level: 'success', message: `编辑完成（应用 ${r.applied} 项，版本 v${r.version}）` });
      if (r.warnings.length > 0) setWarnings(r.warnings);
      await refresh();
      await loadPreview(selected);
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function doConvert(target: string) {
    if (!workspace || !selected) return;
    setBusy(true);
    try {
      const r = await api.officeConvert(workspace.id, selected, target);
      if (r.degraded) {
        setWarnings(r.warnings);
        pushToast({ level: 'warn', message: '转换不可用，请按提示配置 LibreOffice' });
      } else {
        pushToast({ level: 'success', message: `已转换生成 ${r.path}` });
        await refresh();
      }
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    if (!workspace || !selected) return;
    try {
      const r = await api.officeExport(workspace.id, selected);
      pushToast({ level: 'success', message: `导出链接：${r.url}` });
      if (r.url) window.open(r.url, '_blank');
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    }
  }

  async function doRestore(fileId: string, version: number) {
    if (!triggerConfirm(`确认回滚到 v${version}？回滚会生成新版本，可再次回滚。`)) return;
    try {
      const r = await api.restoreFile(fileId, version);
      pushToast({ level: 'success', message: `已回滚自 v${r.restoredFrom}，新版本 v${r.version}` });
      if (selected) await loadPreview(selected);
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    }
  }

  const currentFileId = files.find((f) => f.path === selected)?.id;

  return (
    <div className="grid h-full grid-cols-[300px_1fr] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel
          title="生成文档"
          actions={<Badge tone={converter?.available ? 'ok' : 'warn'}>{converter?.available ? '转换可用' : '转换未配置'}</Badge>}
        >
          <div className="flex flex-col gap-2">
            <input className="rounded border border-border bg-bg px-2 py-1 text-xs" value={genTitle} onChange={(e) => setGenTitle(e.target.value)} placeholder="标题" />
            <select className="rounded border border-border bg-bg px-2 py-1 text-xs" value={genFormat} onChange={(e) => setGenFormat(e.target.value)}>
              {['docx', 'xlsx', 'pptx', 'pdf', 'markdown'].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <textarea
              className="h-24 resize-none rounded border border-border bg-bg px-2 py-1 text-xs"
              value={genContent}
              onChange={(e) => setGenContent(e.target.value)}
              placeholder="Markdown 内容"
            />
            <Button variant="primary" onClick={() => void doGenerate()} disabled={busy}>
              生成
            </Button>
            {converter && !converter.available && <p className="text-[10px] text-amber-400">{converter.hint}</p>}
          </div>
        </Panel>

        <Panel title={`文件（${files.length}）`}>
          {files.length === 0 ? (
            <Empty>暂无 Office 文件</Empty>
          ) : (
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => {
                      void loadPreview(f.path);
                      void loadVersions(f.id);
                    }}
                    className={`w-full rounded border px-2 py-1 text-left text-[11px] ${
                      selected === f.path ? 'border-brand/60 bg-brand/10' : 'border-border hover:border-brand/40'
                    }`}
                  >
                    <div className="truncate">{truncate(f.path, 30)}</div>
                    <div className="text-[10px] text-muted">
                      {f.ext} · {(f.size / 1024).toFixed(1)}KB · v{f.version}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        {selected && (
          <Panel
            title={`编辑：${selected}`}
            actions={
              <div className="flex gap-1">
                <Button onClick={() => void doExport()}>导出</Button>
                <Button onClick={() => void doConvert('pdf')}>转 PDF</Button>
                <Button onClick={() => void doConvert('markdown')}>转 MD</Button>
                <Button variant="primary" onClick={() => void doEdit()} disabled={busy}>
                  应用编辑
                </Button>
              </div>
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted">追加（docx/pptx 保留原格式，只新增内容）</span>
                <textarea className="h-16 resize-none rounded border border-border bg-bg px-2 py-1 text-[11px]" value={appendText} onChange={(e) => setAppendText(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted">文本替换</span>
                <div className="flex gap-1">
                  <input className="w-1/2 rounded border border-border bg-bg px-2 py-1 text-[11px]" placeholder="查找" value={replaceFind} onChange={(e) => setReplaceFind(e.target.value)} />
                  <input className="w-1/2 rounded border border-border bg-bg px-2 py-1 text-[11px]" placeholder="替换为" value={replaceTo} onChange={(e) => setReplaceTo(e.target.value)} />
                </div>
                <span className="mt-1 text-[10px] text-muted">xlsx 单元格（仅 .xlsx 生效）</span>
                <div className="flex gap-1">
                  <input className="w-1/3 rounded border border-border bg-bg px-2 py-1 text-[11px]" placeholder="Sheet" value={cellSheet} onChange={(e) => setCellSheet(e.target.value)} />
                  <input className="w-1/3 rounded border border-border bg-bg px-2 py-1 text-[11px]" placeholder="B2" value={cellRef} onChange={(e) => setCellRef(e.target.value)} />
                  <input className="w-1/3 rounded border border-border bg-bg px-2 py-1 text-[11px]" placeholder="值" value={cellValue} onChange={(e) => setCellValue(e.target.value)} />
                </div>
              </div>
            </div>
            {warnings.length > 0 && (
              <ul className="mt-2 space-y-0.5 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-[10px] text-amber-300">
                {warnings.map((w, i) => (
                  <li key={i}>⚠️ {w}</li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_280px] gap-3">
          <Panel title="预览">
            {!preview ? (
              <Empty>选择一个文件查看预览</Empty>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[10px] text-muted">
                  <Badge tone="info">{preview.format}</Badge>
                  <span>渲染器：{preview.renderer}</span>
                  {preview.tables.length > 0 && <span>表格 {preview.tables.length}</span>}
                  {preview.slides.length > 0 && <span>幻灯片 {preview.slides.length}</span>}
                </div>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg/30 p-2 text-[11px]">{preview.markdown}</pre>
              </div>
            )}
          </Panel>

          <Panel title={`版本历史（${versions.length}）`}>
            {!currentFileId ? (
              <Empty>选择文件后显示</Empty>
            ) : versions.length === 0 ? (
              <Empty>暂无版本记录</Empty>
            ) : (
              <ul className="space-y-1.5">
                {versions.map((v) => (
                  <li key={v.id} className="rounded border border-border bg-bg/30 px-2 py-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span>v{v.version}</span>
                      <span className="text-[10px] text-muted">{(v.size / 1024).toFixed(1)}KB</span>
                    </div>
                    <div className="text-[10px] text-muted">{v.note}</div>
                    <div className="text-[10px] text-muted">{v.createdAt.slice(0, 19).replace('T', ' ')}</div>
                    <Button className="mt-1" onClick={() => void doRestore(currentFileId, v.version)}>
                      回滚到此版本
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
