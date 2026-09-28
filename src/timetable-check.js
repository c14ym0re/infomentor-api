// Undersöker om timetable/appData respekterar startDate/endDate.
//   node src/timetable-check.js
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost, follow, HUB } from './infomentor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))
const { jar } = await login({
  username: creds.username || creds.email,
  password: creds.password,
})

const pupils = await listPupils(jar)
const pupil = pupils[0]
await follow(jar, pupil.switchPupilUrl)
console.log(`Valt barn: ${pupil.name}\n`)

const cases = [
  ['14 dagar', { startDate: '2026-09-28', endDate: '2026-10-12' }],
  ['bara 29/9', { startDate: '2026-09-29', endDate: '2026-09-29' }],
  ['nästa vecka 5–11/10', { startDate: '2026-10-05', endDate: '2026-10-11' }],
  ['inga params', {}],
]

for (const [name, body] of cases) {
  const r = await hubPost(jar, '/timetable/timetable/appData', body)
  const d = r.json || {}
  const items = d.items || []
  const days = {}
  for (const i of items) {
    const day = String(i.start).slice(0, 10)
    days[day] = (days[day] || 0) + 1
  }
  const span = Object.keys(days).sort()
  console.log(
    `${name.padEnd(22)} status=${r.status} items=${items.length} ` +
      `minDate=${d.minDate ?? '-'} maxDate=${d.maxDate ?? '-'} numberOfDays=${d.numberOfDays ?? '-'}`
  )
  console.log(`   dagar: ${span.map((d2) => `${d2}(${days[d2]})`).join(' ') || '(inga)'}\n`)
}

// jämför med dementor-varianten /gettimetablelist
for (const [label, body] of [
  ['gettimetablelist 28/9–4/10', { UTCOffset: '-120', start: '2026-09-28', end: '2026-10-04' }],
  ['gettimetablelist 29/9–29/9', { UTCOffset: '-120', start: '2026-09-29', end: '2026-09-29' }],
]) {
  const r = await hubPost(jar, '/timetable/timetable/gettimetablelist', body)
  const d = r.json
  const arr = Array.isArray(d) ? d : d?.items || []
  const days = {}
  for (const i of arr) {
    const day = String(i.start || i.date || '').slice(0, 10)
    if (day) days[day] = (days[day] || 0) + 1
  }
  console.log(`\n${label}: status=${r.status} items=${arr.length}`)
  console.log(`   per dag: ${Object.keys(days).sort().map((k) => `${k}(${days[k]})`).join(' ') || '(inga)'}`)
  if (arr[0]) console.log(`   item-nycklar: ${Object.keys(arr[0]).join(', ')}`)
  const tue = arr.filter((i) => String(i.start || '').slice(0, 10) === '2026-09-29')
  console.log(`   29/9: ${tue.map((i) => `${String(i.start).slice(11, 16)} ${i.title}`).join(' | ') || '(inga)'}`)
}

async function listPupils(jar) {
  const r = await follow(jar, `${HUB}/`)
  const start = r.body.indexOf('"pupils":[')
  const open = r.body.indexOf('[', start)
  let depth = 0
  for (let i = open; i < r.body.length; i++) {
    if (r.body[i] === '[') depth++
    else if (r.body[i] === ']' && --depth === 0) return JSON.parse(r.body.slice(open, i + 1))
  }
  return []
}
