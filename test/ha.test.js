import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEntities, discoveryMessages, stateMessages, slug } from '../src/ha.js'

const snapshot = {
  collectedAt: '2026-09-28T18:00:00.000Z',
  pupils: [{ id: '1', name: 'Efternamn, Anna' }],
  events: [
    { key: 'k1', child: 'Efternamn, Anna', kind: 'Schema', title: 'Ma', start: '2026-09-29T08:00:00', end: '2026-09-29T08:50:00' },
    { key: 'k2', child: 'Efternamn, Anna', kind: 'Schema', title: 'Idh', start: '2026-09-29T10:00:00', end: '2026-09-29T11:00:00' },
    { key: 'c1', child: 'Efternamn, Anna', kind: 'Kalender', title: 'Prov', start: '2026-10-02T00:00:00', end: '2026-10-02T00:00:00' },
  ],
  tasks: [{ key: 't1', child: 'Efternamn, Anna', title: 'Loggbok', due: '2026-10-02', status: 'Due' }],
  absences: [],
  notifications: [],
  news: [],
  lunch: { school: 'Testskolan', calendar: { '2026-09-29': [{ label: 'Dagens rätt', dish: 'Torsk' }] } },
}

test('slug gör om namn till ascii-id', () => {
  assert.equal(slug('Efternamn, Anna'), 'efternamn_anna')
  assert.equal(slug('Åsa Öberg'), 'asa_oberg')
})

test('buildEntities ger skoldag, uppgifter, nästa händelse, idrott och lunch', () => {
  const { entities } = buildEntities(snapshot)
  const ids = entities.map((e) => e.id).sort()
  const base = 'infomentor_anna_efternamn'
  assert.deepEqual(ids, [
    'infomentor_lunch',
    `${base}_idrott`,
    `${base}_nasta_handelse`,
    `${base}_skoldag`,
    `${base}_uppgifter`,
  ].sort())
  const skoldag = entities.find((e) => e.id.endsWith('_skoldag'))
  assert.equal(skoldag.value, '08:00–11:00')
  const uppg = entities.find((e) => e.id.endsWith('_uppgifter'))
  assert.equal(uppg.value, 1)
  const idrott = entities.find((e) => e.id.endsWith('_idrott'))
  assert.equal(idrott.value, 'ON')
  assert.equal(idrott.type, 'binary_sensor')
  const lunch = entities.find((e) => e.id === 'infomentor_lunch')
  assert.equal(lunch.value, 'Torsk')
})

test('discovery-meddelanden är retained och pekar rätt', () => {
  const msgs = discoveryMessages(snapshot)
  assert.ok(msgs.length > 0)
  assert.ok(msgs.every((m) => m.retain === true))
  const idrott = msgs.find((m) => m.topic.includes('binary_sensor/infomentor_anna_efternamn_idrott/config'))
  assert.ok(idrott, 'hittar idrotts-discovery')
  const payload = JSON.parse(idrott.payload)
  assert.equal(payload.state_topic, 'infomentor/anna_efternamn/idrott')
  assert.equal(payload.payload_on, 'ON')
  assert.equal(payload.device.identifiers[0], 'infomentor')
})

test('state-meddelanden innehåller värde och attribut', () => {
  const msgs = stateMessages(snapshot)
  const val = msgs.find((m) => m.topic === 'infomentor/anna_efternamn/skoldag')
  assert.equal(val.payload, '08:00–11:00')
  const attr = msgs.find((m) => m.topic === 'infomentor/lunch/attributes')
  assert.equal(JSON.parse(attr.payload).skola, 'Testskolan')
})
