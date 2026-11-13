/**
 * 缺字检查（纯函数，UI 直接调用，缺字判定不散落在组件里）。
 *
 * 覆盖集来自构建期生成的 `data/coverage.json`（各内置字体实际可渲染的字符集，
 * 由 scripts/gen-font-data.py 从各 TTF 的 cmap 导出；说文已含简体别名码位）。
 *
 * 「不混排」策略下，UI 拿到 missing 后应做整章决策（提示用户换词或整章换字体），
 * 不要逐字静默补位。
 */

import coverage from './data/coverage.json';

export interface MissingReport {
  fontId: string;
  /** 缺字（去重，按首次出现顺序） */
  missing: string[];
  /** 每个缺字的候选替换（已按“本字体可渲染”过滤，可能为空数组） */
  suggestions: Record<string, string[]>;
}

const COVERAGE = coverage as Record<string, string>;
const coverageCache = new Map<string, Set<string>>();

/**
 * 未收录的字体返回 null：**无法判定，宁可不错报**。
 * 否则 `COVERAGE[fontId] ?? ''` 会得到一个空集合，把整段文字全报成缺字。
 */
function coverageOf(fontId: string): Set<string> | null {
  const cached = coverageCache.get(fontId);
  if (cached) return cached;
  const str = COVERAGE[fontId];
  if (str === undefined) return null;
  const s = new Set(Array.from(str));
  coverageCache.set(fontId, s);
  return s;
}

/** 该字体能否渲染整段文本（空白不计）；字体覆盖集未知时视为可渲染。 */
export function isRenderable(text: string, fontId: string): boolean {
  const set = coverageOf(fontId);
  if (set === null) return true;
  for (const ch of text) {
    if (ch.trim() !== '' && !set.has(ch)) return false;
  }
  return true;
}

/**
 * 常用缺字的候选替换（人工整理，运行时会按字体覆盖过滤）。
 * 只是“建议”，可按需扩充；找不到建议时 UI 提示“说文未收此字，请换词”。
 */
const SUGGESTIONS: Record<string, string[]> = {
  源: ['原', '泉'],
  花: ['華', '卉'],
  前: ['先'],
  似: ['如', '若'],
  坊: ['方'],
  的: ['之'],
  你: ['尔'],
  他: ['其', '彼'],
  她: ['其'],
  这: ['此'],
  那: ['彼'],
  个: ['箇'],
  们: [],
  太: ['泰'],
  以: ['已'],
  为: ['爲'],
  会: ['會'],
};

/**
 * 检查 text 在 fontId 下缺哪些字，并给出候选替换。
 *
 * @example
 * const { missing, suggestions } = checkMissing('财源广进', 'shuowen');
 * // missing: ['源']，suggestions: { 源: ['原'] }
 */
export function checkMissing(text: string, fontId: string): MissingReport {
  const set = coverageOf(fontId);
  // 字体覆盖集未收录 → 无法判定，不报缺字
  if (set === null) return { fontId, missing: [], suggestions: {} };
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const ch of Array.from(text)) {
    if (ch.trim() === '' || seen.has(ch)) continue;
    seen.add(ch);
    if (!set.has(ch)) missing.push(ch);
  }
  const suggestions: Record<string, string[]> = {};
  for (const ch of missing) {
    suggestions[ch] = (SUGGESTIONS[ch] ?? []).filter((s) => set.has(s));
  }
  return { fontId, missing, suggestions };
}
