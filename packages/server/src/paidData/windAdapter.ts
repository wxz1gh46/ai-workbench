import { existsSync } from 'node:fs';
import type { PaidDataProviderSpec } from '@ai/shared';
import { PaidDataAdapter, type AdapterContext, type AdapterResult } from './adapterBase.ts';

/**
 * Wind 万得适配器。
 *
 * 合规且现实的接入方式：**本机终端桥接**（用户已购买并登录 Wind，本机存在终端）。
 * 本适配器：
 *   - 只校验终端路径存在性，不代理登录、不读取/不共享账号凭据
 *   - 未安装终端时显式降级，并给出「去哪儿装」的可读说明
 *   - 真实取数由本机 Wind 客户端（WDS/WSet）完成，本适配器只做参数编排
 */
export class WindAdapter extends PaidDataAdapter {
  readonly providerId = 'wind';

  constructor(spec: PaidDataProviderSpec) {
    super(spec);
  }

  async query(action: string, params: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const missing = this.missingCredentials(ctx.credentials);
    if (missing.length > 0) {
      return this.degraded(`未配置 Wind 终端路径（缺少 ${missing.join(', ')}）。请填写本机已授权终端的安装路径。`);
    }
    const windPath = ctx.credentials.windPath!.trim();
    if (!existsSync(windPath)) {
      return this.degraded(`Wind 终端路径不存在：${windPath}。请确认已安装并登录 Wind 金融终端。`);
    }
    if (action === 'wds.query' && !params.dataset) return this.degraded('缺少必填参数：dataset（Wind 数据集名）');
    if (action === 'wset.data' && !params.codes) return this.degraded('缺少必填参数：codes（代码列表）');
    return this.degraded(
      `已检测到本机 Wind 终端（${windPath}），但真实取数需要在 Wind 客户端内执行 WDS/WSet 脚本。` +
        `本工作台不代持账号、不代理登录，请在终端中授权后由你确认数据回填。`,
    );
  }
}
