// Probar planerings-appen (uolv2) på djupet: listan har vi, men appen har en
// detaljvy (#/uolv2/show/<id>). appData exponerar urls.getUol m.fl. — här
// verifierar vi vilka som svarar och vad de innehåller.
//   node src/probe-uol.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost } from './infomentor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))

const { jar } = await login({
  username: creds.username || creds.email,
  password: creds.password,
})

// Hämta listan först så vi vet vilka id:n som finns.
const app = await hubPost(jar, '/UolV2/UolV2/appData', {})
const uols = (app.json && app.json.uols) || []
const active = uols.find((u) => u.state === 'active') || uols[0]
const finished = uols.find((u) => u.state === 'finished')
console.log(`hittade ${uols.length} planeringar; testar aktiv=${active?.id} (${active?.title?.trim()})`)
if (finished) console.log(`                     samt avslutad=${finished.id} (${finished.title?.trim()})`)
console.log('urls i appData:', JSON.stringify(app.json?.urls || {}))

const id = active?.id
const candidates = [
  ['GetUol{id}', '/UolV2/UolV2/GetUol', { id }],
  ['GetUol{uolId}', '/UolV2/UolV2/GetUol', { uolId: id }],
  ['GetUol{Id}', '/UolV2/UolV2/GetUol', { Id: id }],
  ['GetUol{uolIdStr}', '/UolV2/UolV2/GetUol', { uolId: String(id) }],
  ['GetAllObjectives{id}', '/UolV2/UolV2/GetAllObjectives', { id }],
  ['GetAllTasks{id}', '/UolV2/UolV2/GetAllTasks', { id }],
  ['GetTimelineEntries{id}', '/UolV2/UolV2/GetTimelineEntries', { id }],
]
if (finished) candidates.push(['GetUol{id,avslutad}', '/UolV2/UolV2/GetUol', { id: finished.id }])

for (const [name, path, body] of candidates) {
  try {
    const r = await hubPost(jar, path, body)
    const j = r.json
    const shape = Array.isArray(j)
      ? `array[${j.length}]`
      : j && typeof j === 'object'
        ? Object.keys(j).slice(0, 10).join(',')
        : r.text.slice(0, 60).replace(/\s+/g, ' ')
    const mark = r.text.length > 40 ? '✅' : '  '
    console.log(`${mark} ${String(r.status)} ${String(r.text.length).padStart(6)}B  ${name.padEnd(24)} ${shape}`)
    if (r.text.length > 40) {
      writeFileSync(join(outDir, `uol-detail-${name.replace(/[^\w.-]/g, '_')}.json`), r.text)
    }
  } catch (e) {
    console.log(`   ERR       ${name.padEnd(24)} ${e.message}`)
  }
}
