/**
 * 危险操作确认（统一入口）。
 *
 * 为什么不用 window.confirm 直接散落各处：
 * 1) 需要统一文案与审计语义（「用户确认过」是可审计事实）；
 * 2) 非浏览器环境（测试）可注入替身，避免测试挂起；
 * 3) 将来换成应用内弹窗只需改这一处。
 */
type ConfirmFn = (message: string) => boolean;

let impl: ConfirmFn = (message) => {
  if (typeof window === 'undefined') return false;
  return window.confirm(message);
};

export function triggerConfirm(message: string): boolean {
  return impl(message);
}

/** 测试/嵌入场景注入替身 */
export function setConfirmImpl(fn: ConfirmFn): void {
  impl = fn;
}
