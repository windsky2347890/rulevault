#!/usr/bin/env node
/**
 * session-ledger.mjs —— 变更账本（写会话的"开始/收尾"记账）
 *
 * 为什么：库里只有 log 和 git，缺"**哪次会话动了哪些文件**"的对应关系；工具自带的看板
 * 关掉就没了、换工具也读不到。本脚本把这件事**写进库**，可回翻、跨工具可读。
 * 机制（Change Ledger 思路）：① 干活前先留锚点 ② 收尾时核对实际改动 ③ 未收尾的下次开场点名（崩溃对账）
 *
 * 用法：
 *   node scripts/session-ledger.mjs --check              # 开场用：有没有"进行中"的旧账（**有 ⇒ exit 1**）
 *   node scripts/session-ledger.mjs --start "本次要干什么"  # 写会话开始：记锚点
 *   node scripts/session-ledger.mjs --end "<片段>"         # 收尾：**必须带 --start 时的说明片段**（锚归属校验）
 *   node scripts/session-ledger.mjs --end "<片段>" --takeover="<理由>"  # 关**别人的**账：必须显式接管并留痕
 *   node scripts/session-ledger.mjs --end "<片段>" --allow-dirty="<理由>"  # 越权收尾：**必须带非空理由**
 *
 * ⚠️ 锚归属：`--end` 现在会看"这账是谁的"——
 *   锚说明末尾有 `[会话:x]`：`x === 你` ⇒ 照旧；`x ≠ 你` ⇒ 必须 `--takeover="<理由>"`；
 *   **没写标记**（`--start` 时无身份，账本里相当一部分是这种）⇒ **不按"别人的"处理**，照旧放行＋告警；
 *   拿不到身份 ⇒ 不判。
 *   ⚠️ 接管时结账闸门判**并集**（你的行 ∪ 被接管的行），不是替换——否则接管=绕过结账。
 *
 * 退出码：
 *   0 ＝ 成功；1 ＝ 被拒／失败（`--check` 发现有未收尾也退 1）；2 ＝ 用法错；
 *   3 ＝ `--end` **已记账但明细不全**（指纹失败 ⇒ 不算全成功，账本已落盘、**别再重跑 --end**）。
 *
 * ⚠️ 锚归属校验：
 *   `--end` 只允许关闭**说明行包含指定片段**的"进行中"锚。裸 `--end` 一律拒绝——
 *   多会话并行时它会误关**别的会话**的锚（实测踩过：一次漏 --start 的 --end 关掉了并行会话的账，
 *   对方对账断链）。片段从你 --start 的说明里取，最短能唯一标识即可。
 *
 * 产物：`_AI/变更账本.md`（倒序追加，一条 = 一个写会话）。指纹用 `git hash-object`，
 * 与待审提案的 `target_hash` 同一种算法——所以"审阅后目标被改过"能被检出。
 *
 * 记账口径：`变更` 行的"总数"= git status 条数（**含未跟踪新文件**），
 * 括号里拆成"已跟踪 N 个：+a / -b 行"（来自 `git diff --shortstat HEAD`，只算已跟踪）
 * 与"新文件 M 个（未跟踪）"，N + M = 总数，两个数不再各说各话。
 * 🔴 两处 `git status` **都加 `--untracked-files=all`**。
 * 为什么：默认会把**未跟踪目录折叠成一条**（如 `?? _AI/tmp/`），而本脚本的**消费方**
 * （`lib/settle.mjs` 的 `dirtyPaths`／`unnamedInRegion`，用 `base.has(精确文件路径)` 判基线）
 * 只认**逐个文件路径** ⇒ 折叠串**永不命中** ⇒ `_AI/tmp/` 下那批文件**永远被报"未点名"**、
 * 永远要 `--allow-unnamed`。
 * ⚠️ 这样同一账本里"开账基线 N 项"与"变更 M 个文件"的口径才一致。
 * 注意：行数取自**收尾那一刻**的工作区 diff，不含本条目自身刚写入的几行，
 * 也不含 commit 时 autocrlf 的换行归一化差异 → 与最终 commit 的 `--stat` 可能略有出入，属正常。
 * 另：运行时状态文件（`_AI/.写锁`、`_AI/.开场证迹` 等）被 .gitignore 排除，不会出现在账本里。
 */

import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 🔴 git 读取统一走 settle.mjs：模块级静态 import——
//    本文件此前**自带一份弱判据副本**（只拦 spawn 层；fd 模式"起身后退出码 1、stdout 空"钻过去
//    ⇒ 把「没数到」写成「0 个文件」假数据），与 settle.mjs 头部「单一实现供多处
//    共用」的声称相悖。**漂移即根因**：副本已删；git 读取与 fail-closed 判据的**唯一实现**都在 settle.mjs。
//    ⚠️ 必须静态 import：动态 import 若放在 try 块里是**块作用域**，块外调用直接 ReferenceError。
import { git, gitBlobHash, sessionToken, sessionStamp, isMine, linesOfSession, unsettledForLines, unnamedForLines, parseLockLines, identitySourceWarn, sessionTokenSource, validAgentName, gitStatusLines, gitRootPrefix } from './lib/settle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, '_AI', '变更账本.md');
// 🔴 包冷启动可能在非 git 目录（或 git 未装）⇒ 先探一次，读不到就优雅降级，
//    绝不把「读不到」写成「0 个文件」假数据（fail-closed 口径见 settle.mjs git()）。
const GIT_OK = (() => { try { return git(ROOT, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).trim() === 'true'; } catch { return false; } })();
// （git 读取统一走上方 import 的 settle.mjs git()：判据与读取的**唯一实现**，见 settle.mjs 头部说明。）
// （原本地 git() 已删除—— 它只拦 spawn 层，
//   fd 模式"起身后退出码 1、stdout 空"钻过去写成假数据。读取统一走
//   settle.mjs 的 git()：**真 git 优先＋fail-closed 判据**，失败史见那边的注释。）
// 时间一律用**本地时间**：toISOString() 是 UTC，会让账本时间比实际早 8 小时（与 log/会话日志对不上）
const localDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const localStamp = (d = new Date()) =>
  `${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const now = () => localStamp();

// 🔴（一次评审 · 中）：**写进账本的自由文本必须单行化**。
//   病根：账本按 `\n## ` 切条目，而 `--allow-dirty=<理由>` / `--start <说明>` 都是 argv 原文直拼。
//   理由里带换行＋`## … · status: 进行中` 就能在账本里**伪造出一条"进行中"锚**（实测 `--end` rc=0、
//   随后 `--check` 每次开场都红，只能手改"生成物·勿手改"的账本来清）。
//   修法：换行 → ` ⏎ `；行首 `#` 转义，防止把理由读成标题。
const oneLine = (s) => {
  let t = String(s ?? '').replace(/[\r\n]+/g, ' ⏎ ');
  if (/^#/.test(t)) t = `\\${t}`;
  return t;
};

const HEADER = `---
type: meta
tags: [变更账本, 会话, 审计]
created: 2026-09-11
updated: 2026-09-11
related: [_AI/待审/README, _wiki/schema]
---

# 变更账本

> 由 \`scripts/session-ledger.mjs\` 维护（**生成物，勿手改**）。一条 = 一个写会话。
> 用途：① 任何改动可回溯到具体会话；② 覆盖/删除前有锚点；③ **未收尾的会话下次开场会被点名**。
> 定位：**这是账本（留证据、跨工具可读）**，不是工具自带的临时看板（关掉就没）。

`;

function read() {
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, HEADER, 'utf8');
  return fs.readFileSync(LEDGER, 'utf8');
}

/** 把正文按条目切块：返回 { head, entries: [{title, body}] } */
function parse(txt) {
  const i = txt.indexOf('\n## ');
  if (i === -1) return { head: txt.replace(/\s*$/, '\n'), entries: [] };
  const head = txt.slice(0, i + 1);
  const entries = txt.slice(i + 1).split(/\n(?=## )/).filter(Boolean).map((b) => {
    const nl = b.indexOf('\n');
    return { title: b.slice(0, nl === -1 ? undefined : nl).trim(), body: nl === -1 ? '' : b.slice(nl + 1).replace(/\s*$/, '') };
  });
  return { head, entries };
}
const render = ({ head, entries }) => head + entries.map((e) => `${e.title}\n${e.body}\n`).join('\n');

// ── 🔴 账本安全写回 ──────────
//   病根：账本若是「进程启动时读一次 → 内存改 → 整文件写回」，多会话并发时后写者会把对方
//   刚落的 --start／--end 静默覆盖。
//   修法：**每次尝试都重读最新内容、在新内容上重做改动**；写前最后一眼比对，写后复读确认落地。
//   重试上限 5 次，超限明确报错退出（⛔ 不许静默当成功）。
//   ⚠️ 为什么不上文件锁：_AI/变更账本.md 是免锁的追加型热点文件（任何会话都可写），
//     乐观重试与「热点文件重读重试」同款。
function commitLedger(mutate) {
  const MAX = 5;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    const cur = read();
    const parsed = parse(cur);
    const r = mutate(parsed) || {};
    if (r.ok === false) { console.log(r.msg || '❌ 账本写入被拒。'); process.exit(1); }
    if (read() !== cur) continue;                 // 期间被别人改过 ⇒ 重读重做
    const out = render({ head: parsed.head, entries: parsed.entries });
    fs.writeFileSync(LEDGER, out, 'utf8');
    if (read() === out) return true;              // 落地确认
  }
  console.log(`❌ 账本连续 ${MAX + 1} 次被并发改写打断 —— **未确认写入落地**，请重跑本命令。`);
  process.exit(1);
}

const arg = process.argv[2] || '--check';
// 🔴 身份留痕（设计说明 · 定稿）：
//   本脚本没有 opt()（note = argv.slice(3).join(' ')）⇒ 必须**先把 `--agent <名>` 从 argv 抽出**
//   再拼 note，否则 `--agent Lead` 原文会漏进锚点说明行（对齐 --takeover= 的剔除范式）。
//   语义＝调用方自证（attestation）非鉴权：[代理:名字] 标签进说明段、不升格式版本（lockline 只认 [格式vN]）。
const argvRest = process.argv.slice(3);
let agentName = '';
// `--agent=名` 等号形态显式拒绝（评审订正：静默忽略比报错危险）
if (argvRest.some((a) => typeof a === 'string' && a.startsWith('--agent='))) {
  console.error('❌ `--agent` 不支持等号形态（`--agent=名`）——请写成空格形态：`--agent 名`。');
  process.exit(2);
}
const agentIdx = argvRest.indexOf('--agent');
if (agentIdx >= 0 && argvRest[agentIdx + 1] && !argvRest[agentIdx + 1].startsWith('--')) {
  agentName = argvRest[agentIdx + 1];
  argvRest.splice(agentIdx, 2);   // 抽出 --agent 与其值，note 不含原文
} else if (agentIdx >= 0) {
  // 参数混淆 fail-closed：`--agent` 后无值或紧跟 flag ⇒ 拒绝
  console.error('❌ --agent 缺值（其后没有 token，或紧跟另一个 flag）——拒绝执行（防参数吞并）。');
  process.exit(2);
}
// 🔴🔴 注入漏洞修复（与 write-lock.mjs 同批 · 独立自测发现）：
//   未校验的 `--agent` 值可把协议标记注进**锚点说明行**（实测 `] [会话:伪造tok` 可伪造归属标记）。
//   修法＝fail-closed 白名单（字母/数字/下划线/短横/点/中文，≤40），非法直接拒绝执行。
//   ⚠️ 诚实边界：防"标记注入"，不防"谎报合法名字"（鉴权留第三阶段后期）。
// 白名单收敛为共享函数 validAgentName（lib/settle.mjs 唯一真源）
if (agentName && !validAgentName(agentName)) {
  console.error('❌ --agent 值非法，拒绝执行（防协议标记注入）：只允许「字母/数字/下划线/短横/点/中文」，长度 ≤40，且至少含一个字母/数字/中文。');
  console.error(`   收到：${JSON.stringify(agentName)}`);
  console.error('   ⚠️ 不要用 --agent 传说明文字；说明直接写在命令后面即可。');
  process.exit(2);
}
const note = argvRest.join(' ') || '(未填写说明)';
// 🔴  一次评审：身份**在分支之前**取一次。`--end` 的锚归属判定在本文件后半段的结账闸门里，
//   那里才第一次需要 `TOK`；`const` 是块作用域，不在前面取好就会 ReferenceError。`--start` / `--check` 复用同一个值。
const TOKSrc = sessionTokenSource();   // 🔴 来源**只用同一次读**（独立复核）
const TOK = TOKSrc.tok;
const { head, entries } = parse(read());
const openIdx = entries.findIndex((e) => e.title.includes('进行中'));

if (arg === '--check') {
  if (openIdx === -1) { console.log('✅ 变更账本：没有未收尾的会话。'); process.exit(0); }
  const t = entries[openIdx].title;
  // 修：原实现只截**日期**（丢掉标题里的时分）并交给
  // `Date.parse('YYYY-MM-DD')` —— V8 把它按 **UTC 午夜**解析，于是「距今」系统性算错：
  // 误差 = 条目时刻 − 本地 08:00，**方向随时刻变**（23:xx 的条目多算约 15h，上午的条目可能为负），
  // 连带 `hours > 24` 的升级阈值失准。现在：优先按「日期 + 时分」构造**本地时间**，退化时才用本地午夜。
  const anchorMs = (() => {
    const full = t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (full) return new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5]).getTime();
    const day = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    return day ? new Date(+day[1], +day[2] - 1, +day[3]).getTime() : null;
  })();
  const hours = anchorMs === null ? 0 : (Date.now() - anchorMs) / 3600000;
  console.log(`⚠️ 上一次写会话**未收尾**：${t}`);
  console.log(`   （距今约 ${hours.toFixed(1)} 小时${hours > 24 ? ' — 超过 24h，请检查是否改了一半' : ''}）`);
  console.log('   处理：确认库状态无异常后，跑 `node scripts/session-ledger.mjs --end "<该锚说明的片段>"` 补收尾。');
  const opener = entries.filter((e) => e.title.includes('进行中'));
  for (const e of opener) {
    const desc = (e.body.split('\n').find((l) => l.startsWith('- 说明：')) || '').replace('- 说明：', '').trim();
    console.log(`   · ${e.title} — 说明：${desc}`);
    // 一次评审定下的口径：--check 的提示按锚归属分叉——别人的账要告诉你怎么处置，而不是让你直接 --end。
    const mk = [...desc.matchAll(/\[会话:([^\]]+)\]/g)];
    const at = mk.length ? mk[mk.length - 1][1] : '';
    if (TOK && at && at !== TOK) {
      console.log(`     ↳ 这是**别人的**账（${at}）：请让其本人关，或带 --takeover="<理由>" 代收。`);
    }
  }
  // 评审：旧版 `exit(hours > 24 ? 1 : 0)` ⇒ **未收尾但 <24h 仍退 0**，
  //   退出码与"有没有未收尾"不同构（机械调用方会误判成干净）。现在：**存在「进行中」锚即退 1**；
  //   24h 只保留为"可能改了一半"的加急提示（上面那行）。⚠️ 这是**变严不变宽**。
  process.exit(1);
}

if (arg === '--start') {
  if (openIdx !== -1) console.log(`⚠️ 已有一条"进行中"（${entries[openIdx].title}），本次会追加新条目——请确认上一条是否需要先 --end。`);
  // 会话身份：把 `[会话:<tok>]` 写进「说明」行，
  //   让 `write-lock add` 的**账本闸门**能判定"本会话开过账没有"。旧锚没有该标记 ⇒ 闸门认不出
  //   归属 ⇒ **告警放行、不拦**（拿不到身份不假装认得出）。
  // ⚠️ `--end` 的片段匹配用的是 `includes`，追加后缀不影响它。
  //  评审：sessionToken 已在分支之前取（模块级 TOK），这里复用——不重复取身份。
  // 🔴 （独立复核）：**来源也落进锚块** —— 锚上的 `[会话:…]` 戳若是共享文件
  //   兜底来的 ⇒ **可能不是你的** ⇒ 事后审计（"这条锚到底是谁开的"）分不出来 ⇒ 补一个来源标签。
  //   ⚠️ 与锁行同款：在说明段内加标签，**不改字段、不升格式版本**。
  const owner = TOK ? ' ' + sessionStamp(TOK) + ` [身份:${TOKSrc.source}]` : '';
  // 🔴  身份留痕：`--agent <名>` ⇒ 锚点说明段补 [代理:名字]（自证留痕；不升格式版本）。
  //   tok 只能区分"哪条会话"（UUID 不可人读），[代理:] 补的是"哪个角色"（三向核对的人读归属）。
  const agentTag = agentName ? ` [代理:${agentName}]` : '';
  // ⚠️ 路径基准：porcelain 报的是**相对 git 根**，`gitStatusLines` 已归一到包根并丢弃包外改动
  const dirtyLines = GIT_OK ? gitStatusLines(ROOT) : [];
  const dirty = dirtyLines.length;
  // 🔴 开账基线：把"开账时**已经在改**的文件"记进锚块，
  //   供 `settle.mjs baselineOf()` 把**别人的在制品**排除出本会话的提交范围（治"区域级暂存"）。
  //   ⚠️ 不含 ALWAYS 两件（会话日志／变更账本）：追加型共享文件，本来就不按会话切分。
  //   ⚠️ 改名行**两侧路径都记** —— 少记一侧就会"漏排除"，正是要治的病。
  const porcelainPaths = (l) => {
    const raw = l.slice(3).trim().replace(/^"|"$/g, '');
    return raw.includes(' -> ')
      ? raw.split(' -> ').map((s) => s.trim().replace(/^"|"$/g, ''))
      : [raw];
  };
  const baseList = [...new Set(dirtyLines.flatMap(porcelainPaths))]
    .filter((p) => p && p !== '_AI/会话日志.md' && p !== '_AI/变更账本.md');
  const entry = {
    title: `## ${now()} · status: 进行中`,
    body: [
      `- 说明：${oneLine(note)}${owner}${agentTag}`,
      `- 锚点：HEAD = ${GIT_OK ? (git(ROOT, ['rev-parse', '--short', '--verify', '--quiet', 'HEAD'], { allowFail: true }).trim() || '(无提交)') : '(无 git)'}，开始时工作区 ${GIT_OK ? (dirty === 0 ? '干净' : `${dirty} 项未提交`) : '无法检测（无 git）'}`,
      `- 开账基线（开账时已在改·不算本会话）：${GIT_OK ? (baseList.length ? JSON.stringify(baseList) : '无') : '无法检测（无 git）'}`,
      `- 收尾：待填`,
    ].join('\n'),
  };
  commitLedger((p) => { p.entries.unshift(entry); return { ok: true }; });
  console.log(`✅ 已记锚点：${entry.title}`);
  // 🔴 身份来源可见：锚上的 [会话:…] 戳来自 sessionToken() ⇒ 身份若是共享单槽文件兜底来的，
  //   戳可能盖成别人的（多会话并存时后启动者覆盖那个文件）⇒ 后续 --end 归属错乱、撞区判定失真。
  //   ⇒ 开账这一刻就把来源与风险打出来（账本是错戳最先落地的地方 ⇒ 告警要落在这里）。
  {
    const w = identitySourceWarn('  ', TOKSrc);
    if (w) console.log(w);
  }
  process.exit(0);
}

if (arg === '--end') {
  // ── `--allow-dirty` 必须带非空理由 ───────────────
  //   病根：旧代码只 `find(a => a.startsWith('--allow-dirty'))` ⇒ **裸 flag 也算"有理由"**，
  //   于是"越权收尾"的留痕通道退化成"记得加个词就能过"，与注释/提示承诺的
  //   `--allow-dirty="<理由>"` 不符。现在：缺 `=` 或理由空白 ⇒ **直接拒（exit 1）**，且不给提示行里
  //   那种"（未写理由）"的兜底——没有理由就不许越权。
  const argv3 = process.argv.slice(3);
  // 只把**恰好** `--allow-dirty` / `--allow-dirty=…` 当 flag（复核订正：旧版 `frag`
  //   用宽前缀 `startsWith('--allow-dirty')` 丢弃 token，会把 `--allow-dirty-ish` 这类片段词也吃掉；
  //   现在按**下标**精确剔除"被校验过的那一个 token"，其余 token 原样进 frag）。
  const adIdx = [];
  argv3.forEach((a, i) => { if (a === '--allow-dirty' || a.startsWith('--allow-dirty=')) adIdx.push(i); });
  if (adIdx.length > 1) {
    console.log('❌ `--allow-dirty` 拒绝执行：只能给一次（重复给出无法判定以哪条理由为准）。');
    process.exit(1);
  }
  let dirtyReason = null;
  let dirtyTrace = null;   // 越权理由**要落进账本**（写进 --end 那一条）
  if (adIdx.length === 1) {
    const tok = argv3[adIdx[0]];
    if (!tok.includes('=')) {
      console.log('❌ `--allow-dirty` 拒绝执行：**必须带理由**，写成 `--allow-dirty="<理由>"`（等号形式）。');
      console.log('   原因：它是"越权收尾"的留痕通道；裸 flag ＝ 无理由越权。');
      console.log('   若 `--allow-dirty` 只是你说明片段里的一个词 ⇒ 请把整段片段用引号括成**一个参数**。');
      process.exit(1);
    }
    dirtyReason = tok.slice(tok.indexOf('=') + 1).trim();
    if (!dirtyReason) {
      console.log('❌ `--allow-dirty` 拒绝执行：理由为空（`--allow-dirty=` 后面什么都没写）。');
      process.exit(1);
    }
  }
  // ── `--takeover="<理由>"`──────────────
  //   关**别人的**账必须显式接管并留理由。解析同 adIdx：按下标精确剔除，别把片段词吃掉。
  const tkIdx = [];
  argv3.forEach((a, i) => { if (a === '--takeover' || a.startsWith('--takeover=')) tkIdx.push(i); });
  if (tkIdx.length > 1) {
    console.log('❌ `--takeover` 拒绝执行：只能给一次（重复给出无法判定以哪条理由为准）。');
    process.exit(1);
  }
  let takeoverReason = null;
  if (tkIdx.length === 1) {
    const tkv = argv3[tkIdx[0]];
    if (!tkv.includes('=')) {
      console.log('❌ `--takeover` 拒绝执行：**必须带理由**，写成 `--takeover="<理由>"`（等号形式）。');
      console.log('   原因：接管是"代别人收尾"的留痕通道；裸 flag ＝ 无理由接管（事后查不出谁动的手）。');
      console.log('   若 `--takeover` 只是你说明片段里的一个词 ⇒ 请把整段片段用引号括成**一个参数**。');
      process.exit(1);
    }
    takeoverReason = tkv.slice(tkv.indexOf('=') + 1).trim();
    if (!takeoverReason) {
      console.log('❌ `--takeover` 拒绝执行：理由为空（`--takeover=` 后面什么都没写）。');
      process.exit(1);
    }
  }
  // ── 锚归属校验：只准关"说明含指定片段"的进行中锚 ──
  // 🔴 两个 flag 都要剔（一次评审）：只剔 adIdx 的话，`--takeover=理由` 会留在 frag 里
  //   ⇒ 匹配 0 条 ⇒ 报"没有说明含…的锚"（误导性错误），而不是走接管。
  // 🔴🔴 修 `--agent` 也要剔——否则 `--end --agent 名 "<片段>"`
  //   的 frag 里带着 `--agent 名` ⇒ **永远报"没有说明含…的锚"**（审核实测）。同款坑先例＝adIdx/tkIdx。
  const agIdx3 = [];
  argv3.forEach((a, i) => { if (a === '--agent') { agIdx3.push(i, i + 1); } });
  const drop = new Set([...adIdx, ...tkIdx, ...agIdx3]);
  const frag = argv3.filter((_, i) => !drop.has(i)).join(' ').trim();
  const openList = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.title.includes('进行中'));
  const descOf = (e) => (e.body.split('\n').find((l) => l.startsWith('- 说明：')) || '').replace('- 说明：', '').trim();
  if (openList.length === 0) { console.log('ℹ️ 没有"进行中"的条目，无需收尾。'); process.exit(0); }
  if (!frag) {
    console.log('❌ `--end` 拒绝执行：**必须带锚点归属片段**（你 --start 时写的那句话的片段）。');
    console.log('   原因：裸 `--end` 会关掉"最新的进行中锚"，多会话并行时会误关**别的会话**的锚（实测踩过）。');
    console.log('   当前进行中的锚：');
    for (const { e } of openList) console.log(`     · ${e.title} — 说明：${descOf(e)}`);
    console.log('   用法：node scripts/session-ledger.mjs --end "<你的说明片段>"');
    process.exit(1);
  }
  const matched = openList.filter(({ e }) => descOf(e).includes(frag));
  if (matched.length === 0) {
    console.log(`❌ --end 拒绝执行：没有说明含「${frag}」的进行中锚——该锚可能属于其他会话，请让其归属会话自关。`);
    for (const { e } of openList) console.log(`     · ${e.title} — 说明：${descOf(e)}`);
    process.exit(1);
  }
  if (matched.length > 1) {
    console.log(`❌ --end 拒绝执行：片段「${frag}」匹配到 ${matched.length} 条进行中锚，请用更长片段区分：`);
    for (const { e } of matched) console.log(`     · ${e.title} — 说明：${descOf(e)}`);
    process.exit(1);
  }
  // ── 锚归属判定──────────────
  // 🔴 必须取**最后一个**标记：`--start` 把 `[会话:x]` 追加在说明**末尾**，而说明正文可能
  //    引用别人的会话号（接力页/日志原样粘贴）⇒ 取第一个会误判。
  //    已知边界（写在这里，不许删）：
  //    ① 正文引用了别人的号、而自己没有标记（老锚）⇒ 会被当成别人的 ⇒ 误拒（安全方向，可接受）；
  //    ② 正文里恰好写了**收尾者自己的**号 ⇒ 绕过本判据 —— 只能靠"取最后一个"把概率压到最低。
  const matchedEntry = matched[0].e;
  const checkedDesc = descOf(matchedEntry);
  const marks = [...checkedDesc.matchAll(/\[会话:([^\]]+)\]/g)];
  const anchorTok = marks.length ? marks[marks.length - 1][1] : '';
  // 判定表（顺序写死）：tok 空 ⇒ 不判（旧行为＋告警）；无标记 ⇒ 放行＋告警
  //   （**认不出 ≠ 是别人的**——账本 相当多条目无标记）；自己的 ⇒ 放行；别人的无 takeover ⇒ exit 1。
  if (!TOK) console.log('⚠️ 拿不到会话身份 ⇒ 判不了锚归属，按旧行为收尾。');
  if (!anchorTok) console.log('⚠️ 该锚没有 [会话:] 标记（--start 时无身份，或手写）⇒ 归属不可判，按旧行为收尾。');
  if (TOK && anchorTok && anchorTok !== TOK && tkIdx.length === 0) {
    console.log(`❌ --end 拒绝执行：锚「${checkedDesc.slice(0, 40)}」属于会话 ${anchorTok}，不是你（${TOK}）。`);
    console.log('   这是**别人的账**：接管要显式说明，否则事后查不出谁动的手。');
    console.log('   接管：node scripts/session-ledger.mjs --end "<片段>" --takeover="<理由>"');
    console.log('   让本人关：让对方会话跑同一条命令。');
    process.exit(1);
  }
  // 🔴 三个前置缺一不可：tok 有值 ＋ 确实带了 takeover ＋ 锚确实是别人的。
  //   tok 为空时即便带了 flag，takeoverTok 仍为空 ⇒ 不写「接管：? 接管 sess-A」这种没有主体的行。
  const takeoverTok = (TOK && tkIdx.length === 1 && anchorTok && anchorTok !== TOK) ? anchorTok : '';
  // 联合键锁存：title 只有**分钟**精度（同一分钟可能出现多条同标题条目），不能单独当身份，
  //   配说明行整行，写回时再核"必须恰好命中 1 条"（见下面 commitLedger）。
  const checkedTitle = matchedEntry.title;

  // ── 结账闸门──────────────────────────
  // 「收尾 ＝ 结账」：**锁行声明的范围内还有未提交改动 ⇒ 拒绝收尾**（fail-closed）。
  // 为什么挂这里：`--end` 是收尾**最后一步且必跑**
  //   ⇒ 挂在"必跑步骤"上的闸门不会空转；提醒级的建议栏注定会死。
  // 越过：`--allow-dirty="<理由>"`（单参数形式，上面 frag 已过滤掉它；留痕打印）。
  // ⚠️ 已知误报：崩溃会话的遗留锁也会命中。
  try {
    const { parseLockLines, unsettledForLines, unnamedForLines, isMine, linesOfSession } = await import('./lib/settle.mjs');
    // 🔴 根治：默认只判**本会话自己的行**；别人的未结清只提示不拦（原来查全部行 ⇒ 多会话互锁）。
    // 🔴（一次评审）：接管时改判**并集**（我的行 ∪ 被接管会话的行）
    //   —— 写成替换（judgeTok = takeoverTok || tok）会让接管变成绕过结账，比改前更松。
    const all = parseLockLines(ROOT);
    if (!TOK && all.length) console.log('⚠️ 拿不到会话身份（KB_SESSION_ID 等均未设）⇒ 分不出归属，本次闸门按**旧行为**检查所有行。');
    const mineLines = TOK ? linesOfSession(all, TOK) : [];
    const anchorLines = takeoverTok ? linesOfSession(all, takeoverTok) : [];
    const judgeLines = [...new Set([...mineLines, ...anchorLines])];   // 并集，不是替换
    // 🔴 兜底只看 TOK（"认不出身份"才退回旧行为判全库）；⛔ 不许写 `judgeLines.length ? judgeLines : all`
    //   —— 那会把"我认得出、只是这轮没锁行"错判成"认不出"，去判**全库** ⇒ 两个会话互相把对方锁死的情形复发。
    const pend = unsettledForLines(ROOT, TOK ? judgeLines : all, { ignoreAlways: true });
    // 接管对象零锁行必须显式喊（"未校验"≠"已结清"），分两档、不许合成一句：
    if (takeoverTok && anchorLines.length === 0) {
      console.log(mineLines.length
        ? `⚠️ 接管对象的锁行**不存在**（崩溃前已 remove／从未取锁）⇒ **只校验了你自己的 ${mineLines.length} 行**，对被接管会话的范围未校验。`
        : '⚠️ 接管对象与你本人都没有锁行 ⇒ 本轮**零输入、未校验任何范围**（不等于已结清）。');
    }
    // others 提示要排除接管对象：对方的行接管时改由并集判定，
    // 否则同一批行先被打成「不拦你」、紧接着又被下面拦下——同一批行两种结论。
    const others = TOK ? all.filter((l) => !isMine(l, TOK) && !(takeoverTok && isMine(l, takeoverTok))) : [];
    if (others.length) {
      const op = unsettledForLines(ROOT, others, { ignoreAlways: true });
      if (op.length) console.log(`ℹ️ 另有**别的会话**的 ${op.length} 行未结清（**不拦你**）：${op.map((p) => `「${p.line.note}」`).join(' ')}`);
    }
    if (pend.length && !dirtyReason) {
      // GATE('end-settled')
      console.log('❌ 收尾被拦（**收尾 ＝ 结账**）：还有锁行声明的范围没提交');
      for (const { line: l, paths } of pend) {
        console.log(`   · 「${l.note}」→ ${paths.length} 个未提交：${paths.slice(0, 3).join(' / ')}${paths.length > 3 ? ' …' : ''}`);
      }
      if (takeoverTok) {
        // 提交时 --note 命中别人的行**默认应拦**（一次评审定下的口径），
        console.log('   处置：① 让对方本人收尾（最干净）');
        console.log('        ② 代收：node scripts/session-ledger.mjs --end "<片段>" --takeover="…" --allow-dirty="<理由>"');
        console.log('        ③ 提交时若 note 命中别人的锁行，先确认那行是否已过期；别在别人的锁还新鲜时替他提交。');
      } else {
        console.log('   先跑：git commit -m "<你那行锁的片段>"');
        console.log('   确需先收尾：加 --allow-dirty="<理由>"（**必须写明理由**，留痕）');
      }
      process.exit(1);
    }
    if (pend.length) {
      // 🔴 评审定：理由**同时落账本**（下面 lines.push），不只是控制台。
      //   评审订正：条数不够用——"1 条锁行"可能点名 3 个脏文件；账本是可回翻证据，两个数都记。
      //   评审订正：多行锁**重叠**同一文件时按行求和会重复计数 ⇒ 用 Set 去重。
      dirtyTrace = { lines: pend.length, files: new Set(pend.flatMap((p) => p.paths)).size, reason: dirtyReason };
      if (takeoverTok) {
        // 接管时越权计数口径变**并集**、按来源拆开——"谁给的理由、越的是谁的范围"不再张冠李戴
        //（改前这条会写进对方的条目、读起来像对方自己越权）。
        dirtyTrace.takeover = { mine: mineLines.length, theirs: anchorLines.length };
        console.log(`⚠️ --allow-dirty 越权收尾（接管中）：${dirtyTrace.lines} 行锁 / ${dirtyTrace.files} 个文件未结清（我的 ${mineLines.length} 行／对方 ${anchorLines.length} 行）｜ 理由：${oneLine(dirtyReason)}`);
      } else {
        console.log(`⚠️ --allow-dirty 越权收尾：${dirtyTrace.lines} 行锁 / ${dirtyTrace.files} 个文件未结清 ｜ 理由：${oneLine(dirtyReason)}`);
      }
    }
    // ── 「未点名」提醒：只提醒、不拦（范围已只认点名）──
    try {
      // 评审：输入集合与结账闸门同源（接管时＝并集），否则"对方点名的区域内文件"漏提醒。
      const unm = unnamedForLines(ROOT, TOK ? judgeLines : all, { ignoreAlways: true });
      const n = unm.reduce((a, p) => a + p.paths.length, 0);
      if (n) console.log(`ℹ️ 另有 ${n} 条脏文件在你声明的区域内、但**没被点名**（不进提交；若是你改的 ⇒ 下次取锁时写进 \`--files\`）`);
    } catch (e) { console.log(`⚠️ 未点名清单算不出来（${e.code || e.message}）—— 只警告。`); }
  } catch (e) {
    console.log(`⚠️ 结账闸门跑不动（${e.code || e.message}）—— 只警告，不拦收尾。`);
    //  评审订正：闸门没跑 ⇒ "有没有越权"判不了，但**理由不能静默丢**（用户以为留了痕）。
    if (dirtyReason && !dirtyTrace) {
      dirtyTrace = { degraded: true, reason: dirtyReason };
      console.log('⚠️ `--allow-dirty` 已给，但闸门没运行 ⇒ 按「未校验」把理由记进账本（不假装核对过）。');
    }
  }
  //  补修：porcelain 默认把非 ASCII 路径转义成 `\344\274...` 形式（并加引号），
  // 导致随后 `git hash-object <p>` 找不到文件（原先被 try/catch 静默吞成 '—'）。
  // 加 `core.quotepath=false` 后路径可读、指纹可算；含空格时仍会被引号包裹，故下方照旧去引号。
  // ⚠️ 同上：`gitStatusLines` 归一到包根（否则整仓布局下逐个指纹全部 exit 128 ⇒ 收尾退化成 exit 3）
  const changed = GIT_OK ? gitStatusLines(ROOT) : [];
  // 没有提交的仓库（刚 git init）里 HEAD 不存在 ⇒ diff 会 exit 128；这不是错误，按'无基线'处理
  const shortstat = GIT_OK ? git(ROOT, ['diff', '--shortstat', 'HEAD'], { allowFail: true }) : '';
  // 口径统一：status 的条数**含未跟踪新文件**，而 diff --shortstat **只算已跟踪**——
  // 直接并列会出现「7 个文件（6 files changed）」这种自相矛盾，故拆成两项说明。
  const untracked = changed.filter((l) => l.startsWith('??')).length;
  const tracked = changed.length - untracked;
  const num = (re) => (shortstat.match(re) || [, '0'])[1];
  const parts = [];
  if (tracked) parts.push(`已跟踪 ${tracked} 个：+${num(/(\d+) insertions?\(\+\)/)} / -${num(/(\d+) deletions?\(-\)/)} 行`);
  if (untracked) parts.push(`新文件 ${untracked} 个（未跟踪，行数不计入 diff）`);
  const lines = [];
  // 一次评审定下的口径：接管时身份**只写一处**——「接管：」行；收尾行改「代收」、不再重复会话号。
  // 🔴 只在 takeoverTok 非空时写（⛔ 不许用 tkIdx.length 判断：tok 为空时也带了 flag，
  //   会写出「接管：? 接管 sess-A」这种没有主体的行）。自己的账一字不加。
  if (takeoverTok) lines.push(`- 接管：${TOK} 接管 ${takeoverTok} ｜ 理由：${oneLine(takeoverReason)}`);
  lines.push(takeoverTok
    ? `- 代收：${now()} · HEAD = ${GIT_OK ? git(ROOT, ['rev-parse', '--short', '--verify', '--quiet', 'HEAD'], { allowFail: true }).trim() : '(无 git)'}`
    : `- 收尾：${now()} · HEAD = ${GIT_OK ? git(ROOT, ['rev-parse', '--short', '--verify', '--quiet', 'HEAD'], { allowFail: true }).trim() : '(无 git)'}`);
  // 无标记锚"由谁收的"要能从账本查出来（tok 有值时）。
  if (TOK && !anchorTok) lines.push(`- 归属：锚无标记（--start 时无身份），本次由 ${TOK} 收尾`);
  // 🔴（上述修正的配套）：`--end --agent <名>` 的身份也落盘——
  //   否则该参数只是"被剔掉不报错"（静默忽略＝比拒绝更坏：调用方以为留痕了）。
  if (agentName) lines.push(`- 收尾身份：[代理:${agentName}]（--end 调用方自证；非鉴权）`);
  lines.push(`- 变更：${GIT_OK ? `${changed.length} 个文件（${parts.join('；') || '无改动'}）` : '无法检测（无 git）'}`);
  if (GIT_OK && changed.length) {
    lines.push('- 明细（状态 + 收尾指纹前 10 位）：');
    // 指纹取不到必须留痕（评审 · fail-closed）：
    // 目录 / 已归档或已移动 / 新建未落盘 —— git hash-object 一律 exit 128。
    // 🔴 旧版是 `catch {}` 空吞，只打一行 stderr、退出码仍为 0 ⇒ 账本里留下
    //    "看不见的失真"。判据：**看不见输入的闸门，比没有闸门更危险**——宁可报红，不要静默放行。
    const fpFailed = [];
    // 🔴（一次评审）：**逐条取指纹，不因超过 60 就跳过**——旧版只算前 60 条，
    //   第 61 条起"指纹取不到"根本不会进 fpFailed ⇒ 在「0＝全成功／3＝明细不全」契约下
    //   变成**机器可读的假绿**（实测：60 个正常文件 + 第 61 条目录 ⇒ 旧版 rc=0、无失败行）。
    //   账本**明细仍只列前 60**（控体量），但"失败判定"覆盖全部。
    const DETAIL_MAX = 60;
    for (let idx = 0; idx < changed.length; idx++) {
      const l = changed[idx];
      const show = idx < DETAIL_MAX;
      const st = l.slice(0, 2).trim() || '??';
      // 🔴 ：R（重命名）行的原始形态是 `R  旧路径 -> 新路径`，
      //    原先直接整串当路径去 hash ⇒ 必然失败、被静默吞成 '—'。
      //    fail-closed 上线后第一跑就抓到这条（一次归档移动的实测）。
      //    正确口径：**取新路径**（重命名后的当前所在），旧路径只作为来源痕迹留在 git 侧。
      const raw = l.slice(3).trim().replace(/^"|"$/g, '');
      const arrow = raw.indexOf(' -> ');
      const p = (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim().replace(/^"|"$/g, '');
      let fp = '—';
      let isDir = false;
      try { isDir = fs.statSync(join(ROOT, p)).isDirectory(); } catch { isDir = false; }
      if (isDir) {
        // ✅ 目录指纹的实现说明：
        //    目录**不能**用 `git hash-object`（它只吃文件 ⇒ exit 128）。
        //    A 方案：把目录当一棵"树"证明——**走文件系统**递归列文件（含未跟踪）→ 逐个内容哈希
        //    → "路径:哈希"排序拼串取一次合并哈希。增删文件/改内容都会变 ⇒ 证据强度＝文件型指纹。
        //    两次实测修正：① 用 `git ls-tree HEAD` 只列一层、对未跟踪目录无效；② 用 `git ls-files`
        //    只认**已跟踪**文件（未跟踪目录返回 0 文件 ⇒ 假绿）。故改为 fs 遍历 ＋ 逐文件哈希。
        //    单文件 >64MB 跳过并**如实标注**（不假装全量）。
        try {
          const walk = (dir) => {
            const out = [];
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, e.name);
              if (e.isDirectory()) {
                if (e.name === '.git' || e.name === 'node_modules') continue;
                out.push(...walk(full));
              } else if (e.isFile()) {
                out.push(full);
              }
            }
            return out;
          };
          const absDir = join(ROOT, p);
          const files = walk(absDir);
          let skipped = 0;
          const parts = [];
          for (const f of files) {
            const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
            let sz = 0;
            try { sz = fs.statSync(f).size; } catch { continue; }
            if (sz > 64 * 1024 * 1024) { skipped++; continue; }
            parts.push(`${rel}:${gitBlobHash(fs.readFileSync(f))}`);
          }
          if (parts.length > 0) {
            parts.sort();
            const merged = gitBlobHash(parts.join('\n'));
            fp = `${merged.slice(0, 7)}*dir`;
            if (show) lines.push(`  - \`${st}\` ${raw} · ${fp}（目录指纹:${parts.length} 文件${skipped ? `·跳过 ${skipped} 个>64MB` : ''}）`);
            continue;
          }
        } catch { /* 取不到 ⇒ 落到下面的"指纹失败"，不静默通过 */ }
      } else {
        try { fp = gitBlobHash(fs.readFileSync(join(ROOT, p))).slice(0, 10) || '—'; } catch {}
      }
      // 🔴（实测）：`D`（已删除）项**按定义**没有内容可读 ⇒ 上面必然 fp='—'
      //    ⇒ 被算进 fpFailed ⇒ **只要会话删过文件，收尾就永远"明细不全"**。
      //    实测一条「指纹失败」记录，失败项全是 `D`（并发会话删的提案文件）。
      //    ⇒ 删除的**证据**不是"现在的内容"，而是「**被删掉的是什么**」：取 **HEAD 里的 blob** 当指纹。
      //    取不到（未跟踪文件被删／HEAD 无此路径／spawn 失败）才落回 fpFailed —— **fail-closed 不放宽**。
      //    ⚠️ 与目录指纹（:526）同族：都是"换个通道取得等价证据"，不是"跳过不验"。
      if (fp === '—' && st === 'D') {
        try {
          // 🔴 路径基准：`<rev>:<path>` 永远从**仓库根**解析，整仓布局下 p 是包根相对 ⇒
          //   会打出 `fatal: Needed a single revision` ＋ 指纹失败 ⇒ 收尾恒退 3。必须剥前缀。
          const h = String(git(ROOT, ['rev-parse', '--verify', `HEAD:${gitRootPrefix(ROOT)}${p}`], { allowFail: true }) ?? '').trim();
          if (/^[0-9a-f]{40}$/.test(h)) fp = `${h.slice(0, 10)}·HEAD`;
        } catch { /* spawn 都失败 ⇒ 落回"指纹失败" */ }
      }
      if (fp === '—') fpFailed.push(`${st} ${p}`);
      if (show) lines.push(`  - \`${st}\` ${raw} · ${fp}`);
    }
    if (changed.length > DETAIL_MAX) lines.push(`  - …另有 ${changed.length - DETAIL_MAX} 个文件（**已逐个取指纹**，明细未列出）`);
    if (fpFailed.length) {
      lines.push(`- ⚠️ **指纹失败 ${fpFailed.length} 项**（账本仍留痕，但这些条目无法证明"内容变了没有"）：`);
      for (const f of fpFailed.slice(0, 10)) lines.push(`  - \`${f}\``);
      if (fpFailed.length > 10) lines.push(`  - …另有 ${fpFailed.length - 10} 项`);
    }
    var FP_FAILED = fpFailed;
  }
  // 🔴 越权理由**必须落进账本**——写进 --end 那一条
  //   写的是「账本 `--end` 行」，而改前只打控制台 ⇒ 第二天回翻账本看不到"谁为什么越权"。
  //   评审：文本必须过 `oneLine()`（防伪造条目）；降级态（闸门没跑）也要留痕、且标明未校验。
  if (dirtyTrace) {
    lines.push(dirtyTrace.degraded
      ? `- ⚠️ 越权理由（结账闸门**未运行**，未校验）：${oneLine(dirtyTrace.reason)}`
      : dirtyTrace.takeover
        ? `- ⚠️ 越权（接管中·接管者 ${TOK}；判定集合＝我的∪被接管的；我的 ${dirtyTrace.takeover.mine} 行／对方 ${dirtyTrace.takeover.theirs} 行，共 ${dirtyTrace.files} 个文件未结清）｜ 理由：${oneLine(dirtyTrace.reason)}`
        : `- ⚠️ 越权收尾（--allow-dirty）：${dirtyTrace.lines} 行锁 / ${dirtyTrace.files} 个文件未结清 ｜ 理由：${oneLine(dirtyTrace.reason)}`);
  }
  // 🔴 写回走 commitLedger（一次评审定案）：**在新读到的内容上重新定位该锚再改**，
  //   而不是把启动时那份快照整文件写回——历史上那次丢更新就是后者造成的。
  let doneTitle = '';
  commitLedger((p) => {
    // 🔴（一次评审）：写回时用「title ＋ 说明行」**联合键**重定位，
    //   **必须恰好命中 1 条**——title 只有分钟精度（同一分钟可能出现多条同标题条目），只比 title 会取到
    //   "最新那条"（可能是别人的锚）⇒ 比现状更差。
    //   ⛔ 不许退回按 frag 模糊找：commitLedger 重试会重读账本、新锚 unshift 到最前，
    //   那等于把「审的是 A、关的是 B」的窗口留着（openIdxOwn 死变量时代的病，本件退役）。
    const hits = p.entries.filter((x) => x.title === checkedTitle && descOf(x) === checkedDesc && x.title.includes('进行中'));
    if (hits.length !== 1) {
      return { ok: false, msg: `❌ 账本在本次收尾期间被其他会话改动：目标锚（title＋说明行联合键）命中 ${hits.length} 条（须恰 1）或已不在"进行中" —— **本次未写入**，请重跑 \`--check\` 看现状。` };
    }
    const ee = hits[0];
    ee.title = ee.title.replace('status: 进行中', `status: 已收尾`);
    ee.body = ee.body.split('\n').filter((x) => !x.startsWith('- 收尾：待填')).join('\n') + '\n' + lines.join('\n');
    doneTitle = ee.title;
    return { ok: true };
  });
  console.log(`✅ 已收尾（${GIT_OK ? `${changed.length} 个文件` : '变更无法检测·无 git'}）：${doneTitle}`);
  // 🔴（独立复核）：`--end` 也要告警 —— 它用同一个 `TOK` 判
  //   「这是不是我的锚／要不要接管别人的锚」⇒ 身份若是共享文件兜底来的 ⇒ **可能认错锚**。
  {
    const w = identitySourceWarn('  ', TOKSrc);
    if (w) console.log(w);
  }
  if (typeof FP_FAILED !== 'undefined' && FP_FAILED.length > 0) {
    console.log('');
    console.log(`⚠️ 收尾**已记账**（账本已落盘），但 ${FP_FAILED.length} 项明细**算不出指纹** ⇒ 这个收尾**不算全成功**。`);
    console.log('   常见原因：① 目录里读不到文件（空目录／权限）② 文件已归档或已移动 ③ 新建尚未落盘 ④ 路径含特殊字符。');
    console.log('   补救：先 `git add <具体文件>` 让路径进入索引（别用 `git add -A`），或确认该路径确已移动，并在**下一条**账本里说明。');
    //  评审订正：旧版这里 `exit(1)` ⇒ 调用方判"收尾失败"，可账本**已经关了**；
    //   重跑 `--end` 只会得到「没有进行中的条目」exit 0 —— 两次读数自相矛盾。
    //   改用独立退出码 **3 ＝「已收尾但明细不全」**：0 ＝ 全成功，1 ＝ 真失败（未写账／被拒）。
    //   ⚠️ 不要重跑 `--end`（锚已关闭）；退出码 3 不是"再来一次"的信号。
    process.exit(3);
  }
  process.exit(0);
}

console.log('用法：--check | --start "说明" | --end "<说明片段>"');
process.exit(2);
