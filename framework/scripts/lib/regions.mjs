/**
 * regions.mjs —— 「区域表」**唯一来源**
 *
 * 🔴 为什么有它：区域口径原本散在**四处**，全靠人肉同步 ——
 *   ① `_wiki/schema.md` §0.2 的表（人读的权威表述）
 *   ② `scripts/write-lock.mjs` 的 `const REGIONS`（`add`／`check` 的**校验**）
 *   ③ `scripts/lib/settle.mjs` 的 `REGION_PREFIX`（提交与两道结账闸门的**范围判定**）
 *   ④ 某个 pre-commit 取锁闸门自带的 `REGION_OF_ROOT` ＋ `REGIONS_ALL`（历史情况，本包不含该脚本）
 *   历史上加第八区域 `scripts` 时**只改了 ①②③、漏了 ④** —— 它当场打出
 *   「以下路径本轮未判（无权威的路径→区域映射）：scripts/…」，**自己承认漏网**。
 *
 * ⇒ 现在**代码里只有这一份**：`settle.mjs` re-export 它、`REGIONS` 由本文件 `Object.keys(REGION_PREFIX)` 派生、`write-lock.mjs` 直接 import `REGIONS`、
 *   各写锁脚本用 `REGIONS` / `REGION_PREFIX`；`regionOfPath` 为扩展方预留（本包内暂无调用方）、`parseSchemaRegions` 由本文件 `compareRegionTable` 内部调用；
 *   `compareRegionTable` **由 `lint-wiki.js` 第 7 项调用**——它读 `_wiki/schema.md` 的 §0.2 表格与这里的 `REGION_PREFIX` 对表，
 *   不一致 ⇒ lint 报「区域表不一致」提醒项；**schema 那张表保留为文档**（**不让代码去 import markdown**，是 lint 读文件文本比对）。
 *   改了这里 ⇒ lint-wiki 会自动报不一致（「必须重跑」现在**真的构成校验**了）。
 *
 * ⚠️ **改这里 ＝ 改"给全库上锁的那把锁"**：改完必须重跑
 *   `node scripts/lint-wiki.js`。
 */

// 区域 → 路径前缀（口径与 schema §0.2 表一致；键的顺序 = schema 表里的顺序）
export const REGION_PREFIX = {
  _wiki: ['_wiki/', 'AGENTS.md', 'CLAUDE.md', '使用手册.md'],
  knowledge: ['20-知识/'],
  record: ['10-记录/', '30-自我/'],
  project: ['40-项目/'],
  tool: ['50-工具/', '_模板/'],
  scripts: ['scripts/'],
  meta: ['_AI/', '00-收件箱/'],
  archive: ['90-归档/'],
};

/** 区域枚举（＝各工具的校验用集合） */
export const REGIONS = Object.keys(REGION_PREFIX);

/** 统一分隔符（Windows 反斜杠 → `/`） */
export const normPath = (p) => String(p ?? '').replace(/\\/g, '/');

/**
 * 路径 → 区域；**没有权威映射时返回 `null`**（调用方自己决定"放行并点名未判"还是"阻断"）。
 * 命中多个前缀时取**最长前缀**那个（防重叠时判错）。
 */
export function regionOfPath(p) {
  const q = normPath(p);
  let best = null;
  let bestLen = -1;
  for (const [region, prefixes] of Object.entries(REGION_PREFIX)) {
    for (const pre of prefixes) {
      if ((q === pre || q.startsWith(pre)) && pre.length > bestLen) {
        best = region;
        bestLen = pre.length;
      }
    }
  }
  return best;
}

/**
 * 从 schema 文本里抠出 **§0.2 那张区域表**的区域名（把"人读的文档"变成"机器可读的名单"）。
 * 只认 §0.2 节内首格是反引号标识符的表格行 ⇒ 不会把同节里其它表格（如"同文件同段先后规则"）吃进来。
 */
export function parseSchemaRegions(schemaText) {
  const sec = String(schemaText ?? '')
    .split(/^## /m)
    .find((s) => s.startsWith('0.2 '));
  if (!sec) return [];
  const out = [];
  for (const line of sec.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([A-Za-z_]+)`\s*\|/);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * 一致性核对：**代码（唯一来源）vs schema §0.2 文档**。
 * 由 `lint-wiki.js` 第 7 项调用（唯一调用方）；别在别处重写一份核对逻辑。
 */
export function compareRegionTable(schemaText) {
  const code = REGIONS;
  const schema = parseSchemaRegions(schemaText);
  const missingInSchema = code.filter((r) => !schema.includes(r)); // 代码有、文档没有
  const missingInCode = schema.filter((r) => !code.includes(r)); // 文档有、代码没有
  const noPrefix = code.filter((r) => !(REGION_PREFIX[r] || []).length);
  return {
    ok: schema.length > 0 && !missingInSchema.length && !missingInCode.length && !noPrefix.length,
    code,
    schema,
    missingInSchema,
    missingInCode,
    noPrefix,
  };
}
