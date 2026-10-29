import type { Api, CalendarEvent, DataChanged } from '../shared/api'

declare global {
  interface Window {
    api: Api & {
      onDataChanged(callback: (change: DataChanged) => void): () => void
      onSignIn(callback: (accountId: number) => void): () => void
      onShowEvent(callback: (event: CalendarEvent) => void): () => void
    }
  }
}
