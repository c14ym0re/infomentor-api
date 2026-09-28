// Testar elevväxling: /Account/PupilSwitcher/SwitchPupil/<id>
// Verifierar att schema/kalender faktiskt byter per barn.
//   node src/switch-test.js
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost, follow, HUB } from './infomentor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))

const iso = (d) => d.toISOString().slice(0, 10)
const plus = (n) => iso(new Date(Date.now() + n * 864e5))

const { jar } = await login({
  username: creds.username || creds.email,
  password: creds.password,
})

async function selectedPupil() {
  const r = await follow(jar, `${HUB}/`)
  return r.body.match(/selectedPupilName:\s*'([^']*)'/)?.[1] ?? '(okänt)'
}

async function listPupils() {
  const r = await follow(jar, `${HUB}/`)
  const start = r.body.indexOf('"pupils":[')
  const open = r.body.indexOf('[', start)
  let depth = 0
  for (let i = open; i < r.body.length; i++) {
    if (r.body[i] === '[') depth++
    else if (r.body[i] === ']' && --depth === 0)
      return JSON.parse(r.body.slice(open, i + 1))
  }
  return []
}

async function switchTo(url) {
  const r = await follow(jar, url)
  return r.res.status
}

const pupils = await listPupils()
const original = pupils.find((p) => p.selected)?.switchPupilUrl

console.log(`\nStartvald: ${await selectedPupil()}\n`)

for (const p of pupils) {
  const status = await switchTo(p.switchPupilUrl)
  const now = await selectedPupil()

  const tt = await hubPost(jar, '/timetable/timetable/appData', {
    startDate: iso(new Date()),
    endDate: plus(14),
  })
  const cal = await hubPost(jar, '/calendarv2/calendarv2/getentries', {
    startDate: iso(new Date()),
    endDate: plus(30),
  })

  const ttItems = tt.json?.items ?? []
  const titles = [...new Set(ttItems.map((i) => i.title))].slice(0, 6)
  const calTitles = (cal.json ?? []).map((c) => c.title).slice(0, 4)

  console.log(
    `${p.name.padEnd(22)} switch=${status}  vald="${now}"  ` +
      `schema=${String(ttItems.length).padStart(3)}  kalender=${String((cal.json ?? []).length).padStart(3)}`
  )
  console.log(`   schema-titlar : ${titles.join(' | ') || '(inga)'}`)
  console.log(`   kalender      : ${calTitles.join(' | ') || '(inga)'}`)
}

if (original) {
  await switchTo(original)
  console.log(`\nÅterställde till: ${await selectedPupil()}`)
}
