import { describe, expect, it } from 'vitest'
import { OUTLOOK_BASE, OutlookAuthError, OutlookHttpError, outlookRequest, type OutlookDeps } from './client'

function deps(responses: Response[], sleeps: number[] = []): OutlookDeps & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: (async (url: string) => {
      urls.push(url)
      return responses.shift()!
    }) as typeof fetch,
    getToken: () => ({ raw: 'tok', anchor: 'PUID:1', exp: Infinity, upn: 'me@x.com', tid: 't' }),
    sleep: async (ms) => void sleeps.push(ms)
  }
}

describe('outlookRequest', () => {
  it('never sends the token outside the calendar endpoints', async () => {
    const d = deps([])
    await expect(outlookRequest(d, OUTLOOK_BASE + 'messages')).rejects.toThrow('Blocked Outlook URL')
    await expect(outlookRequest(d, OUTLOOK_BASE + 'mailfolders/inbox/messages')).rejects.toThrow('Blocked Outlook URL')
    await expect(outlookRequest(d, 'https://evil.example/api/beta/me/events')).rejects.toThrow('Blocked Outlook URL')
    await expect(outlookRequest(d, OUTLOOK_BASE + 'events/AQ_1/forward', { method: 'POST' })).rejects.toThrow('Blocked Outlook URL')
    await expect(outlookRequest(d, OUTLOOK_BASE + 'events/AQ_1/acceptx', { method: 'POST' })).rejects.toThrow('Blocked Outlook URL')
    expect(d.urls).toEqual([])
  })

  it('allows the calendar endpoints', async () => {
    const d = deps([
      new Response('{"value":[]}'),
      new Response('{"value":[]}'),
      new Response(null, { status: 204 }),
      new Response('{"value":[]}'),
      new Response(null, { status: 202 }),
      new Response(null, { status: 202 })
    ])
    await outlookRequest(d, OUTLOOK_BASE + 'calendars/AQ_1-x/calendarview?$deltatoken=abc')
    await outlookRequest(d, OUTLOOK_BASE + 'events/AQ_1/instances?startDateTime=a')
    await outlookRequest(d, OUTLOOK_BASE + 'events/AQ_1', { method: 'DELETE' })
    await outlookRequest(d, OUTLOOK_BASE + 'MasterCategories')
    await outlookRequest(d, OUTLOOK_BASE + 'events/AQ_1/accept', { method: 'POST' })
    await outlookRequest(d, OUTLOOK_BASE + 'events/AQ_1/tentativelyaccept', { method: 'POST' })
    expect(d.urls).toHaveLength(6)
  })

  it('waits for Retry-After on 429, then succeeds', async () => {
    const sleeps: number[] = []
    const d = deps(
      [new Response('', { status: 429, headers: { 'Retry-After': '7' } }), new Response('{"ok":true}')],
      sleeps
    )
    expect(await outlookRequest(d, OUTLOOK_BASE + 'calendars')).toEqual({ ok: true })
    expect(sleeps).toEqual([7000])
  })

  it('turns 401 into an auth error and other failures into HTTP errors with the code', async () => {
    await expect(outlookRequest(deps([new Response('', { status: 401 })]), OUTLOOK_BASE + 'calendars')).rejects.toBeInstanceOf(
      OutlookAuthError
    )
    const error = await outlookRequest(
      deps([new Response('{"error":{"code":"SyncStateNotFound"}}', { status: 410 })]),
      OUTLOOK_BASE + 'calendars'
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OutlookHttpError)
    expect(error).toMatchObject({ status: 410, code: 'SyncStateNotFound' })
  })
})
