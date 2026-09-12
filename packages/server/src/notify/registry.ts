import type { NotifyChannelType } from '@ai/shared';
import type { Notifier } from './notifier.ts';
import { DesktopNotifier } from './desktopNotifier.ts';
import { EmailNotifier } from './emailNotifier.ts';
import { WebhookNotifier } from './webhookNotifier.ts';
import { FeishuNotifier } from './feishuNotifier.ts';
import { DingtalkNotifier } from './dingtalkNotifier.ts';
import { WecomNotifier } from './wecomNotifier.ts';

/** 通知渠道注册表：新增渠道只需实现 Notifier 并在此登记 */
export const notifiers: Record<NotifyChannelType, Notifier> = {
  desktop: new DesktopNotifier(),
  email: new EmailNotifier(),
  webhook: new WebhookNotifier(),
  feishu: new FeishuNotifier(),
  dingtalk: new DingtalkNotifier(),
  wecom: new WecomNotifier(),
};

export function getNotifier(type: NotifyChannelType): Notifier {
  return notifiers[type];
}

export function listNotifierMeta() {
  return Object.values(notifiers).map((n) => ({
    type: n.type,
    label: n.label,
    secretFields: n.secretFields,
    configFields: n.configFields,
  }));
}
