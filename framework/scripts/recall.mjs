#!/usr/bin/env node
/**
 * recall.mjs —— 库内召回（关键字版）
 *
 * 用途：找不到"那页在哪"时，按关键词把相关文件 + 命中行 + 上下文捞出来。
 * 定位：地图（开场导航）优先，本脚本兜底——地图是"从哪进"，全库索引是"有什么"，本脚本是"哪里有"。
 *
 * 用法：
 *   node scripts/recall.mjs "关键词" [更多词…]      # 多个词默认 OR（任一命中）
 *   node scripts/recall.mjs 记忆 上下文 --and        # --and 表示必须全部命中
 *   node scripts/recall.mjs 沙箱 --n 10 --ctx 3     # 最多 10 个文件，每个命中行前后各 3 行
 *   node scripts/recall.mjs 旧路径 --all            # 连 90-归档/ 一起搜
 *   node scripts/recall.mjs 规则 --dir 20-知识      # 限定目录
 *
 * 行为：**只在 0 命中时**追加一行到 _AI/召回日志.md（时间 / 查询 / 命中数），供"要不要上向量库"的判据使用。
 *   有命中的查询不写盘——否则每跑一次工作区就多一条未提交，顶起脏树闸门；且"失效线"只统计
 *   "0 命中、但事后确认里有"的行，有命中的行对判据零作用。
 *   ⚠️ 检索面**排除自己的查询流水表**（_AI/召回日志.md）——否则日志里出现过的词
 *   会把本该 0 命中的查询变成"命中"，使失效线需要的行被静默漏记。
 *
 * ═══════════ 什么时候该升级到向量库 ═══════════
 * 三条触发线，**任一满足就重新评估**（不是自动升级，是触发讨论）：
 *   A. 规模线：在册 Markdown 到了几千个的量级
 *   B. 失效线：召回日志里"0 命中、但事后确认库里确实有"累计 ≥ 5 次
 *   C. 形态线：出现"跨语言/近义"检索需求（搜中文要命中英文术语等）且 ≥ 3 次
 * 届时做法：只对 20-知识/ + _wiki/ 建**嵌入索引**（嵌入模型自选，本机或云端均可）；
 * 索引是**生成物**（可随时重建、不手改），原文始终是 Markdown，人可读可审这条底线不变。
 * 现在不建的理由：库还小、命名规范、有地图和双链，关键字匹配的精度已经够；
 * 向量库要额外引入模型/索引/维护成本，且把"可读可审"换成黑箱相似度。
 */

import fs from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'scripts', '.trash', '90-归档']);
const PRIORITY = ['20-知识/', '_wiki/', '50-工具/', '40-项目/', '30-自我/', '10-记录/', '_AI/'];

// 查询流水表不进检索面（防日志自污染 0 命中判定）：召回日志由本脚本写；若你另有检索工具，把它的流水表也加进来。
const FLOW_LOG_RELS = new Set(['_AI/召回日志.md']);

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  argv.splice(i, 2);
  return v;
};
const AND = Boolean(flag('--and', false));
const ALL = Boolean(flag('--all', false));
const N = Number(flag('--n', 15)) || 15;
const CTX = Number(flag('--ctx', 1));
const DIR = flag('--dir', null);
const terms = argv.filter((a) => !a.startsWith('--'));
if (!terms.length) {
  console.log('用法：node scripts/recall.mjs "关键词" [更多词…] [--and] [--all] [--n 15] [--ctx 2] [--dir 20-知识]');
  process.exit(2);
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) && !(ALL && e.name === '90-归档')) continue;
      walk(p, out);
    } else if (e.name.endsWith('.md')) {
      if (FLOW_LOG_RELS.has(relative(ROOT, p).replace(/\\/g, '/'))) continue;
      out.push(p);
    }
  }
  return out;
};

let files = walk(ROOT);
if (DIR) files = files.filter((f) => relative(ROOT, f).replace(/\\/g, '/').startsWith(DIR));
if (!ALL) files = files.filter((f) => !relative(ROOT, f).startsWith('90-归档'));

const res = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const hits = [];
  const hitTerms = new Set();
  lines.forEach((ln, i) => {
    const matched = terms.filter((t) => ln.toLowerCase().includes(t.toLowerCase()));
    if (!matched.length) return;
    if (AND && matched.length !== terms.length) return;
    matched.forEach((t) => hitTerms.add(t));
    hits.push({ n: i + 1, ln: ln.trim().slice(0, 160) });
  });
  if (!hits.length) continue;
  const r = relative(ROOT, f).replace(/\\/g, '/');
  const nameHit = terms.some((t) => basename(f).toLowerCase().includes(t.toLowerCase())) ? 3 : 0;
  const prio = PRIORITY.findIndex((p) => r.startsWith(p));
  res.push({ file: r, hits, score: hitTerms.size * 2 + nameHit + (prio >= 0 ? 3 - prio * 0.2 : 0) });
}
res.sort((a, b) => b.score - a.score);

const total = res.length;
console.log(`🔎 召回「${terms.join(AND ? ' + ' : ' / ')}」 → 命中 ${total} 个文件${ALL ? '（含归档）' : ''}\n`);
for (const r of res.slice(0, N)) {
  console.log(`📄 ${r.file}  (${r.hits.length} 处)`);
  for (const h of r.hits.slice(0, 6)) console.log(`   L${h.n}: ${h.ln}`);
  if (r.hits.length > 6) console.log(`   … 另有 ${r.hits.length - 6} 处`);
}
if (total > N) console.log(`\n（只显示前 ${N} 个文件，用 --n 调大）`);
if (total === 0) console.log('🔴 MISS：0 命中。若你确认库里确实有相关内容，请在 [[_AI/召回日志]] 里标 ✗ —— 累计 5 次即触发"是否上向量库"的复评。');

// 日期/时间一律用本地时间（toISOString 是 UTC，凌晨跑会把产物盖成前一天）
const localDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const localStamp = (d = new Date()) =>
  `${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// 记账（供失效线使用）——只在 0 命中时写：有命中的查询对失效线零作用，却会让被跟踪的日志每次跑都变脏。
if (total === 0) {
  try {
    const logPath = join(ROOT, '_AI', '召回日志.md');
    if (!fs.existsSync(logPath)) {
      const head = [
        '---', 'type: meta', 'tags: [召回, 日志]',
        `created: ${localDate()}`, `updated: ${localDate()}`, '---', '',
        '# 召回日志', '',
        '> 由 `scripts/recall.mjs` **只在 0 命中时**自动追加一行。用途：判断"关键字版召回"是否还够用（见脚本头部三条触发线）。',
        '> 0 命中的行请人工补标 `✗ 应命中`（确属漏检）或 `✓ 本来就没有`。', '',
        '| 时间 | 查询 | 命中文件数 | 人工标注 |', '|---|---|---|---|', '',
      ].join('\n');
      fs.writeFileSync(logPath, head, 'utf8');
    }
    const ts = localStamp();
    // 查询词里的 | 会破表（一行多出单元格）⇒ 写入前把 | 换成 /（原词在控制台输出里仍可见）。
    const q = terms.join(' ').replace(/\|/g, '/');
    fs.appendFileSync(logPath, `| ${ts} | ${q}${AND ? ' (AND)' : ''} | ${total} | |\n`, 'utf8');
  } catch (e) {
    console.log('（召回日志写入失败，不影响本次结果：' + e.code + '）');
  }
}