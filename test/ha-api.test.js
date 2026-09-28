import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv, readHaEnv, publishViaHa, messagesHash } from '../src/ha-api.js'

test('parseEnv tolkar citat, kommentarer och export', () => {
  const env = parseEnv(`# kommentar
HA_URL="http://host:8123"
export HA_TOKEN='abc'
TOM=`)
  assert.equal(env.HA_URL, 'http://host:8123')
  assert.equal(env.HA_TOKEN, 'abc')
  assert.equal(env.TOM, '')
})

test('readHaEnv läser url och token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ha-env-'))
  const p = join(dir, 'ha.env')
  writeFileSync(p, 'HA_URL=http://192.0.2.10\nHA_TOKEN=tok123\n')
  const { url, token } = readHaEnv(p)
  assert.equal(url, 'http://192.0.2.10')
  assert.equal(token, 'tok123')
})

test('readHaEnv kastar om något saknas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ha-env-'))
  const p = join(dir, 'ha.env')
  writeFileSync(p, 'HA_URL=http://x\n')
  assert.throws(() => readHaEnv(p))
})

test('publishViaHa postar varje meddelande till mqtt.publish', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200 }
  }
  const n = await publishViaHa(
    [
      { topic: 'infomentor/anna/skoldag', payload: '08:00–11:00', retain: true },
      { topic: 'infomentor/lunch', payload: 'Torsk', retain: true },
    ],
    { url: 'http://ha:8123', token: 't', fetchImpl, delayMs: 0 }
  )
  assert.equal(n, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://ha:8123/api/services/mqtt/publish')
  assert.equal(calls[0].body.topic, 'infomentor/anna/skoldag')
  assert.equal(calls[0].body.retain, true)
})

test('publishViaHa kastar vid felstatus', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' })
  await assert.rejects(
    () => publishViaHa([{ topic: 'x', payload: 'y' }], { url: 'http://ha', token: 't', fetchImpl, delayMs: 0 }),
    /403/
  )
})

test('messagesHash är stabil och känslig för innehåll', () => {
  const a = [{ topic: 't', payload: '1' }]
  const b = [{ topic: 't', payload: '2' }]
  assert.equal(messagesHash(a), messagesHash([...a]))
  assert.notEqual(messagesHash(a), messagesHash(b))
})
