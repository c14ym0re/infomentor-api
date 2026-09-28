// Kartlägger classlist: appData vs GetClassList, per barn.
// Skriver bara ut grupp-titlar och antal — inga namn.
//   node src/classlist-check.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost, follow, HUB } from './infomentor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))
const { jar } = await login({
  username: creds.username || creds.email,
  password: creds.password,
})

const pupils = await listPupils(jar)

const variants = [
  ['appData', '/classlist/classlist/appData', {}],
  ['GetClassList/{}', '/ClassList/classlist/GetClassList', {}],
  ['GetClassList/id-1', '/ClassList/classlist/GetClassList', { id: '-1' }],
]

for (const p of pupils) {
  await follow(jar, p.switchPupilUrl)
  console.log(`\n=== ${p.name} ===`)
  for (const [name, path, body] of variants) {
    const r = await hubPost(jar, path, body)
    const groups = r.json?.groupConfig
    if (Array.isArray(groups)) {
      const desc = groups
        .map((g) => `"${g.title}" id=${g.id} items=${(g.items || []).length} staff=${g.isStaffGroup}`)
        .join('; ')
      console.log(`  ${name.padEnd(18)} ${r.status} grupper=${groups.length}: ${desc}`)
    } else {
      const keys = r.json && typeof r.json === 'object' ? Object.keys(r.json).slice(0, 6).join(',') : r.text.slice(0, 40)
      console.log(`  ${name.padEnd(18)} ${r.status} ${r.text.length}B  ${keys}`)
    }
    if (name === 'appData') writeFileSync(join(outDir, `classlist-appData-${p.initials}.json`), r.text)
    if (name === 'GetClassList/id-1') writeFileSync(join(outDir, `classlist-getclasslist-${p.initials}.json`), r.text)
  }
}

const orig = pupils.find((p) => p.selected)
if (orig) await follow(jar, orig.switchPupilUrl)

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
