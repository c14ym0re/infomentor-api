import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeIdenticalPlans, formatEventLines } from '../src/digest.js'

const planEvent = (over = {}) => ({
  type: 'plan.new',
  kind: 'plan',
  key: 'Anna|plan|1',
  child: 'Anna',
  id: '1',
  title: 'Spanska_En la cafetería Unidad 1C',
  subjects: ['Spanska'],
  state: 'active',
  start: '2026-09-28',
  end: '2026-10-11',
  teachers: ['Diana Morales'],
  ...over,
})

test('identiska planeringar visas en gång (läraren kan publicera två)', () => {
  const events = [
    planEvent({ id: '8615622', key: 'Anna|plan|8615622' }),
    planEvent({ id: '8615621', key: 'Anna|plan|8615621' }),
  ]
  assert.equal(dedupeIdenticalPlans(events).length, 1)
  const lines = formatEventLines(events)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /NY PLANERING: Spanska_En la cafetería Unidad 1C/)
})

test('olika period, lärare eller barn är olika planeringar', () => {
  const events = [
    planEvent({ id: '1', key: 'A|plan|1' }),
    planEvent({ id: '2', key: 'A|plan|2', start: '2026-10-05' }),
    planEvent({ id: '3', key: 'A|plan|3', teachers: ['Någon Annan'] }),
    planEvent({ id: '4', key: 'B|plan|4', child: 'Bo' }),
  ]
  assert.equal(dedupeIdenticalPlans(events).length, 4)
})

test('andra händelsetyper rörs inte av dubblettfiltreringen', () => {
  const events = [
    { type: 'task.new', title: 'Prov' },
    { type: 'task.new', title: 'Prov' },
    { type: 'plan.changed', child: 'Anna', title: 'Samma', id: '9' },
    { type: 'plan.changed', child: 'Anna', title: 'Samma', id: '10' },
  ]
  assert.equal(dedupeIdenticalPlans(events).length, 3)
})
