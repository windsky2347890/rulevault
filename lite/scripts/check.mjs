#!/usr/bin/env node
/**
 * 全库体检（轻量版）
 * 用法：node scripts/check.mjs
 *
 * 只查这 5 件事——每一项都对应"你会真的想修"的问题：
 *   1. 断链   —— [[双链]] 指向一个不存在的页面
 *   2. frontmatter —— .md 开头缺 --- 块、或缺 type
 *   3. 空文件 —— 建了却一直没写内容
 *   4. 临时文件残留 —— _tmp* / *.bak / ~$* / *.tmp
 *   5. 孤立页 —— 没有任何页面链到它
 *
 * 退出码：有问题 = 1，全绿 = 0。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IGNORE_DIRS = new Set(['scripts', '.git', 'node_modules', '.obsidian', '.tmp', '00-收件箱']);

// 这些目录里的文件不参与"断链出链"检查（它们是模板/归档/说明，允许指向未来才建的东西）
const NO_LINK_CHECK = ['_模板/', '90-归档/', '00-收件箱/', '_wiki/', '_AI/'];
// 这些目录里的文件不算"孤立页"
const NO_ORPHAN_CHECK = ['_wiki/', '_AI/', '90-归档/', '_模板/', '00-收件箱/', '30-自我/'];
// 这些文件豁免 frontmatter 要求
const NO_FM_CHECK = ['AGENTS.md', 'CLAUDE.md', 'README', '_wiki/', '_AI/'];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const inAny = (target, list) => list.some((x) => target.startsWith(x));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(ROOT);
const mdFiles = allFiles.filter((f) => f.endsWith('.md'));

// 建页面索引：完整相对路径（去 .md） 与 短名（basename）都能命中
const pageByPath = new Map();
const pageByBase = new Map();
for (const f of mdFiles) {
  const r = rel(f);
  pageByPath.set(r.replace(/\.md$/, ''), r);
  const base = path.basename(f, '.md');
  if (!pageByBase.has(base)) pageByBase.set(base, []);
  pageByBase.get(base).push(r);
}

const problems = { broken: [], nofm: [], empty: [], temp: [], orphan: [] };
const linkedFrom = new Map(); // 目标文件 → 引用它的文件集合

// ---------- 逐文件检查 ----------
for (const f of mdFiles) {
  const r = rel(f);
  const raw = fs.readFileSync(f, 'utf8');
  const text = raw.replace(/^\ufeff/, '');

  // 3. 空文件
  if (text.trim().length === 0) problems.empty.push(r);

  // 4. 临时文件（按名字，md 里也会有）
  if (/(^|\/)_tmp|\.bak$|~\$|\.tmp$/i.test(r)) problems.temp.push(r);

  // 2. frontmatter
  // 根目录的文档（AGENTS.md / README / DESIGN / LICENSE）是给人看的，不要求 frontmatter
  if (!inAny(r, NO_FM_CHECK) && r.includes('/')) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) problems.nofm.push(r + '  ← 缺整个 --- 块');
    else if (!/^\s*type\s*:/m.test(m[1])) problems.nofm.push(r + '  ← 有 --- 块但缺 type');
  }

  // 1. 断链（本文件里的出链）
  if (!inAny(r, NO_LINK_CHECK)) {
    // 先剥掉行内代码（`...`）——写在反引号里的 [[双链]] 是举例，不算真链接
    const noCode = text.replace(/`[^`]*`/g, '');
    const links = [...noCode.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
    for (let target of links) {
      target = target.split('|')[0].split('#')[0].trim().replace(/\\+$/, '');
      if (!target) continue;
      if (target.includes('{{') || target.includes('<')) continue; // 占位符跳过
      const hit =
        pageByPath.get(target.replace(/\.md$/, '')) ||
        (pageByBase.get(target.replace(/\.md$/, '')) || [])[0] ||
        (pageByBase.get(target) || [])[0];
      if (!hit) problems.broken.push(`${r}  →  [[${target}]]`);
      else {
        if (!linkedFrom.has(hit)) linkedFrom.set(hit, new Set());
        linkedFrom.get(hit).add(r);
      }
    }
  }
}

// 4b. 非 md 的临时文件也算
for (const f of allFiles) {
  const r = rel(f);
  if (/(^|\/)_tmp|\.bak$|~\$|\.tmp$/i.test(r) && !r.endsWith('.md')) problems.temp.push(r);
}

// 5. 孤立页
for (const f of mdFiles) {
  const r = rel(f);
  if (inAny(r, NO_ORPHAN_CHECK)) continue;
  if (!r.includes('/')) continue; // 根目录的 AGENTS.md / README 不算孤立
  if (!linkedFrom.has(r)) problems.orphan.push(r);
}

// ---------- 报告 ----------
const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
console.log(`\n# 全库体检（轻量版） ${today}\n`);
console.log(`扫描 ${mdFiles.length} 个 Markdown 文件。\n`);

function section(no, title, list, hint) {
  const mark = list.length === 0 ? '✅' : '⚠️';
  console.log(`## ${no}. ${title}：${list.length} 处 ${mark}`);
  if (hint) console.log(`> ${hint}`);
  for (const x of list.slice(0, 40)) console.log(`- ${x}`);
  if (list.length > 40) console.log(`- …还有 ${list.length - 40} 处`);
  console.log('');
}

section(1, '断链', problems.broken, '双链指向了不存在的页面。改链接，或把那个页面建出来。');
section(2, 'frontmatter', problems.nofm, '每个笔记开头应有 frontmatter 三行——第一行 ---、中间一行 type: xxx、最后一行 ---。type 用 record / node / topic / project / note / entity 都行。');
section(3, '空文件', problems.empty, '建了却一直没写。要么写点东西，要么删掉。');
section(4, '临时文件残留', problems.temp, '这些不该留在库里：_tmp* / *.bak / ~$* / *.tmp。');
section(5, '孤立页', problems.orphan, '没有任何页面链到它。试着从相关页面加一条 [[双链]]，否则它迟早被忘掉。');

const total = Object.values(problems).reduce((s, x) => s + x.length, 0);
console.log('---');
if (total === 0) {
  console.log('✅ 全绿：5 项检查都没发现问题。\n');
  process.exit(0);
} else {
  console.log(`⚠️ 共 ${total} 处待处理（都不是致命错误，挑你想修的改）。\n`);
  process.exit(1);
}
