import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api } from '../shared/api'
import { registerApi, writesDone } from './ipc'

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
