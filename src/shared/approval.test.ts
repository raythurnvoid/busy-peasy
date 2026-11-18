import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_ARM_MS, approvalText, ASKING, mayAnswer, refuseWhileAsking } from './approval'

describe('mayAnswer', () => {
  it('never takes a script click', () => {
    expect(mayAnswer({ isTrusted: false }, 0, 10_000)).toBe(false)
    expect(mayAnswer({ isTrusted: false, detail: 1 }, 0, 10_000)).toBe(false)
  })

  it('takes a key only once the window has had the focus for 1 s', () => {
    expect(APPROVAL_ARM_MS).toBe(1000)
    // A click from Enter or Space has detail 0; Esc (cancel) has none.
    for (const e of [{ isTrusted: true, detail: 0 }, { isTrusted: true }]) {
      expect(mayAnswer(e, null, 10_000)).toBe(false)
      expect(mayAnswer(e, 0, 999)).toBe(false)
      expect(mayAnswer(e, 0, 1000)).toBe(true)
    }
  })

  it('takes the user\'s mouse click at once, also the one that brings the window to the front', () => {
    expect(mayAnswer({ isTrusted: true, detail: 1 }, null, 0)).toBe(true)
    expect(mayAnswer({ isTrusted: true, detail: 1 }, 0, 1)).toBe(true)
  })
})

describe('approvalText', () => {
  it('asks with the name, and warns only when it must', () => {
    const plain = approvalText({ id: 'a', name: 'Claude Code', twin: false, trayAccess: 'full' })
    expect(plain.title).toBe('Allow "Claude Code" to use Busy Peasy?')
    expect(plain.lines).toHaveLength(1)
    const { lines } = approvalText({ id: 'a', name: 'Claude Code (2)', twin: true, trayAccess: 'read' })
    expect(lines).toContain('Busy Peasy already has an agent named "Claude Code". If you did not start a second copy of it, click Deny.')
    expect(lines).toContain('Agent access in the tray is Read only, so every agent can only read until you change it there.')
  })
})

describe('refuseWhileAsking', () => {
  it('refuses every command but snapshot and getState while a prompt is open, before the handler runs', async () => {
    let asking = true
    const handler = vi.fn(async (name: string) => name)
    const guarded = refuseWhileAsking(() => asking, handler)
    for (const name of ['click', 'fill', 'press', 'navigate', 'openSettings']) {
      await expect(guarded(name, {})).rejects.toThrow(ASKING)
    }
    expect(handler).not.toHaveBeenCalled()
    expect(await guarded('snapshot', {})).toBe('snapshot')
    expect(await guarded('getState', {})).toBe('getState')
    asking = false
    expect(await guarded('click', {})).toBe('click')
  })

  // The repo has no DOM tests, so this checks the source: the check must wrap the whole handler, so it comes first.
  it('wraps the whole agent command handler in App.svelte', () => {
    const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.svelte'), 'utf8')
    expect(app).toContain('window.api.onAgentCommand(refuseWhileAsking(() => approval !== null, async (name, args) => {')
  })
})
