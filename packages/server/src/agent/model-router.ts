import { config } from '../config.ts';
import { AppError } from '../utils/errors.ts';
import { estimateTokens } from './tokens.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ChatResult {
  content: string;
  model: string;
  usage: ChatUsage;
  /** 是否为离线兜底（未配置密钥时） */
  degraded: boolean;
}

export interface ChatOptions {
  messages: ChatMessage[];
  /** 显式指定模型，覆盖自动路由 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

/**
 * 模型路由：
 * 1) 估算输入 token，超过阈值自动切到长上下文模型（百万 Token 场景）
 * 2) 未配置 API Key 时降级到本地确定性兜底（保证 Phase 1 完全可离线运行与测试）
 * 3) 兼容 OpenAI Chat Completions 协议，因此 OpenAI / 本地模型 / 各类网关都可用
 */
export class ModelRouter {
  selectModel(inputTokens: number, explicit?: string | null): string {
    if (explicit) return explicit;
    if (inputTokens >= config.ai.longContextThreshold) return config.ai.longContextModel;
    return config.ai.model;
  }

  get hasCredentials(): boolean {
    return config.ai.apiKey.trim().length > 0;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const inputTokens = opts.messages.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
    const model = this.selectModel(inputTokens, opts.model);

    if (!this.hasCredentials) {
      return this.fallback(opts, model, inputTokens);
    }

    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
    };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw AppError.provider(`模型调用失败 ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? inputTokens,
        outputTokens: json.usage?.completion_tokens ?? estimateTokens(content),
        costUsd: 0,
      },
      degraded: false,
    };
  }

  /**
   * 离线兜底：不假装智能，返回确定性的结构化占位结果。
   * 目的是让 Phase 1 的 Agent 流程、事件、审计、UI 全部可跑通、可测试。
   */
  private fallback(opts: ChatOptions, model: string, inputTokens: number): ChatResult {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const content = opts.jsonMode
      ? JSON.stringify({
          __degraded: true,
          note: '未配置 AI_API_KEY，当前为离线兜底输出。请在设置中配置模型服务。',
        })
      : `【离线模式】未配置模型密钥（AI_API_KEY）。\n\n你的输入：${lastUser.slice(0, 500)}\n\n请在「设置 → 模型接入」中配置 Base URL 与 API Key 后重试。`;
    return {
      content,
      model,
      usage: { inputTokens, outputTokens: estimateTokens(content), costUsd: 0 },
      degraded: true,
    };
  }
}

export const modelRouter = new ModelRouter();
