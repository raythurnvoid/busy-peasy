import { describe, expect, it } from 'vitest'
import { OWA_APP_ID, parseOutlookToken } from './token'

const NOW = Date.UTC(2026, 9, 26, 12)

function jwt(claims: object): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`
}

const good = {
  aud: 'https://outlook.office.com',
  appid: OWA_APP_ID,
  tid: 'tenant',
  exp: NOW / 1000 + 3600,
  scp: 'Calendars.ReadWrite Mail.ReadWrite',
  upn: 'Me@Example.com'
}

describe('parseOutlookToken', () => {
  it('accepts a calendar token from Outlook on the web', () => {
    const token = parseOutlookToken('Bearer ' + jwt(good), 'PUID:1@tenant', NOW)
    expect(token).toMatchObject({ upn: 'me@example.com', tid: 'tenant', anchor: 'PUID:1@tenant', exp: NOW + 3600_000 })
  })

  it.each([
    ['another audience (Graph)', { aud: 'https://graph.microsoft.com' }],
    ['another app', { appid: 'other' }],
    ['no calendar scope', { scp: 'Mail.Read' }],
    ['less than 5 minutes left', { exp: NOW / 1000 + 120 }],
    ['no user', { upn: undefined }]
  ])('rejects %s', (_, change) => {
    expect(parseOutlookToken('Bearer ' + jwt({ ...good, ...change }), undefined, NOW)).toBeNull()
  })

  it('rejects headers that are not bearer JWTs', () => {
    expect(parseOutlookToken('Basic abc', undefined, NOW)).toBeNull()
    expect(parseOutlookToken('Bearer not-a-jwt', undefined, NOW)).toBeNull()
    expect(parseOutlookToken(undefined, undefined, NOW)).toBeNull()
  })
})
