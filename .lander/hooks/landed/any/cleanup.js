// Cleanup: naming what a finished task left behind, and removing nothing.
//
// Tasks create resources and walk away from them. Measured over this corpus,
// 86 tasks created a git worktree and 38 of them never removed one, and the
// rate held flat while the volume tripled. Right now every worktree standing in
// the sibling project — 7 of them — is one a task made and left; not one is
// attributable to anything but a task that has since landed.
//
// Nothing tags a resource with the task that made it, so this reads the target's
// own tool record and tears down what it can attribute. Two facts, from two
// sources, and NEITHER alone is enough:
//
//   - the RECORD answers "did this task create this worktree" — an intent, and a
//     historical one; a path in it may have been removed months ago;
//   - GIT answers "is there still a worktree at that path" — a present fact,
//     with no idea who made it.
//
// Their intersection is what this hook acts on, and that is what makes a
// mis-parse safe in both directions: a path invented by reading a plan document
// that quotes `git worktree add <path>` is not a worktree git registers, and a
// path this body resolved against the wrong directory is not one either.
//
// **This stage removes nothing.** It is the only hook that would act
// destructively, so per hooks.md §8 it ships report-only: it logs what it would
// remove, and what stopped it, until the log shows the identification is right
// across both providers. There is no removal code here to be switched on — a
// disarmed destructive path inside an approved blob is not report-only, it is
// one edit away from armed.
//
// SCOPE: git worktrees, and deliberately nothing else. The design names
// "worktrees, containers, or databases", but what a project's tasks actually
// stand up is a question about that project: across 550 lander tasks the corpus
// holds zero `docker run`, zero `docker compose up`, zero database creations and
// one `nohup`. Worktrees are the whole of it here. `identify` is where a second
// resource kind would go.

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const meta = { api: 1 }

// ── Reading the record ─────────────────────────────────────────────────────

// Codex runs everything through a login shell and reports what it ran —
// `/bin/zsh -lc 'git worktree add …'` — where Claude's harness supplies the
// shell and reports the bare command. Both shapes are in this corpus, so the
// wrapper is unwrapped before matching rather than the anchor being loosened:
// the anchor is what keeps `grep -rlE 'git worktree add'` from counting as an
// invocation of the thing it is searching for.
const SHELL_WRAPPER = /^\s*(?:\S+\/)?[a-z]*sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/
const unwrap = (cmd) => SHELL_WRAPPER.exec(cmd)?.[2] ?? cmd

// Text a command WRITES is data, not commands. A task that appends a planning
// document through a heredoc puts prose into the record as a command, and this
// repository's own planning documents quote `git worktree add <path>` at the
// start of a line — sometimes naming a worktree that really exists, because it
// was copied from an earlier task's work. So the misattribution would land on a
// live resource rather than an invented one.
//
// The commit detector one file over answers this by refusing to treat a newline
// as a command separator at all, and accepts missing a commit on the second line
// of a compound. That trade is wrong here: Codex routinely issues multi-line
// scripts through one login shell, so the second line is where its commands
// live. Cutting the heredoc bodies out instead keeps both — the newline stays a
// separator, and the prose is gone before anything matches it.
function stripHeredocs(cmd) {
  if (!cmd.includes('<<')) return cmd
  const OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  const kept = []
  let closing = null
  for (const line of cmd.split('\n')) {
    if (closing !== null) {
      if (line.trim() === closing) closing = null
      continue
    }
    kept.push(line)
    OPEN.lastIndex = 0
    let last = null
    for (let m; (m = OPEN.exec(line)); ) last = m[2]
    if (last !== null) closing = last
  }
  return kept.join('\n')
}

// `git … worktree add|remove|prune` at a command boundary. `^` anchors the
// string, not a line; a newline joins `;&|(` as a separator, which is safe only
// because of the strip above.
const WORKTREE_CMD =
  /(^|[\n;&|]\s*|\(\s*)git\s+(?:-\S+\s+|--\S+(?:=\S+)?\s+)*worktree\s+(add|remove|prune)\b([^\n;&|]*)/g

// The worktree tool's RESULT, which is the field that makes this exact and the
// one the design does not account for. `ToolItem` keeps a peek at each call's
// output — 200 characters or three lines — and the harness's own wording is
// unambiguous in it:
//
//   Created worktree at <path> on branch <b>.   ← this call made it
//   Entered worktree at <path>.                 ← it already existed
//   Exited and removed worktree at <path>.      ← this call removed it
//   Exited worktree. Your work is preserved at <path> on branch <b>.
//
// So a tool call that reports `{"name":"flows"}` as its input — or, in one real
// case, `{}` — still names the absolute path it created and says whether it
// created it. The design (§2) expected to resolve a bare name against a naming
// convention and could not have distinguished a creation from a re-entry at all.
//
// The first sentence is taken whole and matched inside, rather than one regex
// spanning the optional branch clause: a path contains dots, and a lazy match
// against an optional suffix picks its boundary somewhere unpredictable.
const sentence = (text, n) => String(text).split(/\.(?:\s|$)/)[n] ?? ''
const CREATED_OR_ENTERED = /^(Created|Entered) worktree at (.+?)(?: on branch (\S+))?$/
const REMOVED = /^Exited and removed worktree at (.+?)$/
// The peek is capped at 200 characters or three lines, so a long enough result
// loses its tail. A captured path carrying the ellipsis is a path we do not
// have, and saying so is better than acting on a prefix of one.
const whole = (p) => !p.includes('…')

// Two paths naming the same tree. macOS `/tmp` is a symlink to `/private/tmp`
// and git reports the resolved form, so a literal compare misses; `.` and `..`
// are folded textually rather than through `path.resolve`, because a hook body
// must never touch the filesystem to decide what a path means.
function norm(p) {
  let s = String(p).trim().replace(/\/+$/, '')
  if (s.startsWith('/private/')) s = s.slice('/private'.length)
  const out = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return (s.startsWith('/') ? '/' : '') + out.join('/')
}

// A command's path operand against the tree the task was working in. The record
// does not carry the cwd of each call, so a relative operand — the common shape
// (`.claude/worktrees/x`) — is resolved against the project root and that is an
// ASSUMPTION. It is a safe one only because nothing is acted on that git does
// not also register: a wrong base yields a path no worktree stands at.
const against = (root, p) => norm(p.startsWith('/') ? p : `${root}/${p}`)

// `git worktree add`'s path is the first operand that is neither a flag nor a
// flag's value; `-b`/`-B` take one.
function addPath(rest) {
  const argv = rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-b' || a === '-B') {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return a.replace(/^['"]|['"]$/g, '')
  }
  return ''
}

function firstOperand(rest) {
  for (const a of rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])
    if (!a.startsWith('-')) return a.replace(/^['"]|['"]$/g, '')
  return ''
}

// What the target made, what it removed, and what it did that names a worktree
// without saying which.
//
// One map, keyed by path, holding the LAST thing the target did to it — because
// a task that makes a worktree, removes it, and makes it again at the same path
// has left one standing, and two separate sets cannot say so. `items` is already
// chronological, so the sequence answers this exactly where two timestamps in
// the same millisecond would not.
function identify(items, root) {
  const seen = new Map()
  const unattributed = []
  const made = (path, rest) => seen.set(path, { action: 'created', path, ...rest })
  const gone = (path, rest) => seen.set(path, { action: 'removed', path, ...rest })

  for (const it of items) {
    if (it.kind !== 'tool') continue
    // Only a call that RAN is evidence. `blocked` is a permission refusal and
    // `failed` a non-zero exit; both leave a command in the record naming a
    // worktree that was never made. Three of this repository's own tasks hold a
    // blocked `git worktree add` inside a scratch repository, and counting those
    // would have this hook naming paths that never existed.
    if (it.status !== 'ok') continue

    const name = String(it.name ?? '')
    const input = String(it.inputFull ?? it.input ?? '')
    const output = String(it.output ?? '')

    if (name === 'EnterWorktree') {
      const m = CREATED_OR_ENTERED.exec(sentence(output, 0))
      if (!m) {
        unattributed.push({ at: it.at, why: 'EnterWorktree with no readable result', what: input })
        continue
      }
      if (m[1] === 'Entered') continue // it existed before this task touched it
      if (!whole(m[2])) {
        unattributed.push({ at: it.at, why: 'created a worktree whose path the record truncated', what: output })
        continue
      }
      made(norm(m[2]), { branch: m[3] ?? '', at: it.at, via: 'tool' })
      continue
    }

    if (name === 'ExitWorktree') {
      const r = REMOVED.exec(sentence(output, 0))
      if (r && whole(r[1])) gone(norm(r[1]), { at: it.at, via: 'tool' })
      // `Exited worktree. Your work is preserved at …` and every failure mode
      // leave the worktree standing, which is the default this hook is for.
      continue
    }

    if (!/worktree/i.test(input)) continue
    const cmd = stripHeredocs(unwrap(input))
    WORKTREE_CMD.lastIndex = 0
    let matched = false
    for (let m; (m = WORKTREE_CMD.exec(cmd)); ) {
      matched = true
      const [, , verb, rest = ''] = m
      if (verb === 'add') {
        const p = addPath(rest)
        if (!p) {
          unattributed.push({ at: it.at, why: 'worktree add with no readable path', what: cmd.slice(0, 200) })
          continue
        }
        made(against(root, p), { branch: '', at: it.at, via: 'command' })
      } else if (verb === 'remove') {
        const p = firstOperand(rest)
        if (p) gone(against(root, p), { at: it.at, via: 'command' })
      }
      // `prune` names no path — it clears administrative files for directories
      // that are already gone — so it is neither a creation nor an attributable
      // removal, and saying nothing about it is the accurate answer.
    }
    // A skill is a procedure the PROJECT defines, and what it runs is not in the
    // record: this is the design's stated limitation arriving as a concrete
    // item — a resource made indirectly leaves no attributable trace — so the
    // honest answer is to say so rather than guess. Four tasks in the corpus have
    // nothing but this, all of them one project skill in the sibling repository.
    //
    // A SUBAGENT is deliberately not in this list. Its own tool calls are in the
    // record, carrying `parentId`, so a worktree it made is attributed by the
    // branches above; adding `Agent` here would put a report on every task that
    // merely sent one to go read about worktrees.
    if (!matched && name === 'Skill')
      unattributed.push({ at: it.at, why: 'a Skill call that names no path', what: input })
  }

  const all = [...seen.values()]
  return {
    // Standing at the end of the record: the last thing done to this path made it.
    candidates: all.filter((x) => x.action === 'created'),
    // Everything the target touched, for the log — the negatives are what the
    // claim "the identification is right" actually rests on.
    touched: all,
    unattributed,
  }
}

// ── Asking git ─────────────────────────────────────────────────────────────

// Every worktree this repository currently registers. Read from the PROJECT
// ROOT — never from a candidate, which is a directory this hook may one day
// remove and must therefore never stand in.
async function registered(ctx) {
  const r = await ctx.spawn('git', ['worktree', 'list', '--porcelain'], {
    cwd: ctx.project.root,
  })
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 200) }
  const trees = []
  let cur = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: norm(line.slice(9)), branch: '', detached: false, locked: false, prunable: false }
      trees.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') cur.detached = true
    else if (line.startsWith('locked')) cur.locked = true
    else if (line.startsWith('prunable')) cur.prunable = true
  }
  // The first entry is the main working tree. It is not a worktree anyone
  // created and `git worktree remove` refuses it, but naming it here keeps the
  // refusal in this body rather than in git's error message.
  return { ok: true, trees, main: trees[0]?.path ?? '' }
}

// What makes a worktree safe to release is project knowledge, which is why this
// lives in the project and not in lander. For a git worktree in this repository:
// the tree is clean, and the work survives its removal.
//
// `git worktree remove` deletes the checkout and leaves the branch, so commits
// on a branch survive by construction — but a DETACHED head's commits do not,
// and this repository has produced detached worktrees (`git worktree add
// --detach`). So a detached candidate is reported and never released.
async function judgeSafety(ctx, tree) {
  // The directory this body is standing in. Git's own main-worktree entry is
  // filtered before this, and this is not that check: lander's project root can
  // itself be a linked worktree, in which case git's first entry is somewhere
  // else and the tree the hook runs in is an ordinary candidate. A body must
  // never stand in a directory it may remove.
  if (tree.path === norm(ctx.project.root))
    return { safe: false, blocked: 'the checkout this hook is running in' }
  if (tree.locked) return { safe: false, blocked: 'locked' }
  // Its directory is already gone; there is nothing to release, and the record
  // git still holds is what `git worktree prune` is for.
  if (tree.prunable) return { safe: false, blocked: 'already gone — only its git record remains' }
  if (tree.detached)
    return { safe: false, blocked: 'detached HEAD — removing it would orphan any commit on it' }
  const st = await ctx.spawn('git', ['-C', tree.path, 'status', '--porcelain'], {
    cwd: ctx.project.root,
  })
  if (st.code !== 0)
    return { safe: false, blocked: `could not read its status: ${(st.stderr || '').trim().slice(0, 120)}` }
  const dirty = st.stdout.split('\n').filter((l) => l.trim()).length
  if (dirty) return { safe: false, blocked: `${dirty} uncommitted or untracked file(s)` }
  return { safe: true, blocked: '' }
}

// ── The log ────────────────────────────────────────────────────────────────

// One row per fire, whether or not anything was found. The negatives are the
// point: "the identification is right" is a claim about what it did NOT name as
// much as what it did, and a log of hits alone cannot carry it.
async function log(ctx, row) {
  try {
    await mkdir(ctx.stateDir, { recursive: true })
    const file = path.join(ctx.stateDir, `cleanup-${ctx.trigger.at.slice(0, 10)}.jsonl`)
    const tail = await readFile(file, 'utf8').catch(() => '')
    // A row is a direct body effect, which the platform's retry guarantee
    // excludes — and `error` and `timeout` retry up to five times, so left alone
    // the log would over-count exactly the fires that had trouble.
    if (tail.includes(`"fireId":"${ctx.hook.fireId}"`)) return
    await appendFile(file, JSON.stringify(row) + '\n')
  } catch {
    // The log is evidence, not a dependency.
  }
}

// ── The body ───────────────────────────────────────────────────────────────

export default async function onTurn(ctx) {
  const at = ctx.trigger.at
  const row = { fireId: ctx.hook.fireId, target: ctx.target.id, at, by: ctx.trigger.by }

  const task = await ctx.target.read()
  const all = task.items ?? []
  // The record as it stood at the fire. A fire is dispatched up to 15 seconds
  // after the landing and the body then runs for tens of seconds, so reading
  // live would judge a task that has since been reopened and gone back to work —
  // and, on the removal side, would credit a cleanup that happened after the
  // question was asked.
  const end = all.findIndex((it) => it.kind === 'event' && it.eventKind === 'landed' && it.at >= at)
  if (end < 0) return log(ctx, { ...row, skipped: 'no-landing-in-record' })
  const items = all.slice(0, end + 1)
  // A human who has replied since has taken the task back. Its worktree is not
  // abandoned, it is in use.
  const repliedSince = all.some(
    (it) => it.kind === 'message' && it.role === 'user' && it.at > at,
  )

  const found = identify(items, ctx.project.root)
  // The gate, and it is inherent rather than tuned: roughly one task in seven
  // ever touches a worktree at all, so most fires end here having spent a
  // process, a record read and no model call.
  if (!found.touched.length && !found.unattributed.length)
    return log(ctx, { ...row, skipped: 'nothing-created' })

  const candidates = found.candidates

  // The present fact. Without it every candidate is a historical intent, and
  // most of them were cleaned up long ago.
  const live = await registered(ctx)
  row.touched = found.touched.map((x) => `${x.action}/${x.via}:${x.path}`)
  row.unattributed = found.unattributed.map((u) => u.why)
  row.repliedSince = repliedSince

  if (!live.ok) {
    // The harness that scores this body refuses every spawn on purpose, and so
    // does a checkout that has gone away. Either way the identification is still
    // worth recording; what is not available is the half that would license
    // acting on it.
    await log(ctx, { ...row, verify: 'unavailable', verifyError: live.error, candidates: candidates.map((c) => c.path) })
    return
  }

  const byPath = new Map(live.trees.map((t) => [t.path, t]))
  const standing = []
  for (const c of candidates) {
    const tree = byPath.get(c.path)
    if (!tree) continue // already gone, by whatever hand
    // The main working tree is the first entry `git worktree list` prints and is
    // nothing anyone created. A parse that lands on it is a parse that went
    // wrong, and the accurate report of that is silence, not a refusal notice.
    if (tree.path === live.main) continue
    standing.push({ ...c, ...(await judgeSafety(ctx, tree)), branch: tree.branch || c.branch })
  }

  await log(ctx, {
    ...row,
    verify: 'ok',
    registered: Math.max(0, live.trees.length - 1),
    standing: standing.map((s) => ({ path: s.path, branch: s.branch, via: s.via, safe: s.safe, blocked: s.blocked })),
  })

  // A human who replied after the fire has taken the task back, so a finding
  // about what it "left behind" is about a task that is working again. The row
  // is still written — the identification is what the log is for — but the
  // timeline hears nothing.
  if (repliedSince) return

  const parts = []
  if (standing.length)
    parts.push(
      `This task left ${standing.length === 1 ? 'a worktree' : `${standing.length} worktrees`} standing:\n\n` +
        standing
          .map(
            (s) =>
              `- \`${s.path}\`${s.branch ? ` on \`${s.branch}\`` : ''} — ${
                s.safe ? 'clean; would be removed' : `left alone: ${s.blocked}`
              }`,
          )
          .join('\n'),
    )
  // Evidence that a worktree was involved with no path to attribute it to. A
  // resource created indirectly — by a skill, a script, or a command whose text
  // does not name what it produced — leaves no attributable trace, and this hook
  // reports rather than guesses. It is reported only when nothing else in the
  // record accounts for a creation: an `easel-worktree` skill call sits beside
  // the `git worktree add` it ran, and naming both would be noise.
  if (found.unattributed.length && !found.touched.length)
    parts.push(
      `Something here touched a worktree and left no path to attribute it to, so nothing was identified:\n\n` +
        found.unattributed
          .map((u) => `- ${u.why} — \`${String(u.what).replace(/\s+/g, ' ').slice(0, 120)}\``)
          .join('\n'),
    )
  if (!parts.length) return

  ctx.report(
    parts.join('\n\n') +
      `\n\nNothing was removed. Cleanup is naming what it would release while its ` +
      `identification is being checked; releasing it is a later change.`,
  )
}
