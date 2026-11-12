#!/usr/bin/env node
/**
 * session-open.mjs —— 开场自检（把开场要素一次性打出来 + 落开场证迹）
 *
 * 存在理由：漏开场此前零反馈（跳过开场照样取锁、照样写文件）。本脚本把账本/锁/待审/git
 *   一眼看完，并落一个时间戳文件 `_AI/.开场证迹`——write-lock add 校验它，没戳就拒绝取锁。
 * 输出末行即「开场证迹」，贴到本次会话第一条回复里（含库外维护任务）。
 *
 * 用法：node scripts/session-open.mjs
 * 退出码：0 ＝ 全测到；1 ＝ 找不到开场卡 AGENTS.md；2 ＝ 有字段测不到（git/待审）。
 *
 * 本包为零服务依赖骨架：不探模型服务/检索栈/代理/钩子/依赖体检（那些是可选升级，不在解压即用承诺内）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sessionTokenSource, gitStatusLines } from './lib/settle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 🔴 开场卡存在性检查（包内新增装置）：AGENTS.md 是 AI 认识用户与规则的最低保障，
//    缺了它开场就失去入口 ⇒ 非 0 退出并报「找不到开场卡」（先有装置再写进规则）。
if (!existsSync(join(ROOT, 'AGENTS.md'))) {
  console.error('❌ 找不到开场卡 AGENTS.md（包根）——它是 AI 每次开新会话认识你与规则的入口，缺了开场就失去保障。');
  console.error('   处置：恢复包根 AGENTS.md（或从备份补回），再跑开场自检。');
  process.exit(1);
}

const GIT = 'git'; // 用你自己的系统 git（没装就先别提交，见 README）
const env = { ...process.env };

// ── git 调用：用临时文件重定向，不用管道（沙箱禁命名管道时仍能真拿到输出）──
//   万一仍拿不到 ⇒ 显式报「测不到」，绝不把"没数到"渲染成 0。
function gitCapture(args, bin = GIT) {
  const tmp = join(tmpdir(), `kb-git-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    const r = spawnSync(bin, args, { cwd: ROOT, env, stdio: ['ignore', fd, 'ignore'] });
    closeSync(fd); fd = null;
    if (r.error) return { ok: false, why: r.error.code || r.error.message, out: '' };
    const out = readFileSync(tmp, 'utf8').trim();
    return { ok: r.status === 0, why: r.status === 0 ? '' : `git 退出码 ${r.status}`, out };
  } catch (e) {
    return { ok: false, why: e.code || e.message, out: '' };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 已关 */ } }
    try { unlinkSync(tmp); } catch { /* 没建成就没什么可删 */ }
  }
}

const p2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;

// ── 账本 ─────────────────────────────────────────────
const LEDGER_FRESH_MIN = 30;
let ledgerLine = '账本读取失败';
let ledgerOk = false;
let ledgerOpen = false;
let ledgerAnchor = '—';
let ledgerLastStatus = '（无锚点）';
try {
  const txt = readFileSync(join(ROOT, '_AI', '变更账本.md'), 'utf8');
  const titles = [...txt.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · status: (\S+)/gm)];
  const opens = titles.filter((m) => m[2] === '进行中').map((m) => m[1]);
  const latest = titles[0];
  const fresh = opens.filter((t) => now - new Date(t.replace(' ', 'T') + ':00') < LEDGER_FRESH_MIN * 60 * 1000);
  const stale = opens.filter((t) => !fresh.includes(t));
  ledgerOpen = fresh.length > 0;
  ledgerOk = stale.length === 0;
  const none = titles.length === 0;
  const lastStatus = latest ? latest[2] : '';
  const parts = [];
  parts.push(ledgerOpen
    ? `已开 ✅（${fresh.length} 条进行中）`
    : none
      ? '未开 ⚠️（账本里没有任何锚点 ⇒ 本次没跑 --start）'
      : `未开 ⚠️（0 条进行中；最近一条 ${latest[1]} 是「${lastStatus}」⇒ 若那是你刚收的尾，本次接着干要先 --start）`);
  if (stale.length) parts.push(`⚠️ 另有旧账未收尾 ${stale.length} 条（${stale.join('、')}）`);
  if (ledgerOpen || none) parts.push(`最近一条 ${latest ? latest[1] : '—'}`);
  ledgerLine = parts.join(' · ');
  ledgerAnchor = latest ? latest[1] : '—';
  ledgerLastStatus = lastStatus || '（无锚点）';
} catch { ledgerAnchor = '—'; ledgerLastStatus = '（读取失败）'; }

// ── 写锁 ─────────────────────────────────────────────
const lockPath = join(ROOT, '_AI', '.写锁');
let lockLine = '无锁 ✅', lockN = 0;
if (existsSync(lockPath)) {
  const rows = readFileSync(lockPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  lockN = rows.length;
  lockLine = lockN ? `${lockN} 行（写入前先 check 交集）` : '空文件 ✅';
}

// ── git ──────────────────────────────────────────────
const headR = gitCapture(['rev-parse', '--short', 'HEAD']);
// ⚠️ 路径基准：porcelain 报的是**相对 git 根**，整仓布局下若直接数会把包外改动也算进来
//   ⇒ 走 `gitStatusLines` 归一到包根。
let dirty = null;
let dirtyOk = false;
try {
  dirty = gitStatusLines(ROOT).length;
  dirtyOk = true;
} catch { dirty = null; }
const gitOk = headR.ok && dirtyOk;
const head = headR.ok ? (headR.out || '（无提交）') : '测不到⚠️';
const gitField = gitOk
  ? `HEAD ${head} · 未提交 ${dirty} 项${dirty === 0 ? ' ✅' : ''}`
  : '无仓库/无 git ⚠️（HEAD 与未提交数测不到，不当 0）';

// ── 待审 pending ─────────────────────────────────────
const pendDir = join(ROOT, '_AI', '待审');
let pending = [];
let malformed = [];
let todoN = 0;
let pendRead = true;
if (existsSync(pendDir)) {
  try {
    for (const f of readdirSync(pendDir)) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const t = readFileSync(join(pendDir, f), 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
      const status = (/^status:\s*(\S+)/m.exec(fm ? fm[1] : '') || [])[1];
      const type = (/^type:\s*(\S+)/m.exec(fm ? fm[1] : '') || [])[1];
      if (type === 'todo') todoN++;
      else if (status === 'pending') pending.push(f.replace(/\.md$/, ''));
      else malformed.push(`${f.replace(/\.md$/, '')}（${status ? `status: ${status}` : '缺 status'}）`);
    }
  } catch { pendRead = false; }
}

// ── 卡片同步（只读 --check；目标由 sync-agent-cards 的 --target 配置）─────────
let cardLine = '卡片同步：未配置目标（用 sync-agent-cards --target 指定）';
{
  const tmp = join(tmpdir(), `kb-card-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-agent-cards.js'), '--check'], { cwd: ROOT, env, stdio: ['ignore', fd, 'ignore'], timeout: 15000 });
    closeSync(fd); fd = null;
    const out = readFileSync(tmp, 'utf8');
    if (/全部一致/.test(out)) cardLine = '卡片同步：与源卡一致 ✅';
    else if (/未配置目标/.test(out)) cardLine = '卡片同步：未配置目标（--target 指定）';
    else if (/漂移|未装/.test(out)) cardLine = '卡片同步：不一致 ⚠️（跑 sync-agent-cards.js --check 看明细）';
  } catch { /* 测不到不拦开场 */ }
  finally { if (fd !== null) { try { closeSync(fd); } catch {} } try { unlinkSync(tmp); } catch {} }
}

// ── 开场戳：把"开场"变成写锁的前置条件 ─────────────────
const STAMP_PATH = join(ROOT, '_AI', '.开场证迹');
let stampLine = '开场戳：写入失败 ⚠️';
try {
  writeFileSync(
    STAMP_PATH,
    `${now.toISOString()}\nHEAD ${headR.ok ? (headR.out || '（无提交）') : '测不到'}\n` +
    `# session-open 自动落盘；write-lock add 会校验它。瞬态文件，已 gitignore。\n`,
    'utf8'
  );
  stampLine = `开场戳：已写 _AI/.开场证迹（${now.toISOString()}）`;
} catch (e) {
  stampLine = `开场戳：写入失败 ⚠️（${e.code || e.message}）——write-lock add 将被闸门拦下`;
}

// ── 输出 ─────────────────────────────────────────────
console.log('═══ 开场自检（session-open）═══');
console.log(`时间：${stamp}`);
console.log(`账本：${ledgerLine}`);
console.log(`写锁：${lockLine}`);
console.log(stampLine);
console.log(`git ：${gitField}`);
console.log(`待审：${pendRead ? `${pending.length} 条 pending` : '测不到 ⚠️'}${pendRead && malformed.length ? `（另 ${malformed.length} 份格式不符${todoN ? `／待办 ${todoN}` : ''}）` : ''}`);
console.log(cardLine);
console.log('──────────────────────────────');
console.log('把下一行（含动态值）贴到本次会话第一条回复：');
console.log(
  `开场:${ledgerOk && ledgerOpen && dirty === 0 && pendRead ? '✅' : '⚠️'} ${stamp} / ${gitField} / ` +
  `账本:${ledgerOpen ? '已开' : '未开⚠️'}${ledgerOk ? '' : '·有旧账'}（最近 ${ledgerAnchor} ${ledgerLastStatus}） / ` +
  `${lockN ? `锁 ${lockN} 行` : '锁无'} / 待审${pendRead ? pending.length : '?'}${pendRead && malformed.length ? `（另${malformed.length}份格式不符${todoN ? `／待办${todoN}` : ''}）` : ''}`
);
{
  const src = sessionTokenSource();
  if (src.source === 'file') {
    console.log(`⚠️ 本次没设 env ⇒ 身份只能读共享单槽文件 _AI/.会话身份 ⇒ 里面那个 id 可能是别的会话的（多会话并存时后来者覆盖它）。`);
    console.log(`   文件里那个：${src.raw}`);
    console.log(`   ⇒ 若它就是你这一轮的会话 id ⇒ 跑协议脚本前设：KB_SESSION_ID='${src.raw}'`);
    console.log(`   ⇒ 若不是你的：别设它（设了＝冒用别人身份 ⇒ 锁行盖错戳）⇒ 用你自己那行的 id。`);
  } else if (src.source === 'env') {
    console.log(`✅ 本次身份已由 env 提供（KB_SESSION_ID 生效中）⇒ 锁行归属可信。`);
  } else {
    console.log(`⚠️ 拿不到会话身份（KB_SESSION_ID 未设 ＋ 无身份文件）⇒ 锁行归属「不可判」⇒ 撞区判定会偏弱。`);
    console.log(`   有会话 id 的话先设：KB_SESSION_ID='<你的会话 id>'`);
  }
}

// 退出码：环境测不到 → 2（证迹行已打印，非 0 照样可贴，只表示有字段没测到）。
if (!gitOk || !pendRead) process.exitCode = 2;