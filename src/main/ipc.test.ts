import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Api } from '../shared/api'
import { askApproval, registerApi, writesDone } from './ipc'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: ipc, BrowserWindow: { getAllWindows: () => [] } }))

// Calls one Api method the way our page does, from the dev origin.
function call(api: Partial<Api>, name: keyof Api): Promise<unknown> {
  registerApi(api as Api, 'http://localhost:5173/')
  return ipc.handle.mock.lastCall![1]({ senderFrame: { origin: 'http://localhost:5173' } }, name, [1])
}

// Quit waits on writesDone: true once it has given up or the writes are done.
function waiting(ms: number): () => boolean {
  let done = false
  void writesDone(ms).then(() => (done = true))
  return () => !done
}

describe('writesDone', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for a delete in progress', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const result = call({ deleteEvent: () => new Promise<void>((r) => (finish = r)) }, 'deleteEvent')
    const stillWaiting = waiting(1000)
    await vi.advanceTimersByTimeAsync(10)
    expect(stillWaiting()).toBe(true)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(stillWaiting()).toBe(false)
    await result
  })

  it('lets a failed answer go without an unhandled rejection', async () => {
    const result = call({ respondEvent: () => Promise.reject(new Error('Offline')) }, 'respondEvent')
    await expect(result).rejects.toThrow('Offline')
    await writesDone(1000)
  })

  it.each(['createEvent', 'updateEvent'] as const)('waits for %s in progress', async (name) => {
    vi.useFakeTimers()
    let finish!: () => void
    const result = call({ [name]: () => new Promise<void>((r) => (finish = r)) }, name)
    const stillWaiting = waiting(1000)
    await vi.advanceTimersByTimeAsync(10)
    expect(stillWaiting()).toBe(true)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(stillWaiting()).toBe(false)
    await result
  })

  it('never waits for a sync', async () => {
    vi.useFakeTimers()
    call({ syncNow: () => new Promise(() => {}) }, 'syncNow')
    const stillWaiting = waiting(1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(stillWaiting()).toBe(false)
  })

  it('gives up at its time limit', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const result = call({ deleteEvent: () => new Promise<void>((r) => (finish = r)) }, 'deleteEvent')
    const stillWaiting = waiting(50)
    await vi.advanceTimersByTimeAsync(49)
    expect(stillWaiting()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(stillWaiting()).toBe(false)
    finish()
    await result
  })
})

describe('askApproval', () => {
  afterEach(() => vi.useRealTimers())

  const request = { id: 'a1', name: 'Claude Code', twin: false, trayAccess: 'full' as const }
  const appFrame = { origin: 'http://localhost:5173' }

  // A page: send records what main sends; destroy() closes it.
  type Page = { send: Mock; once: Mock; off: Mock; isDestroyed(): boolean; destroy(): void }
  function page(): Page {
    let destroyed = (): void => {}
    return {
      send: vi.fn(),
      once: vi.fn((_: string, f: () => void) => (destroyed = f)),
      off: vi.fn(),
      isDestroyed: () => false,
      destroy: () => destroyed()
    }
  }

  // Opens a prompt on a page, and gives the page's ready and answer messages.
  function open(
    contents = page(),
    signal = new AbortController().signal
  ): {
    contents: Page
    answered(): Promise<unknown>
    ready(sender?: unknown): void
    answer(id: unknown, value: unknown, event?: object): void
  } {
    vi.useFakeTimers()
    registerApi({} as Api, 'http://localhost:5173/')
    const on = (channel: string): ((...args: unknown[]) => void) => ipc.on.mock.calls.findLast(([c]) => c === channel)![1]
    let answer: unknown = 'none'
    void askApproval(contents as never, request, signal).then((a) => (answer = a))
    return {
      contents,
      answered: async () => (await vi.advanceTimersByTimeAsync(0), answer),
      ready: (sender: unknown = contents) => on('agent-approval-ready')({ sender }),
      answer: (id: unknown, value: unknown, event: object = {}) =>
        on('agent-approval-answer')({ sender: contents, senderFrame: appFrame, ...event }, id, value)
    }
  }

  it('sends the prompt, and again when the page is ready (after a start or a reload)', () => {
    const prompt = open()
    expect(prompt.contents.send).toHaveBeenCalledWith('agent-approval', request)
    prompt.ready()
    prompt.ready(page())
    expect(prompt.contents.send).toHaveBeenCalledTimes(2)
  })

  it('takes the right answer from the page after 1 s, once', async () => {
    const prompt = open()
    vi.advanceTimersByTime(1000)
    prompt.answer('a1', 'read')
    prompt.answer('a1', 'full')
    expect(await prompt.answered()).toBe('read')
  })

  it('ignores an answer sooner than 1 s after the prompt was sent', async () => {
    const prompt = open()
    vi.advanceTimersByTime(999)
    prompt.answer('a1', 'full')
    expect(await prompt.answered()).toBe('none')
    expect(prompt.contents.send).not.toHaveBeenCalledWith('agent-approval', null)
    vi.advanceTimersByTime(1)
    prompt.answer('a1', 'full')
    expect(await prompt.answered()).toBe('full')
    expect(prompt.contents.send).toHaveBeenLastCalledWith('agent-approval', null)
  })

  it('ignores an answer for another agent, from another page or origin, or with a wrong value', async () => {
    const prompt = open()
    vi.advanceTimersByTime(1000)
    prompt.answer('b2', 'full')
    prompt.answer('a1', 'full', { sender: page() })
    prompt.answer('a1', 'full', { senderFrame: { origin: 'https://example.com' } })
    prompt.answer('a1', 'full', { senderFrame: { origin: 'null' } })
    prompt.answer('a1', 'admin')
    // The prompt has no Not now: the page cannot close it without a level.
    prompt.answer('a1', null)
    expect(await prompt.answered()).toBe('none')
    prompt.answer('a1', 'off')
    expect(await prompt.answered()).toBe('off')
  })

  it('closes on abort, and a late answer finds nothing', async () => {
    const abort = new AbortController()
    const prompt = open(page(), abort.signal)
    abort.abort()
    expect(await prompt.answered()).toBe(null)
    expect(prompt.contents.send).toHaveBeenLastCalledWith('agent-approval', null)
    vi.advanceTimersByTime(1000)
    prompt.answer('a1', 'full')
    expect(await prompt.answered()).toBe(null)
  })

  it('stays open until the user answers, however long it takes', async () => {
    const prompt = open()
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(await prompt.answered()).toBe('none')
    expect(prompt.contents.send).not.toHaveBeenCalledWith('agent-approval', null)
    prompt.answer('a1', 'full')
    expect(await prompt.answered()).toBe('full')
  })

  it('answers Not now when the page is gone', async () => {
    const prompt = open()
    prompt.contents.destroy()
    expect(await prompt.answered()).toBe(null)
  })
})
