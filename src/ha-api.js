// Publicera MQTT via Home Assistants service `mqtt.publish`.
// Kräver ingen broker-inloggning — HA sköter anslutningen. Läser HA_URL/HA_TOKEN
// från ~/.config/infomentor/ha.env (eller HA_ENV_FILE / config.ha.envFile).
// fetch är injicerbar => testbar.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Tolkar en enkel KEY=VALUE-envfil (shell-stil). */
export function parseEnv(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim().replace(/^export\s+/, '')
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

export function readHaEnv(path = process.env.HA_ENV_FILE || join(homedir(), '.config', 'infomentor', 'ha.env')) {
  const env = parseEnv(readFileSync(path, 'utf8'))
  if (!env.HA_URL || !env.HA_TOKEN) throw new Error(`${path} saknar HA_URL/HA_TOKEN`)
  return { url: env.HA_URL.replace(/\/$/, ''), token: env.HA_TOKEN }
}

/**
 * Publicerar meddelanden sekventiellt via HA:s mqtt.publish.
 * @param {{topic:string,payload:string,retain?:boolean}[]} messages
 * @param {{url:string,token:string,fetchImpl?:Function,delayMs?:number}} opts
 */
export async function publishViaHa(messages, opts) {
  const doFetch = opts.fetchImpl ?? fetch
  const delayMs = opts.delayMs ?? 40 // var snäll mot API:et
  let sent = 0
  for (const m of messages) {
    const res = await doFetch(`${opts.url}/api/services/mqtt/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ topic: m.topic, payload: m.payload, qos: 0, retain: m.retain ?? true }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`mqtt.publish ${m.topic} → ${res.status} ${body.slice(0, 120)}`)
    }
    sent++
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  }
  return sent
}

/** Stabil hash av discovery-meddelanden, för att slippa republicera i onödan. */
export function messagesHash(messages) {
  const s = messages.map((m) => `${m.topic}=${m.payload}`).join('\n')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}
