import { useEffect, useState } from 'react';
import type { RoleInfo } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';

/**
 * 角色编辑器。
 * 内置角色不可改权限（owner 尤其），UI 上要直接禁用而不是「点了才报错」。
 */
export function RbacRoleEditor({ workspaceId, onChanged }: { workspaceId: string; onChanged?: () => void }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [catalog, setCatalog] = useState<{ key: string; label: string }[]>([]);
  const [selected, setSelected] = useState<RoleInfo | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [r, p] = await Promise.all([api.listRoles(workspaceId), api.rbacPermissions()]);
      setRoles(r.roles);
      setCatalog(p.permissions);
      setSelected((prev) => (prev ? r.roles.find((x) => x.id === prev.id) ?? null : null));
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  function pick(role: RoleInfo) {
    setSelected(role);
    setDraft([...role.permissions]);
  }

  async function save() {
    if (!selected) return;
    if (selected.builtin) {
      pushToast({ level: 'warn', message: '内置角色权限不可修改（owner 必须保留全部权限以避免系统被锁死）' });
      return;
    }
    setBusy(true);
    try {
      await api.updateRole(selected.name, workspaceId, draft);
      pushToast({ level: 'success', message: '角色已更新' });
      await load();
      onChanged?.();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api.createRole({ workspaceId, name: newName.trim(), permissions: [] });
      pushToast({ level: 'success', message: '角色已创建' });
      setNewName('');
      await load();
      onChanged?.();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(role: RoleInfo) {
    if (!confirmDanger(`删除角色 ${role.name}`, '删除后不可恢复。仍然被用户使用的角色无法删除。')) return;
    setBusy(true);
    try {
      await api.deleteRole(role.name, workspaceId);
      pushToast({ level: 'success', message: '角色已删除' });
      setSelected(null);
      await load();
      onChanged?.();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
      <div className="space-y-1">
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => pick(r)}
            className={`flex w-full items-center justify-between rounded border px-2 py-1 text-left text-xs ${
              selected?.id === r.id ? 'border-brand/60 bg-brand/10' : 'border-border bg-panel hover:border-brand/40'
            }`}
          >
            <span className="text-fg">{r.name}</span>
            <span className="flex items-center gap-1">
              {r.builtin && <Badge tone="info">内置</Badge>}
              <span className="text-muted">{r.permissions.length}</span>
            </span>
          </button>
        ))}
        <div className="flex gap-1 pt-1">
          <input
            className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1 text-xs text-fg"
            placeholder="新角色名"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button onClick={create} disabled={busy}>新建</Button>
        </div>
      </div>

      <div className="min-h-[200px] rounded border border-border bg-panel p-2">
        {!selected ? (
          <p className="text-xs text-muted">从左侧选择角色以查看 / 编辑权限。</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm text-fg">{selected.name}</h3>
              <div className="flex gap-1">
                {!selected.builtin && <Button variant="danger" onClick={() => remove(selected)} disabled={busy}>删除</Button>}
                {!selected.builtin && <Button variant="primary" onClick={save} disabled={busy}>保存</Button>}
              </div>
            </div>
            {selected.builtin && (
              <p className="rounded border border-border bg-bg p-2 text-[11px] text-muted">
                内置角色：权限随版本自动同步，不可手工修改。owner 始终拥有全部权限，用于避免把系统锁死。
              </p>
            )}
            <div className="grid gap-1 sm:grid-cols-2">
              {catalog.map((p) => (
                <label key={p.key} className="flex items-start gap-2 rounded border border-border bg-bg p-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={selected.builtin}
                    checked={draft.includes(p.key)}
                    onChange={(e) => setDraft((d) => (e.target.checked ? [...d, p.key] : d.filter((x) => x !== p.key)))}
                  />
                  <span>
                    <code className="text-fg">{p.key}</code>
                    <span className="ml-1 text-muted">{p.label}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
