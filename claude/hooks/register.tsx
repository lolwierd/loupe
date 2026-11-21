// loupe in Claude Code. The mod notes every repository this session edits, and:
//   /loupe        a loupe link per repository (branch + uncommitted work), each with a chat linked to this
//                 session: a read-only fork that answers from what this session already knows
//   /loupe open   the same, opened in the browser
//   /loupe live   the browser's chat sends questions INTO this session (they arrive as prompts here, and the
//                 answer goes back); /loupe off stops it
// The first edit in a repository also puts it on loupe's home, linked to this session (no command needed).
// A row above the prompt offers the links once the session has edited something. Nothing opens unasked.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LoupeLink } from '../types'

const API = 'http://127.0.0.1:4500'
const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const repos = atom({ plugin: 'loupe', key: 'repos' } as const, [] as string[])
const live = atom({ plugin: 'loupe', key: 'live' } as const, false)
const hidden = atom({ plugin: 'loupe', key: 'hidden' } as const, false)
const links = atom({ plugin: 'loupe', key: 'links' } as const, [] as LoupeLink[])

// Module state: it starts over on a reload, which only forgets a cache and, while live, which turn is ours.
const roots = new Map<string, string | null>() // a directory -> the repository it is in
let poll: { cancel: () => void } | null = null
let asking: string | null = null // a live question submitted here, waiting for its turn to end
let inTurn: string | null = null // the live question the running turn answers

async function json($: any, path: string, init: { method?: string; body?: unknown } = {}) {
  const r = await $.http.fetch(API + path, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Loupe': '1' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (r.status === 204) return null
  const j = r.text ? JSON.parse(r.text) : {}
  if (!r.ok) throw new Error(j.error || `loupe answered ${r.status}`)
  return j
}
const daemonDown = 'loupe is not running. Start it with `loupe service install` (or `loupe serve`), then try again.'

async function rootOf($: any, file: string): Promise<string | null> {
  const dir = file.replace(/\/[^/]*$/, '') || '/'
  if (roots.has(dir)) return roots.get(dir) ?? null
  const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
  const root = r && r.exitCode === 0 ? r.stdout.trim() : null
  roots.set(dir, root)
  return root
}

async function sessionTitle($: any): Promise<string> {
  const msgs = await $.session.messages().catch(() => [])
  const first = (Array.isArray(msgs) ? msgs : []).find((m: any) => m.role === 'user' && m.text && !m.text.startsWith('<'))
  return String(first?.text || 'This session').replace(/\s+/g, ' ').slice(0, 80)
}

// A repository this session started editing: loupe opens it as a workspace (or finds the one it has) and links a
// chat to this session, so home lists it with the session's name. Errors stay quiet: this runs on its own.
async function announce($: any, root: string): Promise<void> {
  try {
    await json($, '/api/workspaces', { method: 'POST', body: { target: root, link: { sessionId: await $.session.id(), cwd: await $.session.cwd(), title: await sessionTitle($) } } })
  } catch { /* loupe is down or refused: home simply will not show it */ }
}

// The repositories to open: the ones this session edited, else the one it runs in.
async function targets($: any): Promise<string[]> {
  const edited = await read($, repos)
  if (edited.length) return edited
  const here = await rootOf($, (await $.session.cwd()) + '/.')
  return here ? [here] : []
}

async function openAll($: any, { browser }: { browser: boolean }): Promise<string> {
  const list = await targets($)
  if (!list.length) return 'This session is not in a git repository and has edited none, so there is nothing for loupe to show.'
  let state: any
  try { state = await json($, '/api/state') } catch { return daemonDown }
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()
  const title = await sessionTitle($)
  const out: LoupeLink[] = []
  const lines: string[] = []
  for (const root of list) {
    try {
      const r = await json($, '/api/workspaces', { method: 'POST', body: { target: root, link: { sessionId, cwd, title } } })
      const ws = await json($, `/api/w/${r.id}`).catch(() => null)
      const url = `${state.display}${r.url}`
      const files = ws?.totals?.files
      out.push({ root, url, files })
      lines.push(`- **${root.split('/').pop()}**${ws?.branch ? ` (${ws.branch}${ws.dirty ? `, ${ws.dirty} uncommitted` : ''})` : ''}: ${url}${files !== undefined ? `, ${files} files` : ''}`)
      if (browser) await $.process.run(['open', url]).catch(() => null)
    } catch (err: any) {
      lines.push(`- ${root}: ${err?.message || err}`)
    }
  }
  await update($, links, () => out)
  await update($, hidden, () => false)
  return `${browser ? 'Opened in loupe' : 'In loupe'}:\n${lines.join('\n')}\n\nEach has a chat in its Chat tab linked to this session (a read-only fork that knows what this session did). \`/loupe live\` lets that chat send questions into this session itself.`
}

// ---------------------------------------------------------------- live: questions from the browser
// The tag a live question carries into the session, so its answer is matched to the turn it started and no other.
const tagOf = (id: string) => `(loupe question ${id.slice(0, 8)})`

async function registerLive($: any): Promise<any> {
  const sessionId = await $.session.id()
  return json($, '/api/live', { method: 'POST', body: { sessionId, cwd: await $.session.cwd(), title: await sessionTitle($), repos: await targets($) } })
}
async function goLive($: any): Promise<string> {
  const sessionId = await $.session.id()
  let r: any
  try { r = await registerLive($) } catch { return daemonDown }
  await update($, live, () => true)
  startPolling($, sessionId)
  $.ui.status('loupe: live')
  const urls = (r.workspaces || []).filter((w: any) => w.url).map((w: any) => `- ${r.display}${w.url}`).join('\n')
  return `Live: the "Live session" chat in loupe now sends its questions here, and each answer goes back to it.\n${urls}\n\nThey arrive as prompts marked [From loupe]. \`/loupe off\` stops it.`
}
function startPolling($: any, sessionId: string) {
  poll?.cancel()
  poll = $.clock.every(2000, async () => {
    // While a question is being answered only the heartbeat goes (hold=1): the session stays live and the next
    // question waits in loupe's queue.
    const busy = !!(asking || inTurn)
    let q: any
    try { q = await json($, `/api/live/${sessionId}/next${busy ? '?hold=1' : ''}`) } catch (err: any) {
      // loupe restarted and forgot this session: register again.
      if (/unknown session/.test(String(err?.message))) await registerLive($).catch(() => null)
      return
    }
    if (!busy && q?.id) { asking = q.id; void $.prompt.submit({ text: `${q.text}\n\n${tagOf(q.id)}` }) }
  })
}

async function goOff($: any): Promise<string> {
  poll?.cancel(); poll = null
  asking = null; inTurn = null
  await update($, live, () => false)
  $.ui.status(undefined)
  await json($, `/api/live/${await $.session.id()}`, { method: 'DELETE' }).catch(() => null)
  return 'Not live any more: loupe\'s chats go back to read-only forks of this session.'
}


export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loupe', description: 'Review what this session changed, in loupe', argumentHint: '[open | live | off]' })
    if (await read($, live)) { startPolling($, await $.session.id()); $.ui.status('loupe: live') } // a reload keeps it live
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    if (await read($, live)) await json($, `/api/live/${await $.session.id()}`, { method: 'DELETE' }).catch(() => null)
    return next(e)
  })

  on('command.run', { command: 'loupe' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'live') return { text: await goLive($) }
    if (arg === 'off') return { text: await goOff($) }
    return { text: await openAll($, { browser: arg === 'open' }) }
  })

  // Every repository an edit lands in.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (EDITORS.has(tool) && ran.deny === undefined && ran.isError !== true) {
      const anyE = e as any
      const file = anyE.file_path || anyE.notebook_path
      if (typeof file === 'string' && file.startsWith('/')) {
        const root = await rootOf($, file)
        if (root) {
          const known = (await read($, repos)).includes(root)
          if (!known) {
            await update($, repos, (list) => (list.includes(root) ? list : [...list, root]))
            // The first edit in a repository puts it on loupe's home, linked to this session, with nothing to type.
            // It does not wait for loupe, and a daemon that is down only means home will not show it.
            void announce($, root)
          }
        }
      }
    }
    return ran
  })

  // Which turn answers the live question: the one our own submit starts.
  on('prompt.submit', async ($, e, next) => {
    if (asking && e.origin?.kind === 'plugin' && (e.origin as any).name === 'loupe' && String((e as any).text || '').includes(tagOf(asking))) { inTurn = asking; asking = null }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (inTurn && e.agentId === undefined) {
      // A turn that was already running when the question was queued ends first: only the turn whose prompt
      // carries the tag is the answer.
      const msgs = await $.session.messages().catch(() => [])
      const lastUser = (Array.isArray(msgs) ? [...msgs] : []).reverse().find((m: any) => m.role === 'user' && m.text)
      if (!lastUser || !String(lastUser.text).includes(tagOf(inTurn))) return next(e)
      const id = inTurn
      inTurn = null
      const sessionId = await $.session.id()
      await json($, `/api/live/${sessionId}/answer`, { method: 'POST', body: { id, text: e.answer, durationMs: e.durationMs, error: e.isAborted ? 'stopped in the session' : e.reason === 'error' ? 'the turn ended with an error' : undefined } }).catch(() => null)
    }
    return next(e)
  })

  // The row above the prompt: once this session has edited a repository, the way to review it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const edited = await read($, repos)
    const isLive = await read($, live)
    if (e.props.hasSurvey || (!edited.length && !isLive) || (await read($, hidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const names = edited.map((r) => r.split('/').pop()).join(', ')
    return (
      <Box>
        <Text dimColor>{isLive ? 'loupe (live): ' : 'loupe: '}{names || 'this repository'} </Text>
        <Button key="open" label="Review" onPress={async () => { const text = await openAll($, { browser: true }); if (text.startsWith('loupe is not')) $.ui.toast(text) }} />
        <Button key="hide" label="Hide" onPress={() => update($, hidden, () => true)} />
      </Box>
    )
  })
}
