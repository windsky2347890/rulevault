/**
 * lockline.mjs —— 锁行解析的**唯一实现**（一次评审后确立）
 *
 * 🔴 为什么有它：**同一行锁，三个地方各写一份解析，口径三样**，且没有任何东西会报它们的差异。
 *   实测（一次评审）：
 *     ① write-lock.mjs 缺 `区域:` ⇒ `regions=[全部8区]`  ← 保守（fail-safe）✅
 *     ② 某个 pre-commit 取锁脚本缺 `区域:` ⇒ `regions=[全部8区]`  ← 保守（fail-safe）✅
 *     ③ settle.mjs 缺 `区域:` ⇒ `regions=[]`       ← **该行彻底隐形** ⛔
 *   且 ①② 按**位置**取（`parts[2]`）、③ 按**标签**找（`find(s => s.startsWith('区域:'))`）
 *   ⇒ **同一行在三个解析器眼里可能是三种东西**。
 *
 * 🔴 而③ 是 **提交范围判定与结账闸门的唯一输入**
 *   ⇒ 它把畸形行解析成"零区域"＝ **有人正在写的东西既不被拦、也不被提交 ⇒ 静默漏提交**。
 *
 * ⇒ 本文件是**唯一真源**，三个调用方全部改用它。区域枚举**不在这里重写** ——
 *   仍从 `regions.mjs` 来（那里是区域真源，两件事分开）。
 *
 * ---
 * 【回退策略：保守但不卡死】—— 为什么不是一刀切 fail-closed
 *
 *   另一派做法是 **fail closed**，并明令
 *   （与主流包管理器同一条纪律：**损坏的状态文件不许被静默替换成空文件**）——
 *   即"坏行不许当没看见"，这正是本文件要抄的核心。
 *
 *   但**整体 fail-closed（读到畸形行就拒绝运行）在本库是错的**：
 *     · 本库的锁是「**提醒冲突**」性质，不是分布式强互斥；
 *     · 业界的反对意见把代价讲清了：fail-closed 是
 *       *"correctness-preserving but **liveness-weakening**"*，且 *"a **stale block is crippling**"*；
 *     · 本库**曾发生过闸门误拦**⇒ 再加"畸形就锁死"是同病复发。
 *
 *   ⇒ 取中间档：**坏行按最保守解释（全局锁）＋ 到处报出来（不静默丢弃）＋ 不阻断流程（不 wedge）**。
 *     fail-closed 的**诊断价值**（不漏）＋ fail-open 的**可用性**（不卡），两边好处各拿一半。
 *
 * ⚠️ **改这里 ＝ 改"给全库上锁的那把锁"**：改完必须重跑
 *   `node scripts/lint-wiki.js`（改完必须全绿）。
 */

import { REGIONS } from './regions.mjs';

const ALL_REGIONS = [...REGIONS];

/**
 * 格式版本号（一次评审）—— **按标签扫全行，不按位置**。
 *
 * 🔴 为什么不能靠"它是最后一段"（独立审查推翻过一次设计）：
 *   口径（借自包管理器对锁文件的通行约定）：**纯新增字段不升版本**。若版本号必须**在末尾**，那么将来任何新字段
 *   都只能插在它前面（把它挤到中间）或后面（末尾约定当场失效）
 *   ⇒ **只要加过一个字段，"末尾"这个不变量就永久失效**，而它当初是选行尾的唯一理由。
 *   ⇒ 解析改为**按标签扫**：位置无意义 ⇒ 新增字段随便插哪都不破坏版本号。
 *
 * ⚠️ 为什么仍然**写在行尾**（而不是像有些格式写在文件首行）：**写入原子性**。
 *   首行方案要插入首行 ⇒ 与"别的会话正在 add"交错 ⇒ 可能出现半截版本行。
 *   行尾方案 `add` 仍是**单行 append**、不碰其它行 ⇒ 与在途锁行零交互、不需别人解锁。
 *   ⚠️ 只对 `add` 成立；`remove` 是"读全量→写全量"，另有原子性问题（见 write-lock.mjs）。
 *
 * 语法：`[格式vN]` —— 🔴 **必须自己独占一段**（`… | 说明… | [格式v1]`），
 * 不能附在说明文字后面（`… | 说明 [格式v1]`）。
 *   ⛔ 原因：说明是自由文本，段内也可能出现 `[格式v99]` 这种字面量；
 *     只能靠"整段精确匹配"区分二者 ⇒ 一旦允许附着，**区分就不存在了**。
 *   ⇒ 写锁（`add`）负责保证它独占一段；解析器**不猜、不纠正**，照 §"认不出就报警"处理。
 *   ⇒ 匹配方式：`段.trim()` 全等，或**段内以 ` 空格+[格式vN]` 结尾**（容忍历史手写粘连）。
 */
const VERSION_RE = /^(\[格式v(\d+)\])$|(?:\s+(\[格式v(\d+)\]))$/;

/**
 * 锁行 `id:` 段的**机器形态**（一次评审）—— **唯一真源，别内联复制**。
 *
 * 🔴 为什么要有形状校验：note 是自由文本 ⇒ 段里出现字面 `id:xxx` 会被误认成 id 并
 *   **从 note 里剥掉**（note 被静默改写）⇒ 只认 `L-` 前缀的机器形态。
 * ⚠️ 一次复核发现：这份正则曾被内联复制两份 ⇒ 改一处漂一处 ⇒ 现在只此一处。
 */
const ID_SEG = /^id:L-[0-9a-z-]{2,}$/i;

/** 当前支持的格式版本（破坏性变更才升；纯新增字段不升）
 *
 * 🔴 **v2**：新增 `expires_at:` 段（经一次评审批准）。
 *   **为什么必须升版本**：按本文件的规矩「任何新标记若需要被程序判定，必须先升格式版本」，
 *   而 `expires_at` 正是要被**程序判定**的（到期 ⇒ 标 `expired` ⇒ 别人可接管）。
 *   ⚠️ 不升也能写进去（纯新增段不破坏解析），但**不升版本的机器标记＝在没有协议的地方加协议**：
 *   旧解析器会把它当 note 自由文本 ⇒ 同一行在"写的人"和"读的人"眼里语义不同。
 *   ⇒ 升 1→2。
 *   · **新解析器读旧行**：无该段 ⇒ `expiresAtMs=null` ⇒ 回退 `STALE_HOURS`（write-lock.mjs），不破历史行。
 *   · **旧解析器读新行**：报「版本 v2 高于支持的 v1（按 v1 读，未阻断）」——不阻断，符合本文件反 fail-closed 的设计。
 */
export const CURRENT_FORMAT = 2;

/**
 * 列表字段（`区域:`／`文件:`）的**唯一解析实现**（一次评审 · 独立审查）
 *
 * 🔴 **病根**：调用方 shell 的引号会**原样进 argv**，而锁行把 argv 原样写进字段、
 *   解析端只 `trim()` ⇒ `"a.md","b.md"` 与 `a.md,b.md` 解析出**两组不同的路径**
 *  ⇒ `收尾提交` 把**已经点名**的文件判成「未点名脏文件」并 `exit 3`（真库实测）。
 *
 * ⚠️ **PowerShell 下这个传法是分形的**（审查实测，别按"调用方改写法就能绕"来想）：
 *   · `--files "a.md"`（无逗号）⇒ 干净，**单文件写法今天没病**
 *   · `--files "a","b"` ⇒ `["\"a\",\"b\""]`（**双引号保留**）
 *   · `--files 'a','b'` ⇒ `["'a','b'"]`（**单引号同样保留**）
 *   · `--files "有 空格.md","c.md"` ⇒ **被拆成 3 个 argv**（第二个文件彻底丢失，属残留面，解析层救不了）
 *
 * 两条规则（**别自行简化**）：
 *   ① **引号感知切分** —— 只在**引号外**切 `,`／`，`，引号本身**保留**给 ② 剥。
 *      实测：`"a,b.md"` 必须切出**一个**元素，不是两个。
 *   ② **窄化剥引号** —— **仅当首字符是引号、且末字符是同种引号**才各剥一个；
 *      中间的引号**一律不动**（`20-知识/他说"好".md` 必须原样保留；
 *      "删掉所有引号"的写法会把它变成一个不存在的文件名）。
 *
 * ⚠️ **前提＝Windows 路径语义**：合法 Windows 路径**不可能**以引号开头或结尾
 *   （`"` 在 Win32 路径里非法，单引号同理）⇒ 剥首尾引号**不会伤到任何合法路径**。
 * ⚠️ **全角引号「」不进这条路径**（PowerShell 不会产出，无证据，不处理）。
 */
export function parseListField(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  // ① 引号感知切分
  const parts = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',' || ch === '，') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  // ② 窄化剥引号
  return parts
    .map((t) => {
      const x = t.trim();
      if (x.length >= 2 && ((x[0] === '"' && x.endsWith('"')) || (x[0] === "'" && x.endsWith("'")))) {
        return x.slice(1, -1);
      }
      return x;
    })
    .filter(Boolean);
}

/** 空占位哨兵 `文件:-` 的处理：**必须在归一之后**判（独立审查）。
 *  旧写法在**归一之前**判 `!== '-'` ⇒ 看到的是带引号的 `"-"` ⇒ 不等于 `'-'`
 *  ⇒ 走 split 分支产出 `['"-"']` ⇒ **幽灵文件** ⇒ 收尾提交的范围行打 `[-]`（输出撒谎）。 */
function stripSentinel(list) {
  return list.length === 1 && list[0] === '-' ? [] : list;
}

/**
 * 摘出版本号段，并把它**从 note 里剥离**。
 * 剥离是必须的 —— 否则 `remove` / `--ignore` 的 `line.includes(needle)` 匹配面会被放大
 * （`remove "[格式v1]"` 会命中每一行 ⇒ 一删全删）。
 */
function extractVersion(parts) {
  let version = null;
  let dup = false;
  const kept = [];
  for (const p of parts) {
    const m = p.match(VERSION_RE);
    if (m) {
      const v = Number(m[2] ?? m[4]);
      if (version === null) version = v;
      else if (version !== v) dup = true;
      // 段内匹配时把尾部的版本标记**从该段剥掉**，让 note 保持干净
      kept.push(m[1] ? '' : p.slice(0, m.index).trimEnd());
      continue;
    }
    kept.push(p);
  }
  return { version, dup, kept: kept.filter((p) => p !== '') };
}

/**
 * 解析**一行**锁。
 *
 * 格式（管道分隔，字段**按标签找、不按位置**）：
 *   时间 | 工具 | 区域:a,b | 文件:x,y | 说明… [格式vN]
 *   - `区域:`／`文件:` **找得到就用**，找不到分别回退 `REGIONS`（全局锁）／`[]`。
 *   - **说明里含 `|` 也安全**（按标签找的结果不受影响）—— 这就是取消"位置法"的收益。
 *
 * 🔴 **note 不是自由文本**（独立审查纠正过的旧说法）：
 *   旧注释写"note 是自由文本 ⇒ 不改锁行格式、不用改 schema" —— **这句早已不成立**，
 *   因为 note 里早已塞了多个机器标记：`[会话:xxx]`／`[跳过开场]`／`[跳过开账]`／
 *   `[跳过依赖体检]`（本包无依赖体检装置，该标记为**预留**、当前永不产生）／`[跳过结账]`，现在加上 `[格式vN]`。
 *   ⇒ **诚实的表述**：note 是**带机器标记的混合区**，标记语法 `[名称:值]`，**方括号内不接受分隔符**。
 *   ⇒ 其中**只有 `[格式vN]` 具有解析优先级**（且必须整段精确匹配）；其余标记**永不参与结构判定**。
 *   ⇒ ⚠️ **任何新标记若需要被程序判定，必须先升格式版本** —— 否则就是在没有协议的地方加协议。
 *
 * 🔴 **行只能从 `raw` 写回，禁止从解析字段重建**（审查点明的等着被踩的雷）：
 *   note 已被剥离版本段 ⇒ 若有人图省事用解析字段拼回一行，**版本段会丢失或重复**。
 *   `remove` 现在走 `r.line`（=== `r.raw`）所以安全，但这条契约必须写明。
 *
 * @returns {{
 *   raw: string, time: string, tool: string,
 *   regions: string[], files: string[], note: string,
 *   expiresAt: string,      // 租约到期时刻原文（格式 v2）；'' ＝ 无该段（v1 及更早，调用方回退 STALE_HOURS）
 *   expiresAtMs: number|null, // 上者的毫秒值；null ＝ 无段**或**值不可解析（后者会进 malformed）
 *   isLegacy: boolean,      // 缺 `区域:` 标签 ⇒ 已按全局锁回退（历史上叫"旧格式"）
 *   malformed: string|null, // **结构坏**（字段数／时间戳）；null＝正常
 *   version: number|null,   // 格式版本号；**null ＝ 无版本号（历史遗留）**
 *   versionUnknown: string|null, // 版本号**高于**当前支持 ⇒ 人可读告警（**与 malformed 正交**）
 *   timeMs: number|null
 * }}
 */
export function parseLockLine(raw) {
  const parts = String(raw).split('|').map((s) => s.trim());

  // —— 时间：不可解析就是畸形（不是"当没有时间"）——
  const time = parts[0] || '';
  const t = new Date(time.replace(' ', 'T'));
  const timeOk = !isNaN(t.getTime());

  // —— 字段：**按标签找**（不再按位置取，故 note 里带 `|` 也安全）——
  const regionTag = parts.find((s) => s.startsWith('区域:'));
  const fileTag = parts.find((s) => s.startsWith('文件:'));
  // 🔴（一次评审）：**不可变 id** —— 锁行自带一个与 note 文本无关的
  //   稳定标识。病根：note 既是人读的说明，又是收尾提交按 note 匹配锁行的**匹配键** ⇒
  //   一次批量改名
  //   就能让 `--note` 匹配不上 ⇒ 提交链直接断（exit 2「读不到锁行」）。
  //   ⇒ id 由 `add` 生成、**不随 note 变**；收尾提交按 `--id` 精确取行。
  //   ⚠️ **纯新增字段 ⇒ 不升格式版本**（旧行无 `id:` ⇒ 解析出空串 ⇒ 回退 note 匹配，不破旧行）。
  const idTag = parts.find((s) => ID_SEG.test(s.trim()));
  const id = idTag ? idTag.slice(3).trim() : '';

  // —— 租约到期时刻（格式 v2 · 一次评审）——
  // 🔴 语义：`expires_at` ＝ **租约**（这行锁还有主吗）；`STALE_HOURS` ＝ **陈旧提示**（多久没动）。
  //   两者**并存不互替**：缺 `expires_at`（v1 及更早的行）时由调用方回退 STALE_HOURS。
  //   ⚠️ 值必须是**可解析的时间**；写了但解析不出 ⇒ 结构坏（见下方 malformed），
  //   因为"声明了租约却读不出租约"会让过期判定静默失效——那正是本文件要防的"坏行当没看见"。
  const expTag = parts.find((s) => s.startsWith('expires_at:'));
  const expiresAtRaw = expTag ? expTag.slice('expires_at:'.length).trim() : '';
  const expMsRaw = expiresAtRaw ? new Date(expiresAtRaw.replace(' ', 'T')).getTime() : null;
  const expiresAtBad = !!expiresAtRaw && Number.isNaN(expMsRaw);
  const expiresAtMs = expiresAtBad ? null : expMsRaw;
  const expiresAt = expiresAtBad || !expiresAtRaw ? '' : expiresAtRaw;

  const isLegacy = !regionTag; // 无 `区域:` 标签 ⇒ 旧格式／无法识别
  const regions = isLegacy
    ? [...ALL_REGIONS] // 🔴 保守：按**全局锁**回退（原 settle.mjs 在这里给 []，会让该行隐形）
    : parseListField(regionTag.slice(3));   // 🔴 走统一解析（手写行的 `区域:"project"` 过去会被当成区域名 `"project"` ⇒ fail-open）

  const files = fileTag ? stripSentinel(parseListField(fileTag.slice(3))) : [];

  // 说明 = 去掉「时间｜工具｜已识别标签段｜版本号段」后的剩余部分，按原序拼回。
  //   🔴 `filter` 后不能靠"跳过前 N 个"定位（原 `slice(1|2)` 的写法在缺 `文件:` 的行上会把
  //   **把工具名当成说明**）⇒ 改为**显式打掉前两个字段**再拼。
  //   ⚠️ `id:` 也是标签段 ⇒ 必须一起打掉，否则它会混进 note（note 是自由文本，会污染匹配面）。
  //   ⚠️ 但**只打掉机器形态的 id 段**（`id:L-…`）——note 里字面出现的 `id:xxx` 属于人的文本，
  //   不能被静默改写（一次复核订正）。
  const { version, dup, kept } = extractVersion(parts);
  const tail = kept.slice(2).filter((p) => p && !p.startsWith('区域:') && !p.startsWith('文件:') && !p.startsWith('expires_at:') && !ID_SEG.test(p.trim()));
  const note = tail.join(' | ');

  // —— 畸形：只判**结构**（字段数／时间戳／版本号自相矛盾）——
  // ⚠️「没有版本号」是**格式旧**，**不是结构坏** ⇒ 必须与 `versionUnknown` 分开两个字段。
  //   否则 §8 每次体检都会把所有历史正常行报成"畸形"，训练人忽略 §8（独立审查点名的误报路径）。
  let malformed = null;
  if (parts.length < 3) malformed = `字段数只有 ${parts.length} 个（至少要 3：时间｜工具｜区域）`;
  else if (!timeOk) malformed = `时间戳不可解析：${JSON.stringify(time.slice(0, 24))}`;
  if (dup) malformed = `${malformed ? malformed + '；' : ''}同一行出现多个不同的版本号`;
  if (expiresAtBad) malformed = `${malformed ? malformed + '；' : ''}expires_at 值不可解析：${JSON.stringify(expiresAtRaw.slice(0, 24))}`;

  // —— 版本号：**与 malformed 正交**——
  //   null ＝ 无版本号（历史遗留，**正常存在，不告警**）；
  //   > CURRENT_FORMAT ＝ 声明了但本工具不支持 ⇒ **告警但不阻断**（有意不做成 fail-closed：升级要留路，不能把老副本锁死）。
  let versionUnknown = null;
  if (version != null && version > CURRENT_FORMAT) {
    versionUnknown = `版本 v${version} 高于本工具支持的 v${CURRENT_FORMAT}（按 v${CURRENT_FORMAT} 读，未阻断）`;
  }

  return {
    raw: String(raw),
    time,
    tool: parts[1] || '',
    id,
    regions,
    files,
    note,
    expiresAt,
    expiresAtMs,
    isLegacy,
    malformed,
    version,
    versionUnknown,
    timeMs: timeOk ? t.getTime() : null,
  };
}

/**
 * 解析整个锁文件。
 * @returns {{ rows: object[], malformed: object[], noVersion: object[], versionUnknown: object[] }}
 *   - `rows`：**全部**非空行（畸形行也在内，标了 `malformed`）。
 *   - `malformed`：**结构坏**的那些（字段数／时间戳）。
 *   - `noVersion`：**没有版本号**的那些（历史遗留，正常状态，不是错误）。
 *   - `versionUnknown`：**版本号高于支持**的那些（真要报的警）。
 *   ⚠️ 后三者**互不重叠**，调用方要分别渲染 —— 混在一起报就会把正常历史行说成错误。
 */
export function parseLockFile(text) {
  const rows = [];
  const malformed = [];
  const noVersion = [];
  const versionUnknown = [];
  // ⚠️ `lineNoOf` 是 **raw 整行 → 行号** 的映射，**对重复行会互相覆盖**：
  //   两条逐字完全相同的锁行（同分钟＋同工具＋同区域＋同 note＋同会话标记）
  //   ⇒ Map 只留**后一个**行号 ⇒ 用它反查行号会**指错**。
  //   触发路径窄（`add` 会把 `[会话:tok]` 追加进 note ⇒ 两会话在 tok 非空时不可能逐字相同），
  //   但**这是明摆着的陷阱**，用之前先确认你要查的行**不是**重复行。
  //   🔴 **当前无调用方**（write-lock / lint / settle 都不读它）⇒ 今天无害。
  //   若将来要用它反查行号，**正确做法是遍历 `rows` 找 `r.lineNo`，别用这张表**。
  const lineNoOf = new Map();
  let n = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    n += 1;
    const r = parseLockLine(raw);
    r.lineNo = n;
    rows.push(r);
    lineNoOf.set(r.raw, n);
    if (r.malformed) malformed.push(r);
    else if (r.version == null) noVersion.push(r);
    if (r.versionUnknown) versionUnknown.push(r);
  }
  return { rows, malformed, noVersion, versionUnknown, lineNoOf };
}

/** 一行告警文本（`list`／`check`／`lint` 三个出口共用同一句 ⇒ 口径不会分叉） */
export function malformedTag(r) {
  const bits = [];
  if (r?.malformed) bits.push(`⚠️畸形(第${r.lineNo ?? '?'}行: ${r.malformed})`);
  if (r?.versionUnknown) bits.push(`⚠️${r.versionUnknown}`);
  return bits.join(' ');
}