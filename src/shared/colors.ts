// Google's classic colorId, in the order of Google web's color menu, with the hex Google web shows today (checked live),
// not GET /colors. A sign-in that cannot read the labels picks from these.
export const GOOGLE_COLOR_LIST: [id: string, name: string, hex: string][] = [
  ['4', 'Flamingo', '#E67C73'],
  ['11', 'Tomato', '#D50000'],
  ['6', 'Tangerine', '#F4511E'],
  ['5', 'Banana', '#F6BF26'],
  ['10', 'Basil', '#0B8043'],
  ['2', 'Sage', '#33B679'],
  ['7', 'Peacock', '#039BE5'],
  ['1', 'Lavender', '#7986CB'],
  ['9', 'Blueberry', '#3F51B5'],
  ['3', 'Grape', '#8E24AA'],
  ['8', 'Graphite', '#616161']
]

export const GOOGLE_COLORS: Record<string, string> = Object.fromEntries(GOOGLE_COLOR_LIST.map(([id, , hex]) => [id, hex]))

// Google's 24 default event labels, in the order of Google web's color menu (rows of 9, 9 and 6; checked live). The API
// sends them with no name, sorted by id, so the app names and orders them from this list. Found by hex: each hex is
// unique, while the label ids may differ per account (not checked).
export const GOOGLE_LABEL_LIST: [name: string, hex: string][] = [
  ['Beetroot', '#AD1457'],
  ['Cherry blossom', '#D81B60'],
  ['Flamingo', '#E67C73'],
  ['Tomato', '#D50000'],
  ['Tangerine', '#F4511E'],
  ['Pumpkin', '#EF6C00'],
  ['Mango', '#F09300'],
  ['Banana', '#F6BF26'],
  ['Citron', '#E4C441'],
  ['Avocado', '#C0CA33'],
  ['Pistachio', '#7CB342'],
  ['Basil', '#0B8043'],
  ['Sage', '#33B679'],
  ['Eucalyptus', '#009688'],
  ['Peacock', '#039BE5'],
  ['Cobalt', '#4285F4'],
  ['Lavender', '#7986CB'],
  ['Blueberry', '#3F51B5'],
  ['Wisteria', '#B39DDB'],
  ['Amethyst', '#9E69AF'],
  ['Grape', '#8E24AA'],
  ['Cocoa', '#795548'],
  ['Graphite', '#616161'],
  ['Birch', '#A79B8E']
]

// Outlook category presets: the strong color from the Outlook web Categorize menu. Others are not checked yet.
export const OUTLOOK_COLORS: Record<string, string> = {
  Preset0: '#C50F1F',
  Preset1: '#A74109',
  Preset3: '#835B00',
  Preset4: '#0E7A0B',
  Preset7: '#006A88',
  Preset8: '#6656D1'
}
