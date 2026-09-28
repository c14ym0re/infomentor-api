// Visningsnamn: mappar hub-namnet ("Efternamn, Förnamn") → smeknamn.
// Redigera names.json (skapas från names.example.json). Faller tillbaka på
// "Förnamn Efternamn" om ingen mappning finns.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cfgPath = join(root, 'names.json')

let map = {}
if (existsSync(cfgPath)) {
  try {
    map = JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch (err) {
    console.warn(`[names] kunde inte läsa names.json: ${err.message}`)
  }
}

export function displayName(hubName) {
  const raw = String(hubName || '')
  if (map[raw]) return map[raw]
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length > 1 ? `${parts.slice(1).join(' ')} ${parts[0]}` : raw
}
