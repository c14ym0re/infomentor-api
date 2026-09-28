// Visar hela veckans schema per barn via gettimetablelist (respekterar intervall).
//   node src/week-check.js [YYYY-MM-DD YYYY-MM-DD]
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

const start = process.argv[2] || '2026-09-28'
const end = process.argv[3] || '2026-10-04'

const pupils = await listPupils(jar)
for (const p of pupils) {
  await follow(jar, p.switchPupilUrl)
  const r = await hubPost(jar, '/timetable/timetable/gettimetablelist', {
    UTCOffset: '-120',
    start,
    end,
  })
  const arr = Array.isArray(r.json) ? r.json : r.json?.items || []
  const days = {}
  for (const i of arr) {
    const day = String(i.start || '').slice(0, 10)
    ;(days[day] ??= []).push(i)
  }
  const lessonDays = Object.keys(days).sort()
  const totalLessons = arr.filter((i) => !/^lunch$/i.test((i.title || '').trim())).length
  console.log(`\n=== ${p.name} — ${totalLessons} lektioner (exkl. lunch) över ${lessonDays.length} dagar ===`)
  for (const d of lessonDays) {
    const items = days[d]
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))
      .map((i) => `${String(i.start).slice(11, 16)} ${i.title}${/^lunch$/i.test(i.title.trim()) ? '' : ''}`)
    console.log(`  ${d}: ${items.join(' | ')}`)
  }
}

const orig = pupils.find((p) => p.selected)
if (orig) await follow(jar, orig.switchPupilUrl)

async function listPupils(jar) {
  const r = await follow(jar, `${HUB}/`)
  const s = r.body.indexOf('"pupils":[')
  const open = r.body.indexOf('[', s)
  let depth = 0
  for (let i = open; i < r.body.length; i++) {
    if (r.body[i] === '[') depth++
    else if (r.body[i] === ']' && --depth === 0) return JSON.parse(r.body.slice(open, i + 1))
  }
  return []
}
