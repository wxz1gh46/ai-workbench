import type { WebsitePlan } from '@ai/shared';
import { Badge, Empty } from '@/components/ui';

/**
 * 网站生成结果预览：展示解析出的需求结构（页面/接口/实体/样式/访问控制），
 * 让用户在部署前就能确认「系统理解得对不对」。
 */
export function WebsitePreview({ plan, files }: { plan: WebsitePlan | null; files: { path: string; bytes: number }[] }) {
  if (!plan || !plan.pages) return <Empty>还没有生成结果</Empty>;

  const siteTypeLabel = plan.siteType === 'static' ? '静态站' : plan.siteType === 'fullstack' ? '全栈站' : '全栈站（带数据库）';

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{siteTypeLabel}</Badge>
        <Badge>{plan.framework}</Badge>
        {plan.needsDatabase && <Badge tone="warn">需要数据库</Badge>}
        {plan.degraded && <Badge tone="warn">规则解析（未接模型）</Badge>}
        <span className="text-muted">{plan.summary}</span>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">页面（{plan.pages.length}）</div>
        <ul className="space-y-0.5">
          {plan.pages.map((p) => (
            <li key={p.path} className="flex items-center gap-2">
              <span className="font-mono">{p.path}</span>
              <span>{p.title}</span>
              <span className="text-muted">{p.sections.join(' · ')}</span>
              {p.requiresAuth && <Badge tone="warn">需登录</Badge>}
            </li>
          ))}
        </ul>
      </div>

      {plan.apis.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">后端接口（{plan.apis.length}）</div>
          <ul className="space-y-0.5 font-mono">
            {plan.apis.map((a, i) => (
              <li key={i}>
                <span className="text-brand">{a.method}</span> {a.path} <span className="font-sans text-muted">{a.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.entities.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">数据表（{plan.entities.length}）</div>
          <ul className="space-y-1">
            {plan.entities.map((e) => (
              <li key={e.name} className="rounded border border-border bg-bg p-1.5">
                <div className="font-mono">{e.name}</div>
                <div className="text-[10px] text-muted">
                  {e.columns.map((c) => `${c.name}:${c.type}${c.primary ? '(PK)' : c.nullable ? '' : '*'}`).join(', ')}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">访问控制</div>
        <p>
          {plan.accessControl.type === 'public' ? '公开访问' : plan.accessControl.type === 'password' ? '口令保护' : '邮箱白名单'} —{' '}
          <span className="text-muted">{plan.accessControl.note}</span>
        </p>
      </div>

      {files.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">生成文件（{files.length}）</div>
          <div className="max-h-40 overflow-auto rounded border border-border bg-bg p-1.5 font-mono text-[10px]">
            {files.map((f) => (
              <div key={f.path} className="flex justify-between gap-2">
                <span>{f.path}</span>
                <span className="text-muted">{f.bytes} B</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
