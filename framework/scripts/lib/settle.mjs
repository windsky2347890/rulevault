// 结账校验（收尾提交范围判定）
// 🔴 单一实现，供两处共用：write-lock.mjs（换话题）/ session-ledger.mjs（收尾）
//    —— 同一条规则只写一遍，避免两个挂点逻辑漂移（设计说明 刻意要求）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 区域 → 路径前缀（口径与 schema §0.2 一致）
// 🔴（一次重构）：**定义已移到 `scripts/lib/regions.mjs`（唯一来源）**，
//    这里只 **re-export** —— 区域口径原本散在四处、靠人肉同步，加第八区域 `scripts` 时漏了一处。
//    新代码请直接 `import { REGION_PREFIX } from './regions.mjs'`；此处保留导出以免旧引用断掉。
export { REGION_PREFIX } from './regions.mjs';

// 🔴 锁行解析的唯一真源（一次评审）：本文件原先自己写了一份，与 write-lock.mjs ／
//    各写一份 ⇒ 口径会漂。现在共用这一份。
export { parseLockLine, parseLockFile, malformedTag } from './lockline.mjs';
import { parseLockFile } from './lockline.mjs';
import { REGION_PREFIX } from './regions.mjs';

/** 库根（`sessionToken()` 的身份兜底要读 `_AI/.会话身份`） */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 收尾产物：无论声明什么范围都算"本次会话的产出"（设计说明）
export const ALWAYS = ['_AI/会话日志.md', '_AI/变更账本.md'];

/**
 * **追加型共享文件**（schema §0.2 第 3 条「追加型豁免」清单 —— 唯一真源是 schema 正文）
 *
 * 🔴 为什么撞区排除集要用它：
 *   这 5 个文件是**多会话高频追加**的共享文件（会话日志／召回日志／变更账本／log.md／AI原理笔记）
 *   ⇒ 排空后 exit 0 报「无需提交」＝**静默零提交**（与「假绿」同形状）。
 *   ⇒ 撞区比较集必须**排除全部追加型共享文件**，不能只排除 ALWAYS（2 个）。
 *   ⚠️ 别两处各写一份：这份清单以 schema §0.2 第 3 条为准，改动时**连 schema 一起改**。
 */
export const APPEND_SHARED = [
  '_AI/会话日志.md',
  '_AI/变更账本.md',
  '_AI/召回日志.md',
  '_wiki/log.md',
  '20-知识/topics/AI原理笔记.md',
];

// ── 会话归属 ──────────────────────────────────────
// 锁行带「归属」标记（[会话:xxx]），才能分清"哪行是你自己的"：
//   ① 提交时只取本会话的行，不会把别人的在制品一起带走；
//   ② 结账闸门只判本会话的行，别人的在制品不会锁死你取锁。
// 身份来源＝进程私有的环境变量 KB_SESSION_ID（由你自己的宿主在会话启动时注入）。
// ⚠️ 拿不到身份 ⇒ 退回旧行为并显式告警，绝不假装认得出归属。
export function sessionToken() {
  return sessionTokenSource().tok;
}

/**
 * 身份来源必须可判：共享单槽文件 `_AI/.会话身份` 不能当身份通道——多会话并存时后启动者覆盖它，
 *   读到的可能是别人的 id，会把你的锁行盖成别人的戳、进而被别人的提交带走。
 *   认领只认进程私有的 env；文件兜底保留但必须可见。
 *   source＝env（可靠）／file（共享文件，可能不是你的）／none（不可判）。调用方据此告警。
 *   ⚠️ file 来源时不要当成"这就是我"：先显式设 KB_SESSION_ID（本包自定义的变量名）。
 * @returns {{tok:string, source:'env'|'file'|'none', raw:string}}
 */
export function sessionTokenSource() {
  // 只认本包自己的环境变量——认多个宿主专名会让包绑死在特定工具上，退化成
  //   "全库扫"，提交归属与"闸门只判自己"双双失效，其中提交归属会把别人的在制品一起带走（比误拦更危险）。
  const id = process.env.KB_SESSION_ID || '';
  if (id) return { tok: `sess-${id.replace(/^session-/, '').slice(0, 8)}`, source: 'env', raw: id };
  // 文件级兜底：宿主不设那三个 env ⇒ 上面恒空 ⇒ 锁行永远没有 [会话:] 标记 ⇒ 归属永远不可判。
  //   约定：若你的宿主不注入环境变量、也无法在启动时传 env，可让它在开场把会话 id 写进
  //   _AI/.会话身份（瞬态、已 gitignore）——本包**不会自动创建**该文件，需要在宿主侧自己配。
  //   ⚠️ 诚实边界：该文件是单槽 ⇒ 多会话并存时后启动者覆盖它 ⇒ 读到的可能不是你的 id。
  //   保留它当过渡兜底，但来源必须可见：source:'file' ⇒ 调用方必须告警。
  //   根治：宿主在会话启动时注入 env（source:'env'）⇒ 本兜底永远不生效。
  try {
    const f = path.join(REPO_ROOT, '_AI', '.会话身份');
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8').trim();
      if (raw) return { tok: `sess-${raw.replace(/^session-/, '').slice(0, 8)}`, source: 'file', raw };
    }
  } catch { /* 读不到就当没有身份 */ }
  return { tok: '', source: 'none', raw: '' };
}
/**
 * 身份来源告警（唯一真源）：source==='file' 时必须打出来。
 *   共享单槽文件里的 id 可能是别人的 ⇒ 把"静默认错"变成当场可见，并给出可靠修法（显式设 env，env 优先于文件）。
 * @param {string} indent 行首缩进
 * @returns {string} 告警文本（不需要告警时返回空串）
 */
export function identitySourceWarn(indent = '', src = null) {
  // ⚠️ 必须传调用方已经算好的来源（sessionTokenSource() 的返回值），别在这里重读：
  //   另一会话可能正好在两次读之间覆盖 _AI/.会话身份 ⇒ 告警里报的 id 与实际盖的戳不是同一个 ⇒ 告警反而误导。
  const s = src || sessionTokenSource();
  if (s.source !== 'file') return '';
  return `${indent}⚠️ **本次会话身份来自共享文件 \`_AI/.会话身份\`**（KB_SESSION_ID 未设）⇒ 它记的是**最后启动那个宿主会话**的 id（\`${s.raw}\`）⇒ **可能不是你的** ⇒ 归属可能认错（你的锁行可能盖成别人的戳、被别人的提交一起带走）。\n`
    + `${indent}   修法：**显式设 \`KB_SESSION_ID=<你的会话 id>\`**（env 优先于文件 ⇒ 不会被别的会话顶掉）。`;
}

/** 宿主名：按会话 id 环境变量判是哪个工具；拿不到就如实说"未识别"，不默认填某个工具名（否则锁行 tool 字段会撒谎）。
 *  ⚠️ 只改这一格填什么值、不动字段位置与分隔段 ⇒ 不改锁行格式。
 *  ⚠️ 也不能去掉该字段：锁行解析按**标签**找字段，少一段会让整行被当「旧格式全局锁」⇒ 冲突检测与取锁闸门静默放行。 */
export function hostName() {
  if (process.env.KB_SESSION_ID) return 'local';
  return '未识别'; // **不假装认得出** —— 拿不到身份就说拿不到
}
/** 写进锁行 note 的会话标记（note 本就是自由文本 ⇒ **不改锁行格式**、不用改 schema） */
export function sessionStamp(tok) { return tok ? `[会话:${tok}]` : ''; }
export function isMine(line, tok) { return !!tok && String(line.note || '').includes(`[会话:${tok}]`); }
export function linesOfSession(lines, tok) { return lines.filter((l) => isMine(l, tok)); }

/**
 * 🔒 角色名（`--agent <名>`）白名单校验 —— 全库唯一真源。
 * 🔴🔴 身份留痕改造（复核收敛）：三处调用方（write-lock add / remove /
 *   session-ledger --start）**共用本函数**，不许各自抄正则——否则三份副本必漂移。
 * 设计约束：名字会被拼进**协议标记**（`[代理:名]`）与 `.闸门留痕.log` 的 Tab 分列，故必须 fail-closed：
 *   ① 字符集＝字母/数字/下划线/短横/点/中文（禁 `|` `[` `]` 换行 Tab ⇒ 防标记注入与字段伪造）
 *   ② 长度 1–40
 *   ③ **至少含一个字母/数字/中文**（拒 `-` / `.` / 纯 `_` 串如 `__`——`_` 在中间/末尾合法，
 *      所以 `sub_agent-1` / `_x` / `x_` 放行，但 `__` / `___` 这种纯下划线名被拒）
 *      ⚠️ 自查修正：原来第二段用 `/[\w\u4e00-\u9fa5]/`，而 **`\w` 含下划线** ⇒
 *      `__` 被误判为合法（与注释不符）。改用显式 `[A-Za-z0-9\u4e00-\u9fa5]`，把下划线排除在"必需字符"外。
 * ⚠️ 诚实边界：本函数防的是"标记/字段注入"，**不防"谎报一个合法名字"**（那是鉴权，第三阶段后期再议）。
 */
export function validAgentName(name) {
  return typeof name === 'string'
    && /^[\w.\u4e00-\u9fa5-]{1,40}$/.test(name)
    && /[A-Za-z0-9\u4e00-\u9fa5]/.test(name);
}

export const norm = (p) => p.replace(/\\/g, '/');

/**
 * **路径归一（比对用）**
 *
 * 🔴 病根：`norm` 只换斜杠 ⇒ `./x.md`、`X.MD`、绝对路径、`x.md` 会被当成**四个不同的文件**
 *   ⇒ 撞区判定漏判（实测 10 组对照：`./`／大小写／绝对路径**全部漏判**）。
 *   ⇒ 本函数把两边都归一到**同一把尺**：相对库根 ＋ 正斜杠 ＋ 去 `./` ＋ **小写**（Windows 大小写不敏感）。
 *
 * @param {string} p 路径
 * @param {string|null} root 库根（给了才能把绝对路径/相对路径拉平）
 */
export function canonPath(p, root = null) {
  let s = String(p ?? '').replace(/\\/g, '/').trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  if (root) {
    const abs = path.isAbsolute(s) ? s : path.join(root, s);
    s = path.relative(root, abs).replace(/\\/g, '/');
  }
  s = s.replace(/^\.\//, '').replace(/\/+/g, '/');
  return s.toLowerCase();
}

/**
 * 快照通道（spawn 不可用时的兜底读取）—— 本包**不附赠**快照脚本，整段装置已退役。
 *
 * 历史上这里有：撞区判定函数、`.tmp/git-snapshot.txt` 快照常量与读取器、
 * bash/pwsh 双通道刷新器——都是原库「收尾提交脚本」的配套件。本包不随包发布
 * 那个脚本 ⇒ 整段随之删除。
 *
 * 保留的口径（给将来想恢复快照通道的人）：
 *   ① `git()` 优先真 spawn；spawn 层失败（EPERM/ENOENT/EBUSY 等）才考虑兜底；
 *   ② 兜底失败 ⇒ fail-closed 抛错，**不许把「读不到」报成「没改动」**；
 *   ③ 快照陈旧性只看时长、不看是否落后于 HEAD 的教训：提交后 60s 内旧快照会把
 *      「已提交」报成「未提交」——恢复前必须先解决这一条。
 */

function queryKey(args) {
  const a = [...args];
  if (a[0] === '-c' && a[1] === 'core.quotepath=false') a.splice(0, 2);
  return a.join(' ');
}

/** git blob 内容哈希——与 `git hash-object` 同算法（sha1("blob <size>\0" + content)），纯 node 不 spawn。
 *  供 session-ledger 收尾明细用（spawn 在本环境不可用；同算法同结果，可拿
 *  `git hash-object` 对拍验证）。 */
export function gitBlobHash(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`, 'utf8').update(buf).digest('hex');
}

export function git(root, args, { allowFail = false, bin = 'git' } = {}) {
  // 🔴 **真 git 优先，spawn 失败即 fail-closed 抛错**（快照通道已整段删除，见文件头）。
  //   旧序是「快照优先（≤60s 新鲜就直接用）」，而"新鲜"只看**时长**、不看**是否落后于 HEAD**
  //   ⇒ 提交后 60s 内仍会读到**提交前**状态 ⇒ `--end` 把"已提交"报成"未提交"
  //   （实测假拦过；铁证＝同一条命令等快照后立刻成功）。
  //   新序判据分区干净：**能 spawn ⇒ 权威；spawn 读不到 ⇒ fail-closed 抛**（快照通道已退役，见文件头）。
  //   ⚠️ 与另一条纪律不冲突：另一条复核纪律管「失败形状要穷举、不许落空」，本条管「**优先级**」。
  try {
    return execFileSync(bin, ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' });
  } catch (e) {
    // 🔴 fail-closed（一次评审定的口径）：
    //   **spawn 层异常**（受限沙箱禁命名管道 ⇒ EPERM errno −4048；git 不存在 ⇒ ENOENT；
    //   **EBUSY**＝实测过的第三种 spawn 死法）
    //   ＝ 命令**根本没跑起来** ＝ 「读不到」——而它与「跑起来了、输出为空」（干净的仓库）
    //   **是两回事**。前者**一律原样抛出**；`allowFail` 只许吞后一种里的"非 0 退出且无 stdout"。
    //   旧写法 `if (allowFail) return '';` 把 EPERM 静默吞成空串 ⇒ 闸门报「无改动」（假绿）——
    //   同一问题先后复发三次，
    //   一次比一次隐蔽：前两次靠提权绕过（绕过 ≠ 修好），第三次直接写进了账本。
    const spawnFailed = !!e && (e.code === 'EPERM' || e.code === 'ENOENT' || e.code === 'EINVAL' || e.code === 'EBUSY' || e.errno === -4048);
    if (spawnFailed) {
      // 🔴 fail-closed（快照通道已随「收尾提交脚本」退役，见文件头退役说明）：
      //   spawn 层失败 ⇒ 「读不到」是既定事实。本包不附赠快照兜底 ⇒ 直接抛，
      //   绝不把「读不到」报成「没改动」（假绿是本包反复治理的同一类病）。
      const err = new Error(
        'git 无法执行（spawn ' + e.code + (e.errno ? ' · errno ' + e.errno : '') + '）：git ' + args.join(' ') + ' —— 这是「读不到」，不是「没改动」\n' +
        '   本包不附赠快照兜底 ⇒ 没有兜底可用，fail-closed 原样抛出\n' +
        '   自救：换到 git 能直接执行的环境，或自己写一个把 git 状态写进文件的脚本供外部比对'
      );
      err.code = e.code || 'GIT_SPAWN_FAILED';
      err.errno = e.errno;
      err.cause = e;
      throw err;
    }
    // 🔴 一次评审新增：**跑了但退出码非 0 且 stdout 空**
    //   ＝ 也是「读不到」。 实测：fd 模式下进程起身后死于 0x5、退出码 1、stderr 有话、
    //   stdout 空 ⇒ 旧判据（只查 spawn 层）放行 ⇒ 空输出被当成"git 说没问题"——而对 `git status`
    //   来说空输出就等于"工作区干净" ⇒ `--start`/`--end` 把「没数到」写成「0 个文件」假数据。
    //   ⚠️ `allowFail` 契约保留：调用方显式说"非 0 退出且无输出可接受"时才返回 ''。
    if (e && e.status != null && !(typeof e.stdout === 'string' && e.stdout.trim())) {
      if (allowFail) return '';
      const err = new Error(`git 退出码 ${e.status} 且无输出：git ${args.join(' ')} —— 这是「读不到」，不是「没改动」`);
      err.code = 'GIT_SILENT_FAILURE';
      err.errno = e.errno;
      err.cause = e;
      throw err;
    }
    if (!allowFail) throw e;
    // 跑了、但退出码非 0：**有 stdout 就交回去**（如尚无 HEAD 的仓库），没有才承认"确实没读到"
    return typeof e.stdout === 'string' ? e.stdout : '';
  }
}

/**
 * 锁行解析 → 委托给**唯一真源** `lib/lockline.mjs`。
 *
 * 🔴 原来这里**自己写了一份**解析（`parts.find(区域:)`），与
 *   各脚本各写一份 ⇒ **同一行在不同地方读出不同东西**，
 *   且本函数的输出是**提交归属判定与结账闸门的唯一输入** ⇒ 它把畸形行解析成
 *   `regions=[]` 时，该行彻底隐形 ⇒ **静默漏提交**。
 *   现在三处共用同一实现、同一回退口径（缺 `区域:` ⇒ 全局锁，畸形行**不丢**）。
 *
 * ⚠️ 保留本函数与返回结构（`raw/regions/files/note`）不变 ⇒ **下游 5 个消费者零改动**。
 * 新增字段：`malformed`（null 或人可读原因）、`isLegacy`、`lineNo`、`timeMs`。
 */
export function parseLockLines(root) {
  const f = path.join(root, '_AI', '.写锁');
  if (!fs.existsSync(f)) return [];
  return parseLockFile(fs.readFileSync(f, 'utf8')).rows;
}

/** 畸形锁行（一次评审） */
export function malformedLockLines(root) {
  const f = path.join(root, '_AI', '.写锁');
  if (!fs.existsSync(f)) return [];
  return parseLockFile(fs.readFileSync(f, 'utf8')).malformed;
}

/** 进程内 git 状态缓存。
 *
 *  🔴 为什么加：O(N) 的真凶在这里。`unsettled()`（本文件后文的范围判定）与 `unnamedInRegion()`
 *    都 `return dirtyPaths(root)`，而 `unsettledForLines()`/`unnamedForLines()`
 *    是**逐行调用** ⇒ **N 行锁 ⇒ 2N 次 `git status --porcelain -uall` spawn**。
 *    实测（独立审查夹具，`add` 判定时刻）：1行140ms／2行278／4行576／8行1050／**16行2007ms**
 *    ⇒ 窗口**随锁行数线性增长、无上界**，而锁只 `add` 不自动清理。
 *    缓存后同夹具 `add` 全程 **2552ms → 636ms**。
 *
 *  ⚠️ **缓存不能替代「判定前重读锁文件」（一次评审）**——它只把窗口**缩小**，不**消除**。
 *    两者分工：5.1 保证「判定用最新数据」（**正确性**），缓存保证「最新数据足够新」（性能＋缩小窗口）。
 *    只做缓存不做 5.1 ⇒ 仍会漏报，只是漏报窗口从 2 秒缩到 0.14 秒。
 *
 *  ⚠️ **单次快照语义的核查结论**（一次评审）：
 *    - `dirtyPaths` 在本文件外**无直接调用方**（grep 全 `scripts/` 确认）⇒ 全部经
 *      `unsettled`/`unnamedInRegion` 间接进来，而这两者**都在同一次只读判定里**。
 *    - 收尾提交用的是它**自己的** `git()`，**不是** `dirtyPaths`
 *      ⇒ 它在暂存前不会污染本缓存；且**暂存发生在判定之后**，本来就不该在同一快照里。
 *    - `write-lock.mjs` 的 `add` 闸门链同样只读。
 *    ⇒ 一个进程内 git 状态不该变化，缓存成立。
 *    🚫 **若将来有人在同一进程里 `git add`/`commit` 之后再调 `unsettled`/`dirtyPaths`，
 *        必须先 `invalidateDirtyCache()`**（或在写后显式传 `{ fresh: true }`）——
 *        否则会读到写之前的快照 ⇒ 那正是本提案要治的病换了个方向复发。
 */
let _dirtyCache = null;          // Map<root, Set<normPath>>
let _dirtyStamp = null;          // Map<root, number> 诊断用：记录是第几次调用

/** 让本进程内已缓存的 git 状态失效（任何 git 写操作之后必须调）。 */
export function invalidateDirtyCache(root = null) {
  if (root == null) { _dirtyCache = null; _dirtyStamp = null; return; }
  if (_dirtyCache) _dirtyCache.delete(root);
  if (_dirtyStamp) _dirtyStamp.delete(root);
}

/**
 * 🔴🔴 **porcelain 路径基准**（修：结账闸门在整仓布局下静默放行）
 *
 * 病根：`git status --porcelain` 报的是**相对 git 仓库根**的路径，而本包的 `root`
 * 可能只是仓库的**子目录**——例如 `rulevault` 整仓 clone 后，`framework/` 是这个仓库的子目录。
 * 直接把 porcelain 路径当"相对 root"用 ⇒ 拼成 `framework/framework/AGENTS.md`
 * ⇒ 锁/结账闸门的路径比对**全部匹配不上** ⇒ **闸门报"已结清"，其实有改动没提交**。
 * 实测：整仓布局下改了包内文件再 `write-lock check`，exit 0 不拦；
 * 而"包根＝git 根"的控制组 exit 1 正确拦截。**照着 README 的 `cd framework` 用法用的人，闸门形同虚设。**
 *
 * 修法：取 `root` 相对 toplevel 的前缀并**剥掉**；不在前缀下的路径＝包外改动，**丢弃**。
 * 剥不掉（root 不在仓库内）⇒ **fail-closed 抛错**，绝不静默当成"没有改动"。
 */
const _prefixCache = new Map();

/** `root` 相对 git 根的前缀（`'framework/'` 或 `''`）；非 git 目录返回 `''`（由调用方的 GIT_OK 兜底） */
export function gitRootPrefix(root) {
  const key = norm(root).replace(/\/+$/, '');
  if (_prefixCache.has(key)) return _prefixCache.get(key);
  // 🔴 **不要自己算**：拿 `--show-toplevel` 与 root 做字符串前缀比较，在 Windows 上会被
  //   **8.3 短名**与**长名**两种写法打败 —— 同一条路径在两种写法下看起来都在 `Temp` 下，
  //   前缀比较却为 false ⇒ 修复本身变成新的 fail-closed 误拦。
  //   `--show-prefix` 由 git 直接给出「当前目录相对仓库根」的前缀，天然正确（包根＝git 根时为空）；
  //   它同时免疫 8.3 短名、大小写、symlink 三类差异。
  //   🔴 **注意**：这里**不要写具体用户名**（短名／长名都是）——本机用户名进注释＝泄露。
  let prefix = '';
  try {
    prefix = norm(git(root, ['rev-parse', '--show-prefix'], { allowFail: true }).trim());
  } catch { prefix = ''; }
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  _prefixCache.set(key, prefix);
  return prefix;
}

/** 清空前缀缓存（首次初始化后路径不变，仅供测试/极端重绑场景） */
export function invalidateGitPrefix() { _prefixCache.clear(); }

/**
 * `git status --porcelain` 的**已归一到包根**版本：状态码保留原样，路径剥掉 git 根前缀，
 * **包外文件整行丢弃**。三处消费者（dirtyPaths / 开账基线 / 收尾明细）共用本函数，
 * 避免"只修一处、另两处继续按错基准"——同一 bug 在 `session-ledger.mjs` 已经历过一次。
 */
export function gitStatusLines(root) {
  let raw;
  try {
    raw = git(root, ['status', '--porcelain', '--untracked-files=all']);
  } catch (e) {
    const err = new Error(`gitStatusLines：读不到 git 状态（${e.code || e.message}）—— fail-closed，拒绝把「读不到」当成「没有改动」`);
    err.code = e.code || 'GIT_UNREADABLE';
    throw err;
  }
  const prefix = gitRootPrefix(root);
  const rows = raw.split(/\r?\n/).filter(Boolean);
  if (!prefix) return rows;
  const out = [];
  for (const l of rows) {
    const code = l.slice(0, 3);                       // 状态码 + 分隔空格：保持原列宽
    const body = l.slice(3).trim().replace(/^"|"$/g, '');
    const sides = body.includes(' -> ')
      ? body.split(' -> ').map((s) => s.trim().replace(/^"|"$/g, ''))
      : [body];
    const kept = sides
      .filter((p) => p && p.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((p) => p.slice(prefix.length));
    if (!kept.length) continue;                       // 包外改动：不属于本包
    out.push(code + kept.join(' -> '));
  }
  // 🔴 修正：**删掉**了原来那条「仓库有改动但一条都不在包内 ⇒ 前缀可疑 ⇒ 抛错」的防御。
  //   病根：`--show-prefix` 是 **git 自己算的**（`framework/` 或 `''`），不存在"算错"这个可能——
  //   它唯一的失败模式是**非 git 目录**（此时返回 `''`，由调用方的 GIT_OK 兜底）。
  //   而"仓库里有改动但都在包外"（改 `lite/` 或根 README.md）在交付布局里是**日常**，不是异常。
  //   原防御把这种日常误判成"前缀可疑" ⇒ `session-ledger --start` 在第一步就崩溃（实测）。
  //   结论：**返回空数组**就是正确语义——"包内确实没有改动"。
  return out;
}

export function dirtyPaths(root, { fresh = false } = {}) {
  if (!fresh && _dirtyCache) {
    const hit = _dirtyCache.get(root);
    if (hit) return [...hit];              // 副本：不给调用方直接改缓存的机会
  }
  //   🔴 fail-closed（一次评审）：本函数是**每一道结账闸门的唯一输入**
  //   ⇒ **不许 allowFail**。读不到就抛（带 code），让调用方报红 ——
  //   而不是返回空数组、让闸门把"读不到"报成"没有改动"（两次假绿都是这里）。
  let raw;
  try {
    // 🔴 `-uall`（= `--untracked-files=all`）**必须带**：
    //   默认口径会把**新目录**折叠成一条 `?? 90-归档/` ⇒ 于是"点名 `90-归档/new-丙.md`"**永远匹配不上**
    //   （文件级点名的前提是**文件级取数**）。折叠形态还会让 `ALWAYS`（`_AI/变更账本.md`）也匹配不上，
    //   表现为"点名范围内没有改动 —— 无需提交"（**静默漏提交**，比报错更坏）。
    //   实测：收尾提交的场景就是这么红的。
    //   ⚠️ 路径基准由 `gitStatusLines` 统一归一（整仓布局下 porcelain 路径相对 git 根，不是包根）。
    raw = gitStatusLines(root).join('\n');
  } catch (e) {
    const err = new Error(`dirtyPaths：读不到 git 状态（${e.code || e.message}）—— fail-closed，拒绝把「读不到」当成「没有改动」`);
    err.code = e.code || 'GIT_UNREADABLE';
    throw err;
  }
  const out = [];
  for (const l of raw.split(/\r?\n/).filter(Boolean)) {
    // ⚠️ 改名行是 `R  old -> new`：**两侧路径都要算**。
    //    只取整串 ⇒ 它既不是合法路径（提交时 `git add` 报 pathspec 错），也不等于任一侧；
    //    于是"老路径不在我声明区域、新路径在"的改名会**整个逃过取锁/结账闸门**（闸门报"已结清"）。
    //    同一个 bug 在 `session-ledger.mjs` 已修过一次，这里是它没同步到的第二处。
    const p = norm(l.slice(3).trim().replace(/^"|"$/g, ''));
    if (p.includes(' -> ')) out.push(...p.split(' -> ').map((s) => s.trim()));
    else out.push(p);
  }
  // 🔴 一次评审定的口径：缓存**规范化后的路径集合**。
  //   对外**仍返回数组**（下游 `unsettled`/`unnamedInRegion` 都用 `.filter`）⇒ **零改动下游**。
  //   ⚠️ 返回的是**缓存数组的副本**，不给调用方直接改它的机会（否则改一次就污染整进程）。
  if (!_dirtyCache) _dirtyCache = new Map();
  const arr = [...new Set(out)];           // 去重：改名两侧可能重复
  _dirtyCache.set(root, arr);
  return [...arr];
}

// ── 「开账基线」：把"我开账前就已经在改的文件"排除出我的范围
// 病根：按区域算范围时 regions 是**路径前缀**匹配 ⇒ 声明 `--region meta` ＝ 声明整个 `_AI/`，
//   而 `--files` 只是"或"关系、**收不窄** ⇒ 别人的在制品会被卷进我的提交（实测：
//   某次提交卷进了别的会话的知识页）；反向亦然——我的新文件会被对方提交走。
// 修法：`session-ledger.mjs --start` 把**开账那一刻的脏文件清单**写进锚块（`- 开账基线：`），
//   这里按**会话标记**找回它，把"开账时就已经脏、又不是我显式点名的"文件从范围里减掉。
//   ⇒ 语义是「范围直接读**你自己**那行锁」：**归属按"是不是我这一棒产生的"判**。
// ⚠️ 已知代价（提案里写明）：开账前就脏、而我又**改了**它、又没写进 `--files` 的文件会被漏掉
//   ⇒ 兜底＝取锁时显式列 `--files`（**显式点名恒优先**，不受基线影响）。
// ⚠️ ALWAYS（会话日志／变更账本）**不受基线影响**：追加型共享文件，物理上无法按会话切分。

/** 读某会话最近一次 `--start` 记下的开账基线（集合）；读不到 ⇒ 空集（＝退回旧行为，不假装有基线） */
export function baselineOf(root, tok) {
  if (!tok) return new Set();
  const f = path.join(root, '_AI', '变更账本.md');
  if (!fs.existsSync(f)) return new Set();
  let blocks;
  try { blocks = fs.readFileSync(f, 'utf8').split(/\r?\n(?=## )/); } catch { return new Set(); }
  for (const b of blocks) {                        // 账本新→旧：第一条命中即"最近一次开账"
    if (!b.includes(`[会话:${tok}]`)) continue;
    const m = b.match(/^- 开账基线[^\n]*?：\s*(\[[^\n]*\]|无)\s*$/m);
    if (!m) continue;
    if (m[1] === '无') return new Set();
    try { return new Set(JSON.parse(m[1]).map(norm)); } catch { return new Set(); }
  }
  return new Set();
}

/** 某个范围里还没提交的路径
 *  🔴 **口径：只认「点名文件」，不再按区域纳入。**
 *  为什么改：区域是**路径前缀**匹配（＝"位置"判据），而提交范围要回答的是"**这改动是不是我这一棒的**"
 *  （＝"归属"判据）。归属问题用位置判据 ⇒ 开账之后**别人**改的同区域文件会被算成我的（ 真库
 *  实测：`_AI/踩坑录.md` 不是我改的却进了我的范围）。⇒ 归属只认点名（＋挂名的 ALWAYS）。
 *  `regions` 现在只有两个用途：① 生成**未点名清单**（见 `unnamedInRegion`）② `legacyRegions` 兼容旧行为。
 *  ⚠️ `ignoreAlways`：`--end` 处的检查必须用它——否则是**循环依赖**：
 *  账本由 `--end` 自己写、日志在收尾前才写 ⇒ 排在 `--end` 之前"先提交"永远做不到。
 *  ⚠️ `baseline:false`：只用于"想知道对方到底还有多少没结"的**提示性**检查。 */
export function unsettled(root, { regions = [], files = [], tok = '' } = {}, { ignoreAlways = false, baseline = true, legacyRegions = false } = {}) {
  const scopeFiles = ignoreAlways ? [...new Set(files)] : [...new Set([...files, ...ALWAYS])];
  const base = baseline ? baselineOf(root, tok) : new Set();
  return dirtyPaths(root).filter((p) => {
    const q = norm(p);
    if (scopeFiles.some((f) => norm(f) === q)) return true;          // ① 点名（含 ALWAYS）恒算我的
    if (!legacyRegions) return false;                                // ② 默认**不再按区域纳入**（径修订）
    const inRegion = regions.some((r) => (REGION_PREFIX[r] || []).some((pre) => q === pre || q.startsWith(pre)));
    if (!inRegion) return false;
    return !base.has(q);                                            // 开账时就在改 ⇒ 不是本会话的
  });
}

/** 「**只靠区域、没被点名**」的脏文件（评审的一条具体改动）
 *  为什么要单独算：`unsettled` 现在只认点名 ⇒ 这些文件**不会**进提交范围；但"锁里声明了区域、
 *  区域里有脏、却一个都没点名"**八成是取锁时漏写了文件名**（而不是"那些都不是我的"）⇒ 必须报出来。
 *  与基线的分工：**开账前就脏的**（在基线里）仍算别人的存量，**不提示**；基线之后才脏的才提示。 */
export function unnamedInRegion(root, { regions = [], files = [], tok = '' } = {}, { baseline = true } = {}) {
  const named = new Set([...files, ...ALWAYS].map(norm));
  const base = baseline ? baselineOf(root, tok) : new Set();
  return dirtyPaths(root).filter((p) => {
    const q = norm(p);
    if (named.has(q)) return false;
    const inRegion = regions.some((r) => (REGION_PREFIX[r] || []).some((pre) => q === pre || q.startsWith(pre)));
    if (!inRegion) return false;
    return !base.has(q);
  });
}

/** 逐条锁行判"有没有未结清的声明范围" → [{line, paths}]（会话身份从锁行的 `[会话:<tok>]` 取） */
export function unsettledForLines(root, lines, opts = {}) {
  const res = [];
  for (const ln of lines) {
    const m = String(ln.note || '').match(/\[会话:([^\]]+)\]/);
    const paths = unsettled(root, { ...ln, tok: m ? m[1] : '' }, opts);
    if (paths.length) res.push({ line: ln, paths });
  }
  return res;
}

/** 逐条锁行算「未点名」清单 → [{line, paths}]（只提醒、不拦；结账闸门才拦） */
export function unnamedForLines(root, lines, opts = {}) {
  const res = [];
  for (const ln of lines) {
    const m = String(ln.note || '').match(/\[会话:([^\]]+)\]/);
    const paths = unnamedInRegion(root, { ...ln, tok: m ? m[1] : '' }, opts);
    if (paths.length) res.push({ line: ln, paths });
  }
  return res;
}
