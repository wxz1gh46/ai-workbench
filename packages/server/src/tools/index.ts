import { listDirTool, readFileTool, writeFileTool } from './fs-tools.ts';
import { officeGenerateTool } from './office-tools.ts';
import { toolRegistry } from './registry.ts';

let initialized = false;

/** 注册内置工具（幂等） */
export function registerBuiltinTools(): void {
  if (initialized) return;
  initialized = true;
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(listDirTool);
  toolRegistry.register(officeGenerateTool);
}

export { toolRegistry } from './registry.ts';
export * from './types.ts';
