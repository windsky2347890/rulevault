#!/usr/bin/env node
/**
 * write-lock.mjs —— 区域写锁（零依赖）
 *
 * 规则正文：[[_wiki/schema]] §0.2（区域锁协议）
 * 为什么有它：锁文件是多行格式，**手写容易错**；而且"我这次要改的区域跟别人撞不撞"应当由脚本算，不靠脑算。
 *
 * 用法：
 *   node scripts/write-lock.mjs list
 *   node scripts/write-lock.mjs check --region _wiki,tool [--files AGENTS.md] [--ignore <子串>]
 *   node scripts/write-lock.mjs add    --region _wiki,tool [--files AGENTS.md] [--tool <工具名>] [--note "在做什么"] [--ignore "自己那一行的片段"]
 *   node scripts/write-lock.mjs add    --region meta --force        # 临时取锁（跳过开场闸门，锁行留痕）
 *   node scripts/write-lock.mjs remove <匹配串> [--takeover="<理由>"]   # 删**自己的**行；删**别人的**锁＝接管动作，必须带理由并留痕
 *
 * ⛔ **开场闸门**：`add` 前先校验 `_AI/.开场证迹`
 *    （由 `node scripts/session-open.mjs` 落），**缺戳 / 戳≥12h** → 退出码 1、不写锁。
 *    越过方式只有 `--force`，且会在锁行追加 `[跳过开场]`。设计理由：前置条件闸门（fail-closed）。
 *    `list` / `check` / `remove` **不受闸门影响**（收尾绝不能被堵）。
 *
 * ⛔ **`add` 前的闸门**（全部实现在 `evaluateGates`，跑 `add --dry-run` 可见逐门结论）：
 *    ① `files-not-dir` 路径形状（**`--force` 也绕不过**，它是校验不是闸门）
 *    ② `open-stamp` 开场戳（12 小时内）
 *    ③ `ledger-anchor` 账本「进行中」锚
 *    ④ `settle-anchor` 上次收尾的未结清项
 *    阻断门红 ⇒ **退出码 1、不写锁**；`--force` 可越过 ②③④ 并在锁行留痕 `[跳过X]`。
 *    `settle-unnamed` 是提示门，不拦只提醒。
 *
 * ⭐ **`check` 和 `add` 现在都能认出"自己"**（一次评审执行，含独立审查的补强项）。
 *    判据＝锁行 note 里的机器标记 `[会话:tok]`（`isMine`），**不需要人去改自己的 note 措辞**。
 *    - 自己占着的**相交**区域 → 单列为「你自己还持 N 条相交锁」，**不算冲突、不阻断**。
 *    - 别人的冲突 → 照旧报，且 `check` 退出码仍为 1。
 *    - 🔴 **拿不到会话身份（tok 为空）⇒ 不做任何自我豁免，全部照报并告警**。
 *      （反例就在本文件下方：`tok ? filter : rows` 会把"没有身份"读成"全是我的"
 *        ⇒ 真冲突全部静默消失。这与 schema「能在空文件上永远报『无冲突』的锁，不是锁」同族。）
 *    ⚠️ `--ignore` **降级**为"额外的、指名道姓的排除"，不再是"必须手写才能不撞自己"。
 *       它的匹配面是 **note**，不是整行 —— 因为 `[格式v1]` 版本段在整行里但不在 note 里，
 *       按整行匹配会让 `--ignore "[格式v1]"` **滤掉所有行** ⇒ 静默假绿。
 *
 * 退出码：`check` 有**别人**冲突 → 1；`add` 被开场闸门拦下 → 1；其余 0；用法错 → 2。
 * 🔴 **契约变更留痕**：过去"只撞自己那一行"也会退 1；现在那种情况**退 0**。
 *    理由：那是假冲突，报"阻断"本就不对。今天无脚本消费 `check` 的退出码（只被人/AI 读），
 *    但**这是对外可见的行为变更**，故写在这里，不藏在改动里。
 *
 * 🔴🔴 **登记在册：微秒级残窗（多轮独立审查后决定「暂缓修」）**
 *
 *   **病**：`remove` 是**重写型**（`writeFileSync(tmp)` ＋ `renameSync(tmp, LOCK)`），
 *   而 `add` 是**增量型**（`appendFileSync`）。**同一文件两种语义** ⇒
 *   并发 `add` 若落在「**最后一次重读 → `renameSync`**」之间，那行会被 `renameSync`
 *   **一并销毁**，且**输出零警告**。
 *
 *   **为什么暂缓修**（多轮审查一致）：
 *   ① 消除它**只有一个方向**（`remove` 也只追加）——该方向**已实测成立**；
 *   ② 但两版落地装置各有**致命缺陷**，且致命缺陷的**触发频率远高于原病**：
 *      · 标记行进锁文件本体 ⇒ 缺 `区域:` 标签 ⇒ 被解析成 **8 区全局锁**
 *        ⇒ **每次 `remove` 误拦全库**（实测每轮都出假冲突）；
 *      · 旁路撤销文件 ⇒ `stamp` 只到**分钟** ⇒ 同会话「释放后重取锁」时两行逐字相同
 *        ⇒ **指纹必然相同 ⇒ 新锁一出生就是死的**（实测复现）；
 *        而「释放后重取锁」是 **schema §0.2 第 8.5 条每个会话每天都在做的动作**。
 *      ⇒ **拿「每天发生一次的静默假绿」换「一年碰不到两次的静默销毁」，不划算。**
 *
 *   **诚实声明**：本装置**存在**这个残窗，**没有消除它**。
 *   触发条件＝**两个会话恰好同时**（一个收尾、一个开工）落在那个微秒窗口 ⇒ 极罕见。
 *   ⚠️ **一旦发生：那一行会被静默销毁、无任何告警**——本文件任何代码都检不出它，
 *      因为被销毁的行**比任何快照都更新**，**不包含在任何可比较的集合里 ⇒ 信息上不存在指纹**
 *      （我为此试过「写前备份」与「拿重读快照比」两种兜底，均已证伪并删除）。
 *   ⇒ 若你正撞上（锁行莫名消失）：**重取锁**即可，并**当面向使用者说明**。
 *
 *   ⚠️ 这条竞态窗口**没有自测模式能覆盖**：要断言它就得在生产路径插停顿点制造竞态，
 *      而靠竞态的断言检出率极低（且等于给锁写入加一个慢路径）
 *      ⇒ 那样的自测**是装饰不是闸门**。本包只用结构性断言（函数内现读）压窗口，不假装能消除。
 *
 * 边界（明说）：
 *   - **只管锁文件**，不读不写别的文件。
 *   - **它不替你做判断**：有冲突时"只让出交集区域"仍由你会话执行；陈旧行可接管（一次评审）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionToken, sessionStamp, isMine, linesOfSession, hostName, identitySourceWarn, sessionTokenSource, validAgentName, APPEND_SHARED } from './lib/settle.mjs';
// 区域枚举 = 唯一来源（与 settle.mjs 共用，避免多份人肉同步漂移）
import { REGIONS } from './lib/regions.mjs';
// 锁行解析 = 唯一来源（本文件与 settle.mjs 共用；回退口径＝缺 区域: 走全局锁）
import { parseLockLine, parseLockFile, malformedTag, parseListField, CURRENT_FORMAT } from './lib/lockline.mjs';

// 🔴 库根按脚本自身位置找（不靠 cwd）——否则从别的目录跑会把锁写错地方、静默失效。
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, '_AI', '.写锁');
const STALE_HOURS = 12;
/** 锁租约默认时长（小时）——格式 v2 的 `expires_at:`
 *
 * 🔴 **与 `STALE_HOURS` 是两条时间线，并存不互替**：
 *   · `STALE_HOURS=12` ＝ **陈旧提示**（"多久没动"）——只影响措辞里"多长时间没动"；
 *   · `LOCK_TTL_HOURS=2` ＝ **租约**（"这行锁还有主吗"）——到期 ⇒ 标 `expired` ⇒ 计为 staleHits。
 *   为什么租约要短于陈旧线：TTL 的意义是**活锁不被误判**（2h 内一定还有主，崩溃遗留很快可接管），
 *   而 12h 是"多久没动"的提示线。混成一个数就会二选一地丢掉一边的语义。
 * ⚠️ 缺 `expires_at` 的旧行（格式 v1 及更早）**回退 `STALE_HOURS`**，行为与改动前完全一致。
 * ⚠️ **续租只发生在 `add`**（每次 `add` 都写新的 `expires_at`）；`remove` **不做续租**——
 *   它走"读全量→改→写全量"且逐字回写原始行，改存活行的字段需要新增
 *   重写逻辑，本装置不做（评审时定的口径）。
 */
const LOCK_TTL_HOURS = 2;

const argv = process.argv.slice(2);
const cmd = argv[0];
// 🔴 `--dry-run` 只对 `add` 有效（本地预演提案，一次评审通过）。
//   ⚠️ **不许静默忽略**：本文件反复治理的同一类病就是「参数被静默吞掉」。
//   ⇒ 给了 `--dry-run` 却用错命令 ⇒ **响亮拒绝（exit 2）**，不假装生效了。
if (argv.includes('--dry-run') && cmd !== 'add') {
  console.error(`❌ \`--dry-run\` 只对 \`add\` 有效（当前命令：${cmd || '（无）'}）——list/check/remove 本来就不写锁，没有"预演"可言。`);
  console.error('   用法：node scripts/write-lock.mjs add --dry-run --region <区> --files <文件…>');
  process.exit(2);
}


// （开发期的自测模式不随包发布；运行时闸门见 add/check/remove。）
/**
 * 参数取值。**空格形态** `--name 值`（值不能以 `--` 开头）＋ **等号形态** `--name=值`。
 * 🔴🔴 修（「静默丢参」·本项目反复治理的同一类病）：
 *   原实现只认空格形态 ⇒ `--note=值` / `--files=…` 这类等号写法被**静默忽略**，
 *   实测 `--note="等号说明文本"` 写出来的锁行是「（未写说明）」——**调用方以为写进去了**。
 *   这是本文件注释里反复警告的"静默失效"，却在参数解析这一层存在了很久。
 *   ⇒ 补等号形态（纯增量：空格形态行为逐字不变）。
 *   ⚠️ 形态差异要写准：**空格形态**的值不能以 `--` 开头（否则会被当成下一个 flag）；
 *      **等号形态**的值没有这个限制（`--note=--agent=x` 实测 exit 0、note 即 `--agent=x`）——
 *      因为等号后紧跟的就是值，不存在"被当成 flag"的歧义。两种形态的边界**不对称**。
 *   ⚠️ 据实收窄：**是否把"读不到值"升级为报错，由各调用点自己决定**——
 *      本函数只负责"读得到就返回、读不到返回 def"，不替调用方做 fail-closed 判定。
 *      目前只有 `--note` 做了响亮拒绝（见 add 分支）；`--files` / `--tool` 等仍是"读不到用默认值"。
 */
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) return v;
  }
  const eqPrefix = `--${name}=`;
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith(eqPrefix));
  if (eq) return eq.slice(eqPrefix.length);
  return def;
};

/** 给报错文案用：这个参数在命令行里到底是什么形态（不把整条命令打出来）。 */
const argShapeFor = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v) return `${name}（后面没有值）`;
    return v.startsWith('--')
      ? `${name} ${JSON.stringify(v)}（下一个 token 以 -- 开头 ⇒ 被当成 flag）`
      : `${name} ${JSON.stringify(v)}`;
  }
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith(`${name}=`));
  return eq ? `${eq}（等号后为空）` : name;
};

function readRows() {
  if (!fs.existsSync(LOCK)) return [];
  return fs.readFileSync(LOCK, 'utf8').split(/\r?\n/).filter((l) => l.trim());
}

// 🔴 解析口径**不再自己写一份**（一次评审）：原先按**位置**取 `parts[2]/[3]`，
//   与 `lib/settle.mjs`（标签法）**口径两样**。
//   现在统一用唯一真源 `lib/lockline.mjs` —— 三个入口对同一行必然读出同一个结果。
//   本函数只补**本脚本特有**的两样：小时数与陈旧标记（真源不关心时间语义）。
function parse(line) {
  const r = parseLockLine(line);
  // 🔴 畸形（时间不可解析）⇒ **不谎报"陈旧 Infinityh"**。真源的 `malformed` 已经是人话，
  //   这里让 hours=Infinity 只用于"不参与陈旧判定"的内部逻辑，**不再显示成陈旧**。
  const bad = !!r.malformed;
  const hours = r.timeMs == null ? Infinity : (Date.now() - r.timeMs) / 36e5;
  // 🔴 租约到期（格式 v2）：
  //   有 `expires_at` ⇒ **按租约判**（到期＝可接管）；没有（v1 旧行）⇒ 沿用 `stale`（STALE_HOURS）。
  //   ⚠️ 畸形行不判过期（`bad`）——时间都读不出来的行，说它"租约到期"就是编。
  const expired = !bad && r.expiresAtMs != null && Date.now() > r.expiresAtMs;
  return {
    ...r,
    line: r.raw,
    hours,
    stale: !bad && hours >= STALE_HOURS,
    expired,
  };
}

const rows = readRows().map(parse);

// 补行号（一次评审）：`malformedTag` 要能点名"第几行"，而真源只给 `raw`。
for (const [i, r] of rows.entries()) r.lineNo = i + 1;

/** 找出 mine/myFiles 与 pool 的交集，分三类返回：
 *   conflicts —— **别人**的冲突（阻断级语义：退出码 1）
 *   staleHits —— 别人的陈旧行（随时可显式接管，12h 只是提示线——一次评审）
 *   selfHits  —— **本会话自己**的相交行（自提醒，不阻断）
 *
 * 🔴 一次评审：**`tok` 为空 ⇒ 完全不做自我豁免**。
 *   理由（反例就在同一文件里）：`tok ? filter : rows` 这个形状会把
 *   「取不到会话身份」读成「全部行都算我的」⇒ 三个环境变量全空时**每一行都被滤掉**
 *   ⇒ `check` 永远回「✅ 无冲突」+ 退出码 0 ⇒ **真冲突零反馈**。
 *   那正是 schema §0.2「能在空文件上永远报『无冲突』的锁，不是锁」复发在过滤侧。
 *   ⇒ 拿不到身份就**全部照报**，宁可吵，不可静默。
 *   （`isMine` 自身 `!!tok` 短路返回 false，语义本已 fail-closed；危险只在"有人为
 *     保持一致而把它写成三元表达式"。）
 *
 * 🔴 原 `skipLine` 参数**已删除**：全文件两个调用点都不传它，
 *   第 93 行的 `if (skipLine && …) continue` **从未执行过一次**——是纯装饰。
 *   真正的"认出自己"改由 `isMine` 按 `[会话:tok]` 机器标记判定（不需要人去改
 *   note 措辞，见上文：靠子串的 `--ignore` 是假解法）。
 */
function findConflicts(mine, myFiles, pool = rows, tok = '') {
  const conflicts = [], staleHits = [], selfHits = [];
  for (const r of pool) {
    // 顺序要紧：先问"是不是自己"，再问"陈不陈旧"——否则会叫你去"接管"自己
    // 几十小时前留下的锁（陈旧行的语义是"可被别人接管"）。
    if (tok && isMine(r, tok)) {
      // 5.9：自提醒**必须限定为有交集的**自己行，否则合法持多个不重叠锁时刷噪音
      //      （schema §0.2 第 8.5 明确允许合法持多行锁）。
      const inter = r.regions.filter((x) => mine.includes(x));
      const fInter = r.files.filter((x) => myFiles.includes(x));
      if (inter.length || fInter.length) selfHits.push({ r, inter, fInter });
      continue;
    }
    // 🔴（一次评审）：**`expired` 必须与 `stale` 同权**。
    //   病根：若只在 `list` 里标 expired、`check`／`add` 仍按硬冲突报，就出现
    //   "list 说可接管、check 说撞车"的两套口径 ⇒ 人按哪个办都错。
    if (r.stale || r.expired) { staleHits.push(r); continue; }
    const inter = r.regions.filter((x) => mine.includes(x));
    const fInter = r.files.filter((x) => myFiles.includes(x));
    if (inter.length || fInter.length) conflicts.push({ r, inter, fInter });
  }
  return { conflicts, staleHits, selfHits };
}

/** ⚠️ 共享函数：`check` 与 `add` 都调它。**加参数时**两处调用点都要改**，
 *  否则其中一处会静默少打一类。
 *  `tokEmpty` 只是为了在输出里把"没做自我豁免"这件事说出来。 */
function printConflicts(conflicts, staleHits, selfHits = [], tokEmpty = false) {
  if (conflicts.length) {
    console.log('⚠️ **有冲突** —— 只对下列**交集**只读，其余区域照常写：');
    for (const c of conflicts) {
      console.log(`  - 与「${c.r.tool} · ${c.r.note}」交集：区域[${c.inter.join(',') || '无'}] 文件[${c.fInter.join(',') || '无'}]`);
    }
    if (selfHits.length) {
      console.log(`  · （另有 ${selfHits.length} 行是**你自己**的锁，已自动排除：${selfHits.map((c) => `「${c.r.note}」`).join('、')}）`);
    }
    console.log('  · 若某条**确实是别人的**锁却误判成自己，别用 `--ignore` 掩盖——核对它的 `[会话:…]` 标记是否写错。');
  } else {
    console.log('✅ 无冲突：本会话可正常写（不同区域互不影响）。');
  }
  if (tokEmpty) {
    console.log('⚠️ 取不到会话身份（tok 为空）⇒ **无法排除本会话自己的行**，本次全部照报，不做任何自我豁免。');
  }
  if (selfHits.length && !conflicts.length) {
    console.log(`  · 你自己还持 ${selfHits.length} 条相交锁（已自动排除，不算冲突）：${selfHits.map((c) => `「${c.r.note}」`).join('、')}`);
  }
  for (const r of staleHits) {
    // 🔴（一次评审）：**两种"可接管"要分开说**，否则人分不清
    //   "因为租约到期"还是"因为很久没动"——两者的确定性差很远（租约到期是设计内，陈旧只是提示）。
    const why = r.expired
      ? `**租约已到期**（expires_at ${r.expiresAt || '?'}，TTL ${LOCK_TTL_HOURS}h）`
      : `陈旧 ${Math.floor(r.hours)}h（STALE_HOURS=${STALE_HOURS}，只作提示）`;
    console.log(`  · 另有一条可接管行（${why}，${r.tool}）：**随时可显式接管**——node scripts/write-lock.mjs remove "<匹配串>" --takeover="<理由>"（schema §0.2 第 6 条 · 一次评审）。`);
  }
  // ── 「冲突返回下一步」（一次评审补的实施条目）──────────────
  // 🔴 病根：冲突只报「与谁撞」，不报「那我下一步跑什么」⇒ 人得回去翻 schema 才知道怎么办
  //   借鉴了常见 CLI 的做法：错误信息自带下一条可执行的命令。只给命令，**不自动执行**——装置只提醒，不代替人动。
  if (conflicts.length) {
    console.log('  · 下一棒：node scripts/write-lock.mjs list —— 先看清对方持着什么、几时取的、租约何时到；对方提交完即放行，再重跑你刚才那条命令。');
  }
}

/** 冲突裁决段
 *
 *  🔴 病根：schema §0.2「同文件同段 ⇒ 先来后到 ＋ 后到者必须 rebase」**早就写了**，
 *    但装置只报「有冲突」**不说谁先谁后** ⇒ 双方只能各自读锁行自己猜先后
 *    ⇒  上午场两边互相猜错、互相被对方的锁行挡了一轮
 *    （我 `write-lock add` 被结账闸门拒 3 次只能 `--force`；某次提交信息自陈
 *    「锁归属档拦路走显式放行」）⇒ **规则没错，缺的是装置输出**。
 *
 *  ⚠️ 口径：**按锁行时间**（`timeMs`）；时间不可解析的行排最后并标注。
 *  ⚠️ 只给裁决，**不自动改任何东西**（改动最小化；也不新增闸门）。
 */
function printAdjudication(conflicts) {
  const ordered = conflicts.map((c) => ({ c, t: c.r.timeMs == null ? Infinity : c.r.timeMs }));
  ordered.sort((a, b) => a.t - b.t);
  const first = ordered[0];
  const give = (x) => x.c.r.files.filter((f) => x.c.fInter.includes(f));
  // 🔴（独立复核订正）：**任一行时间不可解析 ⇒ 不点先到者**。
  //   旧写法只判"最早那行" ⇒ 混合情形（1 行可解析＋1 行坏）仍会**编造**一个"先到者"，
  //   并让那条时间坏的后到者去让出文件（复核实测复现）。
  if (ordered.some((x) => x.c.r.timeMs == null)) {
    console.log('  · 裁决：⚠️ **有锁行的时间不可解析** ⇒ 没有先后可判（不编造顺序）⇒ 按 schema 第 2 条「让出交集」处理。');
    return;
  }
  console.log('  · 裁决（schema §0.2「同文件同段 ⇒ 先来后到 ＋ 后到者 rebase」）：');
  if (ordered.length === 1) {
    // 🔴（评审订正）：**只有一条冲突行时，不要先打「先到者」又打「没有先后可判」**
    //   （旧写法自相矛盾：先说"先到者是谁"、紧接着说"没有先后可判"——复核实测复现）。
    //   ⇒ 正确口径：只有一条 ⇒ **它就是先到者**，你（后到者）让出交集。
    console.log(`      先到者（只有这一条）：${first.c.r.time} · ${first.c.r.tool}「${first.c.r.note}」`);
    console.log('      ⇒ 你（后到者）让出交集文件（schema 第 2 条）。');
    console.log('      ⚠️ 先后按**本机时钟**排序；两台机器的时钟有偏差时，这个先后可能不准（不假装精确）。');
    return;
  }
  console.log(`      先到者：${first.c.r.time} · ${first.c.r.tool}「${first.c.r.note}」`);
  console.log('      ⚠️ 先后按**本机时钟**排序；两台机器的时钟有偏差时，这个先后可能不准（不假装精确）。');
  for (const x of ordered.slice(1)) {
    const g = give(x);
    console.log(`      后到者：${x.c.r.time} · ${x.c.r.tool}「${x.c.r.note}」⇒ 让出 ${g.length} 个文件：${g.join('、') || '（无文件交集，只撞区域）'}`);
    console.log('                 （让出＝本次不点名这些文件；先到者写完后，后到者**重读最新版本**再 rebase 自己的改动）');
  }
}

/** `--ignore` 的匹配面：**`r.note`，不是 `r.line`/`r.raw`**（一次评审补强）。
 *  起因＝一次评审给锁行加了 `[格式v1]` 版本段，它留在 `raw` 里、已被
 *  `parseLockLine` 从 `note` 里剥掉 ⇒ 若按 `r.line` 匹配，`check --ignore "[格式v1]"`
 *  会把**每一行**都滤空 ⇒ 输出「✅ 无冲突」+ 退出码 0 ＝ **静默假绿**。
 *  `remove` 用的就是 `r.note`，这里与它对齐。 */
function ignoreFilter(ignore, base) {
  const src = base || rows;
  return ignore ? src.filter((r) => !r.note.includes(ignore)) : src;
}

if (cmd === 'list') {
  if (!rows.length) { console.log('（锁文件为空 / 不存在）'); process.exit(0); }
  console.log(`写锁共 ${rows.length} 条：`);
// 一次评审定下的原则：**畸形行不许静默替换成空锁文件**（与主流包管理器对损坏状态文件的处理同 philosophy）。
//   坏行已按"全局锁"从解析层保守处理，这里只负责**说出来**——不阻断流程（不 wedge）。
const bad = rows.filter((r) => r.malformed);
if (bad.length) {
  console.log(`⚠️ 其中 ${bad.length} 行畸形（已按**全局锁**保守处理，不阻断；请人工修好或取锁时别手写）——见下方标 ⚠️畸形 的行：`);
}
for (const [i, r] of rows.entries()) {
    // 🔴（一次评审）：`expired` 与 `stale` **分开标**——
    //   前者是「租约到期」（设计内、确定可接管），后者是「很久没动」（只是提示，可能是活锁）。
    //   两者都落到 staleHits（见 findConflicts），所以这里只说清**为什么**可接管。
    const tags = [r.isLegacy ? '⚠️旧格式=全局锁' : '', r.expired ? `⏰租约到期(expires_at ${r.expiresAt || '?'})——可接管：remove "<片段>" --takeover="<理由>"` : r.stale ? `⚠️陈旧(${Math.floor(r.hours)}h，可接管——remove "<片段>" --takeover="<理由>"（12h 只是提示线）)` : '', malformedTag(r)].filter(Boolean).join(' ');
    console.log(`  ${i + 1}. [${r.time}] ${r.tool} | 区域:${r.regions.join(',')}${r.files.length ? ' | 文件:' + r.files.join(',') : ''}${r.id ? ' | id:' + r.id : ''} | ${r.note} ${tags}`);
  }
  process.exit(0);
}

if (cmd === 'check') {
  // 🔴  一次评审：**入口就归一**，下面四处全部吃归一后的数组。
  //   病根＝CLI 侧吃**原始 argv**（shell 的引号原样进来），解析侧吃**归一后的锁行**
  //   ⇒ 两端口径不对称 ⇒ `findConflicts` 的文件交集永不命中（同文件并发冲突零反馈，fail-open）。
  const mine = parseListField(opt('region') || '');
  const myFiles = parseListField(opt('files') || '');
  const bad = mine.filter((r) => !REGIONS.includes(r));
  if (!mine.length || bad.length) {
    console.error(`--region 必填，且只能是：${REGIONS.join(' / ')}${bad.length ? `（不认识：${bad.join(',')}）` : ''}`);
    process.exit(2);
  }
  const ignore = opt('ignore');   // 降级为"额外的、指名道姓的排除"（一次评审）
  // 🔴 一次评审（独立审查顺手发现）：**跳过 0 行不许说"已跳过"**。
  //   旧写法 `--ignore "根本不存在的串"` 照样打印「（已跳过 note 含「…」的行）」——
  //   **跳过 0 行却声称跳过了**。在「静默假绿」是头等公民的库里，这种措辞会误导排查
  //   （让人以为排除生效了，实际什么都没排）。
  const ignoreBase = ignoreFilter(ignore);
  const ignoredCount = ignore ? rows.length - ignoreBase.length : 0;
  if (ignore && !ignoredCount) {
    console.log(`⚠️ \`--ignore "${ignore}"\` **没匹配到任何一行**（匹配面＝note，不含 \`[格式v…]\` 版本段）——本次实际**一行都没排除**。`);
  }
  // 🔴 一次评审：不再自己内联循环，改调 `findConflicts`（与 `add` 同一份判据）。
  //   原内联循环是 `findConflicts` 去掉 skipLine 后的复制品 ⇒ 同型逻辑两份，改一处漏一处。
  const tok = sessionToken();
  const { conflicts, staleHits, selfHits } = findConflicts(mine, myFiles, ignoreBase, tok);
  console.log(`本次声明区域：${mine.join(',')}${myFiles.length ? ` | 文件:${myFiles.join(',')}` : ''}${ignoredCount ? `（已跳过 note 含「${ignore}」的 ${ignoredCount} 行）` : ''}`);
  printConflicts(conflicts, staleHits, selfHits, !tok);
  // 🔴（一次评审）：冲突时**给出先到/后到裁决**（见 printAdjudication）。
  if (conflicts.length) printAdjudication(conflicts);
  process.exit(conflicts.length ? 1 : 0);
}

/**
 * ══ 单一真源：四道阻断门 ＋ 一道提示门 ＋ 下一棒 ══════════════════════════════
 * 本地预演（只读、不写事实）· 连续多次全量通过
 *  一次评审通过（全量落地）。
 *
 * 🔴 **为什么必须抽成函数**：改动前五道门是五段**内联 `if…exit(1)`**，
 *   「哪些检查会让 add 走 exit(1)」只能靠人读代码数出来（评审）。
 *   ⇒ 现在**门清单由本函数枚举**，add 与 --dry-run **共用同一段判定**（一条硬要求：「门不写死」）。
 *
 * 🔴 **两条硬约束（评审）**：
 *   ① **真实 add 的输出与退出码必须一字不变** ⇒ io:'real' 路径的 console 文本与顺序**逐字照抄**改动前；
 *      本函数只把「打印什么／退不退」从流程里**搬进数据**，不新写措辞（逐字 diff 验这条）。
 *   ② **dry-run 不得在旁路另写一份判定** ⇒ 「是否复用 5 分钟内的同范围锁行」也走同一函数
 *      （`computeReuse`）⇒ 预演报「将新增 1 行」与真跑恒一致。
 *
 * 返回：[{ id, kind:'阻断'|'提示', ok, why, next, forceNote, info:[{s,t}], err:[{s,t}],
 *           noteIfForced, exitCode, compute? }]
 *   · `info` ＝ 真实路径下**逐字照抄**、无条件打印的行（s:'out'⇒console.log）
 *   · `err`  ＝ 真实路径在「未过且未 --force」时打印的行（s:'err'⇒console.error）后 exit(1)
 *   · `compute`＝ 可选的**惰性** thunk：只有走到这条 entry 时才跑（保真：改动前 fatal 时不会跑后续检查）
 *   · `noteIfForced` ＝ 被 --force 越过时追加进锁行说明段的留痕（仅真实 add 用）
 */
async function evaluateGates({ io, files, mine, force, tok }) {
  const entries = [];
  const out = (t) => ({ s: 'out', t });
  const err = (t) => ({ s: 'err', t });
  const push = (e) => { entries.push(e); return e; };

  // ── GATE('files-not-dir') ────────────────────────────────────────────────
  // `--files` 路径校验（一次评审定的）。
  // 判据（三版迭代，见设计说明）：尾斜杠/通配符/已是目录/父路径不是目录 ⇒ **拒**；
  //   其余不存在的路径 ⇒ **警告放行**（"将要新建"是合法用法，锁行可写任意路径）。
  {
    const items = files && files !== '-' ? parseListField(files) : [];
    const bad = [];
    for (const raw of items) {
      const p = String(raw).replace(/\\/g, '/');
      if (/[*?[]/.test(p)) { bad.push([raw, '含通配符（通配符今天不展开，与目录同病）']); continue; }
      if (/[/\\]$/.test(raw)) { bad.push([raw, '以分隔符结尾（永远 ≠ 实际文件路径）']); continue; }
      const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { bad.push([raw, '是已存在的目录']); continue; }
      const parent = path.dirname(abs);
      if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) { bad.push([raw, '父路径存在但不是目录']); continue; }
    }
    const e = {
      id: 'files-not-dir', kind: '阻断', ok: !bad.length,
      // 🔴 `noForce`：**这道门不是闸门，是形状校验** ⇒ `--force` 绕不过它（改动前就是无条件 exit 1）。
      //   独立复核实测抓到：改动前 `add --files <目录> --force` ⇒ exit 1、锁表为空；
      //   改动后同一命令 ⇒ exit 0 且写进一条「文件:dir」的锁行 ⇒ 真实 add 行为回归 ＋ 预演/真跑相左。
      noForce: true,
      why: bad.length
        ? `不合法的路径 ${bad.length} 个：${bad.map(([b, why]) => `「${b}」—— ${why}`).join('；')}`
        : `路径形状都合法（${items.length} 个）`,
      next: 'node scripts/write-lock.mjs add --region <区> --files <逐个具体文件名…>',
      forceNote: '不可用 --force 越过（形状错误不是闸门问题）',
      info: [], err: [],
    };
    if (bad.length) {
      e.err = [
        err('❌ --files 里有不合法的路径：'),
        ...bad.map(([b, why]) => err(`   · 「${b}」—— ${why}`)),
        err('   后果：锁行与你收尾时的 git 提交范围按**精确文件路径**比对，这些形态永远匹配不上 ⇒ 文件会**静默不进提交**。'),
        err('   修：逐个写**具体文件名**（目录覆盖是 `--region` 的活）；确要新建的文件直接点名即可。'),
      ];
    } else {
      const ghost = items.filter((raw) => {
        const p = String(raw).replace(/\\/g, '/');
        return !fs.existsSync(path.isAbsolute(p) ? p : path.join(ROOT, p));
      });
      if (ghost.length) {
        e.info = [
          out(`⚠️ --files 里有当前不存在的路径（按"将要新建"放行）：${ghost.join('、')}`),
          out('   ⚠️ 若你想写的是**一个目录**，本命令不支持——请逐个写文件名。'),
        ];
        e.why = `路径形状都合法（${items.length} 个；其中 ${ghost.length} 个当前不存在，按"将要新建"放行）`;
      }
    }
    push(e);
  }

  // ── GATE('open-stamp') ────────────────────────────────────────────────────
  // 开场闸门：
  // 缺 `_AI/.开场证迹`（session-open 落）或戳已陈旧 → **拒绝取锁**（fail-closed）；
  // `--force` 显式越过，并在锁行里写 `[跳过开场]` 留痕。
  {
    const STAMP = path.join(ROOT, '_AI', '.开场证迹');
    let stampWhy = '';
    let stampInfo = '';
    try {
      if (!fs.existsSync(STAMP)) {
        stampWhy = '缺 _AI/.开场证迹（本次没跑 session-open）';
      } else {
        const first = fs.readFileSync(STAMP, 'utf8').split(/\r?\n/)[0].trim();
        const t = new Date(first);
        if (isNaN(t.getTime())) stampWhy = `戳内容不可解析（${first.slice(0, 40)}）`;
        else {
          const age = (Date.now() - t.getTime()) / 36e5;
          stampInfo = `开场证迹 ${first}（${age.toFixed(1)}h < ${STALE_HOURS}h）`;
          if (age >= STALE_HOURS) stampWhy = `戳已陈旧 ${age.toFixed(1)}h（≥${STALE_HOURS}h）`;
        }
      }
    } catch (e) { stampWhy = `戳读取失败（${e.code || e.message}）`; }
    const e = {
      id: 'open-stamp', kind: '阻断', ok: !stampWhy,
      why: stampWhy || stampInfo || '开场证迹在有效期内',
      next: 'node scripts/session-open.mjs',
      forceNote: '可加 --force 越过（留痕 [跳过开场]）',
      info: [], err: [],
      noteIfForced: ' [跳过开场]',
    };
    if (stampWhy) {
      e.err = [
        err(`⛔ 开场闸门：${stampWhy}`),
        err('   先跑：node scripts/session-open.mjs   （它同时打出开场证迹行 + 落戳）'),
        err('   确实只需临时取锁（如纯排查锁状态）：加 --force —— 会在锁行写「[跳过开场]」留痕。'),
      ];
    }
    push(e);
  }

  // ── GATE('ledger-anchor') ────────────────────────────────────────────────
  // 账本闸门：
  // 「取了锁、没开账」＝ 崩溃对账空转。**本会话在账本里没有「进行中」锚 ⇒ 拒绝取锁**。
  // ⚠️ 锚身份来自 `session-ledger.mjs --start` 写进「说明」行的 `[会话:<tok>]`；
  //    **旧锚没有该标记 ⇒ 认不出归属 ⇒ 只告警不拦**（拿不到身份不假装认得出）。
  {
    let ledgerWhy = '';
    const info = [];
    if (!tok) {
      info.push(out('⚠️ 拿不到会话身份（KB_SESSION_ID 等均未设）⇒ 账本闸门按**旧行为**放行（不假装认得出）。'));
    } else {
      try {
        const LEDGER = path.join(ROOT, '_AI', '变更账本.md');
        if (!fs.existsSync(LEDGER)) {
          ledgerWhy = '读不到 _AI/变更账本.md';
        } else {
          const blocks = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n(?=## )/);
          const openBlocks = blocks.filter((b) => b.includes('status: 进行中'));
          const mineOpen = openBlocks.filter((b) => b.includes(sessionStamp(tok)));
          if (!mineOpen.length) {
            const legacy = openBlocks.filter((b) => !b.includes('[会话:'));
            if (legacy.length) {
              info.push(out(`⚠️ 账本闸门：${legacy.length} 条进行中锚**没有会话标记**（旧格式）⇒ 认不出归属，**本次告警放行**。`));
            } else {
              ledgerWhy = openBlocks.length
                ? `账本里有进行中锚，但**没有本会话的**（缺 ${sessionStamp(tok)}）⇒ 这一轮没 --start`
                : '账本里没有进行中锚 ⇒ 这一轮没 --start';
            }
          }
        }
      } catch (e) {
        info.push(out(`⚠️ 账本闸门跑不动（${e.code || e.message}）—— 只警告，不拦取锁。`));
      }
    }
    const e = {
      id: 'ledger-anchor', kind: '阻断', ok: !ledgerWhy,
      why: ledgerWhy || (tok ? '账本里有本会话的「进行中」锚' : '拿不到会话身份 ⇒ 按旧行为放行'),
      next: 'node scripts/session-ledger.mjs --start "<本次要做什么>"',
      forceNote: '可加 --force 越过（留痕 [跳过开账]）',
      info, err: [],
      noteIfForced: ' [跳过开账]',
    };
    if (ledgerWhy) {
      e.err = [
        err(`⛔ 账本闸门：${ledgerWhy}`),
        err('   先跑：node scripts/session-ledger.mjs --start "<本次要做什么>"（它同时给崩溃对账留锚）'),
        err('   确需只临时取锁：加 --force —— 会在锁行写「[跳过开账]」留痕。'),
      ];
    }
    push(e);
  }

  // ── GATE('settle-anchor') ────────────────────────────────────────────────
  // 结账闸门：
  // 「换话题 ＝ 结账」：**已有锁行声明的范围内还有未提交改动 ⇒ 拒绝取新锁**（fail-closed）。
  // ⚠️ 已知误报：**崩溃会话的遗留锁**也会命中 —— 那正是 --force 存在的理由（且会留痕）。
  // 跑不动（如 git 不可用）只警告不拦：同"依赖闸门测不到不冒充红"的口径。
  {
    const info = [];
    let pend = [];
    let othersCount = 0;
    let settleRan = true;
    try {
      const { parseLockLines, unsettledForLines } = await import('./lib/settle.mjs');
      // 🔴 根治：**只判本会话自己的行**。原来查 `parseLockLines(ROOT)` 全部行 ⇒
      //   A 的在制品会把 B 挡在门外（实测：我只能 `--force`），多会话下等于把并发变串行。
      //   别人的未结清**只提示不拦**（交集风险仍要让人看见）。
      const all = parseLockLines(ROOT);
      if (!tok && all.length) info.push(out('⚠️ 拿不到会话 ID ⇒ 分不出锁行归属，本次闸门按**旧行为**检查所有行。'));
      const others = tok ? all.filter((l) => !isMine(l, tok)) : [];
      if (others.length) {
        // 🔴 ignoreAlways 与 session-ledger.mjs 的对应逻辑拉齐（按标签找，不按行号）。
        const op = unsettledForLines(ROOT, others, { ignoreAlways: true });
        if (op.length) {
          info.push(out(`ℹ️ 另有**别的会话**的 ${op.length} 行未结清（**不拦你**，只提示交集）：${op.map((p) => `「${p.line.note}」`).join(' ')}`));
          othersCount = op.length;
        }
      }
      pend = unsettledForLines(ROOT, tok ? linesOfSession(all, tok) : all, { ignoreAlways: true });
    } catch (e) {
      settleRan = false;
      info.push(out(`⚠️ 结账闸门跑不动（${e.code || e.message}）—— 只警告，不拦取锁。`));
    }
    const e = {
      id: 'settle-anchor', kind: '阻断', ok: !pend.length,
      why: pend.length
        ? `还有 ${pend.length} 行锁行声明的范围没提交（先结账，再换话题）`
        : (settleRan ? '本会话没有未结清的锁行范围' : '结账闸门跑不动（只警告，不拦）'),
      next: 'git commit -m "<你那行锁的片段>"',
      forceNote: '可加 --force 越过（留痕 [跳过结账]）',
      info, err: [],
      noteIfForced: ' [跳过结账]',
      detail: pend,
      extraHints: othersCount ? [{ why: `别的会话有 ${othersCount} 行未结清（不拦你，只提示交集）`, next: 'node scripts/write-lock.mjs list' }] : [],
    };
    if (pend.length) {
      e.err = [
        err('⛔ 结账闸门：还有锁行声明的范围没提交 —— **先结账，再换话题**'),
        ...pend.map(({ line: l, paths }) => err(`   · 「${l.note}」→ ${paths.length} 个未提交：${paths.slice(0, 3).join(' / ')}${paths.length > 3 ? ' …' : ''}`)),
        // ── 「下一棒」的 **settle-anchor** 落点（一次评审要求覆盖两类）──
        //   他人锁交集那一类在 `printConflicts` 末尾；这一条是结账闸门类的下一步。
        err('  · 下一棒：git commit -m "<你那行锁的片段>"'),
        err('   若那是崩溃会话的遗留锁（不是你的）：加 --force —— 会在锁行写「[跳过结账]」留痕。'),
      ];
    }
    push(e);

    // ── 「未点名」提醒（只提醒、不拦）────────────────────
    //   范围现在**只认点名文件** ⇒ 锁里声明了区域、区域里有脏、却没点名，**八成是取锁时漏写文件名**。
    //   这里**只提醒、不拦**：那些文件本来就不在范围内（拦下来会挡住正常提交流程）；
    //   真正"不替你猜"的判断要由你自己做（本包不附赠提交脚本）。
    //   🔴 **惰性**：改动前这段在「结账闸门 fatal」时**根本不会跑** ⇒ 这里也用 compute thunk，
    //      保证真实路径的执行顺序与改动前逐字一致（依赖这一点）。
    // 🔴 **按引用捕获自身**（落地后复核）：原来写 `entries[entries.length - 1]` 反查自己
    //   ⇒ 一旦有人在本条**之后**插一道新门（自然位置），thunk 会把「另有 N 条脏文件未点名」
    //   写进**新门**的 why，而 settle-unnamed 自己停在默认文案。verdict 不变，但 dry 的逐门
    //   「一句原因」会指错门。判据不变、位置不变 ⇒ 用局部引用锁住。
    const unnamedEntry = {
      id: 'settle-unnamed', kind: '提示', ok: true,
      why: '（未算：真实路径在 fatal 时不会走到这里）',
      next: '重取锁时把那些文件写进 `--files`',
      forceNote: '（提示项，不拦）',
      info: [], err: [],
      compute: async () => {
        try {
          const { parseLockLines, unnamedForLines } = await import('./lib/settle.mjs');
          const all = parseLockLines(ROOT);
          const unm = unnamedForLines(ROOT, tok ? linesOfSession(all, tok) : all, { ignoreAlways: true });
          const n = unm.reduce((a, p) => a + p.paths.length, 0);
          if (n) {
            unnamedEntry.info = [
              out(`ℹ️ 另有 ${n} 条脏文件在你声明的区域内、但**没被点名**（不会进提交）—— 若是你改的，重取锁时把它们写进 \`--files\`：`),
              ...unm.slice(0, 2).map((p) => out(`   · 「${p.line.note}」→ ${p.paths.slice(0, 3).join(' / ')}${p.paths.length > 3 ? ' …' : ''}`)),
            ];
            unnamedEntry.why = `另有 ${n} 条脏文件在你声明的区域内、但没被点名（不会进提交）`;
          } else {
            unnamedEntry.why = '没有未点名的脏文件（你声明的区域内一切都是点名过的）';
          }
        } catch (e) {
          unnamedEntry.info = [out(`⚠️ 未点名清单算不出来（${e.code || e.message}）—— 只警告。`)];
          unnamedEntry.why = '未点名清单算不出来（只警告）';
        }
      },
    };
    push(unnamedEntry);
  }

  return entries;
}

/**
 * 「5 分钟内的同范围锁行」判定（一次评审）——**真跑与预演共用**。
 * 🔴 诚实边界：这条分支在当前调用下**不可达**（防御性保留——若未来调用方传对象身份，它会生效）（`tok` 是字符串 ⇒ `tok.session` 恒 undefined ⇒ `sess` 恒假）；
 *   保留原样、**不修**（「不改 add 现有判定逻辑」这条原则），但**两处都走这一个函数**，
 *   免得预演侧另写一份「正确语义」的判定 ⇒ 出现「预演说将复用、真跑却新增一行」的相左（评审）。
 */
function computeReuse(freshRows, tok, mine, filesArg) {
  // ⚠️ tok 为空（身份不可用）时**跳过去重**——身份都认不出就做「同会话」判定是冒险，
  const sess = tok && tok.session;
  const norm5 = (a) => [...new Set(a || [])].sort().join('\u0001');
  const myFiles5 = filesArg === '-' ? ['-'] : parseListField(filesArg);
  if (!sess) return null;
  return freshRows.find((r) => r.timeMs != null
    && ((String(r.raw).match(/\[会话:([^\]]+)\]/) || [])[1] === sess)
    && norm5(r.regions) === norm5(mine)
    && norm5(r.files) === norm5(myFiles5)
    && (Date.now() - r.timeMs) <= 5 * 60_000);
}

if (cmd === 'add') {
  const mine = (opt('region') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = mine.filter((r) => !REGIONS.includes(r));
  if (!mine.length || bad.length) {
    console.error(`--region 必填，且只能是：${REGIONS.join(' / ')}${bad.length ? `（不认识：${bad.join(',')}）` : ''}`);
    process.exit(2);
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  // 🔴 评审（方案丙）：**默认值不再填死工具名** —— 那会让
  //   会话自称成某个工具，锁行的 tool 字段**撒谎**，且已导致一次错误推理（一次评审）。
  //   改成「显式传的优先，否则按会话身份反推，拿不到就说拿不到」；
  //   **只改这一格的值、不动字段位置** ⇒ 不改锁行格式、不用改 schema（旧行照读）。
  const tool = opt('tool', hostName());
  if (tool === '未识别') console.log('⚠️ 取不到会话身份（KB_SESSION_ID 未设、无身份文件）⇒ tool 字段记「未识别」，**不假装认得出**；归属仍由 note 里的 `[会话:]` 判定。');
  const files = opt('files', '-');
  // 🔴🔴 修（**静默丢参**）：整个解析段重写。
  //   病根：`opt()` 只认空格形态 ⇒ `--note=值` 被**静默忽略**、写出来是「（未写说明）」；
  //        那次把"硬拒"退成"静默"才暴露（旧病，不是身份留痕引入的）。
  //   一次独立复核指出的三个对称性问题，用**「有没有读到值」这一事实**判，而不是拿默认串当哨兵：
  //     ① `--note=` 空值原来静默写空说明 ⇒ 现在拒绝（与 files/tool/region 空值一致）
  //     ② 注释原称"值以 `--` 开头由调用点响亮拒绝"越界 ⇒ 只对 --note 如此，注释据实收窄
  //     ③ `--note "（未写说明）"` 被哨兵相等误拒 ⇒ 改用 null 判定后，这句当普通说明照过
  const noteRaw = opt('note', null);                       // null ⇒ 没读到值
  const noteFlagGiven = argv.includes('--note')
    || argv.some((a) => typeof a === 'string' && a.startsWith('--note='));
  if (noteFlagGiven && (noteRaw === null || noteRaw === '')) {
    console.error(`❌ --note 给了但**没读到值** —— 拒绝执行（不静默写默认说明/空说明）。`);
    console.error(`   收到形态：${argShapeFor('--note')}`);
    console.error('   原因：只认 `--note 值` 或 `--note=值`；若值**以 `--` 开头**会被当成下一个 flag（无法与 flag 区分），`--note=` 后为空同理。');
    console.error('   ⇒ 若说明文本确实以 `--` 开头，请改写措辞（例如在前面加一个字）。');
    process.exit(2);
  }
  let note = noteRaw === null ? '（未写说明）' : noteRaw;
  if (argv.some((a) => typeof a === 'string' && /^--(files|tool|region)=$/.test(a))) {
    console.error('❌ `--files=` / `--tool=` / `--region=` 的值不能为空 —— 拒绝执行。');
    process.exit(2);
  }
  // 🔴  身份留痕（设计说明 · 定稿）：可选 `--agent <名>`
  //   ⇒ note 追加 `[代理:名字]` 标签——**调用方自证（attestation）非鉴权**：对"漏传/忘传"可查，
  //   不防谎报（真拦截＝鉴权，留第三阶段后期）。照 `[会话:]` 范式进说明段、去重、不升格式版本
  //   （lockline VERSION_RE 只认 [格式vN]，审核已核）。tok 只能区分"哪条会话"（UUID 不可人读），
  //   [代理:] 补"哪个角色"的人读归属。缺省不追加 ⇒ 旧调用逐字节不变。
  const agentName = opt('agent');
  // 🔴 修：`--agent=名` 等号形态不认 ⇒ 原来**静默忽略**（add 无标签、
  //   remove 静默 no-match）。静默失败比报错危险 ⇒ 显式拒绝，指明正确写法。
  // 🔴 修：**排除 `--note` 的值**——`--note "--agent=x"` 是合法说明文本，
  //   不该被当成等号形态而拒绝（否则 fail-closed 误伤正常调用）。
  const _ni = argv.indexOf('--note');
  const _noteValIdx = _ni >= 0 ? _ni + 1 : -1;
  if (argv.some((a, i) => typeof a === 'string' && a.startsWith('--agent=') && i !== _noteValIdx)) {
    console.error('❌ `--agent` 不支持等号形态（`--agent=名`）——请写成空格形态：`--agent 名`。');
    process.exit(2);
  }
  // 🔴🔴 **参数混淆修复（Lead 边界自测发现）**：
  //   `--agent` 后面紧跟另一个 flag（如 `--agent --force`）时 `opt()` 返回 null ⇒ **静默忽略**，
  //   而那个 `--force` 被当成真正的 force flag ⇒ **实测写出了带 [force] 的锁行（跳过结账闸门）**。
  //   这是"参数吞并 ⇒ 闸门绕过"，必须 fail-closed：`--agent` 后面无值或紧跟 flag ⇒ 拒绝执行。
  if (argv.includes('--agent') && !agentName) {
    console.error('❌ --agent 缺值（其后没有 token，或紧跟另一个 flag）——拒绝执行。');
    console.error('   原因：否则下一个 flag 会被当成你的名字吞掉（实测 `--agent --force` 会误触发 force、跳过结账闸门）。');
    process.exit(2);
  }
  // 🔴🔴 **注入漏洞修复（独立自测发现）**：
  //   未校验的 `--agent` 值会把协议标记**注进锁行**——实测三条攻击串全部成功：
  //     ① `--agent "甲] [会话:伪造tok"` ⇒ 锁行出现 `[会话:伪造tok]`（可冒认归属）
  //     ② `--agent "乙] [跳过结账"`   ⇒ 伪造闸门留痕标记
  //     ③ `--agent "丙 | 区域:scripts,meta | 文件:scripts/write-lock.mjs"`
  //        ⇒ **锁行多出两组 `区域:`/`文件:` 字段**（可伪造声明范围＝提权）
  //   病因：note 是自由文本，但里面塞着**被机器解析的协议标记**（lockline 文件头已写这条）；
  //        我这次让**一个参数**能往 note 里写字 ⇒ 把"自由文本"变成"可注入面"。
  //   修法＝**fail-closed 白名单**（收敛为共享函数 `validAgentName`，见 lib/settle.mjs）：
  //        字母/数字/下划线/短横/点/中文，长度 ≤40，且**至少含一个字母/数字/中文**
  //        （⇒ 拒 `-` / `.` / 纯 `_` 串；`sub_agent-1` 这类合法名照过）；
  //        含 `|` `[` `]` 换行 Tab 或超长 ⇒ **直接拒绝执行**（不清洗后放行——清洗会让人以为写成功了）。
  //   ⚠️ 诚实边界：本校验防的是"标记注入"，**不防"谎报一个合法名字"**（那是鉴权，留第三阶段后期）。
  //   ⚠️ 评审订正：旧注释写"拒绝 `_`"与代码不符（`_` 在中间/末尾是合法的，只有**纯 `_` 串**被拒）。
  if (agentName) {
    if (!validAgentName(agentName)) {
      console.error('❌ --agent 值非法，拒绝执行（防协议标记注入）：只允许「字母/数字/下划线/短横/点/中文」，长度 ≤40，且至少含一个字母/数字/中文。');
      console.error(`   收到：${JSON.stringify(agentName)}`);
      console.error('   ⚠️ 不要用 --agent 传说明文字；说明请放进 --note。');
      process.exit(2);
    }
    if (!note.includes(`[代理:${agentName}]`)) note += ` [代理:${agentName}]`;
  }
  // 🔴 （独立复核）：来源要**只用同一次读** —— 告警里报的 id 与**实际盖的戳**
  //   必须同一个（另一会话可能正好在两次读之间覆盖 `_AI/.会话身份` ⇒ 重读会让告警误导）。
  const tokSrc = sessionTokenSource();
  const tok = tokSrc.tok;   // 本会话身份（评审 根治）；拿不到 = ''（退回旧行为并告警）

  // ══ 四道阻断＋一道提示：判定与打印**都**来自单一真源 `evaluateGates` ══
  //   io:'real' ⇒ 与改动前**逐字同输出、同退出码**；io:'dry' ⇒ 只收集，不因门未过退出非零。
  const io = argv.includes('--dry-run') ? 'dry' : 'real';
  const force = argv.includes('--force');
  const gateEntries = await evaluateGates({ io, files, mine, force, tok });
  for (const g of gateEntries) {
    if (g.compute) await g.compute();
    // 🔴 dry 模式：**只收集**，不打印真实路径的输出行、**不因门未过退出非零**（一条硬要求：
    //    `--dry-run` 恒 exit 0，唯一例外＝用法错 exit 2，在参数校验层已拦）。
    if (io !== 'real') continue;
    for (const l of g.info || []) console.log(l.t);
    if (g.ok) continue;
    // 🔴 `noForce` 的门（形状校验类，如 files-not-dir）**--force 也拦**（改动前就是无条件 exit 1）。
    if (!force || g.noForce) {
      for (const l of g.err || []) console.error(l.t);
      process.exit(g.exitCode || 1);
    }
    if (g.noteIfForced) note += g.noteIfForced;
  }

  // 🔴 一次评审实测修：原来**无条件追加** `sessionStamp(tok)`，
  //   而调用方常把标记**写进 `--note` 自己**（卡片第 2 步就教人这么写）⇒ 同一标记出现两次
  //   （`… [会话:sess-x] [会话:sess-x]`）。功能上不坏（`isMine` 用 includes），
  //   但**显示重复**、且会让"这行是不是被人手拼过"看不出来 ⇒ 已存在才补。
  if (tok && !note.includes(sessionStamp(tok))) note += ' ' + sessionStamp(tok);
  // 🔴（独立复核）：**来源要落盘** —— 锁行只写 `[会话:…]` ⇒ 事后审计
  //   分不出「可靠戳（env 来的）」与「**可能是别人 id** 的戳（共享文件来的）」⇒ 说明段补一个来源标签。
  //   ⚠️ 标签放在**说明段内**（不新增字段、不动分隔段 ⇒ **不升格式版本**；`lib/lockline.mjs` 按标签扫，
  //   多一个标签不影响解析——说明段本来就塞着 `[会话:]`／`[跳过开场]`／`[跳过开账]`）。
  if (tok) note += ` [身份:${tokSrc.source}]`;
  // ── GATE('force-trace') ──────────────────────────────────────────────────────
  // `--force` 留痕（一次评审定的）。**只在这一处写一次**。
  // 病因：原实现的四段留痕都是 `if (闸门红 && force) note += ' [跳过X]'`（四条**独立**的顺序 if）
  //   ⇒ **四道门全绿时传 `--force`，锁行一个字都不加** ⇒ 事后查不出"这一轮到底越没过"。
  // 写法约束（独立审查逐条定死，照抄别改）：
  //   ① 进 **note 段内**、且**在 `[格式vN]` 之前** —— `lib/lockline.mjs` 的「版本纪律」要求"需程序判定
  //      的新标记先升格式版本"，而黏在版本段后会破坏 `VERSION_RE` 的识别（version=null）；
  //   ② **只在末尾写一次**（不在四个闸门处各写一句，否则会 `[force] [force] [force] [force]`）；
  //   ③ 已在 note 里则不重复（照上一行的 `[会话:]` 去重范式）。
  if (force && !note.includes('[force]')) note += ' [force]';
  // 🔴  独立审查纠正：上面那句注释里的「note 是自由文本 ⇒ 不改锁行格式」**早已不成立**
  //   （`[会话:]`／`[跳过结账]`… 早就塞在 note 里了）。诚实表述见 `lib/lockline.mjs` 文件头。
  // 🔴 格式版本号（一次评审）：**独占一段**追加在行尾。
  //   为什么不写进 note（`${note} [格式v1]`）：说明是自由文本，段内也可能是字面量
  //   ⇒ 只能靠"整段精确匹配"区分 ⇒ **必须自己占一段**。解析器仍容忍粘连（历史手写）。
  // 🔴  一次评审：**写入端也归一** ⇒ 新锁行不再把 shell 的引号落盘，
  //   `list` 的人读输出也不会是一串带引号的路径。
  const filesOut = files === '-' ? '-' : parseListField(files).join(',');
  // 🔴（一次评审）：**每行带一个不可变 id**。
  //   病根：note 既是人读的说明，又是收尾提交时按 note 匹配锁行的**匹配键** ⇒
  //   一次批量改名就能让 `--note` 匹配不上 ⇒ 提交链断（exit 2）。
  //   ⇒ id 与 note 文本**完全解耦**：note 怎么改都不影响 `--id` 取行。
  //   形态：`L-<base36 毫秒时间戳>-<4 位随机>` ⇒ 同毫秒内几乎不可能重复（随机段 36^4≈168 万）。
  //   ⚠️ **纯新增字段 ⇒ 不升格式版本**（旧行无 `id:` ⇒ 解析出空串 ⇒ 回退 note 匹配，不破旧行）。
  const lockId = `L-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // 🔴 租约到期时刻（格式 v2）：**每次 add 都续租**。
  //   格式与行首 `stamp` 同款（`YYYY-MM-DD HH:mm`，本地时钟）——人读一致，`parseLockLine` 两种都认。
  //   ⚠️ 用 `expires_at` 而不是 `ttl`：写**绝对时刻**，读的人不必知道 TTL 是多少（租约可被单行覆盖）。
  const expD = new Date(Date.now() + LOCK_TTL_HOURS * 36e5);
  const p2 = (n) => String(n).padStart(2, '0');
  const expiresAtStr = `${expD.getFullYear()}-${p2(expD.getMonth() + 1)}-${p2(expD.getDate())} ${p2(expD.getHours())}:${p2(expD.getMinutes())}`;
  const line = `${stamp} | ${tool} | 区域:${mine.join(',')} | 文件:${filesOut} | id:${lockId} | expires_at:${expiresAtStr} | ${note} | [格式v${CURRENT_FORMAT}]`;
  // ⭐ 取锁时**顺带报冲突**（`rows` 是"加锁前"的状态 ⇒ 本次新加的那行**不在里面**，天然不撞自己）。
  // 🔴 一次评审：这里过去认不出**"自己上一行"**——同一会话先后取
  //   两个区域重叠的锁时，会把**你自己的行**报成冲突（同一晚上能撞好几次）。
  //   当时的处方是"让人手写 `--ignore` 绕过"，那是**假解法**（要改自己的 note 措辞才能过，
  //   且子串会误伤同措辞的别人的行 ⇒ 静默漏掉真冲突）。
  //   ⇒ 现在改成 `findConflicts` 内部按 `isMine(r, tok)` **自动认出自己**；
  //   自己占着的相交区域**单列为自提醒**（真实重叠，不是幻觉，但不能当"别人的冲突"报）。
  //   `--ignore` 保留，但**降级**为"额外的、指名道姓的排除"，匹配面从 `r.line` 改到 `r.note`。
  const ignore = opt('ignore');
  // 🔴  一次评审：与 `check`／文件闸门**同一口径**（都吃归一后的数组）。
  const myFileList = files === '-' ? [] : parseListField(files);
  // 🔴 一次评审（独立审查实测有效的那一条）：**判定前重读锁文件**。
  //   病根＝`rows` 在**模块顶层**求值（早于命令分发），而 `add` 从进程启动到判定之间要跑
  //   **四道闸门**（路径形状／开场戳／账本／结账闸门走 git）⇒ 这段时间里**别的会话 `add` 的
  //   相交锁不在快照里** ⇒ 报「✅ 无冲突」⇒ **漏报真冲突**，两个会话同时写同一区域。
  //   ⚠️ 独立审查**实测否决了「把闸门挪到判定之后」**（原方案 2）：`rows` 既然是模块顶层
  //   求值，判定前移**不改变数据的陈旧度**（模块加载到闸门前只隔 1–5ms）⇒ 治不了病。
  //   ⇒ **只有「判定前重读」能动病因**。
  //   实现范式＝`freshLocks()`（函数内现读 ＋ 尾读 git 核对版本）——
  //   那是全仓库做得最对的读法。
  //   ⚠️ 重读**必须重解析**（不是复用已 parse 过的对象）——`parse()` 依赖 `Date.now()` 算 `hours/stale`。
  const freshRows = readRows().map(parse);
  for (const [i, r] of freshRows.entries()) r.lineNo = i + 1;
  const { conflicts, staleHits, selfHits } = findConflicts(mine, myFileList, ignoreFilter(ignore, freshRows), tok);
  // ══ `--dry-run` 分支：只读预演（五条硬要求）══════════════
  //   🔴 **零写入**：本分支在 `fs.mkdirSync`／`appendFileSync` **之前** return ⇒ 锁表不动、
  //      开场戳不动、`.闸门留痕.log` 不动、任何文件都不动（八项断言逐条验这条）。
  //   🔴 **与真跑同源**：门判定来自 `evaluateGates`、复用判定来自 `computeReuse`、冲突判定来自
  //      `findConflicts`——**没有一处在 dry 侧另写**（评审）。
  if (io === 'dry') {
    // 🔴 「阻断型」＝**除显式标 `kind:'提示'` 以外都算阻断**（独立复核订正）：
    //   原来写 `kind === '阻断'` ⇒ 以后新增一道门若忘了标 kind，它在预演里会**整条消失**（fail-open）；
    //   现在改成"默认阻断、提示要显式声明" ⇒ 忘标 ⇒ **仍然报出来**（fail-safe）。
    const blocking = gateEntries.filter((g) => g.kind !== '提示');
    const failed = blocking.filter((g) => !g.ok);
    const dup = computeReuse(freshRows, tok, mine, files);
    console.log('[预演·只读·未取锁] 不写锁行 · 不记任何事实 · 下一步仍须真跑 add 才能落笔');
    console.log(`声明：区域:${mine.join(',')} ｜文件:${files === '-' ? '-' : myFileList.join(',')} ｜会话:${tok || '（拿不到身份）'}`);
    console.log('逐门结论（阻断型）：');
    for (const g of blocking) {
      console.log(`  ${g.ok ? '✅' : '⛔'} ${g.id.padEnd(15, ' ')}${g.why}${g.ok ? '' : `｜${g.forceNote}`}`);
      if (!g.ok && g.next) console.log(`      → 下一棒：${g.next}`);
    }
    console.log(`结论：真实 add ${failed.length ? '会被拦' : '不会被拦'}（${failed.length} 门未过）`);
    if (force && failed.length) {
      console.log(`  ℹ️ 本次带了 --force ⇒ 真实 add 会越过这 ${failed.length} 道门（留痕写进锁行说明段：${failed.map((g) => (g.noteIfForced || '').trim()).join(' / ')}）`);
    }
    console.log(`取锁落点：${dup ? `将复用 id:${dup.id}（5 分钟内的同范围锁行——不新增行）` : '将新增 1 行'}`);
    const hints = [];
    for (const g of gateEntries) {
      if (g.kind === '提示') hints.push({ mark: 'ℹ️', id: g.id, why: g.why, next: g.next });
      for (const h of g.extraHints || []) hints.push({ mark: '⚠️', id: 'settle-others', why: h.why, next: h.next });
    }
    for (const c of conflicts) {
      hints.push({
        mark: '⚠️', id: '他人锁交集',
        why: `${c.r.tool}「${c.r.note}」持有 ${c.fInter.join('、') || '（无文件交集，只撞区域）'}${c.fInter.some((f) => APPEND_SHARED.includes(f)) ? '（其中追加型豁免文件可写）' : ''}；先来后到 rebase`,
        next: 'node scripts/write-lock.mjs list',
      });
    }
    for (const r of staleHits) {
      hints.push({
        mark: 'ℹ️', id: 'stale-takeover',
        why: `有一条可接管行（${r.expired ? `租约已到期 expires_at ${r.expiresAt || '?'}` : `陈旧 ${Math.floor(r.hours)}h`}）：${r.tool}「${r.note}」`,
        next: 'node scripts/write-lock.mjs remove "<匹配串>" --takeover="<理由>"',
      });
    }
    if (selfHits.length) {
      hints.push({ mark: 'ℹ️', id: 'self-locks', why: `你自己还持 ${selfHits.length} 条相交锁（已自动排除，不算冲突）`, next: '（不用处理）' });
    }
    if (hints.length) {
      console.log('提示（不拦，但你会撞车）：');
      for (const h of hints) {
        console.log(`  ${h.mark} ${h.id.padEnd(15, ' ')}${h.why}`);
        if (h.next) console.log(`      → 下一棒：${h.next}`);
      }
    }
    console.log('本次预演**未取锁**：没有写锁行、没有写开场戳、没有写 .闸门留痕.log、没有改任何文件。');
    // 🔴 **诚实边界**：dry 的门判定会走 `settle.mjs` 的 git 查询。settle.mjs 的 `git()` 在
    //    spawn 失败时**直接抛 fail-closed 错误**，不会静默降级 ⇒
    //    门判定读不到 ⇒ dry 报「门没跑」而不是假装跑过。此处只提醒这条边界，不描述已不存在的行为。
    console.log('⚠️ 诚实边界：门判定走 settle.mjs 的 git 查询；若 node 侧 git spawn 失败，它会 fail-closed 抛错（不静默降级、不写任何临时文件）。');
    console.log('引用本输出的日志/锁行**必须保留**首行的「[预演·只读·未取锁]」前缀（否则按假证迹论）。');
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  // 🔴 INVARIANT（一次评审）：
  //   `appendFileSync` 的**原子性是 `remove` 合并修复的前提**。若有人把它改成
  //   「readFileSync → 改 → writeFileSync」（看着像个无害优化，甚至更"整洁"），
  //   `remove` 的「写前重读＋合并」会**静默失效**（并发 add 的行被覆盖且无人察觉），
  //   同时 `remove` 自己的写也会被并发 add 冲掉。
  //   ⇒ 改这一行前先读一次评审定的两条原则。
  // 一次评审定的口径：**无条件追加 `\n`**，去掉 `existsSync && readFileSync().trim()` 这个读-判。
  //   旧写法是**读-判-再写** ⇒ 两个 `add` 同时判定"文件为空"⇒ 都不加 `\n` ⇒ `lineAlineB` 粘成一行。
  //   双 add 判空压测：**旧写法每次都粘连；无条件写则零粘连**。
  //   ⚠️ 唯一副作用：首次创建时文件以 `\n` 开头（`split('\n')[0] === ''`）。
  //   已核查全部消费方无人取 `[0]`（session-open.mjs 与解析器都 `.filter(l => l.trim())`；
  //   `readRows` 也 filter）⇒ 无害，且任意一次 `remove` 写回后即消失。
  //   `parseLockFile` 跳过空行 ⇒ 空文件场景行数仍正确（多情形实跑通过）。
  // ♻️ 同会话去重（一次评审）：同一 [会话:…] ＋ 同区域集 ＋ 同文件集 ＋ 距该行 ≤5 分钟
  //    ⇒ 复用该行（打印原 id，本次不追加）。⚠️ 提案原文「更新该行 note」与上方 INVARIANT（禁止 read+write）
  //    冲突 ⇒ 落地取舍：**零写入**保住 append 契约，note 保持原值（复用场景下 note 差异无关紧要）。
  {
    // ⚠️ tok 为空（身份不可用）时**跳过去重**——身份都认不出就做「同会话」判定是冒险，
    //    🔴 判定**真跑与预演共用** `computeReuse`（一次评审）——
    //    禁止在 dry 侧另写一份「正确语义」的复用判定。
    const dup = computeReuse(freshRows, tok, mine, files);
    if (dup) {
      console.log(`♻️ 复用 5 分钟内的同范围锁行 ${dup.id}（同会话·同区域·同文件·≤5min）`);
      console.log(`   原锁行：${dup.raw}`);
      process.exit(0);
    }
  }
  fs.appendFileSync(LOCK, '\n' + line, 'utf8');
  console.log(`✅ 已加锁：${line}`);
  // 🔴（一次口径订正）：**身份来源可见** ——
  //   病根（当场复现）：身份来自共享单槽文件 `_AI/.会话身份` 时，读到的**可能是别人的 id**
  //   ⇒ 这一行锁会被盖上别人的戳 ⇒ 之后那个会话收尾提交（范围按它那行锁点名）
  //   会把它当成自己的行 ⇒ **我的文件被它一起提交**。
  //   ⇒ 取锁这一刻就把来源和风险打出来（不拦、只告警 ⇒ 不新增闸门）。
  {
    const w = identitySourceWarn('  ', tokSrc);
    if (w) console.log(w);
  }
  printConflicts(conflicts, staleHits, selfHits, !tok);
  // 🔴（评审订正）：**裁决段也要挂在 `add` 之后** ——
  //   真正撞车的时刻是**取锁这一刻**（`check` 只是"看一眼"）⇒ 只挂 check 的话，
  //   当事人看不到"谁先谁后、该让哪几个文件"。
  if (conflicts.length) printAdjudication(conflicts);
  // 附带产物（一次评审）：
  // 让判定**可核对**——「此刻有谁在持锁」，而不是「N ms 前谁在持锁」。
  // ⚠️ 不打时间差：窗口无上界（16 行锁时判定前 2 秒），那行字会恒为真＝噪音。
  console.log(`  · 判定基于本次重读的 ${freshRows.length} 行锁（模块顶层那份快照已不用）。`);
  process.exit(0);
}

if (cmd === 'remove') {
  // ── `--takeover="<理由>"`────────────
  //   删**别人的**锁＝接管动作：必须带理由并留痕。解析与 session-ledger 的接管逻辑对齐：
  //   等号＋非空、只给一次。🔴 必须先于 needle 拼装解析并**剔除 token**——needle 是
  //   argv.slice(1).join(' ')，不剔的话 `--takeover=理由` 会进匹配串 ⇒ 命中 0 行
  //   （同款坑在 session-ledger 的 drop = adIdx ∪ tkIdx 先例）。
  const rawArgs = argv.slice(1);
  const tkIdx = [];
  rawArgs.forEach((a, i) => { if (a === '--takeover' || a.startsWith('--takeover=')) tkIdx.push(i); });
  if (tkIdx.length > 1) {
    console.log('❌ `--takeover` 拒绝执行：只能给一次（重复给出无法判定以哪条理由为准）。');
    process.exit(1);
  }
  let takeoverReason = null;
  if (tkIdx.length === 1) {
    const tkv = rawArgs[tkIdx[0]];
    if (!tkv.includes('=')) {
      console.log('❌ `--takeover` 拒绝执行：**必须带理由**，写成 `--takeover="<理由>"`（等号形式）。');
      console.log('   原因：删**别人的**锁＝接管动作，事后要能查出谁动的手（schema §0.2 第 6 条）。');
      console.log('   若 `--takeover` 只是你匹配串里的一个词 ⇒ 请把整段匹配串用引号括成**一个参数**。');
      console.log('   ⚠️ 以 `--takeover=` **开头**的匹配串目前无法表达（会被当成 flag）——请换一个片段。');
      process.exit(1);
    }
    takeoverReason = tkv.slice(tkv.indexOf('=') + 1).replace(/[\t\r\n]+/g, ' ').trim();
    if (!takeoverReason) {
      console.log('❌ `--takeover` 拒绝执行：理由为空（`--takeover=` 后面什么都没写，或只有空白/换行）。');
      process.exit(1);
    }
  }
  const dropTk = new Set(tkIdx);
  // 🔴🔴 修 `--agent` 也要从 needle 剔除——
  //   原来只剔 `--takeover` ⇒ `remove "<串>" --takeover="理" --agent 名` 的 needle 里带着
  //   `--agent 名` ⇒ **100% 匹配失败且 rc=0 静默无操作**（审核实测两次复现；连带 takeover
  //   的 [代理:] 留痕成死代码）。同款坑先例＝本段注释里的 `--takeover` 剔除。
  // 🔴🔴 修：**只剔还不够——必须同时白名单校验**。
  //   病因：agentTrace（下方 takeover 留痕）用的是**未校验的原值** ⇒ `--agent "x<TAB>伪造tok"`
  //   能给 `.闸门留痕.log` 的 Tab 分隔格式**注入伪造字段**（该日志按 \t 分列，比对 takeoverReason
  //   有 tab 清洗、agent 却没有＝不对称漏洞）。⇒ 抽出＋校验＋**复用同一个已校验值**。
  const agIdx = [];
  rawArgs.forEach((a, i) => { if (a === '--agent') { agIdx.push(i, i + 1); } });
  // `--agent=名` 等号形态显式拒绝（评审订正：静默 no-match 比报错危险）
  if (rawArgs.some((a) => typeof a === 'string' && a.startsWith('--agent='))) {
    console.log('❌ `--agent` 不支持等号形态（`--agent=名`）——请写成空格形态：`--agent 名`。');
    process.exit(2);
  }
  const agSet = new Set(agIdx);
  const removeAgent = agIdx.length ? (rawArgs[agIdx[0] + 1] || '') : '';
  // 参数混淆 fail-closed：`--agent` 后无值或紧跟 flag ⇒ 拒绝
  if (agIdx.length && (!removeAgent || removeAgent.startsWith('--'))) {
    console.log('❌ `--agent` 缺值（其后没有 token，或紧跟另一个 flag）——拒绝执行（防参数吞并/闸门绕过）。');
    process.exit(2);
  }
  // 白名单收敛为共享函数 validAgentName（lib/settle.mjs 唯一真源），不再就地抄正则
  if (removeAgent && !validAgentName(removeAgent)) {
    console.log('❌ `--agent` 值非法，拒绝执行（防协议标记/Tab 字段注入）：只允许「字母/数字/下划线/短横/点/中文」，长度 ≤40，且至少含一个字母/数字/中文。');
    console.log(`   收到：${JSON.stringify(removeAgent)}`);
    process.exit(2);
  }
  const needle = rawArgs.filter((_, i) => !dropTk.has(i) && !agSet.has(i)).join(' ').trim();
  if (!needle) { console.error('用法: node scripts/write-lock.mjs remove <匹配串> [--takeover="<理由>"] [--agent <名>]'); process.exit(2); }

  // 🔴 一次评审的修法：
  //   **写前重读 ＋ 把并发新增的行合并回去**，让别人的锁行**物理存活**。
  //
  //   为什么不是「重读→删→原子写→写后核对」（一次评审）：
  //   那个「写后核对」是**死装置**——`after` 读的是**自己刚写出的文件**，并发 `add` 若落在
  //   `renameSync` **之前**，它的行被覆盖、**从 `after` 里消失** ⇒ `lost = 0` ⇒ **一句警告都不打**。
  //   ⇒ 它只能检出「自己没造成的那类丢失」，对**真正危险的那类结构性失明**（同类形态）。
  //
  //   被否决的其他候选（审查实跑裁决，别再走回头路）：
  //     A「行数对比」：**能检出但不修复**——B 的行照样被销毁，只是把静默失效变成有告警的失效；
  //       且残余盲区：`A_pre` 读完之后到 `renameSync` 之间 ⇒ 零告警、B 被销毁。
  //     B「写后重读」：结构上不可能（见上）。
  //     C「标记删除」：把竞态从 `remove` 搬到清理函数（清理本身又是一次读-改-写），
  //       且要同步改 lockline / list / check / settle 四个消费方。
  //
  //   ⚠️ **诚实边界（残窗声明，不是免责）**：本方案把窗口压到「一次 readRows 到 renameSync」
  //     的微秒级，**但没有消除它**——单进程、无文件锁的协作式锁文件**不可能**完全消除
  //     读-改-写竞态。最后那句残窗声明是写出来的，不是假装解决了。
  const fresh = readRows().map(parse);
  for (const [i, r] of fresh.entries()) r.lineNo = i + 1;
  const before = fresh.length;
  // 🔴 匹配**打 note，不打 line**（一次评审）：版本号写进 `line` 之后，
  //   `remove "[格式v1]"` 这类匹配串会**命中每一行** ⇒ 一删全删。
  // 🔴（一次评审 · 独立复核订正）：**匹配面加 id** ——
  //   否则出现「按 id 提交、按 note 删除」的不对称（复核复现：`add` 写出 `id:L-…`，
  //   `remove "L-…"` ⇒ 「没匹配到（匹配面＝note）」⇒ 自己的锁行删不掉）。
  const hit = (r) => r.note.includes(needle) || r.id === needle;
  const hits = fresh.filter(hit);
  const kept = fresh.filter((r) => !hit(r));
  const hitCount = hits.length;

  // 🔴 一次评审发现的问题：`removed == 0`（没匹配到）原来**照样重写全文件**，
  //   并打印「锁文件未动」⇒ 实测并发 `add` 的行被覆盖销毁，而用户看到"未动"会**完全放心**。
  //   ⇒ **没匹配到就一个字都不写**，并明说。
  if (!hitCount) {
    console.log(`⚠️ 没匹配到「${needle}」（匹配面＝note，共 ${before} 行锁）—— **锁文件一个字都没动**。`);
    if (!fs.existsSync(LOCK)) console.log('  · （锁文件本就不存在）');
    process.exit(0);
  }

  // 🔴 一次评审发现的另一个问题：原来的多行保护**方向反了**——
  //   `kept.concat(fresh.filter(hit).slice(-1))` 把命中的行**加回去**，于是实际删掉的是**前面那些命中行**
  //   （可能是别人的），留下**最后命中**那行；可提示文字写的是"只删最后命中的那 1 行"，
  //   且 `✅ 已删 ${removed} 行` 里 `removed` 是**命中数**不是**删除数** ⇒ **报的是假账**。
  //   ⇒ 现在：**只删最后命中那一行**（收尾只删自己那行），**真报删除数**，并**点名删的是哪一行**。
  // ⇒ 现在：**多命中时不再删其余命中行**（`kept` 自然满足），**真报删除数**（只有 1），并**点名删的是哪一行**。
  const doomed = hitCount > 1 ? hits.slice(-1) : hits;   // 只用于计数与点名，不进 target
  if (hitCount > 1) {
    const dropped = hits.slice(0, -1);
    console.log(`⚠️ 「${needle}」命中 ${hitCount} 行，**本命令只删自己那一行** ⇒ 只删**最后命中**的那行；其余 ${dropped.length} 行**原样保留**。`);
    console.log(`  · 保留但未删：${dropped.map((r) => `「${r.note.slice(0, 40)}${r.note.length > 40 ? '…' : ''}」`).join('、')}`);
    console.log('  · ⚠️ 若上面某行**是别人的**，那是你的匹配串太宽 —— 请用更精确的匹配串重跑。');
  }
  // ── 归属三态分派────────────────
  //   病根：本分支旧实现是**无差别 note 匹配**（hit = note.includes，无归属检查、零留痕）
  //   ⇒ 用法块承诺的「只删自己那一行」是空承诺——谁知道片段就能删谁的锁。
  //    实测过一次「接力实删死锁」走的就是这个洞。
  //   ⚠️ 归属只判定 **doomed**（真正要删的那行）：多命中时其余命中行本来就被
  //   「只删最后命中」保护着原样保留、不越权 ⇒ 不整体拒绝（设计说明 的"混合命中整体拒绝"
  //   执行时修订——多命中保护已保住别人的行，整体拒绝反而误伤"自己两条相邻锁行匹配
  //   同一片段"的常见场景；修订经一次评审确认）。
  //   判定口径与前述规则同源：**认不出 ≠ 是别人的**——无标记行放行＋告警；
  //   拿不到身份不假装认得出。
  const tokSrcR = sessionTokenSource();
  const tokR = tokSrcR.tok;
  const doomedRow = doomed[0];
  // 🔴（一次口径订正）：**身份来源可见** ——
  //   `remove` 是**破坏性**路径（会删锁行）⇒ 身份若是共享单槽文件兜底来的、**读到的是别人的 id**
  //   ⇒ `isMine` 会把**别人的行当成自己的** ⇒ **可能删掉别人的锁行**。
  //   ⇒ 删之前就把来源与风险打出来（不拦、只告警 ⇒ 不新增闸门）。
  {
    const w = identitySourceWarn('  ', tokSrcR);
    if (w) console.log(w);
  }
  // 🔴 判"是不是我的"必须走全库唯一真源 `isMine`（`note.includes('[会话:<tok>]')`，check/add/commit
  //   共用）——一次评审订正：原实现取 note 中**第一个** [会话:x] 定归属，与 isMine 口径
  //   分叉 ⇒ 自己的行 note 里引用了别人的标记（接力场景自然写法）会被误判成别人的 ⇒ 误拦，
  //   且 takeover 路径会写假审计。标签**文本**（给文案/留痕用）取**最后一个**（与 评审 账本锚同口径）。
  //   ⚠️ 伴随风险（审核已登记，全库 isMine 既有语义）：别人的行 note 里若**引用了我的标记**，
  //   isMine 会误判成我的 ⇒ 无 takeover 删除。此形态我方无法单方面构造（note 由对方写），
  //   一致性优先于这个窄路径；彻底治法是锁行禁引用别人的标记（另案）。
  const doomedMine = isMine(doomedRow, tokR);
  const ownerMarks = [...doomedRow.note.matchAll(/\[会话:([^\]]+)\]/g)];
  const doomedOwner = ownerMarks.length ? ownerMarks[ownerMarks.length - 1][1].replace(/[\t\r\n]+/g, ' ').trim() : '';
  if (tokR && !doomedMine && doomedOwner && !takeoverReason) {
    // GATE('remove-takeover')
    console.log(`❌ remove 拒绝执行：要删的那行**不是你的**（[会话:${doomedOwner}]）——删别人的锁要显式接管。`);
    console.log('   处置：① 让对方会话自己删；');
    console.log(`        ② node scripts/write-lock.mjs remove "<匹配串>" --takeover="<理由>"`);
    process.exit(1);
  }
  if (tokR && !doomedMine && !doomedOwner) {
    console.log('⚠️ 要删的行没有 [会话:] 标记 ⇒ 归属不可判，按旧行为删除。');
  }
  if (!tokR) {
    console.log('⚠️ 拿不到会话身份 ⇒ 判不了归属，按旧行为删除。');
  }

  // ── 双向多重集差（一次评审）────────────────
  // ⚠️ 为什么必须**双向**，而不是只算「多出来的」（这是本轮最关键的修正）：
  //
  //   ① 正向 `added`：justBefore 里有、fresh 里已无额度 ⇒ 并发 `add` 的行 ⇒ **必须救回**
  //   ② 反向 `survived`：fresh 里有、justBefore 里已无额度 ⇒ **被并发 `remove` 删掉的行**
  //      ⇒ **绝不能写回去**。否则＝**锁复活**：别人的 `remove` 已打印「已删 1 行」
  //      并认为收尾完成 ⇒ 他的行又回来 ⇒ **他不会再删第二次**
  //      ⇒ **永久陈旧锁、误拦他人至 12h、零告警**（liveness 方向的误拦）。
  //
  //   🔴 旧代码只做了 ①，且 `target` 直接取 `fresh.filter(¬hit)`
  //      ⇒ 并发 remove 的删除被撤销。审查实跑：fresh=[B,A]、justBefore=[A]、删 A
  //      ⇒ 旧代码写回 [B]（B 复活）；本代码写回 []（正确）。
  //      触发条件只需「**任意两个 remove 时间重叠**」，**不需要逐字相同的行** ⇒ 并不罕见。
  //
  //   为什么用**多重集**（计数差）而不是 Set（存在性）：锁行**不带唯一序号**，
  //   两条**逐字完全相同**的行在 Set 里不可区分 ⇒ 存在性判据会数错条数。
  //   计数差问的是「多出几条／少了几条」，与真实场景严格对应。
  //   ⚠️ 真实触发路径只有 (a) 同一会话重复 `add`（自动化/重试）、(b) 两会话都拿不到 tok
  //      （手工跑，`sessionToken()` 为空时已告警）——因为 `add` 会把
  //      `[会话:tok]` 追加进 note ⇒ 两会话在 tok 非空时不可能逐字相同。
  const justBefore = readRows().map(parse);

  const fq = new Map();                       // fresh 里每条整行的可用额度
  for (const r of fresh) fq.set(r.line, (fq.get(r.line) ?? 0) + 1);
  const added = [];
  for (const r of justBefore) {
    const left = fq.get(r.line) ?? 0;
    if (left > 0) fq.set(r.line, left - 1);   // fresh 里就有额度 ⇒ 不是新增
    else added.push(r);                        // 多出来的 ⇒ 并发 add，必须救回
  }

  const jq = new Map();                       // justBefore 里每条整行的可用额度
  for (const r of justBefore) jq.set(r.line, (jq.get(r.line) ?? 0) + 1);
  const survived = [];
  for (const r of fresh) {
    const left = jq.get(r.line) ?? 0;
    if (left > 0) { jq.set(r.line, left - 1); survived.push(r); }
    // else: justBefore 里已无额度 ⇒ 它在两次读之间**被别人的 remove 删掉了** ⇒ 不写回
  }

  // 🔴 `target` 由 `survived` 派生，**不再是** `kept`/`fresh.filter(¬hit)`（按上述发现修正）。
  //   `kept` 是「fresh 里的非命中行」，有并发 remove 时会**包含已被别人删掉的行** ⇒ 复活。
  //   ⚠️ 评审时自查发现的 bug 也在此一并修正：`target = kept.concat(doomed…)` 会把
  //   **要删的那行又加回去** ⇒ 文件一行没少却在报「已删 1 行」（**假账 ＋ 没删**）。
  //
  // 🔴🔴 判定方式（评审时二次自查修正）：**不能**用 `survived.filter(¬hit)`。
  //   那个写法在「**所有命中行都逐字相同**」时会**把命中行全剔** ⇒ `target` 为空
  //   ⇒ 走 `unlinkSync` ⇒ **整个锁文件连同别人的锁行一起消失**（实测复现）。
  //   根因：`hit` 是**note 子串**判定，而 `survived` 是**多重集**判定，**基准不同**，
  //   前者正确也救不了后者。
  //   ⇒ 改为**按索引**判定：多命中时，「命中行里除最后一条之外的**全部**」都要保留。
  const doomedSet = new Set(doomed);
  const target = survived.filter((r) => !doomedSet.has(r));
  // 🔴 `final` 不是 `target`（独立审查发现，**执行时最易漏**）：`added` 里的行**合法地**
  //   不在 target 名单里，若拿 target 做「写后核对」，**每次并发都必然误报一次**
  //   —— 一个「每次都吵的告警等于没有告警」。
  const final = target.concat(added);

  // 🔴🔴 评审时自查抓出的第二个回归（比第一个更隐蔽，**已修**）：
  //   `target = survived.filter(¬hit)` 在「**多条逐字相同的行全部被同一 needle 命中**」时
  //   会把**它们全部剔除** ⇒ `final` 为空 ⇒ 走 `unlinkSync` ⇒ **整个锁文件连同别人的锁行一起消失**。
  //   实测：两行完全相同 ＋ `remove "完全一样"` ⇒ 打印「其余 1 行原样保留」，
  //   而**那一行连同文件一起被删了**（提示撒谎 ＋ 覆盖丢失）。
  //   根因：`survived`（存活判定，用多重集）和 `hit`（命中判定，用 note 子串）**基准不同**，
  //   前者正确也救不了后者 —— `survived` 本就含那两条，filter 之后就没了。
  //   ⇒ 当年的「下限保护」（shouldKeep/refuseEmpty）实为**死分支**：survivorsKept.length===0 时
  //      shouldKeep 恒 ≤ 0 ⇒ refuseEmpty 恒 false ⇒ 永不可达（数学证明：refuseEmpty 的两个合取支
  //      在所有取值下互斥——survivorsKept=0 时 shouldKeep=0；survivorsKept>0 时第三支假）。
  //   ⇒ **不删空的真保护 = 上方 doomedSet 恒等判定**（要删的行按对象恒等剔除，其余原样保留），
  //      兜底：不得删空、不得把假账当真。
  //   ⇒  一次评审要求：死分支已删——它曾误导维护者
  //      误以为有两道防线。

  if (!final.length) { if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK); }
  else {
    // 原子写：先写临时文件，再 rename 覆盖（Windows 下 rename 覆盖是原子的）
    const tmp = LOCK + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, final.map((r) => r.line).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, LOCK);
  }

  // ── 接管清理留痕（一次评审）：删了**别人的**行必须留机器可读痕 ─────────────
  //   锁文件是生成物、不留历史——不写这行，「谁删了别人的锁」只有 stdout 有、事后查不出。
  //   走 `_AI/.闸门留痕.log`（Tab 分隔，与既有闸门留痕格式一致）；**fail-open**：
  //   写失败只告警不拦（删除已由 stdout＋理由强制兜底，不能被日志文件权限卡死）。
  //   账本**不写**——账锚的接管由 `session-ledger --end --takeover` 负责，两处不重复。
  if (tokR && doomedOwner && doomedOwner !== tokR) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    //  身份留痕：takeover trace 也带 [代理:]（评审——破坏性动作全入口归因）
    // 🔴 **必须用上面已白名单校验过的 removeAgent**，不要在此重取
    //   `opt('agent')` 原值（那份未校验 ⇒ Tab 可注进本日志的分列格式）。
    // 🔴 修：原来 agentTrace 末尾带 `\t` ⇒ **带 agent 的行多出一列**，
    //   列数随调用而变 ⇒ 按列号解析的下游会错位。改为**折进「理由」列内**（`[代理:甲] 理由`），
    //   保证本日志**恒为 6 列**（stamp / kind / tok / owner / reason / note）。
    const agentTrace = removeAgent ? `[代理:${removeAgent}] ` : '';
    const traceLine = `${stamp}\tlock-takeover\t${tokR}\t${doomedOwner}\t${agentTrace}${takeoverReason.replace(/\t/g, ' ')}\t删 1 行`;
    try {
      fs.appendFileSync(path.join(ROOT, '_AI', '.闸门留痕.log'), traceLine + '\n', 'utf8');
      console.log(`✅ 接管清理：删了**别人的** 1 行（属 [会话:${doomedOwner}]）｜ 理由：${takeoverReason}（已留痕 .闸门留痕.log）`);
    } catch (e) {
      console.log(`✅ 接管清理：删了**别人的** 1 行（属 [会话:${doomedOwner}]）｜ 理由：${takeoverReason}`);
      console.log(`⚠️ 接管留痕写失败（${e.code || e.message}）—— 删除继续，但这条只有本输出有痕。`);
    }
  }

  // ── 写后核对：现在拿 `final` 比，且**明确说出残窗**（要求点名 [会话:xxx]）──
  const after = readRows().map(parse);
  const finalSet = new Set(final.map((r) => r.line));
  const lost = after.filter((r) => !finalSet.has(r.line)).length;
  if (added.length) {
    console.log(`✅ 合并：合回并发新增的 ${added.length} 行 —— ${added.map((r) => `「${r.note.slice(0, 40)}${r.note.length > 40 ? '…' : ''}」`).join('、')}`);
  }
  if (lost) {
    console.log(`⚠️ 写后核对：锁文件现有 ${after.length} 行，其中 ${lost} 行**不在我这次的名单里** ⇒ 可能有并发 add 被覆盖，请复查。`);
    for (const r of after.filter((x) => !finalSet.has(x.line))) {
      console.log(`  · [会话:${(r.note.match(/\[会话:([^\]]+)\]/) || [, '?'])[1]}] ${r.note.slice(0, 50)}`);
    }
  }
  // 残窗声明（审查订正：**写出来，比假装解决了值钱**）
  console.log(`  · ⚠️ 诚实边界：「最后一次重读」到 \`renameSync\` 之间若还有并发 add，本命令**挡不住**（单进程无文件锁的协作式锁文件无法完全消除读-改-写竞态）。已把窗口压到微秒级，但没消除。`);

  // ✅ 真报**删除数**（不是命中数——独立审查发现旧代码这里是假账）
  const deletedCount = doomed.length;
  if (deletedCount) {
    console.log(`✅ 已删 ${deletedCount} 行${(takeoverReason && doomedOwner && !doomedMine) ? '（接管清理）' : '（收尾只删自己那一行）'}${hitCount > 1 ? '—— 就是**最后命中**那行；其余命中行原样保留。' : '。'}`);
  } else {
    console.log(`⚠️ 没匹配到「${needle}」，锁文件未动`);
  }
  process.exit(0);
}

console.error('用法: node scripts/write-lock.mjs list | check --region <…> | add --region <…> [--files …] [--note …] [--force] | remove <匹配串> [--takeover="<理由>"]');
process.exit(2);
