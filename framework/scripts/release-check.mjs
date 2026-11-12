#!/usr/bin/env node
/**
 * release-check.mjs —— 发布第一道闸门：形状扫描（发布闸门第一道：形状扫描）
 *
 * 用法：node scripts/release-check.mjs [目标目录]
 *       node scripts/release-check.mjs --target <目录>
 *   目标缺省 = 当前工作目录；**不按脚本自身位置找库根**，给别的包体检直接指它的目录即可。
 *
 * 为什么按形状扫：早先那版按「期望清单」核对，清单外的东西（id、hex、UUID、手机号）
 *   永远不会报警。这里改成形状规则，且**必须配阳性对照**：往临时副本注入
 *   一个假姓名＋真形状的假手机号重跑，本脚本必须报红；不报红 ⇒ 这道闸不算数。
 *
 * ⚠️ 形状扫描抓不到「举例式泄露」（专业公式、真实页名、亲属称呼、某人的原话）。
 *   发布 = 这一道 ＋ 另起干净上下文逐文件通读，**两道缺一不可**，见 DESIGN.md。
 *   本脚本只负责第一道，不代替人读。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const tIdx = argv.indexOf('--target');
const target = tIdx > -1 ? argv[tIdx + 1] : (argv.find((a) => !a.startsWith('--')) || process.cwd());
const ROOT = resolve(target || '.');
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
  console.error(`⛔ 目标目录不存在或不是目录：${ROOT}`);
  process.exit(2);
}

const SKIP = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.tmp']);
const TEXT = /\.(md|js|mjs|cjs|json|ya?ml|txt|ps1|html|css|svg)$/i;
// 免「点开头」过滤的例外（**仍参与扫描**，只是不因隐藏文件名被跳过）：
const NO_DOT_SKIP = new Set(['LICENSE', '.gitignore', '.gitattributes', 'CHANGELOG.md', 'README.md']);

// 形状规则：命中即报，不设「看起来像示例就放行」的白名单（白名单不得放行阳性对照样本）。
const SHAPES = [
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['UUID', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi],
  ['长 hex 标识符', /(?<![0-9a-f])[0-9a-f]{20,}(?![0-9a-f])/gi],
  ['Windows 用户目录', /[A-Za-z]:\\Users\\[^\\\s]+\\/g],
  ['Unix 家目录具体用户', /\/Users\/[A-Za-z][A-Za-z0-9._-]{2,}\//g],
];
const LINK = /https?:\/\/[^\s)`"'\]>]+/g;

// 🔴 **本机用户名**（形状规则只覆盖完整用户目录路径，裸用户名漏网 ⇒ 注释里写用户名＝发布出去）
//   做法：读到真值就检查真值（与 sync-must-keep 从宪法取源、同源检查同一思路）——
//   比加一条「看起来是用户名」的形状规则准，不会误报普通英文单词。
//   含 Windows 8.3 短名。**≥3 字符才查**，太短的名字误报率高。
//
//   ⚠️ **8.3 短名的算法顺序错了就全错**（一次评审实测：先剔字符再大写会把小写字母
//     全部删掉 ⇒ 一个混合大小写的用户名算出「只剩两个字母」，而 OS 权威短名是六个字母，
//     实测注入漏网）。
//     正确顺序＝**先大写、再剔非字母数字、再截前 6**：`混合大小写 → 全大写 → 截前 6 → 短名`
//     （权威来源＝`cmd /c dir /x C:\Users` 与 `$env:TEMP` 双源互证）。
//     ⚠️ **注释里也不要写本机真实用户名当例子**——那本身就是泄露（一次评审实测：
//       实现者自己在注释里写了真名当例子，被本闸门当场抓到 5 处命中）。
//     ⚠️ 该近似**不做碰撞编号**（真实短名会 ~2、~3…）；但发布闸是「宁可多报」的 ——
//       命中了请人工确认，漏报才是真漏。
//   变体：原样／全小写／全大写／8.3 短名 —— 四态都查，**去重**。
const _short83 = (u) => String(u).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) + '~1';
const _localUsers = [os.userInfo().username, process.env.USERNAME, process.env.USER, process.env.LOGNAME]
  .filter(Boolean)
  .flatMap((u) => [u, u.toLowerCase(), u.toUpperCase(), _short83(u)])
  .filter((u) => u.length >= 3);
// 🔴 **去重**（短名变体与原名可能撞 ⇒ 同一位置会被重复计入命中数）
const _localUsersSet = [...new Set(_localUsers)];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && !NO_DOT_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
    else if (TEXT.test(e.name) || NO_DOT_SKIP.has(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).sort();
const hits = [];
const links = [];
const idHits = [];
for (const f of files) {
  const txt = readFileSync(f, 'utf8');
  const r = relative(ROOT, f).replace(/\\/g, '/');
  txt.split('\n').forEach((ln, i) => {
    for (const [label, re] of SHAPES) {
      re.lastIndex = 0;
      const m = ln.match(re);
      if (m) hits.push({ f: r, n: i + 1, label, word: m[0] });
    }
    // 本机用户名：按词匹配（避免把 "user" 之类短词误报；长短名分别查）
    for (const u of _localUsersSet) {
      if (u.length < 3) continue;
      const re = new RegExp(`\\b${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      re.lastIndex = 0;
      if (re.test(ln)) {
        const m = ln.match(re);
        if (m) idHits.push({ f: r, n: i + 1, user: u, word: m[0] });
      }
    }
    LINK.lastIndex = 0;
    for (const m of ln.matchAll(LINK)) links.push({ f: r, n: i + 1, url: m[0] });
  });
}

console.log(`# 发布形状扫描：${ROOT}`);
console.log(`扫描 ${files.length} 个文本文件`);
console.log('');
console.log(`## 形状命中：${hits.length} 项`);
for (const h of hits.slice(0, 60)) console.log(`  ${h.f}:${h.n} [${h.label}] ${h.word}`);
if (hits.length > 60) console.log(`  …还有 ${hits.length - 60} 项`);
console.log('');
console.log(`## 外链（供人工复核，不计入命中）：${links.length} 条`);
for (const l of links.slice(0, 20)) console.log(`  ${l.f}:${l.n} ${l.url}`);
if (links.length > 20) console.log(`  …还有 ${links.length - 20} 条`);
console.log('');
console.log(`## 本机身份命中（发布前人工确认）：${idHits.length} 项`);
for (const h of idHits.slice(0, 40)) console.log(`  ${h.f}:${h.n} [本机用户${h.user}] ${h.word}`);
if (idHits.length > 40) console.log(`  …还有 ${idHits.length - 40} 项`);
console.log('');
if (hits.length || idHits.length) {
  console.log(`⛔ ${hits.length} 项形状命中${idHits.length ? ` + ${idHits.length} 项本机身份命中` : ''} → exit 1（发布阻断）`);
  process.exit(1);
}
console.log('✅ 形状扫描 0 命中。**这还不是发布通过**——还须完成第二道：干净上下文逐文件通读。');
