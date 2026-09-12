import { useEffect, useRef, useState } from 'react';
import type { Message } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';

const CONVERSATION_KEY = 'ai-workbench:conversationId';

/**
 * 对话页。
 * - 消息原文持久化在服务端（SQLite），这里只做展示
 * - citations 展示「召回来源」，对应百万 Token 上下文管理的可溯源性要求
 */
export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [citations, setCitations] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pushToast = useAppStore((s) => s.pushToast);

  const conversationId = localStorage.getItem(CONVERSATION_KEY) ?? crypto.randomUUID();
  useEffect(() => {
    localStorage.setItem(CONVERSATION_KEY, conversationId);
    void api
      .listMessages(conversationId)
      .then((r) => setMessages(r.messages))
      .catch(() => undefined);
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function send() {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setInput('');
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      conversationId,
      role: 'user',
      content,
      citations: [],
      tokenCount: 0,
      summarized: false,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    try {
      const res = await api.sendMessage(conversationId, content);
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), res.userMessage, res.assistantMessage]);
      setCitations(res.citations);
      if (res.degraded) pushToast({ level: 'warn', message: '离线兜底回复：请配置模型密钥以获得真实回答' });
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setSending(false);
    }
  }

  return (
    <Panel
      title="对话"
      actions={
        <>
          <Badge>会话 {conversationId.slice(0, 8)}</Badge>
          {citations.length > 0 && <Badge tone="info">召回 {citations.length} 条来源</Badge>}
        </>
      }
      className="h-full"
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 space-y-3 overflow-auto">
          {messages.length === 0 && <Empty>输入消息开始对话。长对话会自动做滚动摘要与向量召回。</Empty>}
          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[80%] rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-sm'
                    : 'max-w-[85%] whitespace-pre-wrap rounded-lg border border-border bg-bg px-3 py-2 text-sm'
                }
              >
                <div className="mb-1 text-[10px] uppercase text-muted">{m.role}</div>
                {m.content}
                {m.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {m.citations.slice(0, 8).map((c) => (
                      <Badge key={c} tone="info">
                        来源 {c.slice(0, 10)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="mt-3 flex gap-2 border-t border-border pt-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={2}
            placeholder="输入消息，⌘/Ctrl + Enter 发送"
            className="flex-1 resize-none rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <Button variant="primary" onClick={() => void send()} disabled={sending || !input.trim()}>
            {sending ? '发送中…' : '发送'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
