# infomentor-api

Unofficial, dependency-free toolkit for reading **InfoMentor** (the Swedish
school platform, "Mentor" / "InfoMentor Hub") with a regular **email/password**
account — and turning it into a **family dashboard and notification engine**:
Home Assistant sensors, event-driven alerts, a searchable history, and an
evening report delivered by email.

> ⚠️ **Not affiliated with InfoMentor.** For personal use with your own account.
> The endpoints are undocumented and can change without warning. Use at your own
> risk and respect the service's terms of use.

## Features

- **Login** with an email/password **Mentor account** (no BankID), following the
  OAuth hand-off into a `hub.infomentor.se` session.
- **Read** notifications, news, calendar, timetable, assignments, attendance and
  **plans** (Unit of Learning) for every child on the account.
- **Plans** carry period, teachers and the **assignments linked to the plan**
  (`GetAllTasks`) — and when a plan is *edited* the alert says what changed.
- **School lunch** from Mateo (optional).
- **Event engine** — compares each poll with the stored state and classifies
  what is new / changed / removed, with an *immediate* vs *digest* priority.
- **Poller** (`watch.js`) with quiet hours and backoff, run as cheap cron ticks.
- **Home Assistant** sensors via **MQTT Discovery** — no broker credentials
  needed (published through HA's `mqtt.publish`).
- **History** in SQLite (append-only event log) with search and per-child views.
- **Evening report** by email — accessible HTML + plain text, with the same
  change list ("what is new since last time") in both halves. School **news** is
  listed too; anything published more than 30 days ago counts as backfill and
  never alerts.
- **Ops** — a weekly **health check** (archive age, log warnings, InfoMentor
  entries in the HA log) and an **issue/fork watch** for your GitHub repos.
- **Home Assistant tooling** — install a Lovelace **dashboard** from a JSON file
  over HA's WebSocket API, and set the integration's **options** over REST.
- **Zero npm dependencies** — Node 18+ built-in `fetch`, `node:sqlite`,
  `node:test`; email via Python's stdlib `smtplib`. Includes a hand-written
  MQTT 3.1.1 client.

## Requirements

- **Node 18+** (tested on Node 22) — nothing to `npm install`.
- **Python 3** — only to send email.

## Quickstart

```bash
git clone https://github.com/c14ym0re/infomentor-api.git
cd infomentor-api

cp credentials.json.example credentials.json   # your InfoMentor email + password
npm run flow        # sanity check: where an unauthenticated client lands
npm run login       # verifies the login and creates a hub session
npm run probe       # dumps every endpoint it can find into out/

npm run collect     # collect + diff + write out/digest.txt
npm run report      # render out/kvallsammanfattning.html
npm run mail:test   # dry-run of the email
```

## Configuration

All local config lives next to the code and is **gitignored**. Only the
`.example` files are committed.

| File | Purpose |
|---|---|
| `credentials.json` | InfoMentor email + password |
| `names.json` | optional — map hub names to nicknames |
| `lunch.json` | optional — school-lunch unit (Mateo) |
| `smtp.json` | SMTP account for sending email |
| `config.json` | optional — poller settings (see below) |
| `dashboard.json` | optional — a Lovelace view for `npm run dashboard` |

```jsonc
// credentials.json
{ "username": "you@example.com", "password": "…" }

// names.json — hub name ("Lastname, Firstname") → display name
{ "Lastname, Firstname": "Nickname" }

// lunch.json — from https://meny.mateo.se/<municipality>/<unitId>
{ "provider": "mateo", "unitId": "123", "school": "Your school" }

// config.json — poller (defaults shown)
{
  "pollMinutes": 20,
  "digestAt": "18:00",
  "quietHours": { "from": "20:30", "to": "06:30" },
  "adminEmail": "you@example.com",
  // turn this OFF if you use the HACS integration instead (recommended)
  "mqtt": { "enabled": true, "discoveryPrefix": "homeassistant" },
  "ha": {
    "envFile": "~/.config/infomentor/ha.env",
    "dashboardFile": "dashboard.json"
  },
  "github": {
    "repos": ["your-user/infomentor-api"],
    "credentialsFile": "~/.config/infomentor/git-credentials"
  },
  "integrationOptions": {
    "scan_interval": 20,
    "enable_lunch": true,
    "mateo_unit_id": "123",
    "names": "Lastname, Firstname = Nickname"
  }
}
```

Paths may start with `~`. Environment overrides: `HA_ENV_FILE`,
`DASHBOARD_FILE`, `GITHUB_TOKEN` / `GITHUB_CREDENTIALS`, `INFOMENTOR_DB` and
`MAIL_DRY_RUN=1` (dry-run the email).

SMTP needs an **app password**, not your account password (Gmail/Workspace:
<https://myaccount.google.com/apppasswords>, requires 2-Step Verification).

## Running

### Poller

```bash
npm run watch:once        # one tick (for cron)
npm run digest            # force an evening report now
npm run preview           # email the report as it looks now, but leave the
                          # archive untouched (the events stay for the real run)
npm run watch             # long-running loop every pollMinutes
node src/watch.js --once --dry   # test tick: no email/MQTT
```

Each tick collects, updates the archive, publishes HA sensors, and then:

- sends **immediate alerts** (new/changed assignment, changed/removed calendar
  entry, registered absence) — unless it's within **quiet hours**;
- sends the **evening report** once the clock passes `digestAt`, with everything
  collected since the last one.

Delivered events are marked in the archive, so nothing is sent twice.

### Schedule it (cron)

```
# poll — offset so it doesn't collide with the HA integration's own interval
5,35 * * * * /path/to/infomentor-api/run-watch.sh
# issue/fork watch, twice a day
10 8,20 * * * /path/to/infomentor-api/run-issuewatch.sh
# weekly health check
0 8 * * 1    /path/to/infomentor-api/run-health.sh
```

Ticks instead of a daemon: simple, survives reboots, and all state lives in
SQLite. The `run-*.sh` wrappers log to `out/`.

### History

```bash
npm run history -- status
npm run history -- search "Test"
npm run history -- child "Lastname, Firstname" 2026-09-01 2026-10-01
```

### Home Assistant dashboard

```bash
npm run dashboard               # push dashboard.json as the view /skol-panel
npm run dashboard -- --dry      # just report what would be written
DASHBOARD_FILE=my.json npm run dashboard
```

The view is written through HA's **WebSocket API** (the same path the UI uses),
so `.storage` is never hand-edited. Ready-made example dashboards live in the
integration repo:
[`examples/`](https://github.com/c14ym0re/infomentor-homeassistant/tree/main/examples).

### Integration options over the API

```bash
node src/set-options.js         # applies config.integrationOptions
```

### Health check and issue/fork watch

```bash
npm run health                  # print the weekly report
npm run health:mail             # mail it to config.adminEmail
npm run issues                  # diff since the last run, mail on new activity
                                # (the first run only sets a baseline)
npm run issues:report           # mail the current state
```

The health check looks at the archive age (vs `pollMinutes`), warnings in
`out/watch.log`, and InfoMentor warnings/errors in the HA log — read with
`ssh root@<ha-host> ha core logs`, and skipped with a note if SSH isn't set up.
The issue watch tracks new issues, comments and **forks** in
`config.github.repos`.

## How it works

```
src/infomentor.js   cookie jar, login(), hubPost()
src/gather.js       collect everything → snapshot
src/events.js       change detection (pure, testable)
src/store.js        SQLite: current items + append-only event log
src/digest.js       the evening summary as text
src/plans.js        plans and their linked assignments (pure)
src/watch.js        poller: tick, quiet hours, alerts, digest
src/report.js       renders accessible HTML report
src/send_mail.py    sends email via SMTP (digest + alerts)
src/ha.js           Home Assistant MQTT Discovery payloads
src/ha-api.js       publish via HA's mqtt.publish
src/mqtt.js         hand-written MQTT 3.1.1 client (QoS 0/1, reconnect)
src/history.js      history CLI
src/lunch.js        school lunch from Mateo
src/names.js        nickname mapping
src/healthcheck.js  weekly health report
src/issuewatch.js   GitHub issue/comment/fork watch
src/install-dashboard.js  push a Lovelace view via HA's WebSocket API
src/set-options.js  set the integration's options via HA's REST API
test/               unit tests (node:test)
```

### Login flow

```
GET  hub.infomentor.se                     → 302 → login page (oauth_token)
POST oauth_token        → mentor/          → login form (__VIEWSTATE)
POST username/password  + viewstate        → 302
POST oauth_token        → mentor/          → back to hub
POST …/isauthenticated                    → session established
```

The session lives in cookies (`ASP.NET_SessionId`, `BIGipServer~…`, `IMHome`).
Every run logs in again, so a dead session is never a problem.

Municipalities differ: some use BankID/SSO (`sso.infomentor.se/login.ashx?idp=…`),
others the email/password Mentor account used here. Which one works depends on
your school. If you use SSO, the same end state (hub cookies) is what you need.

## Discovered endpoints

All are `POST` to `https://hub.infomentor.se` with a JSON body (often `{}`),
after the session above.

| Area | Endpoint |
|---|---|
| Pupil list | parsed from the hub start page (`IMHome.pupils`) |
| Pupil switch | `GET /Account/PupilSwitcher/SwitchPupil/<id>` |
| Notifications | `/NotificationApp/NotificationApp/GetNotifications` |
| News | `/Communication/News/GetNewsList` |
| Calendar | `/calendarv2/calendarv2/getentries` (`{startDate,endDate}`) |
| Timetable | `/timetable/timetable/gettimetablelist` (`{start,end}`) |
| Assignments | `/task/task/GetTasks` |
| Attendance | `/attendance/attendance/appData` |
| Contacts | `/classlist/classlist/appData` (school staff) |
| Plans (Unit of Learning) | list `/UolV2/UolV2/GetUols` (`{}`), detail `/UolV2/UolV2/GetUol` (`{id}`) |
| Assessments | `/assessmentv2/assessmentv2/appData` |

Notes:
- `/timetable/timetable/appData` **ignores** `startDate`/`endDate` and returns a
  rolling 5-day window — use `gettimetablelist` when you need a date range.
- A dead session answers `200` with an **empty body**; treat that as logged out.
- Notifications are aggregated across all children and mapped back to a pupil
  via `pupilSourceId`.
- Plans: `GetUols` only lists `{id, title, subjects, state}` (plus the `subjects`
  and `academicYears` lookups); `state` is `active` / `notstarted` / `finished`.
  `GetUols {academicYearId: <id>}` returns a **previous** academic year's plans.
  The detail `GetUol` **requires** the body key `id` — `uolId`/`Id` answer
  `HTTP 500` — and returns three sections:
  - `uol` — overview rows: *Beskrivning*, *Ämne*, *Termin*, *Startdatum*,
    *Slutdatum*, *Årskurs*, *Stadier*, *Lärare* (names as `Lastname, Firstname`
    pairs joined by commas)
  - `syllabus` — the pedagogical plan in the school's fixed categories:
    *Översikt*, *Tidplan* (week by week), *Begrepp*, *Arbetssätt*, *Bedömning*,
    *Kunskapsmål*
  - `statement` — curriculum criteria, incl. per-level (`levelHeader` E/C/A)
    assessment texts.
- `GetAllTasks {id}` returns the **assignments linked to the plan**
  (`{type, hasMore, tasks[]}`). These are the *same* objects as the `GetTasks`
  list — the call adds the **link** (which tests and homework belong to this
  unit), not new data. `title`, `dueDate`, `status`, `milestoneCount` /
  `milestonesComplete` are the useful ones for a parent view.
  `GetAllObjectives {id}` answers empty and `GetTimelineEntries` answers
  `HTTP 500` for a parent account.
- A plan also arrives as a notification — `appType: Uol`,
  `type: UnitOfLearning` (published) or `UolUpdated` (changed),
  `url: #/uolv2/show/<id>`.
- `npm run probe:uol` maps the plan app and writes `out/uol-detail-*.json`.

## Home Assistant

There are **two ways** to get this into Home Assistant — pick **one** to avoid
duplicate entities:

1. **The native integration (recommended for HA):**
   [`c14ym0re/infomentor-homeassistant`](https://github.com/c14ym0re/infomentor-homeassistant)
   — install via HACS, configure in the UI, get real entities and devices. Example
   dashboards are in its [`examples/`](https://github.com/c14ym0re/infomentor-homeassistant/tree/main/examples);
   `npm run dashboard` in this repo pushes your own view into HA.
2. **The MQTT bridge in this repo** (below) — for people who prefer not to
   install a custom integration, or who run the poller outside HA.

If you use the integration, turn the bridge **off** in `config.json`:

```jsonc
{ "mqtt": { "enabled": false } }
```

…and purge the retained topics once so Home Assistant removes the old entities:

```bash
npm run purge:ha
```

### MQTT bridge (alternative)

Entities are published with **MQTT Discovery**, so they appear automatically
under a single "Infomentor" device:

| Entity | Meaning |
|---|---|
| `sensor.<child>_skoldag` | school day start–end (next school day) |
| `sensor.<child>_uppgifter` | assignments due within 7 days |
| `sensor.<child>_nasta_handelse` | next calendar event |
| `binary_sensor.<child>_idrott_nasta_skoldag` | PE next school day |
| `sensor.<child>_lunch` | school lunch (next school day) |

Publishing goes through HA's own MQTT integration (`mqtt.publish`), so no broker
username/password is required — just `HA_URL` + a long-lived token, e.g. in
`~/.config/infomentor/ha.env`:

```
HA_URL=http://homeassistant.local:8123
HA_TOKEN=…
```

A standalone MQTT 3.1.1 client (`src/mqtt.js`) is included for direct broker
publishing if you prefer.

## Design & accessibility

The HTML report is built for real inboxes:

- **Inline styles only** (Gmail strips `<style>`/`<head>`), table-based layout
  with `role="presentation"`.
- **WCAG 2.2 AA contrast** with margin (primary `#1d1d1f`, secondary `#515154`,
  muted `#6e6e73`).
- 16–17 px body text, no italics, no thin weights.
- Light mode locked (`color-scheme: light only`) so dark mode can't wreck contrast.
- Under Gmail's 102 kB clipping limit.

## Credits

Built on the groundwork of the open-source Skolplattformen project:

- [`kolplattformen/skolplattformen`](https://github.com/kolplattformen/skolplattformen)
  (Apache-2.0) — `libs/api-infomentor`, endpoint documentation.
- [`kolplattformen/dementor.net`](https://github.com/kolplattformen/dementor.net)
  (MIT) — the email/password login flow.

## License

MIT © 2026 Claes Hall — see [LICENSE](LICENSE).
