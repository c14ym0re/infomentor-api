import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePlans,
  normalizePlanTasks,
  planInfo,
  planChanges,
  parseTeachers,
  planFieldKey,
  formatPeriod,
  stripHtml,
} from '../src/plans.js'

test('normalizePlans mappar ämnes-id:n till namn', () => {
  const plans = normalizePlans({
    uols: [{ id: 1, title: ' Spanska 1C ', subjects: [10, 99], state: 'active' }],
    subjects: [
      { id: 10, name: 'Spanska' },
      { id: 20, name: 'Bild' },
    ],
  })
  assert.deepEqual(plans, [
    { id: '1', title: 'Spanska 1C', subjects: ['Spanska'], state: 'active' },
  ])
})

test('normalizePlans tål tomt och ofullständigt svar', () => {
  assert.deepEqual(normalizePlans(), [])
  assert.deepEqual(normalizePlans({}), [])
  assert.deepEqual(normalizePlans({ uols: [{ id: 2 }] })[0], {
    id: '2',
    title: '',
    subjects: [],
    state: '',
  })
})

test('stripHtml gör HTML till läsbar text', () => {
  assert.equal(stripHtml('<p>Hej&nbsp;<b>7D</b>!</p>\n<p>Vi ses</p>'), 'Hej 7D! Vi ses')
  assert.equal(stripHtml(null), '')
})

const DETAIL = {
  sections: [
    {
      type: 'uol',
      overview: [
        { label: 'Beskrivning', value: '<p>Vi lär oss om <b>bråk</b>.</p>' },
        { label: 'Ämne', value: 'Matematik' },
        { label: 'Termin', value: 'HT26' },
        { label: 'Startdatum', value: '2026-08-18' },
        { label: 'Slutdatum', value: '2026-12-18' },
        { label: 'Årskurs', value: '9' },
        { label: 'Lärare', value: 'Kvarnbrink,   Erika,Gomez Fraga,  Angeles' },
      ],
    },
    {
      type: 'syllabus',
      sections: [
        {
          title: 'Pedagogisk planering LÅ26-27',
          fields: [
            { label: 'Tidplan:', value: '<p>V.40 Bråk</p>' },
            { label: 'Bedömning - Du visar dina kunskaper så här:', value: '<p>Prov v. 42</p>' },
            { label: 'Tomt fält', value: '' },
          ],
        },
      ],
    },
    { type: 'statement', matrixTypes: [] },
  ],
}

test('parseTeachers parar ihop "Efternamn, Förnamn"', () => {
  assert.deepEqual(parseTeachers('Kvarnbrink,   Erika'), ['Erika Kvarnbrink'])
  assert.deepEqual(parseTeachers('Kvarnbrink, Erika,Gomez Fraga, Angeles'), [
    'Erika Kvarnbrink',
    'Angeles Gomez Fraga',
  ])
  assert.deepEqual(parseTeachers(''), [])
})

test('planFieldKey kortar skolans etiketter', () => {
  assert.equal(planFieldKey('Tidplan:'), 'Tidplan')
  assert.equal(planFieldKey('Kunskapsmål - När vi är klara …'), 'Kunskapsmål')
  assert.equal(planFieldKey(''), '')
})

test('planInfo plockar ut period, lärare, fält och beskrivning', () => {
  const info = planInfo(DETAIL)
  assert.equal(info.start, '2026-08-18')
  assert.equal(info.end, '2026-12-18')
  assert.equal(info.term, 'HT26')
  assert.equal(info.grade, '9')
  assert.deepEqual(info.teachers, ['Erika Kvarnbrink', 'Angeles Gomez Fraga'])
  assert.equal(info.description, 'Vi lär oss om bråk.')
  assert.deepEqual(info.fields, { Tidplan: 'V.40 Bråk', Bedömning: 'Prov v. 42' })
})

test('planInfo faller tillbaka på Översikt när Beskrivning saknas', () => {
  const info = planInfo({
    sections: [
      { type: 'uol', overview: [{ label: 'Termin', value: 'VT27' }] },
      { type: 'syllabus', sections: [{ fields: [{ label: 'Översikt - Vi lär oss:', value: '<p>allt</p>' }] }] },
    ],
  })
  assert.equal(info.description, 'allt')
  assert.equal(info.start, '')
})

test('planInfo tål tomt svar', () => {
  assert.deepEqual(planInfo(), {
    term: '',
    start: '',
    end: '',
    grade: '',
    teachers: [],
    fields: {},
    description: '',
  })
})

test('normalizePlanTasks trimmar, sorterar och tar med delmål', () => {
  const tasks = normalizePlanTasks({
    hasMore: false,
    tasks: [
      { id: 3, title: ' Loggbok v.37 ', dueDate: '2026-09-11T00:00:00', status: 'active', milestoneCount: 0 },
      {
        id: 1,
        title: 'Prov: Samhällsekonomi',
        dueDate: '2026-10-23',
        status: 'active',
        milestoneCount: 3,
        milestonesComplete: 2,
      },
      { id: 2, title: 'Utan datum', dueDate: null, status: 'done' },
    ],
  })
  assert.deepEqual(
    tasks.map((t) => t.id),
    ['3', '1', '2'] // sorterat på förfallodatum, utan datum sist
  )
  assert.deepEqual(tasks[0], {
    id: '3',
    title: 'Loggbok v.37',
    due: '2026-09-11',
    status: 'active',
  })
  assert.equal(tasks[1].milestones, '2/3')
  assert.equal(tasks[2].milestones, undefined)
})

test('normalizePlanTasks tål tomt svar', () => {
  assert.deepEqual(normalizePlanTasks(), [])
  assert.deepEqual(normalizePlanTasks({ tasks: null }), [])
})

test('planChanges hittar ändrade fält, lärare och planeringsdelar', () => {
  const prev = planInfo(DETAIL)
  const next = planInfo({
    sections: [
      { type: 'uol', overview: [...DETAIL.sections[0].overview.filter((r) => r.label !== 'Lärare'), { label: 'Lärare', value: 'Wickman, Mathilda' }] },
      {
        type: 'syllabus',
        sections: [
          {
            fields: [
              { label: 'Tidplan:', value: '<p>V.40 Bråk, V.41 Procent</p>' },
              { label: 'Arbetssätt - Så jobbar vi:', value: '<p>Grupparbete</p>' },
            ],
          },
        ],
      },
    ],
  })
  const changes = planChanges(prev, next)
  const labels = changes.map((c) => c.label).sort()
  assert.deepEqual(labels, ['Arbetssätt', 'Bedömning', 'Lärare', 'Tidplan'])
  assert.equal(changes.find((c) => c.label === 'Lärare').to, 'Mathilda Wickman')
  assert.equal(changes.find((c) => c.label === 'Tidplan').to, 'V.40 Bråk, V.41 Procent')
})

test('planChanges ger inget när inget ändrats', () => {
  const info = planInfo(DETAIL)
  assert.deepEqual(planChanges(info, { ...info }), [])
})

test('formatPeriod gör kort svensk period', () => {
  assert.equal(formatPeriod('2026-08-18', '2026-12-18'), '18/8–18/12')
  assert.equal(formatPeriod('2026-08-18', '2026-08-18'), '18/8')
  assert.equal(formatPeriod('', ''), '')
})
