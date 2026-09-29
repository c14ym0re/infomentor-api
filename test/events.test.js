import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  itemsFromSnapshot,
  indexByKey,
  detectChanges,
  summarize,
  dedupePlanNotifications,
  dropEnrichmentChanges,
  seedNewKinds,
} from '../src/events.js'

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

test('borttagen kalenderpost i det förflutna ignoreras (rullande fönster)', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ events: [] })
  // kalenderposten startar 2026-09-30; med "idag" 2026-10-01 har den bara
  // lämnat fönstret och ska INTE rapporteras som borttagen
  assert.equal(detectChanges(prev, itemsFromSnapshot(next), { today: '2026-10-01' }).length, 0)
  // framtida borttagning rapporteras däremot
  const future = detectChanges(prev, itemsFromSnapshot(next), { today: '2026-09-29' })
  assert.equal(future.length, 1)
  assert.equal(future[0].type, 'calendar.removed')
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

const plan = (over = {}) => ({
  key: 'A|plan|1',
  child: 'A',
  id: '1',
  title: 'Spanska 1C',
  subjects: ['Spanska'],
  state: 'active',
  description: 'att ställa frågor',
  url: '/#/uolv2/show/1',
  start: '2026-08-18',
  end: '2026-12-18',
  teachers: ['Erika'],
  fields: { Tidplan: 'V.40' },
  fetchedAt: 1,
  ...over,
})

test('ny planering blir plan.new (immediate) med beskrivning', () => {
  const prev = indexByKey(itemsFromSnapshot(snap()))
  const next = snap({ plans: [plan()] })
  const events = detectChanges(prev, itemsFromSnapshot(next))
  const ev = events.find((e) => e.type === 'plan.new')
  assert.equal(ev.priority, 'immediate')
  assert.equal(ev.description, 'att ställa frågor')
  assert.deepEqual(ev.subjects, ['Spanska'])
})

test('avslutad planering blir plan.changed (immediate)', () => {
  const prev = indexByKey(itemsFromSnapshot(snap({ plans: [plan()] })))
  const next = itemsFromSnapshot(snap({ plans: [plan({ state: 'finished' })] }))
  const events = detectChanges(prev, next)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'plan.changed')
  assert.equal(events[0].priority, 'immediate')
})

test('ändrat startdatum eller lärare fångas', () => {
  const prev = indexByKey(itemsFromSnapshot(snap({ plans: [plan({ start: '2026-08-18', teachers: ['Erika'] })] })))
  const next = itemsFromSnapshot(
    snap({ plans: [plan({ start: '2026-09-01', teachers: ['Erika', 'Mathilda'] })] })
  )
  const ev = detectChanges(prev, next).find((e) => e.type === 'plan.changed')
  assert.deepEqual(
    ev.changes.map((c) => c.field).sort(),
    ['start', 'teachers']
  )
})

test('första detaljhämtningen är ingen ändring', () => {
  // Posten saknar detalj (fetchedAt null) och får period/lärare/fält nästa tick.
  const bare = { start: undefined, end: undefined, teachers: undefined, fields: undefined, fetchedAt: undefined }
  const prev = indexByKey(itemsFromSnapshot(snap({ plans: [plan(bare)] })))
  const enriched = itemsFromSnapshot(snap({ plans: [plan()] }))
  const events = detectChanges(prev, enriched)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'plan.changed')
  // …men den filtreras bort: föregående post hade aldrig någon detalj.
  assert.deepEqual(dropEnrichmentChanges(events, prev), [])
  // När detaljen väl är känd behålls ändringar.
  const known = indexByKey(enriched)
  const changed = itemsFromSnapshot(snap({ plans: [plan({ start: '2026-09-01' })] }))
  assert.equal(dropEnrichmentChanges(detectChanges(known, changed), known).length, 1)
})

test('planeringsnotisen tas bort när plan.new finns i samma omgång', () => {
  const notif = { type: 'notification.new', id: '9', url: '#/uolv2/show/8615622' }
  const other = { type: 'notification.new', id: '8', url: '/#/communication/news/1' }
  const ny = { type: 'plan.new', id: '8615622' }
  assert.deepEqual(dedupePlanNotifications([notif, other, ny]).map((e) => e.id), ['8', '8615622'])
  // utan plan.new behålls notisen (då finns ingen beskrivning att visa)
  assert.deepEqual(dedupePlanNotifications([notif]), [notif])
})

test('seedNewKinds ger en ny posttyp en baslinje', () => {
  const items = [{ kind: 'plan' }, { kind: 'task' }]
  const events = [
    { kind: 'plan', type: 'plan.new' },
    { kind: 'task', type: 'task.new' },
  ]
  const first = seedNewKinds(events, items, new Set(['task']))
  assert.deepEqual(first.events.map((e) => e.type), ['task.new'])
  assert.deepEqual([...first.seeded].sort(), ['plan', 'task'])
  // andra körningen är typen känd — inget filtreras längre
  assert.equal(seedNewKinds(events, items, first.seeded).events.length, 2)
})
