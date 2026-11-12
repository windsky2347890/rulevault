# rulevault

A script gatekeeper for AI-collaborated knowledge bases.

As you work with an AI, your knowledge base grows. Without oversight, things start slipping — concepts you already explained get asked again, the AI invents answers you already have on disk, two sessions edit the same file and trample each other, a reply claims "updated" but the file was never touched.

rulevault turns those failure modes into something a script can check. Did the session open by consulting the library? Did it take a lock before writing? Did it settle at the end? If something is missed, it fails right away. Pure Node ≥18 standard library, zero dependencies, no npm install.

## The four principles

1. **Files are memory** — the AI has no memory across sessions; files are the only persistent memory. Important facts must be written down.
2. **Simple and portable** — plain Markdown + Git, no proprietary software. Any tool or AI can take over.
3. **Convention first** — consistent filenames, formats, and headings, so you can still find things years later.
4. **Write to review** — a record nobody looks at is just a pile of files. Write it down so it can be used, searched, and decided on later.

## Two tiers

**lite** (7 files) — one person, one AI, no concurrent sessions.

**framework** (59 files) — multiple concurrent sessions, or when you need to know who changed what and whether the work was settled.

If unsure, start with lite. Both tiers share the same skeleton; framework adds to lite, not a rewrite.

```bash
git clone https://github.com/windsky2347890/rulevault.git
cd rulevault/lite
node scripts/check.mjs
```

## What it doesn't do

1. **Vector search** — it needs external services, which conflicts with the zero-dependency promise. When your library grows, local embeddings + a vector store is the way (Ollama + LanceDB is a cheap option that costs no API).
2. **Content hosting** — every `{{}}` placeholder is meant for you to fill in yourself. Edit in a Markdown tool like Obsidian, version with Git, sync over WebDAV.
3. **Decision-making** — it only checks whether the work that should be done was actually done. It can suggest, but the call is yours.

MIT.
