import type { PaidDataProviderSpec } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { findProvider } from './providerRegistry.ts';
import { PaidDataAdapter, StubAdapter } from './adapterBase.ts';
import { ThsAdapter } from './thsAdapter.ts';
import { TycAdapter } from './tycAdapter.ts';
import { WindAdapter } from './windAdapter.ts';
import { HsjyAdapter } from './hsjyAdapter.ts';
import { SpGlobalAdapter } from './spGlobalAdapter.ts';
import { ImfAdapter } from './imfAdapter.ts';
import { HyydAdapter } from './hyydAdapter.ts';
import { AcademicAdapter } from './academicAdapter.ts';

/**
 * 适配器工厂。每个 provider 一个实现；未实现真实调用的走 StubAdapter（显式降级）。
 * 新增 provider 只需：注册表加声明 + 工厂加一行，不改 QueryRunner。
 */
const BUILDERS: Record<string, (spec: PaidDataProviderSpec) => PaidDataAdapter> = {
  tonghuashun: (s) => new ThsAdapter(s),
  tianyancha: (s) => new TycAdapter(s),
  wind: (s) => new WindAdapter(s),
  'hs-juyuan': (s) => new HsjyAdapter(s),
  'sp-global': (s) => new SpGlobalAdapter(s),
  imf: (s) => new ImfAdapter(s),
  'hyyd-legal': (s) => new HyydAdapter(s),
  academic: (s) => new AcademicAdapter(s),
};

export function createAdapter(providerId: string): PaidDataAdapter {
  const spec = findProvider(providerId);
  if (!spec) throw AppError.notFound(`未知的付费数据源：${providerId}`);
  const builder = BUILDERS[providerId];
  return builder ? builder(spec) : new StubAdapter(spec);
}

export function adapterIds(): string[] {
  return Object.keys(BUILDERS);
}
