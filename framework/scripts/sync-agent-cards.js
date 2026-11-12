#!/usr/bin/env node
/**
 * sync-agent-cards.js —— 全局薄卡（B 型载体）同步器
 *
 * 每个 AI 工具认自己路径下的开场文件（如 ~/.config/<工具>/AGENTS.md 之类），
 * 手抄多份必然漂移。本脚本把「50-工具/卡片/源-全局卡.md」作为唯一源，生成/校验所有目标。
 *
 * 用法：
 *   node scripts/sync-agent-cards.js --check                 # 只比对，不改文件；有问题 exit 1
 *   node scripts/sync-agent-cards.js --target "工具A=~/.config/工具A/AGENTS.md" --check
 *   node scripts/sync-agent-cards.js --target "工具A=~/.config/工具A/AGENTS.md" --write --yes
 *
 * 🔴 安全闸：`--write` **必须**同时带 `--yes`，否则只打印将覆盖的路径并 exit 1，绝不写文件。
 *    带 `--yes` 写入前，旧文件自动备份到 90-归档/卡片备份/。
 *
 * 目标路径可配：`--target "标签=路径"`（可重复）指定要同步的工具全局卡；不指定则无目标。
 *    路径里的 `~` 会展开为用户主目录。新增工具＝加一个 --target；摘除＝不再传它。
 *
 * 报警分型：漂移（文件在、内容≠源＝有人手改了生成物）／未装（登记了但本机找不到目录）／失败，
 *    各占一行各有一个数，不混成一个数稀释真漂移。单个目标失败不拖垮整脚本。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '50-工具', '卡片', '源-全局卡.md');
const BACKUP_DIR = join(ROOT, '90-归档', '卡片备份');

const argv = process.argv.slice(2);
const mode = argv.includes('--write') ? 'write' : 'check';
const confirmed = argv.includes('--yes');

/** 解析 --target "标签=路径"（可重复）；~ 展开为主目录。不指定则无目标。 */
function parseTargets() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--target') continue;
    const spec = argv[i + 1];
    if (!spec || !spec.includes('=')) {
      console.error(`❌ --target 需要 "标签=路径" 形式，收到：${spec ?? '(空)'}`);
      process.exit(1);
    }
    const eq = spec.indexOf('=');
    const label = spec.slice(0, eq).trim();
    let p = spec.slice(eq + 1).trim();
    if (p.startsWith('~')) p = join(homedir(), p.slice(1));
    out.push({ label, path: p });
    i++;
  }
  return out;
}
const TARGETS = parseTargets();

const BANNER =
  '<!-- ⚠️ 本文件由 scripts/sync-agent-cards.js 从 50-工具/卡片/源-全局卡.md 生成，请勿手改；\n' +
  '     要改内容请改源文件，然后运行：node scripts/sync-agent-cards.js --write --yes -->\n\n';

// 备份戳用本地时间（toISOString 是 UTC，凌晨跑会把备份盖成前一天）
const stamp = (() => {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
})();

/** 取正文：丢掉 frontmatter 与「独占一行的 <!-- EMIT -->」之前的维护者说明 */
function emitBody(src) {
  let s = readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const m = s.match(/^<!--\s*EMIT\s*-->[ \t]*\r?\n/m);
  if (m) s = s.slice(m.index + m[0].length);
  return s.replace(/^\s*\n/, '');
}

if (!existsSync(SRC)) {
  console.error(`❌ 找不到源卡：${SRC}`);
  process.exit(1);
}
const want = BANNER + emitBody(SRC);

// 🔴 --write 安全闸：不带 --yes ⇒ 只打印将覆盖路径，exit 1，不写任何文件。
if (mode === 'write' && !confirmed) {
  console.log('⛔ --write 必须同时带 --yes 才会写文件（防误覆盖全局卡）。');
  if (TARGETS.length) {
    console.log('   本次将覆盖以下目标：');
    for (const t of TARGETS) console.log(`   · ${t.label}  ${t.path}`);
  } else {
    console.log('   （尚未配置目标；用 --target "标签=路径" 指定。）');
  }
  console.log('   确认无误后重跑：node scripts/sync-agent-cards.js --write --yes …');
  process.exit(1);
}

if (!TARGETS.length) {
  console.log('ℹ️ 未配置目标。用 --target "标签=路径" 指定你的工具全局卡，例如：');
  console.log('   node scripts/sync-agent-cards.js --target "工具A=~/.config/工具A/AGENTS.md" --check');
  process.exit(mode === 'write' ? 1 : 0);
}

const drift = [];    // 漂移：文件在、内容 ≠ 源
const absent = [];   // 未装：登记了但本机找不到目录
const failed = [];   // 其它失败
const problems = () => drift.length + absent.length + failed.length;

for (const t of TARGETS) {
  try {
    const cur = existsSync(t.path) ? readFileSync(t.path, 'utf8') : null;
    if (cur === want) {
      console.log(`✅ ${t.label} 已同步  ${t.path}`);
      continue;
    }
    if (mode === 'check') {
      if (!existsSync(dirname(t.path))) absent.push(t);
      else drift.push(t);
      continue;
    }
    // write（已带 --yes）：建父目录 → 备份旧文件 → 写入
    mkdirSync(dirname(t.path), { recursive: true });
    if (cur !== null) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const bak = join(BACKUP_DIR, `${basename(dirname(t.path))}-${basename(t.path)}.${stamp}.bak`);
      copyFileSync(t.path, bak);
      console.log(`📦 已备份旧文件 → ${bak}`);
    }
    writeFileSync(t.path, want, 'utf8');
    console.log(`✍️  ${t.label} 已写入  ${t.path}`);
  } catch (e) {
    failed.push({ t, why: e.code || e.message });
  }
}

if (drift.length) {
  console.log(`\n🔴 漂移 ${drift.length} 个（文件在、内容 ≠ 源 ⇒ 有人手改了生成物）：`);
  for (const t of drift) console.log(`   · ${t.label}  ${t.path}`);
  console.log('   ⇒ 处置：那处手改若是有意的，回写到 50-工具/卡片/源-全局卡.md；否则重跑 --write --yes。');
}
if (absent.length) {
  console.log(`\n⚠️ 未装 ${absent.length} 个（登记着该工具，但本机找不到它的目录）：`);
  for (const t of absent) console.log(`   · ${t.label}  ${t.path}`);
  console.log('   ⇒ 处置：① 已弃用 ⇒ 不再传该 --target；② 还要用 ⇒ 装好后重跑 --write --yes。');
}
if (failed.length) {
  console.log(`\n❌ 写失败 ${failed.length} 个（不影响其它目标）：`);
  for (const x of failed) console.log(`   · ${x.t.label}  ${x.why}`);
}

if (mode === 'check') {
  console.log(problems()
    ? `\n结果：漂移 ${drift.length} · 未装 ${absent.length} · 失败 ${failed.length} —— 三类各有处置（见上）。`
    : '\n结果：全部一致。');
  process.exit(problems() ? 1 : 0);
}
const bad = absent.length + failed.length;
console.log(`\n结果：写入完成（源 ${SRC}）${bad ? `；另有 ${bad} 个目标没写成（见上）` : ''}。`);
process.exit(bad ? 1 : 0);