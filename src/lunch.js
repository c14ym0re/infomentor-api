// Skolmat via Mateo (samma publik som HA:s skolmat-integration använder).
//   enhets-URL: https://meny.mateo.se/<kommun>/<enhetsId>
//   API:        https://meny-api.mateo.se/api/v1/days/<enhetsId>?from=&to=
// Enhets-ID:t sätts i lunch.json (se lunch.example.json).
// Returnerar { "YYYY-MM-DD": [{ dish, label }, ...] }.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cfgPath = join(root, 'lunch.json')

export function lunchConfig() {
  if (!existsSync(cfgPath)) return null
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch (err) {
    console.warn(`[lunch] kunde inte läsa lunch.json: ${err.message}`)
    return null
  }
}

/** Hämtar lunchmenyn för intervallet [fromISO, toISO] (YYYY-MM-DD). */
export async function fetchLunchCalendar(fromISO, toISO) {
  const cfg = lunchConfig()
  if (!cfg?.unitId) return {}
  const url = `https://meny-api.mateo.se/api/v1/days/${cfg.unitId}?from=${fromISO}&to=${toISO}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Referer: 'https://meny.mateo.se/' },
  })
  if (!res.ok) throw new Error(`Mateo ${res.status} ${res.statusText}`)
  const days = await res.json()
  const map = {}
  for (const d of Array.isArray(days) ? days : []) {
    const date = String(d.date || '').slice(0, 10)
    if (!date) continue
    map[date] = (d.meals || []).map((m) => ({ dish: m.name, label: m.type || '' }))
  }
  return map
}
