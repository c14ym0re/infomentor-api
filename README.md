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
- **Read** notifications, news, calendar, timetable, assignments and attendance,
  for every child on the account.
- **School lunch** from Mateo (optional).
- **Event engine** — compares each poll with the stored state and classifies
  what is new / changed / removed, with an *immediate* vs *digest* priority.
- **Poller** (`watch.js`) with quiet hours and backoff, run as cheap cron ticks.
- **Home Assistant** sensors via **MQTT Discovery** — no broker credentials
  needed (published through HA's `mqtt.publish`).
- **History** in SQLite (append-only event log) with search and per-child views.
- **Evening report** by email — accessible HTML + plain text.
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
  "mqtt": { "enabled": true, "discoveryPrefix": "homeassistant" },
  "ha": { "envFile": "~/.config/infomentor/ha.env" }
}
```

SMTP needs an **app password**, not your account password (Gmail/Workspace:
<https://myaccount.google.com/apppasswords>, requires 2-Step Verification).

## Running

### Poller

```bash
npm run watch:once        # one tick (for cron)
npm run digest            # force an evening report now
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
*/20 * * * * /path/to/infomentor-api/run-watch.sh
```

Ticks instead of a daemon: simple, survives reboots, and all state lives in
SQLite. `run-watch.sh` logs to `out/watch.log`.

### History

```bash
npm run history -- status
npm run history -- search "Test"
npm run history -- child "Lastname, Firstname" 2026-09-01 2026-10-01
```

## How it works

```
src/infomentor.js   cookie jar, login(), hubPost()
src/gather.js       collect everything → snapshot
src/events.js       change detection (pure, testable)
src/store.js        SQLite: current items + append-only event log
src/digest.js       the evening summary as text
src/watch.js        poller: tick, quiet hours, alerts, digest
src/report.js       renders accessible HTML report
src/send_mail.py    sends email via SMTP (digest + alerts)
src/ha.js           Home Assistant MQTT Discovery payloads
src/ha-api.js       publish via HA's mqtt.publish
src/mqtt.js         hand-written MQTT 3.1.1 client (QoS 0/1, reconnect)
src/history.js      history CLI
src/lunch.js        school lunch from Mateo
src/names.js        nickname mapping
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
| Plan/assessments | `/uolv2/uolv2/appData`, `/assessmentv2/assessmentv2/appData` |

Notes:
- `/timetable/timetable/appData` **ignores** `startDate`/`endDate` and returns a
  rolling 5-day window — use `gettimetablelist` when you need a date range.
- A dead session answers `200` with an **empty body**; treat that as logged out.
- Notifications are aggregated across all children and mapped back to a pupil
  via `pupilSourceId`.

## Home Assistant

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
