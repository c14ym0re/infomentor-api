import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemsFromSnapshot, indexByKey, detectChanges, summarize } from '../src/events.js'

const snap = (over = {}) => ({
  notifications: [{ id: 1, child: 'A', title: 'Nyhet', subTitle: 'x', date: '2026-09-28', appType: 'News' }],
  tasks: [{ key: 'A|task|10', child: 'A', id: '10', title: 'Loggbok', subject: 'Teknik', due: '2026-10-02', status: 'Due' }],
  events: [{ key: 'A|cal|5', child: 'A', kind: 'Kalender', id: '5', title: 'Prov', start: '2026-09-30', end: '2026-09-30' }],
  absences: [{ child: 'A', absentToday: false, absentTomorrow: false, pendingLeaveRequests: 0, absentSessionsToday: [] }],
  news: [{ id: 9, title: 'Info', published: '2026-09-27' }],
  ...over,
})

test('itemsFromSnapshot ger stabila nycklar per typ', () => {
  const items = itemsFromSnapshot(snap())
  const keys = items.map((i) => i.key).sort()
  assert.deepEqual(keys, [
    'A|cal|5',
    'A|task|10',
    'absence|A',
    'news|9',
    'notification|1',
  ])
})

test('första körningen: allt är nytt', () => {
  const events = detectChanges(indexByKey([]), itemsFromSnapshot(snap()))
  const types = events.map((e) => e.type).sort()
  assert.deepEqual(types, ['absence.new', 'calendar.new', 'news.new', 'notification.new', 'task.new'])
})

test('oförändrat läge ger inga händelser', () => {
  const items = itemsFromSnapshot(snap())
  const events = detectChanges(indexByKey(items), items)
  assert.equal(events.length, 0)
})

test('ny uppgift är "immediate", ny kalenderpost är "digest"', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ tasks: [...snap().tasks, { key: 'A|task|11', child: 'A', id: '11', title: 'Prov', subject: 'Kemi', due: '2026-10-05', status: 'Due' }] })
  const events = detectChanges(prev, itemsFromSnapshot(next))
  const ny = events.find((e) => e.type === 'task.new')
  assert.equal(ny.priority, 'immediate')
  const calPrev = indexByKey([])
  const cal = detectChanges(calPrev, itemsFromSnapshot(snap())).find((e) => e.type === 'calendar.new')
  assert.equal(cal.priority, 'digest')
})

test('ändrat förfallodatum fångas och är "immediate"', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ tasks: [{ ...snap().tasks[0], due: '2026-10-09' }] })
  const events = detectChanges(prev, itemsFromSnapshot(next))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'task.changed')
  assert.equal(events[0].priority, 'immediate')
  assert.deepEqual(events[0].changes[0], { field: 'due', from: '2026-10-02', to: '2026-10-09' })
})

test('avklarad uppgift blir task.done (digest)', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ tasks: [{ ...snap().tasks[0], status: 'Done' }] })
  const events = detectChanges(prev, itemsFromSnapshot(next))
  assert.equal(events[0].type, 'task.done')
  assert.equal(events[0].priority, 'digest')
})

test('borttagen kalenderpost rapporteras, schema ignoreras', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ events: [] })
  const events = detectChanges(prev, itemsFromSnapshot(next))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'calendar.removed')
  assert.equal(events[0].priority, 'immediate')
})

test('registrerad frånvaro blir immediate', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ absences: [{ child: 'A', absentToday: true, absentTomorrow: false, pendingLeaveRequests: 0, absentSessionsToday: ['Ma 10:00'] }] })
  const events = detectChanges(prev, itemsFromSnapshot(next))
  assert.equal(events[0].type, 'absence.registered')
  assert.equal(events[0].priority, 'immediate')
})

test('summarize grupperar per barn', () => {
  const items = itemsFromSnapshot({
    notifications: [],
    events: [],
    absences: [],
    news: [],
    tasks: [
      { key: 'A|task|1', child: 'A', id: '1', title: 'x', status: 'Due' },
      { key: 'B|task|2', child: 'B', id: '2', title: 'y', status: 'Due' },
    ],
  })
  const groups = summarize(detectChanges(indexByKey([]), items))
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.child).sort(), ['A', 'B'])
})
