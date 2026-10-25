export const TOOL_OUTPUT_LIMIT = 2000;
export const SUMMARY_LIMIT = 80;

/** 附加给各 agent 的要求：最后一行写一句适合语音播报的总结 */
export const SUMMARY_PROMPT =
  '任务结束时，在最终回复的最后单独写一行「总结：」加一句不超过 40 字的中文口语总结，用于语音播报，不要包含代码、文件路径或 Markdown 符号。';

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 取「总结：」行；没有时取最后一行非代码文字，去掉 Markdown 符号 */
export function extractSummary(result: string): string {
  const tagged = [...result.matchAll(/^\s*总结[:：]\s*(.+)$/gm)].at(-1)?.[1];
  if (tagged) return truncate(tagged.trim(), SUMMARY_LIMIT);
  const withoutCode = result.replace(/```[\s\S]*?```/g, '');
  const lines = withoutCode
    .split('\n')
    .map((l) => l.replace(/[#>*`_|]/g, '').replace(/^\s*[-\d.]+\s+/, '').trim())
    .filter((l) => l && !/^-+$/.test(l));
  return truncate(lines.at(-1) ?? '', SUMMARY_LIMIT);
}
