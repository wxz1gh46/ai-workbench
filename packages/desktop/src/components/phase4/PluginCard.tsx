import type { PluginManifestV4, PluginInstallationInfo } from '@ai/shared';
import { Badge, Button } from '@/components/ui';

/**
 * 插件卡片。
 * 关键信息必须一眼可见，避免用户「装了一个会读文件+联网的插件却不知道」：
 *   - 是否需要在沙箱外访问（权限 sensitive）
 *   - 是否需要自己配置凭据（requiresUserAuth + 变量名）
 *   - 是否已签名（未签名的插件在 UI 上要显著标注）
 */
export function PluginCard({
  manifest,
  installed,
  busy,
  onInstall,
  onUninstall,
  onUpdate,
  onAuthorize,
  onViewCalls,
}: {
  manifest: PluginManifestV4;
  installed?: PluginInstallationInfo;
  busy?: boolean;
  onInstall?: () => void;
  onUninstall?: () => void;
  onUpdate?: () => void;
  onAuthorize?: () => void;
  onViewCalls?: () => void;
}) {
  const sensitive = manifest.permissions.filter((p) => p.sensitive);
  const granted = installed?.grantedScopes ?? [];
  const missingRequired = (installed?.permissions ?? []).filter((p) => p.required !== false && !granted.includes(p.scope));

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium text-fg">{manifest.name}</h3>
            <Badge tone="info">{manifest.kind}</Badge>
            {installed && <Badge tone="ok">已安装 v{installed.version}</Badge>}
            {installed?.updateAvailable && <Badge tone="warn">可更新 → v{installed.latestVersion}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted">{manifest.description}</p>
          <p className="mt-1 text-[11px] text-muted">
            v{manifest.version} · {manifest.author} · {manifest.source}
          </p>
        </div>
      </header>

      <dl className="flex flex-wrap gap-1 text-[11px]">
        <dt className="sr-only">权限</dt>
        {manifest.permissions.map((p) => (
          <dd key={p.scope}>
            <Badge tone={granted.includes(p.scope) ? 'ok' : p.sensitive ? 'warn' : 'default'}>
              {p.scope}
              {granted.includes(p.scope) ? ' ✓' : ''}
            </Badge>
          </dd>
        ))}
      </dl>

      <ul className="space-y-0.5 text-[11px] text-muted">
        <li>沙箱：{manifest.sandbox ? '✅ 进程/网络/文件受限' : '⚠️ 未启用沙箱'}</li>
        <li>工具：{manifest.tools.map((t) => t.name).join('、') || '（无）'}</li>
        {manifest.secretRefs.length > 0 && <li>需你提供的凭据变量：{manifest.secretRefs.join('、')}</li>}
        {sensitive.length > 0 && <li className="text-amber-400">敏感权限 {sensitive.length} 项，需逐项授权</li>}
        {installed && missingRequired.length > 0 && <li className="text-amber-400">还有 {missingRequired.length} 项必授权未完成，调用会被拒绝</li>}
      </ul>

      <footer className="mt-auto flex flex-wrap justify-end gap-1">
        {onViewCalls && installed && <Button variant="ghost" onClick={onViewCalls}>调用日志</Button>}
        {installed && onAuthorize && <Button onClick={onAuthorize}>权限管理</Button>}
        {installed && installed.updateAvailable && onUpdate && (
          <Button onClick={onUpdate} disabled={busy}>更新</Button>
        )}
        {installed && onUninstall ? (
          <Button variant="danger" onClick={onUninstall} disabled={busy}>卸载</Button>
        ) : (
          onInstall && <Button variant="primary" onClick={onInstall} disabled={busy}>{busy ? '安装中…' : '安装'}</Button>
        )}
      </footer>
    </article>
  );
}
