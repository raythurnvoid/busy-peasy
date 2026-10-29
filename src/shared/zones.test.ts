import { describe, expect, it } from 'vitest'
import { ZONES, ianaZone, isZone, windowsZone } from './zones'

process.env.TZ = 'Europe/Berlin'

describe('zones', () => {
  it('maps the zones we use', () => {
    // A few rows checked by hand against CLDR, so swapped or renamed rows fail here.
    expect(ianaZone('UTC')).toBe('Etc/UTC')
    expect(ianaZone('GMT Standard Time')).toBe('Europe/London')
    expect(ianaZone('W. Europe Standard Time')).toBe('Europe/Berlin')
    expect(ianaZone('FLE Standard Time')).toBe('Europe/Kiev')
    expect(ianaZone('Eastern Standard Time')).toBe('America/New_York')
    expect(ianaZone('India Standard Time')).toBe('Asia/Calcutta')
    expect(windowsZone('Europe/Rome')).toBe('W. Europe Standard Time')
    expect(windowsZone('Eastern Standard Time')).toBe('Eastern Standard Time')
    expect(windowsZone('Asia/Tokyo')).toBe('Tokyo Standard Time')
    expect(windowsZone('tzone://Microsoft/Custom')).toBeUndefined()
    expect(windowsZone('constructor')).toBeUndefined()
    // Not in the table: its clock is not the main zone's.
    expect(windowsZone('Antarctica/Casey')).toBeUndefined()
  })

  it("finds a zone by another id of it, as Google and Outlook may send the new one", () => {
    expect(windowsZone('Asia/Kolkata')).toBe('India Standard Time')
    expect(windowsZone('Europe/Kyiv')).toBe('FLE Standard Time')
  })

  it('takes only the zones the picker lists', () => {
    expect(isZone('Europe/Rome')).toBe(true)
    expect(isZone('UTC')).toBe(true)
    // Not zone ids the picker lists (Intl takes some of them).
    for (const zone of ['Mars/Base', '+01:00', 'europe/rome', 'EST', '', 5, null]) expect(isZone(zone), String(zone)).toBe(false)
  })

  it("also takes this PC's zone, which the list may lack, as the dialogs offer it", () => {
    try {
      process.env.TZ = 'Etc/GMT+11'
      expect(isZone('Etc/GMT+11')).toBe(true)
      expect(isZone('Etc/GMT+10')).toBe(false)
    } finally {
      process.env.TZ = 'Europe/Berlin'
    }
  })

  // We send wall time in the main zone of a Windows name, so every listed zone must show the same clock all year.
  it('each listed zone keeps the same clock as the main zone of its Windows name', () => {
    // Both sides of the US and EU DST changes.
    const instants = [[0, 15, 12], [2, 10, 12], [2, 29, 12], [6, 15, 12], [9, 26, 12], [10, 2, 12]].map(([m, d, h]) => Date.UTC(2026, m, d, h))
    const clock = (t: number, timeZone: string): string => new Date(t).toLocaleString('sv-SE', { timeZone })
    for (const [name, zones] of Object.entries(ZONES)) {
      for (const iana of zones) {
        expect(windowsZone(iana), iana).toBe(name)
        for (const t of instants) expect(clock(t, iana), `${iana} at ${new Date(t).toISOString()}`).toBe(clock(t, zones[0]))
      }
    }
  })
})
