// Verifierar att Uppgifter (task/GetTasks) följer valt barn.
//   node src/tasks-check.js
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

const r = await follow(jar, `${HUB}/`)
const start = r.body.indexOf('"pupils":[')
const open = r.body.indexOf('[', start)
let depth = 0
let pupils = []
for (let i = open; i < r.body.length; i++) {
  if (r.body[i] === '[') depth++
  else if (r.body[i] === ']' && --depth === 0) {
    pupils = JSON.parse(r.body.slice(open, i + 1))
    break
  }
}

for (const p of pupils) {
  await follow(jar, p.switchPupilUrl)
  const t = await hubPost(jar, '/task/task/GetTasks', {})
  const d = t.json ?? {}
  const titles = (d.items ?? []).map((i) => `${i.title}${i.isOverdue ? ' ⚠' : ''} (${i.dueDate})`)
  console.log(`\n${p.name}: totalDue=${d.totalDue} totalOverdue=${d.totalOverdue} done=${d.totalDone} items=${(d.items ?? []).length}`)
  for (const t2 of titles) console.log(`   · ${t2}`)
}

// återställ
const orig = pupils.find((p) => p.selected)
if (orig) await follow(jar, orig.switchPupilUrl)
