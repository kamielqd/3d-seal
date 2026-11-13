/**
 * 版式引擎 · 字体注册与加载（含分片按需加载）
 *
 * - fontId → FontDef（名称 / 文件路径或分片 / 授权 / 作者 / 是否内置）
 * - 支持「多分片字体」：说文解字拆成 block1/block2，合成一个 FontSet 供 layout 使用。
 * - **分片按需**：ensureFont(fontId, text) 会依据 data/font-shards.json 的 ranges，
 *   只 fetch+parse 文本命中的分片（输入「福」只拉 block1，不拉 block2）。
 * - 只接收 TTF/OTF；不支持 WOFF2（opentype.js 无原生 woff2 解码，且整包解析）。
 *
 * 字体文件放在 public/fonts/<id>/ 下，运行时按 import.meta.env.BASE_URL 拼相对路径。
 */

import * as opentype from 'opentype.js';
import type { Glyph } from 'opentype.js';
import type { GlyphFont } from './text';
import shardData from './data/font-shards.json';

/** 一个字体分片（多分片字体的一个文件）。 */
export interface FontShardDef {
  id: string;
  /** 相对 BASE_URL 的路径，或绝对 http(s) URL */
  filePath: string;
}

export interface FontDef {
  id: string;
  /** 显示名 */
  name: string;
  /** 单文件字体的路径（与 shards 二选一） */
  filePath?: string;
  /** 多分片字体（如说文 block1/block2），与 filePath 二选一 */
  shards?: FontShardDef[];
  /** 授权标识，如 'OFL-1.1' / 'OGDL-1.0' */
  license: string;
  licenseUrl?: string;
  author?: string;
  /** 是否已内置子集文件；未内置的按需加载会快速失败并给出清晰提示 */
  bundled: boolean;
}

export type FontState = 'idle' | 'loading' | 'loaded' | 'error';

export const DEFAULT_FONT_ID = 'smiley-sans';

/** 内置字体注册表 */
const BUILTIN: FontDef[] = [
  {
    id: 'smiley-sans',
    name: '得意黑 Smiley Sans',
    filePath: 'fonts/smiley-sans/smiley-sans-subset.ttf',
    license: 'OFL-1.1',
    licenseUrl: 'https://scripts.sil.org/OFL',
    author: 'atelierAnchor',
    bundled: true,
  },
  {
    id: 'lxgw-wenkai',
    name: '霞鹜文楷 LXGW WenKai',
    filePath: 'fonts/lxgw-wenkai/lxgw-wenkai-subset.ttf',
    license: 'OFL-1.1',
    licenseUrl: 'https://github.com/lxgw/LxgwWenKai',
    author: 'LXGW',
    bundled: true,
  },
  {
    id: 'lxgw-seal',
    name: '霞鹜篆书 LxgwSeal',
    filePath: 'fonts/lxgw-seal/lxgw-seal.ttf',
    license: 'OFL-1.1',
    licenseUrl: 'https://github.com/lxgw/LxgwSeal',
    author: 'LXGW',
    bundled: true,
  },
  {
    // 说文解字：按字频分两块，切换篆书模式时按文本命中的分片按需加载
    id: 'shuowen',
    name: '说文解字（小篆）',
    shards: [
      { id: 'block1', filePath: 'fonts/shuowen/shuowen-block1.ttf' },
      { id: 'block2', filePath: 'fonts/shuowen/shuowen-block2.ttf' },
    ],
    license: 'OGDL-1.0',
    licenseUrl: 'https://data.gov.tw/license',
    author: '台湾全字库 CNS11643',
    bundled: true,
  },
  {
    id: 'source-han-sans',
    name: '思源黑体 Source Han Sans',
    filePath: 'fonts/source-han-sans/source-han-sans-subset.otf',
    license: 'OFL-1.1',
    licenseUrl: 'https://github.com/adobe-fonts/source-han-sans',
    author: 'Adobe',
    bundled: true,
  },
];

/* ------------------------------------------------------------------ */
/* 分片 ranges 索引（构建期由 gen-font-data.py 生成）                   */
/* ------------------------------------------------------------------ */

interface ShardRangeTable {
  shards: { id: string; ranges: number[] }[];
}

const SHARD_TABLES = shardData as unknown as Record<string, ShardRangeTable>;
const SHARD_SETS = new Map<string, { id: string; set: Set<number> }[]>();
for (const [fontId, table] of Object.entries(SHARD_TABLES)) {
  SHARD_SETS.set(
    fontId,
    table.shards.map((s) => {
      const set = new Set<number>();
      for (let i = 0; i < s.ranges.length; i += 2) {
        for (let cp = s.ranges[i]; cp <= s.ranges[i + 1]; cp++) set.add(cp);
      }
      return { id: s.id, set };
    }),
  );
}

/**
 * 纯函数：按文本（只看 CJK 码位，忽略 ASCII/标点）选出命中的分片 id。
 * 返回 null 表示该字体没有 ranges 信息（调用方应加载全部分片）。
 * 返回 [] 表示文本没有任何 CJK 码位命中（如纯数字/空白，或全是缺字）。
 */
export function selectShardIds(fontId: string, text: string): string[] | null {
  const sets = SHARD_SETS.get(fontId);
  if (!sets) return null;
  const cps = Array.from(new Set(Array.from(text, (c) => c.codePointAt(0) ?? 0))).filter(
    (cp) => cp >= 0x2e80,
  );
  if (cps.length === 0) return [];
  return sets.filter((s) => cps.some((cp) => s.set.has(cp))).map((s) => s.id);
}

/* ------------------------------------------------------------------ */
/* 字体集：多分片合成一个 GlyphFont                                     */
/* ------------------------------------------------------------------ */

/**
 * 多分片字体集：把多个 opentype.Font 合成一个 GlyphFont。
 * charToGlyph 依次在各分片里查，命中 index!==0 即返回；都没有则返回首片 .notdef。
 * （说文已把简体码位作为别名写进分块 cmap，所以这里按简体 char 直接命中。）
 */
export class FontSet implements GlyphFont {
  readonly unitsPerEm: number;
  readonly shardIds: string[];
  readonly fonts: opentype.Font[];

  constructor(fonts: opentype.Font[], shardIds: string[]) {
    if (fonts.length === 0) throw new Error('FontSet 至少需要一个字体分片');
    this.fonts = fonts;
    this.shardIds = shardIds;
    this.unitsPerEm = fonts[0].unitsPerEm;
  }

  charToGlyph(ch: string): Glyph {
    for (const f of this.fonts) {
      const g = f.charToGlyph(ch);
      if (g && g.index !== 0) return g;
    }
    return this.fonts[0].charToGlyph(ch);
  }

  hasChar(ch: string): boolean {
    for (const f of this.fonts) {
      const g = f.charToGlyph(ch);
      if (g && g.index !== 0) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 内部状态                                                            */
/* ------------------------------------------------------------------ */

const registry = new Map<string, FontDef>();
for (const def of BUILTIN) registry.set(def.id, def);

/** fontId -> (shardId -> 已解析的 opentype.Font) */
const shardFonts = new Map<string, Map<string, opentype.Font>>();
/** `${fontId}/${shardId}` -> 进行中的分片加载 */
const shardPromises = new Map<string, Promise<opentype.Font>>();
/** fontId -> 状态 */
const states = new Map<string, { state: FontState; error?: string }>();

function ensureShardMap(fontId: string): Map<string, opentype.Font> {
  let m = shardFonts.get(fontId);
  if (!m) {
    m = new Map();
    shardFonts.set(fontId, m);
  }
  return m;
}

function baseUrl(): string {
  const b = import.meta.env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : b + '/';
}

function resolveUrl(filePath: string): string {
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return baseUrl() + filePath.replace(/^\.?\//, '');
}

/** 取一个 FontDef 的分片列表（单文件字体视为只有一个分片）。 */
function shardDefsOf(def: FontDef): FontShardDef[] {
  if (def.shards && def.shards.length > 0) return def.shards;
  if (def.filePath) return [{ id: 'main', filePath: def.filePath }];
  return [];
}

/* ------------------------------------------------------------------ */
/* 查询接口                                                            */
/* ------------------------------------------------------------------ */

export function listFonts(): FontDef[] {
  return [...registry.values()];
}

export function getFontDef(id: string): FontDef | undefined {
  return registry.get(id);
}

export function getFontState(id: string): FontState {
  return states.get(id)?.state ?? 'idle';
}

export function isFontLoading(id: string): boolean {
  return states.get(id)?.state === 'loading';
}

/** 已加载分片组成的 FontSet（按 FontDef 分片顺序）；若一个都没加载返回 undefined。 */
export function getLoadedFontSet(id: string): FontSet | undefined {
  const m = shardFonts.get(id);
  const def = registry.get(id);
  if (!m || m.size === 0 || !def) return undefined;
  const ids = shardDefsOf(def)
    .map((s) => s.id)
    .filter((sid) => m.has(sid));
  const fonts = ids.map((sid) => m.get(sid)!);
  return new FontSet(fonts, ids);
}

/** 兼容旧接口：返回首个已加载分片的 opentype.Font。 */
export function getLoadedFont(id: string): opentype.Font | undefined {
  const m = shardFonts.get(id);
  return m && m.size > 0 ? m.values().next().value : undefined;
}

export function getFontError(id: string): string | undefined {
  return states.get(id)?.error;
}

/** 未知 fontId 回退到默认字体（例如历史 spec 里残留的旧 id） */
export function resolveFontId(id: string | undefined | null): string {
  if (id && registry.has(id)) return id;
  return DEFAULT_FONT_ID;
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

/** 运行时注册字体（例如用户本地上传，或后续动态子集） */
export function registerFont(def: FontDef): void {
  registry.set(def.id, def);
}

async function fetchFont(url: string): Promise<opentype.Font> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`字体文件加载失败 HTTP ${resp.status}：${url}`);
  const buf = await resp.arrayBuffer();
  return opentype.parse(buf);
}

/** 加载单个分片（带缓存与并发去重）。 */
async function loadShardFont(fontId: string, shard: FontShardDef): Promise<opentype.Font> {
  const m = ensureShardMap(fontId);
  const cached = m.get(shard.id);
  if (cached) return cached;
  const key = `${fontId}/${shard.id}`;
  const pending = shardPromises.get(key);
  if (pending) return pending;
  const p = (async () => {
    const font = await fetchFont(resolveUrl(shard.filePath));
    m.set(shard.id, font);
    return font;
  })();
  shardPromises.set(key, p);
  try {
    return await p;
  } finally {
    shardPromises.delete(key);
  }
}

/** 依据文本选分片：null→全部；[]→首个；否则→命中的分片。 */
function pickShards(fontId: string, shards: FontShardDef[], text?: string): FontShardDef[] {
  if (text === undefined) return shards;
  const ids = selectShardIds(fontId, text);
  if (ids === null) return shards;
  if (ids.length === 0) return shards.slice(0, 1);
  return shards.filter((s) => ids.includes(s.id));
}

/**
 * 加载一个可用于排版的 FontSet。
 * @param text 若提供，则只加载命中该文本的分片（分片按需）；不提供则加载全部分片。
 */
export async function ensureFont(fontId: string, text?: string): Promise<FontSet> {
  const def = registry.get(fontId);
  if (!def) throw new Error(`未注册的字体：${fontId}`);

  const allShards = shardDefsOf(def);
  if (allShards.length === 0) throw new Error(`字体「${def.name}」没有可用文件`);

  const anyRemote = allShards.some((s) => /^https?:\/\//i.test(s.filePath));
  if (!def.bundled && !anyRemote) {
    const message = `字体「${def.name}」尚未内置子集文件，请先子集化打包或改用本地上传`;
    states.set(fontId, { state: 'error', error: message });
    throw new Error(message);
  }

  const target = pickShards(fontId, allShards, text);
  if (target.length === 0) throw new Error(`字体「${def.name}」没有匹配的分片`);

  states.set(fontId, { state: 'loading' });
  try {
    const fonts = await Promise.all(target.map((s) => loadShardFont(fontId, s)));
    states.set(fontId, { state: 'loaded' });
    return new FontSet(fonts, target.map((s) => s.id));
  } catch (e) {
    states.set(fontId, { state: 'error', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** 加载全部分片（等价于 ensureFont(fontId) 不传 text）。 */
export async function loadFont(fontId: string): Promise<FontSet> {
  return ensureFont(fontId);
}

/**
 * 用户本地上传：直接从内存 ArrayBuffer 解析并注册为可用字体，**不经过网络、不上传**。
 */
export function loadFontFromBuffer(def: FontDef, buffer: ArrayBuffer): opentype.Font {
  const font = opentype.parse(buffer);
  registry.set(def.id, { ...def, bundled: true });
  ensureShardMap(def.id).set('upload', font);
  states.set(def.id, { state: 'loaded' });
  return font;
}
