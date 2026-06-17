// Ad-hoc integration test for the permission-principal enforcement.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 6199
const UI = 'ui-secret-token'
const proj = mkdtempSync(path.join(os.tmpdir(), 'lander-test-'))
const API = `http://localhost:${PORT}`

const child = spawn('npx', ['tsx', 'server/index.ts'], {
  env: {
    ...process.env,
    PROJECT_DIRS: proj,
    LANDER_UI_TOKEN: UI,
    PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let slug = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  const m = d.match(/^\s+(\S+)\s+/m)
  if (m && !slug && d.includes(proj.replace(/.*\//, ''))) {}
})

const results = []
const ok = (name, cond, extra = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${API}/api/projects`)
      if (r.ok) return await r.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server never came up')
}

async function create(headers, perms, title = 'x') {
  const r = await fetch(`${API}/api/${slug}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ title, ...perms }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

function diskToken(id) {
  const dirs = readdirSync(path.join('data'))
  for (const d of dirs) {
    const f = path.join('data', d, 'tasks', `${id}.json`)
    try {
      return JSON.parse(readFileSync(f, 'utf8')).token
    } catch {}
  }
  return undefined
}

try {
  const projects = await waitUp()
  slug = projects[0].slug

  // 1. UI may create a task with edits+commits.
  const ui = await create(
    { 'x-lander-ui-token': UI },
    { allowEdits: true, allowCommits: true },
  )
  ok('UI grants edits+commits', ui.status === 201 && ui.body.allowEdits === true)
  ok('token not leaked over HTTP', ui.body.token === undefined, `got ${ui.body.token}`)
  const parentId = ui.body.session
  const parentToken = diskToken(parentId)
  ok('parent token persisted on disk', !!parentToken)

  // 2. Anon (no token) may NOT grant edits.
  const anon = await create({}, { allowEdits: true })
  ok('anon denied edits', anon.status === 403, `status ${anon.status}`)

  // 3. Anon may create a no-perms task.
  const anonPlain = await create({}, {})
  ok('anon may create plain task', anonPlain.status === 201)

  // 4. A task with a valid token may pass on a perm it HAS (edits).
  const taskHdr = {
    'x-lander-task': parentId,
    'x-lander-project': slug,
    'x-lander-token': parentToken,
  }
  const childEdits = await create(taskHdr, { allowEdits: true })
  ok('task forwards held edits', childEdits.status === 201, `status ${childEdits.status}`)

  // 5. A task may NOT pass on a perm it lacks. Make a task with edits only.
  const editsOnly = await create({ 'x-lander-ui-token': UI }, { allowEdits: true })
  const editsOnlyToken = diskToken(editsOnly.body.session)
  const eHdr = {
    'x-lander-task': editsOnly.body.session,
    'x-lander-project': slug,
    'x-lander-token': editsOnlyToken,
  }
  const overreach = await create(eHdr, { allowCommits: true })
  ok('task denied forwarding unheld commits', overreach.status === 403, `status ${overreach.status}`)

  // 6. A task may NOT impersonate another by guessing its id without the token.
  const impersonate = await create(
    { 'x-lander-task': parentId, 'x-lander-project': slug, 'x-lander-token': 'wrong' },
    { allowEdits: true },
  )
  ok('bad token treated as anon (denied)', impersonate.status === 403, `status ${impersonate.status}`)

  // 7. A task may NOT self-escalate via PATCH.
  const patch = await fetch(`${API}/api/${slug}/tasks/${editsOnly.body.session}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...eHdr },
    body: JSON.stringify({ allowCommits: true }),
  })
  ok('task denied self-PATCH of perms', patch.status === 403, `status ${patch.status}`)

  // 8. UI may PATCH perms.
  const uiPatch = await fetch(`${API}/api/${slug}/tasks/${editsOnly.body.session}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-lander-ui-token': UI },
    body: JSON.stringify({ allowCommits: true }),
  })
  ok('UI may PATCH perms', uiPatch.status === 200)

  // 9. A task may NOT grant a tool via /allow.
  const allow = await fetch(`${API}/api/${slug}/tasks/${editsOnly.body.session}/allow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...eHdr },
    body: JSON.stringify({ rule: 'Bash(rm:*)', scope: 'task' }),
  })
  ok('task denied /allow', allow.status === 403, `status ${allow.status}`)

  // 10. CLI status path (task principal, no perms involved) still works.
  const status = await fetch(`${API}/api/${slug}/tasks/${parentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...taskHdr },
    body: JSON.stringify({ status: 'landed' }),
  })
  ok('task may still set status', status.status === 200, `status ${status.status}`)
} catch (e) {
  results.push(`ERROR  ${e.message}`)
} finally {
  child.kill('SIGKILL')
  console.log('\n' + results.join('\n') + '\n')
  const failed = results.some((r) => !r.startsWith('PASS'))
  process.exit(failed ? 1 : 0)
}
