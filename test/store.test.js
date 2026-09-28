import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { itemsFromSnapshot, indexByKey, detectChanges } from '../src/events.js'

const snap = () => ({
  notifications: [{ id: 1, child: 'A', title: 'Nyhet', date: '2026-09-28' }],
  tasks: [{ key: 'A|task|10', child: 'A', id: '10', title: 'Loggbok', due: '2026-10-02', status: 'Due' }],
  events: [{ key: 'A|cal|5', child: 'A', kind: 'Kalender', id: '5', title: 'Prov', start: '2026-09-30' }],
  absences: [{ child: 'A', absentToday: false, pendingLeaveRequests: 0 }],
  news: [],
})

function fresh() {
  return new Store(':memory:')
}

test('applyItems + getPrevIndex ger samma poster tillbaka', () => {
  const s = fresh()
  const items = itemsFromSnapshot(snap())
  const { inserted } = s.applyItems(items, '2026-09-28T18:00:00Z')
  assert.equal(inserted, items.length)
  const prev = s.getPrevIndex()
  assert.deepEqual([...prev.keys()].sort(), items.map((i) => i.key).sort())
  assert.equal(prev.get('A|task|10').title, 'Loggbok')
  s.close()
})

test('andra körningen upptäcker bara det nya', () => {
  const s = fresh()
  const first = itemsFromSnapshot(snap())
  s.applyItems(first, '2026-09-28T18:00:00Z')

  const second = snap()
  second.tasks[0].due = '2026-10-09'
  second.events.push({ key: 'A|cal|6', child: 'A', kind: 'Kalender', id: '6', title: 'Ny', start: '2026-10-01' })
  const events = detectChanges(s.getPrevIndex(), itemsFromSnapshot(second))

  assert.equal(events.length, 2)
  assert.deepEqual(events.map((e) => e.type).sort(), ['calendar.new', 'task.changed'])
  s.close()
})

test('pruneMissing tar bort poster som försvunnit', () => {
  const s = fresh()
  const items = itemsFromSnapshot(snap())
  s.applyItems(items, '2026-09-28T18:00:00Z')
  const removed = s.pruneMissing([items[0].key])
  assert.equal(removed, items.length - 1)
  assert.equal(s.getPrevIndex().size, 1)
  s.close()
})

test('events loggas, listas och markeras levererade', () => {
  const s = fresh()
  const events = detectChanges(indexByKey([]), itemsFromSnapshot(snap()))
  const ids = s.logEvents(events, '2026-09-28T18:00:00Z')
  assert.equal(ids.length, events.length)

  const pend = s.pendingEvents()
  assert.equal(pend.length, events.length)
  const imm = s.pendingEvents({ priority: 'immediate' })
  assert.ok(imm.length >= 1)
  assert.ok(imm.every((e) => e.priority === 'immediate'))

  s.markDelivered([ids[0]], '2026-09-28T18:01:00Z')
  assert.equal(s.pendingEvents().length, events.length - 1)
  s.close()
})

test('sök och historik per barn', () => {
  const s = fresh()
  const events = detectChanges(indexByKey([]), itemsFromSnapshot(snap()))
  s.logEvents(events, '2026-09-30T18:00:00Z')
  assert.equal(s.search('Prov').length, 1)
  assert.equal(s.historyForChild('A', '2026-09-01', '2026-10-01').length, events.length)
  assert.equal(s.historyForChild('B', '2026-09-01', '2026-10-01').length, 0)
  s.close()
})

test('meta kan sättas och läsas', () => {
  const s = fresh()
  assert.equal(s.getMeta('lastPoll'), null)
  s.setMeta('lastPoll', '2026-09-28T18:00:00Z')
  assert.equal(s.getMeta('lastPoll'), '2026-09-28T18:00:00Z')
  s.close()
})
