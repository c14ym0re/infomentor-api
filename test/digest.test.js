import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDigest,
  countBits,
  dedupeIdenticalPlans,
  formatEventLines,
  NEWS_LINES_MAX,
  planTopic,
} from '../src/digest.js'

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

test('planTopic kortar till arbetsområdet', () => {
  assert.equal(
    planTopic('Teknik - Årskurs 9 - Hur utvecklar vi ny teknik?', 'Teknik'),
    'Hur utvecklar vi ny teknik?'
  )
  assert.equal(
    planTopic('ÅK 9 - Samhällskunskap - Globala frågor / Konflikter och hotbilder', 'Samhällskunskap'),
    'Globala frågor / Konflikter och hotbilder'
  )
  assert.equal(planTopic('7D - IDH - Friluftsliv', 'Idrott och hälsa'), 'Friluftsliv')
})

test('planTopic är tom när titeln bara upprepar ämnet', () => {
  assert.equal(planTopic('7BD - Samhällskunskap HT26', 'Samhällskunskap'), '')
  assert.equal(planTopic('7B och 7D Biologi', 'Biologi'), '')
  assert.equal(planTopic('Släktträd läxa - Mentorstid', 'Mentor'), '')
  assert.equal(planTopic('', 'Teknik'), '')
  assert.equal(planTopic('Kemi', 'Kemi'), '')
})

test('planTopic kapar en lång titel snyggt', () => {
  const topic = planTopic('X - X - ' + 'ord '.repeat(20).trim(), 'X')
  assert.ok(topic.length <= 47)
  assert.ok(topic.endsWith('…'))
})

test('uppgiftsraden i rapporten visar ämnet och arbetsområdet', () => {
  const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)
  const snapshot = {
    collectedAt: new Date().toISOString(),
    pupils: [{ name: 'Anna' }],
    events: [],
    absences: [],
    tasks: [
      {
        key: 'Anna|task|1',
        child: 'Anna',
        title: 'Loggbok v.36',
        subject: 'Teknik',
        due: soon,
        status: 'active',
        plan: 'Teknik - Årskurs 9 - Hur utvecklar vi ny teknik?',
      },
      {
        key: 'Anna|task|2',
        child: 'Anna',
        title: 'Glosor',
        subject: 'Samhällskunskap',
        due: soon,
        status: 'active',
        plan: '7BD - Samhällskunskap HT26', // bara ämnet → inget arbetsområde
      },
    ],
  }
  const out = buildDigest(snapshot, { events: [] })
  assert.ok(out.includes('Loggbok v.36 (Teknik) — Hur utvecklar vi ny teknik?'))
  assert.ok(out.includes('Glosor (Samhällskunskap)'))
  assert.ok(!out.includes('Glosor (Samhällskunskap) —'))
})

test('nya nyheter listas (nyast först) och räknas i rubriken', () => {
  const events = [
    { type: 'news.new', title: 'Fotografering', published: '2026-09-29' },
    { type: 'news.new', title: 'Veckobrev åk 6 v. 41', published: '2026-10-06' },
  ]
  assert.ok(countBits(events).includes('2 nyhet(er)'))
  const lines = formatEventLines(events)
  assert.match(lines[0], /NYHET: Veckobrev åk 6 v\. 41/)
  assert.match(lines[1], /NYHET: Fotografering/)
})

test('fler nyheter än taket sammanfattas i en rad', () => {
  const events = Array.from({ length: NEWS_LINES_MAX + 2 }, (_, i) => ({
    type: 'news.new',
    title: `Nyhet ${i}`,
    published: `2026-09-${String(10 + i).padStart(2, '0')}`,
  }))
  const lines = formatEventLines(events)
  assert.equal(lines.length, NEWS_LINES_MAX + 1)
  assert.match(lines.at(-1), /…och 2 äldre nyhet\(er\)/)
})

test('notisens appnamn visas med svensk etikett', () => {
  const lines = formatEventLines([
    { type: 'notification.new', appType: 'CalendarV2', title: 'Ny kalenderhändelse', child: 'Anna', date: '2026-09-29' },
    { type: 'notification.new', appType: 'Uol', title: 'Ny planering', child: 'Anna', date: '2026-09-29' },
    { type: 'notification.new', appType: 'Okänd', title: 'Något', child: 'Anna', date: '2026-09-29' },
  ])
  assert.match(lines[0], /^• \[Kalender\]/)
  assert.match(lines[1], /^• \[Planering\]/)
  assert.match(lines[2], /^• \[Okänd\]/)
})
