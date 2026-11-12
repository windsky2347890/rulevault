#!/usr/bin/env node
/**
 * sync-must-keep.mjs —— 从宪法生成「每轮必守」注入件（生成物，勿手改）
 *
 * 存在理由：宪法 §1 写着「每次 AI 会话开始时，必须首先阅读本文件」，但多数工具只支持**按需读**——
 *   **规则承诺了机制做不到的事**。本脚本把宪法里的铁律提取成一个极小注入件，让开场就能拿到。
 *
 * 做法（不新增第二事实源）：
 *   - **正文仍是宪法**（`使用手册.md`，唯一权威源）；
 *   - 本脚本从宪法**提取**「每轮必守」极小集（§2 各规则首句 + §3 对时铁律 / 不删除只归档），
 *     **生成** `_wiki/_每轮必守.md`；支持开场注入的工具自动注入它，其他工具由 `AGENTS.md`「铁律」节兜底；
 *   - `--check` 比对生成物与宪法是否同源 → 漂移即退出码 1（**防漂移的强制装置**）。
 *
 * 用法：
 *   node scripts/sync-must-keep.mjs --write     # 生成/更新 _wiki/_每轮必守.md
 *   node scripts/sync-must-keep.mjs --check     # 只校验（收尾/CI 用），漂移 → 1
 *
 * 退出码：一致 0 / 漂移或缺文件 1 / 判据失效或用法错 2。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONSTITUTION = join(ROOT, '使用手册.md')
const TARGET = join(ROOT, '_wiki', '_每轮必守.md')

/** 🔴 提取链告警（一次评审实测）：命中「唯一例外」却取不到限定词时收集，主流程据此 rc=2。 */
let extractWarnings = []

const wantCheck = process.argv.includes('--check')
const wantWrite = process.argv.includes('--write')

/** 取一句话（到第一个句号为止），过长则截断——注入件要短。 */
function firstSentence(raw) {
  const t = String(raw).replace(/\s+/g, ' ').replace(/^- /, '').trim()
  const i = t.indexOf('。')
  const cut = i >= 0 ? t.slice(0, i + 1) : t
  return cut.length > 140 ? `${cut.slice(0, 140)}…` : cut
}

/** 从宪法提取「每轮必守」条目。规则字母按宪法实际有的取（正则 A–M，实际命中 A–H＋两条铁律）。 */
function extract() {
  const text = readFileSync(CONSTITUTION, 'utf8')
  const items = []

  const re = /^### 规则 ([A-M])：(.+)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length)
    const nextH = after.search(/^#{2,3} /m)
    const block = (nextH >= 0 ? after.slice(0, nextH) : after).trim()
    const line = block.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
    items.push({ key: `规则 ${m[1]}：${m[2].trim()}`, text: firstSentence(line) })
  }

  // §3 通用约定里的两条硬铁律（去掉行首的 `- **xxx**：`，避免与 key 重复）
  const lines = text.split(/\r?\n/)
  for (const key of ['对时铁律', '不删除只归档']) {
    const idx = lines.findIndex((l) => l.startsWith(`- **${key}**`))
    if (idx < 0) continue
    const raw = lines[idx].replace(/^- \*\*[^*]+\*\*：?/, '')
    let t = firstSentence(raw)
    // 🔴 **例外不能丢**（一次评审）：宪法把「归档只留最新一份」放在**下一条 bullet** 里，
    //   只取首句会把「**唯一例外**见下一条」抹掉 ⇒ AI 开场读到的注入件与宪法**相反**
    //   （该删的旧快照也不敢删）⇒ 命中「唯一例外」时把下一条 bullet 的要点一并带上。
    if (raw.includes('唯一例外') && (lines[idx + 1] || '').startsWith('- **')) {
      // 🔴 **限定词不能丢**（一次评审实测）：宪法把「仅限归档区内」写在 bullet
      //   **标题**里（`**归档只留最新一份（上条的例外，仅限归档区内）**`），剥标题的正则
      //   会把括号连同限定词一起吃掉 ⇒ 生成物里「只保留最新一份快照」没了范围限定，
      //   AI 开场读到会误以为正文也要删。⇒ 剥完标题后把括号里的限定词补回句尾。
      const t2raw = lines[idx + 1].replace(/^- \*\*[^*]+\*\*：?/, '')
      let t2 = firstSentence(t2raw)
      const t2title = lines[idx + 1].match(/^- \*\*([^*]+)\*\*：?/)
      let qualifier = ''
      if (t2title) {
        const scope = (t2title[1].match(/（([^）]+)）/) || [])[1]
        if (scope) qualifier = scope.replace(/^上条的例外[，,]?/, '').trim()
      }
      if (qualifier) t2 = `${t2}（${qualifier}）`
      else {
        // 🔴 **断言（一次评审实测）**：命中「唯一例外」却取不到限定词 ⇒ 生成物会静默丢范围。
        //   实测：把宪法标题括号去掉再 --write，生成物静默丢「仅限归档区内」、无告警、--check 仍 rc=0。
        //   ⇒ 这里显式告警，主流程 rc=2，不写文件、不判定一致。
        extractWarnings.push(`「${key}」命中「唯一例外」，但下一条 bullet 标题里没有限定词括号 —— 生成物会静默丢掉范围限定（如「仅限归档区内」）。请检查宪法 §3 的 bullet 标题是否保留了括号。`)
      }
      t = `${t}（例外：${t2}）`
    }
    items.push({ key, text: t })
  }
  return items
}

/** 生成物全文；`> 生成日期：` 行被 --check 忽略（每次跑都会变）。 */
function render(items) {
  const now = new Date().toISOString().slice(0, 10)
  const body = items.map((it, i) => `${i + 1}. **${it.key}** —— ${it.text}`).join('\n')
  return `---
type: meta
tags: [生成物, 铁律, 每轮必守]
generated_by: scripts/sync-must-keep.mjs
source: 使用手册.md
related: [使用手册, AGENTS, _wiki/开场导航]
---

# 每轮必守（生成物 · 勿手改）

> **本页是生成物**：由 \`node scripts/sync-must-keep.mjs --write\` 从 [[使用手册|使用手册]]（唯一正文）提取，
> 支持开场注入的工具每个会话自动注入；其他工具由 [[AGENTS|AGENTS]]「铁律」节兜底。
> **要改规则请改宪法正文**，然后重跑 \`--write\`；\`--check\` 不一致即报错（防漂移）。
> 生成日期：${now}（本行为 --check 忽略项；只到日，不含时刻）

${body}
`
}

const strip = (s) => s.split(/\r?\n/).filter((l) => !/^> 生成(?:时间|日期)：/.test(l)).join('\n').trim()

const items = extract()
if (extractWarnings.length) {
  console.error('⚠️ 提取链告警（一次评审）：')
  for (const w of extractWarnings) console.error('  - ' + w)
  console.error('⇒ rc=2（提取链有告警：不写文件、不判定一致）')
  process.exit(2)
}
if (items.length < 5) {
  console.error(`❌ 只从宪法提取到 ${items.length} 条（判据可能已变，预期 ≥5）——中止，不写文件。`)
  process.exit(2)
}
const want = render(items)

if (wantCheck) {
  if (!existsSync(TARGET)) {
    console.error(`❌ 生成物不存在：${TARGET}\n   跑：node scripts/sync-must-keep.mjs --write`)
    process.exit(1)
  }
  const have = readFileSync(TARGET, 'utf8')
  if (strip(have) === strip(want)) {
    console.log(`✅ 每轮必守与宪法同源（${items.length} 条）`)
    process.exit(0)
  }
  console.error('❌ 漂移：_wiki/_每轮必守.md 与宪法不一致\n   跑：node scripts/sync-must-keep.mjs --write')
  process.exit(1)
}

if (wantWrite) {
  writeFileSync(TARGET, want, 'utf8')
  console.log(`✅ 已写 _wiki/_每轮必守.md（${items.length} 条，${Buffer.byteLength(want, 'utf8')} B）`)
  process.exit(0)
}

console.error('用法：node scripts/sync-must-keep.mjs --check | --write')
process.exit(2)