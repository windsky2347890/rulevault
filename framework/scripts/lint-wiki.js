#!/usr/bin/env node
/**
 * lint-wiki.js —— 知识库通用体检（七项）
 *
 * 用法：node scripts/lint-wiki.js             # 打印报告
 *       node scripts/lint-wiki.js --out f.md  # 同时把报告写入文件
 *
 * 检查项（只保留与「库里写了什么内容」无关的通用项＋废弃说法附项）：
 *   1 断链 / 2 frontmatter / 3 空文件 / 4 临时残留 / 5 孤立页 / 6 收尾证迹 / 7 区域表与代码一致
 *
 *   🔴 **第 7 项为什么必须在这里**（一次评审实测）：`regions.mjs` 注释写着「改完必须重跑
 *   lint-wiki.js」，但 lint 原先**不 import regions** ⇒ 给 `regions.mjs` 注入第 9 个区域后
 *   lint 仍「0 阻断」——**「必须重跑」不构成校验**。现在 lint 直接调 `compareRegionTable`
 *   读 `_wiki/schema.md` 的表格与代码里的 `REGION_PREFIX` 对表，不一致 ⇒ 提醒（不阻断，
 *   因为区域表是文档-代码一致性，不是结构性错误；但漏报会导致写锁区域判定错）。
 *
 * 判据口径（本包自洽）：
 *   - 断链：[[双链]] 先按路径、再按文件名解析；语法示例占位符跳过；归档/历史文件不计
 *   - 收尾证迹：日志里带日期的条目须有「收尾:」行，缺 ⇒ 阻断
 *   - 其余四项 ⇒ 提醒，不阻断
 *   - 退出码只由阻断项决定；提醒项全部归零才算「干净」
 *
 * 零依赖：只用 Node 内置模块，不需要索引、向量库、git、插件或任何服务。
 * 想加自己库里的「废弃说法」检查 ⇒ 改下面 STALE 表（只留了一条示例，见该节注释）。
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRegionTable } from './lib/regions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
const L = [];
const say = (s = '') => L.push(s);

/** 遍历所有 .md（跳过点开头的隐藏项与依赖目录） */
function walkMd(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkMd(p, out);
    } else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 遍历所有文件（临时残留检查用，不只 .md） */
function walkAny(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkAny(p, out);
    } else out.push(p);
  }
  return out;
}

const files = walkMd(ROOT).sort();
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const isArch = (p) => rel(p).startsWith('90-归档/');
const isHistorical = (p) => isArch(p) || /(_wiki\/log|_AI\/会话日志|_AI\/踩坑录)\.md$/.test(rel(p)) || /_AI\/体检报告-/.test(rel(p));

// 日期一律用本地时间：toISOString() 是 UTC，凌晨跑会把报告盖成前一天
const localDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 建索引：路径（去 .md）→ 文件；文件名 → 文件[] */
const byPath = new Map();
const byBase = new Map();
for (const f of files) {
  const r = rel(f).replace(/\.md$/, '');
  byPath.set(r, f);
  const b = basename(f, '.md');
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(f);
}

say(`# 知识库体检报告（${localDate()}）`);
say('');
say(`扫描 ${files.length} 个 Markdown 文件。`);
say('');

// ── 1. 断链 ──────────────────────────────────────────────
// 占位符是文档里「教你写双链」用的示例，不是真链接，跳过。
// 同名多页：按文件名回退解析时出现多个候选 ⇒ 判为歧义，与断链同列（阻断）。
const PLACEHOLDER = new Set(['双链', '页面名', 'wikilink', '#', '标题']);
const inbound = new Map();
const broken = [];
const linkRe = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
for (const f of files) {
  const txt = readFileSync(f, 'utf8');
  for (const m of txt.matchAll(linkRe)) {
    const raw = m[1].trim();
    if (!raw || PLACEHOLDER.has(raw)) continue;
    const target = raw.replace(/\\+$/, '').replace(/^\.\//, '').replace(/\.md$/, '');
    const line = txt.slice(0, m.index).split('\n').length;
    let hit = null;
    if (byPath.has(target)) hit = byPath.get(target);
    else if (byBase.has(basename(target))) {
      const cands = byBase.get(basename(target));
      hit = cands[0];
      if (cands.length > 1 && !isHistorical(f)) {
        broken.push({ from: rel(f), line, target: raw, type: '歧义（同名多页）', cands: cands.map(rel) });
        continue;
      }
    }
    if (!hit) broken.push({ from: rel(f), line, target: raw, type: '不存在' });
    else {
      if (!inbound.has(hit)) inbound.set(hit, new Set());
      inbound.get(hit).add(rel(f));
    }
  }
}
const brokenReal = broken.filter((b) => !isHistorical(join(ROOT, b.from)));
say(`## 1. 断链：${brokenReal.length} 处（阻断项；历史/归档文件不计；语法示例占位符已跳过）`);
const byType = {};
for (const b of brokenReal) (byType[b.type] ||= []).push(b);
for (const [t, arr] of Object.entries(byType)) {
  say(`- **${t}** ${arr.length} 处`);
  for (const b of arr.slice(0, 40)) say(`  - \`${b.from}:${b.line}\` → [[${b.target}]]${b.cands ? '（候选：' + b.cands.join(' / ') + '）' : ''}`);
  if (arr.length > 40) say(`  - …还有 ${arr.length - 40} 处`);
}
say('');

// ── 2. frontmatter ───────────────────────────────────────
// 豁免：归档/收件箱/模板/元信息区、素材区、根目录单页、随代码走的工程文档。
// 这些页天生不进双链网络，也不套用库页的 frontmatter 规范。
const EXEMPT = ['90-归档/', '00-收件箱/', '_模板/', '_AI/', '20-知识/notes/', '20-知识/sources/', '20-知识/transcripts/'];
const ENGINEERING_DOC = [/\/docs\//, /\/(CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE|SECURITY)\.md$/i];
const isExempt = (p) => EXEMPT.some((e) => rel(p).startsWith(e)) || !rel(p).includes('/') || ENGINEERING_DOC.some((re) => re.test(rel(p)));

const noFm = [];
const noType = [];
for (const f of files) {
  if (isExempt(f)) continue;
  const txt = readFileSync(f, 'utf8');
  if (!/^---\r?\n/.test(txt)) { noFm.push(f); continue; }
  const end = txt.search(/\r?\n---/);
  const fm = end > 0 ? txt.slice(txt.indexOf('\n') + 1, end) : '';
  if (!/^type:\s*\S/m.test(fm)) noType.push(f);
}
say(`## 2. Frontmatter：缺整块 ${noFm.length} 个 / 有块但缺 type ${noType.length} 个（提醒项）`);
for (const f of [...noFm, ...noType].slice(0, 30)) say(`- \`${rel(f)}\``);
say('');

// ── 3. 空文件 ────────────────────────────────────────────
// 空壳目录也该放一份「这页是干什么的」说明；真 0 字节页视为遗漏。
const empty = files.filter((f) => statSync(f).size === 0 && !isArch(f));
say(`## 3. 空文件：${empty.length} 个（提醒项）`);
for (const f of empty.slice(0, 30)) say(`- \`${rel(f)}\``);
say('');

// ── 4. 临时残留 ──────────────────────────────────────────
const junk = walkAny(ROOT).filter((f) => /\.(bak|tmp|old)$|~$/.test(rel(f)));
const loose = readdirSync(ROOT).filter((n) => /^(\.tmp-|tmp-|untitled)/i.test(n));
const runtime = ['_AI/.写锁', '_AI/.开场证迹'].filter((p) => existsSync(join(ROOT, p)));
say(`## 4. 临时残留：备份/临时文件 ${junk.length} 个 / 根目录散落 ${loose.length} 个（提醒项）`);
for (const f of junk.slice(0, 20)) say(`- \`${rel(f)}\``);
for (const n of loose.slice(0, 20)) say(`- \`${n}\``);
say(`- 运行时状态文件：${runtime.length ? runtime.join('、') + '（装置产物，已在 .gitignore 中，不计入残留）' : '无'}`);
say('');

// ── 5. 孤立页 ────────────────────────────────────────────
// 判据：没有任何入链。索引页/导航页正是给全库补入链的地方，不在豁免里。
const orphans = files.filter((f) => !isExempt(f) && !inbound.has(f));
say(`## 5. 孤立页（无任何入链）：${orphans.length} 个（提醒项）`);
for (const f of orphans.slice(0, 40)) say(`- \`${rel(f)}\``);
if (orphans.length > 40) say(`- …还有 ${orphans.length - 40} 个`);
say('');

// ── 6. 收尾证迹 ──────────────────────────────────────────
// 带日期的日志条目末尾要写「收尾:」行：没写完的活不许假装完成。
// 通用口径：不预设某个库的立规日期，所有带日期条目一律判。
const TRACE_FILES = ['_wiki/log.md', '_AI/会话日志.md'];
function collectTraces(path) {
  if (!existsSync(join(ROOT, path))) return [];
  return readFileSync(join(ROOT, path), 'utf8')
    .split(/\n(?=## )/)
    .filter((b) => /^## \[?(20\d\d-\d\d-\d\d)/.test(b))
    .map((b) => ({ b, d: b.match(/^## \[?(20\d\d-\d\d-\d\d)/)[1] }));
}
let traceMissing = 0;
say('## 6. 收尾证迹（带日期的日志条目须有「收尾:」行；阻断项）');
for (const p of TRACE_FILES) {
  const dated = collectTraces(p);
  const miss = dated.filter((x) => !/收尾\s*[:：]/.test(x.b));
  traceMissing += miss.length;
  say(`- \`${p}\`：带日期条目 ${dated.length} 条，缺收尾证迹 ${miss.length} 条`);
  for (const m of miss.slice(0, 10)) say(`  - ${m.b.split('\n')[0].slice(0, 70)}`);
}
say('');

// ── 附：废弃说法表（可自填 · 提醒项）──────────────────────
// 表里只留一条示例。具体服务名／端口／模型档位都是各自库的历史，不通用，也不该预置。
// 填法：把不再使用的旧说法写进 re，why 写「为什么废弃」；命中行会在报告里提醒。
// 日期开头的历史条目、以及本身在解释「某说法已废弃」的元描述行，都不算命中。
const STALE = [
  { re: /示例占位-请替换/, why: '示例：这里填「已废弃的说法」及原因' },
];
const staleHits = [];
for (const f of files) {
  if (isHistorical(f)) continue;
  readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
    if (/^\s*[-*]\s*20\d\d-\d\d-\d\d/.test(ln)) return;
    if (/(别名|退化|并入|收敛|弃用|删除|现役)/.test(ln)) return;
    for (const s of STALE) if (s.re.test(ln)) staleHits.push({ f: rel(f), n: i + 1, why: s.why });
  });
}
say(`## 附：废弃说法：${staleHits.length} 处（提醒项；表见脚本内 STALE，按需替换示例）`);
for (const h of staleHits.slice(0, 20)) say(`- \`${h.f}:${h.n}\` → ${h.why}`);
say('');

// ── 7. 区域表与代码一致（接 compareRegionTable；提醒项）──
let regionHits = 0;
{
  const schemaPath = join(ROOT, '_wiki', 'schema.md');
  if (existsSync(schemaPath)) {
    const r = compareRegionTable(readFileSync(schemaPath, 'utf8'));
    if (!r.ok) {
      regionHits++;
      say('## 7. 区域表与代码一致：❌ 不一致');
      say('  代码里的区域（' + r.code.length + ' 个）：' + r.code.join(' / '));
      say('  schema 表里的区域（' + r.schema.length + ' 个）：' + r.schema.join(' / '));
      if (r.missingInSchema.length) say('  - **代码有、文档没有**：' + r.missingInSchema.join(' / '));
      if (r.missingInCode.length) say('  - **文档有、代码没有**：' + r.missingInCode.join(' / '));
      if (r.noPrefix.length) say('  - **有区域但无前缀映射**：' + r.noPrefix.join(' / '));
      say('');
    } else {
      say('## 7. 区域表与代码一致：✅（' + r.code.length + ' 个区域，双向对齐）');
      say('');
    }
  }
}

// ── 结论 ────────────────────────────────────────────────
const blockers = brokenReal.length + traceMissing;
const reminders = noFm.length + noType.length + empty.length + junk.length + loose.length + orphans.length + staleHits.length + regionHits;
say('## 结论');
say(`- 阻断项：断链 ${brokenReal.length} + 缺收尾证迹 ${traceMissing} = **${blockers}**（>0 → exit 1）`);
say(`- 提醒项：frontmatter 缺失 ${noFm.length + noType.length} ／ 空文件 ${empty.length} ／ 临时残留 ${junk.length + loose.length} ／ 孤立页 ${orphans.length} ／ 废弃说法 ${staleHits.length} ／ 区域表不一致 ${regionHits} = **${reminders}**`);

const report = L.join('\n');
const outIdx = process.argv.indexOf('--out');
if (outIdx > -1 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], report, 'utf8');
  console.log(`报告已写入 ${process.argv[outIdx + 1]}（${report.length} 字符）`);
} else {
  console.log(report);
}
if (blockers > 0) {
  console.log(`⛔ 阻断项 ${blockers} 个 → exit 1`);
  process.exit(1);
}
console.log(reminders === 0 ? '✅ 0 阻断，提醒项归零' : `⚠️ 0 阻断，但提醒项 ${reminders} 个未归零`);
