import { mount } from 'svelte'

// Bundled, so the fonts work offline and pass the CSP (font-src 'self').
import '@fontsource-variable/cinzel'
import '@fontsource-variable/eb-garamond'
import './styles/palazzo-core.css'
import './styles/palazzo-busy-peasy.css'
import './app.css'

import App from './App.svelte'
import Reminder from './Reminder.svelte'
import { loadSettings } from './lib/settings.svelte'

// Settings first, so the first paint already uses them. On error the page still opens, with the defaults.
await loadSettings().catch((e) => console.error(e))

// Reminder windows load the same page with #reminder=... in the URL.
const app = mount(location.hash.startsWith('#reminder') ? Reminder : App, {
  target: document.getElementById('app')!
})

export default app
