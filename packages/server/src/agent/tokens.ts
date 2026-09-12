/**
 * Token 估算：不引入 tiktoken（体积大且对中文不准）。
 * 采用「CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token」的经验估算，
 * 误差对预算分配足够；真实用量以模型返回的 usage 为准并回写 DB。
 */
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateMessagesTokens(messages: { content: string }[]): number {
  // 每条消息固定开销约 4 token
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
