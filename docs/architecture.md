# Architecture and design decisions

[← back to the README](../README.md)

How the pieces work, and the places where this app deliberately departs from
the design handoff it was built from.

## Intake: a link, handed to Bambuddy

A request used to be an uploaded `.stl` or `.3mf`, validated, stored in MinIO
and shown in a three.js viewer. It is now a **MakerWorld link**. The printer
owner runs Bambuddy in front of the
printer, and Bambuddy can already fetch a MakerWorld model, slice it and queue
it. So the app stopped holding geometry at all: no upload, no object storage,
no viewer, no download, no "Open in PrusaSlicer". The link *is* the model, and
Bambuddy's state is where the ticket stands.

`src/lib/bambuddy.ts` is the client. It is server-only and talks to Bambuddy on
the LAN with an API key scoped to **Manage Library + Manage Queue** and nothing
else. There is no Control Printer permission, so a compromise of this app can
slice and queue, but cannot start, stop or otherwise touch a running print.
`src/lib/bambuddy-sync.ts` is everything that happens without a person
clicking.

### What the form takes, and why

- **A MakerWorld model page**, checked on the server (`isMakerWorldModelUrl`).
  Only a MakerWorld link can be resolved, and anything else would fail on every
  sync pass forever, so it is refused up front. The link is also rendered as an
  `<a href>`, so it must be `http(s)` (`isHttpUrl`), and the story page checks
  again before linking.
- **A colour, picked from what is on the shelf.** The picker is rendered live
  from Bambuddy's spool inventory (`listSpools`). The only thing the form sends
  is a `spoolId`, which `createStoryFromLink` looks up again server-side: a
  spool that has run out is `409`, and material, colour name and hex are copied
  from the spool, never from the request. They are copied onto the row on
  purpose, so the ticket keeps showing what was asked for after that spool is
  archived or restocked.
- **PLA only.** Every request is sliced with the template pipeline's PLA
  preset (see [Slicing and queueing](#slicing-and-queueing)). Colour picks a
  spool, never a material, so a PETG spool would
  slice cleanly and print wrong. The picker filters to PLA and the server
  refuses anything else, because the API takes any spool id.
- Quantity, a needed-by date and a free-text note, as before.

A tip, if the owner has the tip jar switched on — see
[The tip jar, as a switch](#the-tip-jar-as-a-switch).

### The handoff

`createStoryFromLink` writes the row, then calls `processIntake` in the same
request:

1. **resolve** the link (title, model id) and **import** the model into
   Bambuddy's library → `libraryFileId`. If the link names a print profile
   Bambu won't serve (share links carry one), it retries once with the
   model's default profile and tells the requester.
2. **read the model's colours** and record them on the ticket (see
   [Multi-colour models](#multi-colour-models))
3. **start slicing it** directly → `sliceJobId`, and the ticket is `Slicing`
   (see [Slicing and queueing](#slicing-and-queueing))
4. **wait about 20 s** for the slice; if it's done, queue it and tell the
   requester where the ticket landed. A slower slice is the sync's to finish.

The slice job and `Slicing` are saved the moment the job exists. A crash after
that point can't lead to anything printing unwatched: nothing is queued until
the app queues it.

`processIntake` never throws. If Bambuddy is down, or its Bambu Cloud sign-in
has expired, the ticket stays `Requested` with an `errorMessage`, the admin is
told once (not every pass), and the next sync retries it. Nobody has to
resubmit. The one refusal the requester does see is at the very start: if the
spool lookup cannot reach Bambuddy, the form says so and nothing is created
(`503` on the API).

A claim (`intakeStartedAt`, a 10-minute lease) keeps the synchronous call and a
cron tick from both importing the same story, and the sync takes the same
claim before it queues a finished slice or slices again, so a ticket is never
queued twice. Decline and withdraw respect it too, so they answer `409` for the
few seconds intake holds a story rather than being overwritten mid-handoff.

### Slicing and queueing

The app slices and queues itself rather than through a Slicer Pipeline run.
A pipeline run sends only its fixed printer, process, filament and bed
presets: it can't carry a MakerWorld designer's own settings, can't choose
plates (it slices plate 1), and loads a fixed number of filaments, which
crashes the slicer on many multi-colour models. Bambuddy's direct slice call
(`POST /library/files/{id}/slice`) can do all three.

One pipeline is still configured (`BAMBUDDY_PIPELINE_ID`), as a **template**:
its printer, process, bed type, PLA filament preset and target printer are the
starting point, so they stay editable in Bambuddy's own UI. `planSlice` then
adds, per model:

- **Filaments:** one PLA preset per slot the model's project defines
  (`filamentCountFor`). Bambu Studio's CLI aborts ("Flush volumes matrix do
  not match to the correct size!") when given more filaments than a
  multi-colour project defines. Measured through Bambuddy:

  | Project slots | Presets loaded | Result |
  | --- | --- | --- |
  | 1 | 1 or 4 | slices |
  | 3 | 3 | slices |
  | 3 | 4 | aborts |
  | 7 (6 used) | 6 or 7 | slices |

- **The designer's settings:** exactly what Bambuddy's own "use the
  designer's settings" applies. The file lists the process settings its
  designer changed; all of them are carried except the printer-coupled ones
  (speeds, accelerations, prime-tower geometry, tuned for the designer's
  machine) and the preset-defining ones (the template's pick wins).
- **Plates:** all of them (`plate: 0`, one multi-plate 3MF). A file with a
  single plate slices that one.
- **Colours:** the ticket's pick per slot, else the designer's, so the sliced
  file records what will actually print.

Bambuddy keeps slice jobs in memory only: a restart loses them, and a finished
one is forgotten after 30 minutes. If the sync finds a job gone, it slices
again. Nothing was queued from it, so that costs at most a spare sliced file.

A finished slice is queued with **one entry per plate per copy**, every one
**created waiting for a person** (`manual_start` set at creation), for the
template's printer or model class. With copies, all of a ticket's entries
share one Bambuddy batch, and the ticket follows the batch's counts; a single
copy has no batch, so its entries are followed one by one. The slice's real
print time and filament weight go on the ticket.

### Multi-colour models

Before slicing (see [Slicing and queueing](#slicing-and-queueing)), intake
asks Bambuddy which filament slots the model's plate actually uses (`filament-requirements`, which reads the 3MF) and
records one `StoryFilament` row per slot: the model's slot number, the
designer's colour, grams, and the spool it will print in. Slot numbers are
the designer's and arbitrary (a single-colour model's only slot was 3 in the
first one tried), so the order form's colour goes on the slot using the most
filament, the main part in practice. The others start as the printer owner's
choice.

A model with more than one colour notifies the requester, and the ticket
grows a *Colours* panel to pick a spool per slot. Picks made after slicing
don't re-slice: the colours written into the sliced file are only labels, and
which spool feeds which part is the owner's AMS mapping when they start the
print. Colour can change until the
print starts (`COLOUR_EDITABLE`), because every request is sliced as PLA:
colour never changes the slicing, only which AMS slot feeds which part when
the owner starts the print in Bambuddy. The queue's *Ready to print* list
shows that mapping so the owner can apply it. More colours than the AMS holds
(`AMS_SLOTS`, 4) is flagged to the owner rather than refused.

Reading the colours is best-effort. If it fails, the ticket has no slots and
shows the form's colour, exactly as before this existed. A re-queued ticket
copies its slots and picks, and intake keeps them rather than re-reading.

Deliberately not done: writing the AMS mapping onto the queue entry
automatically. It only works when the chosen spools are loaded, and a wrong
mapping prints the wrong colours; the owner reviews every print anyway.

### The one thing that must not be late: manual start

The app's promise is that sliced work waits in a reviewed pile until somebody
starts it. Every entry the app queues is **created** with `manual_start`, so
there is no moment in which it could start by itself.

That was not always so. A pipeline run creates its own queue entry as it
reaches `dispatching`, wanting to auto-start, and Bambuddy has no setting to
make it wait, so the only lever was to switch each entry to manual start as
soon as it appeared, racing Bambuddy's dispatch. `secureQueueEntries` still
does that for tickets sliced through a pipeline before direct slicing: on every
sync pass while no queue entry is known yet, and again while a known one is
still pending. Bambuddy refuses that PATCH with `400` once an entry has left
`pending`, which is treated as a no-op.

### Status is derived, not clicked

Every status but `Declined` comes from Bambuddy:

| Bambuddy | Ticket |
| --- | --- |
| slice job running | `Slicing` |
| slice job failed | `Failed`, with the slicer's own reason |
| entries all waiting | `Ready`, waiting for the owner to start them in Bambuddy |
| any entry printing, or some printed and some still waiting | `Printing` |
| all finished, at least one printed | `Done`, noting any that didn't print |
| none printed (failed, cancelled, skipped, or removed) | `Failed` |

`queueOutcome` in `scope.ts` turns a batch's counts, or each entry's status,
into that. With a single entry, its own words are kept: why it failed, or why
a pending entry is waiting (`waiting_reason`, e.g. "sliced for A1, not
compatible with P2S"), because a `Ready` ticket that is quietly stuck needs the
owner's eyes.

Tickets sliced through a pipeline run before direct slicing still go through
`deriveStatus` and the run's own state until they finish. Two run quirks are
handled there, both seen live: a run that completes but never queues anything
becomes `Failed` after a two-minute grace, and a run whose slice failed but
was left `in_progress` (with an `error_message` and a `completed_at`, and a
cancel that answered `200` without changing it) counts as `Failed`.

Each change notifies the requester, tells the owner when a ticket is `Ready`,
and writes a `story.status_changed` audit row. The Bambuddy ids behind a ticket
(the library files, slice job, queue batch and entries, pipeline run, archive)
are never selected into what the pages or the API render.

### The sync, and what schedules it

`POST /api/cron/sync` runs `syncOpenStories`: `processIntake` for anything still
`Requested`, `syncStory` for everything else that is open, one story at a
time. It has no session, because nothing it does is a person's action. It is
authorised by `CRON_SECRET` in an `Authorization: Bearer` header, compared in
constant time, and a missing secret refuses every request rather than falling
open.

**Nothing in the stack calls it.** A deployment has to: a host crontab entry
curling it every few minutes is enough (see [Deployment](deployment.md#bambuddy-and-the-sync)).
Without it, a ticket whose slice takes longer than intake's short wait stays
`Slicing`, and nothing after `Ready` is ever seen.

### What is deliberately not handled yet

- **Withdrawing or declining after the handoff.** Once a ticket is `Slicing`,
  Bambuddy holds a library file and possibly a queue entry. Tearing those down
  is real work this app does not do yet, so withdraw is `Requested`/`Declined`
  only and decline is `Requested` only. Past that, the requester asks the owner,
  and the owner cancels in Bambuddy.
- **One pipeline, one material.** A second material means a second pipeline and
  a way to choose between them; nothing here pretends otherwise.
- **The owner's review happens in Bambuddy.** The queue page lists `Ready`
  tickets and those that need a look, but starting a print is done in Bambuddy's
  own UI, on purpose: this app's key cannot start one.

## Decisions taken against the handoff

The handoff contradicts itself in two places and leaves three things open.
All five are settled, and recorded here so nobody has to re-derive them:

| Question | Decision |
| --- | --- |
| Tip pill radius — README §3 says `8px`, the prototype renders `999px` | **8px.** The tokens reserve `999px` for "avatars, dots and status chips only", so two written sources beat the render. |
| *Printing* column label — README §2 says amber `#79541a`, the prototype uses teal `#0b4340` | **Amber.** The tokens call amber "warning / in-progress only", and Printing is the in-progress state. It also makes the live column findable. |
| Where declined stories go — `Declined` is not in the flow, so it has no column | **Off the board entirely.** The board is for work that is still moving; the profile at `/me` carries the whole history, declined included. |
| The whole-board empty state, which the handoff says to ask about | **Minimal.** One quiet panel saying what is true, with the *Order up* button already above it. No invented onboarding. |
| Print-time estimates | **Only the slicer's.** See below. |

### The stats that changed

The handoff's admin profile card is "Printer time given". There is no honest
number behind it, so rather than invent one the admin's cards count things that
are real and actionable: prints finished, tickets **Ready to print**, and
tickets that **need a look** (anything carrying an `errorMessage`). An earlier
version counted bytes of geometry printed; that went with the uploads.

### The print time is the slicer's, or nothing

A figure derived from the bounding box is a guess dressed as a measurement —
it cannot know infill, layer height, wall count or the printer's speeds, and
it is worst on exactly the models people care about. The handoff's definition
of done says nothing should claim to know what the printer is doing, and a
number someone might plan their afternoon around is the kind of claim it warns
about.

So no estimate was ever invented. Now that the app slices every request
itself, the slicer's own print time and filament weight come back with the
slice, and the ticket shows those: a measurement, not a guess.

## The API, and why there is a service layer

Everything the queue can do is reachable over JSON as well as through the
forms — see [the API](api.md). Adding that changed the shape of the code in
one significant way, and it is the part worth knowing about.

The admin actions used to live entirely in `src/app/actions/stories.ts`: read
the `FormData`, check the role, check the transition, write the row, notify the
uploader, write the audit event, redirect. Copying that into a route handler
would have meant two implementations of four rules, and the second one only has
to forget once. So the operations moved to **`src/lib/stories.ts`**, which
takes an `Actor` and decides for itself who may do what. The server actions
became adapters — `FormData` in, redirect out — and the route handlers are
adapters too: JSON in, status code out.

The practical test of that is `npm run verify:api`, which drives the JSON
surface against every rule `npm run verify:queue` drives through the forms, and
gets the same answers.

Three decisions inside it that look odd on purpose:

- **The API answers 403 where a page answers 404.** Everywhere else, a surface
  you may not reach returns 404 so that a 403 cannot confirm it exists. That
  reasoning does not survive publishing an OpenAPI document:
  `/api/stories/{id}/decline` is listed at `/api/openapi.json`, so hiding it is
  theatre — and it would tell an honest client their ticket had vanished when
  the truth is that they are not the printer owner. Whether a *ticket* exists
  is still hidden, through the same `storyScope` fragment.
- **There is no endpoint that sets a status.** Status is derived from
  Bambuddy (see [Status is derived, not clicked](#status-is-derived-not-clicked)),
  and `decline` is the only move a person makes. An endpoint taking a target
  status would let the board claim something the print farm does not know.
- **Nothing spreads a database row onto the wire.** `src/lib/api.ts` names
  every field it emits. That is what keeps the Bambuddy handoff ids out of
  every response without anyone having to remember to strip them, and it is
  what makes a column added tomorrow private by default.

The document at `/api/openapi.json` is assembled per request from two halves:
the app's own paths, written out, with request bodies converted from the same
Zod schemas the handlers validate with; and Better Auth's, generated by the
library so they cannot drift when a plugin is added or a version bumped.

The console at `/docs` is a plain HTML route rather than a page, because
Swagger UI's stylesheet expects to own the document and the root layout owns
this one — four self-hosted webfonts, a diner palette and a paper texture.
Swagger UI itself is copied out of `node_modules` at build time by
`scripts/vendor-swagger.ts`: a CDN would be refused by `script-src 'self'`,
would be unreachable on a NAS with no outbound internet, and would put a third
party in the request path of an otherwise entirely first-party tool.

## The audit page, and why it grew panels

`/admin/audit` was always defended with the same argument: for one printer and
five colleagues, a screen the owner glances at beats threshold alerts nobody
tunes and everybody learns to ignore. That argument has a hole in it — it only
works if somebody looks, and a reverse-chronological wall of rows is not
something anyone opens twice.

So three panels sit above the log, in `src/lib/dashboard.ts`. They answer the
questions a person arrives with, none of which a log answers by being scrolled:
**is anything being refused**, **where is work piling up**, and **what filament
is being asked for**.

Two rules held while building them, and they are the interesting part:

- **Aggregation only.** No column exists because of this page, and nothing is
  recorded for it. Everything is derived from rows that were already there — the
  stage medians, for instance, are reconstructed from the `from` field every
  `story.status_changed` was already carrying. A dashboard that needs its own
  schema has stopped being a view and started being a feature.
- **Events from the trail, work from the tables.** The refusals panel reads
  `AuditEvent`; the material and colour panel reads `Story`. The audit
  trail is a log, not a warehouse, and querying it for things the domain tables
  already know is how a log slowly turns into a schema nobody meant to design.

No charting library. A CDN would be refused by `script-src 'self'`, would be
unreachable on a NAS with no outbound internet, and it is four bars — the same
reasoning that vendored Swagger UI rather than linking it.

## The feature-request track ('frr')

A second backlog lives at `/frr`: anyone files a feature request, and the owner
triages it through the same board, queue, status flow, conversation,
notifications and audit trail as a print — see
[Feature requests](feature-requests.md).

It is built as a deliberate **parallel** of the print backlog, not folded into
it. There is a `FeatureRequest`/`FeatureComment` pair of tables and a
`src/lib/features.ts` service that mirrors `stories.ts` operation-for-operation;
`Story`, intake and the JSON API are untouched, with no `kind`
flag threading feature logic through them. The pure rules sit beside the print
ones in `scope.ts` — `featureScope`, `FEATURE_FLOW`, `assertFeatureTransition`,
`featureRef` — and are kept parallel rather than merged into one generic helper
on purpose: the print rules are load-bearing and exercised directly by the
suites, so a shared cleverness a change to one backlog could bend for the other
is a worse trade than a little duplication. The *shape* is identical, which is
what makes the owner handle a request exactly as they handle a print.

Where the two backlogs meet is shared infrastructure, extended additively: one
`Notification` row can point at a story or a feature (a nullable `featureId`,
and the Activity feed routes to `/story` or `/frr` on whichever is set), and the
audit trail gained `feature.*` verbs. Neither change alters how a print behaves.
`npm run verify:frr` drives the whole track the way `verify:queue` drives the
print one.

## Later additions, kept thin

Several features that came after are deliberately additions on top of the two
backlogs rather than new subsystems, each covered by the verify suite for its
side:

- **A past print can be re-queued.** `requeueStory` clones an old ticket into
  a fresh `Requested` one with the same link, spool and wish fields, and none
  of the old Bambuddy ids: the sync resolves and imports the link again rather
  than trusting a library file or queue entry that may be gone. (Withdraw once
  reached `Accepted` too; that status no longer exists, and withdraw is back to
  `Requested`/`Declined` — see [intake](#what-is-deliberately-not-handled-yet).)
- **`/history`** is a scoped read of the finished prints (`Done`/`Failed`/
  `Declined`) through the same `storyScope`, filtered by status, material and
  date, with the re-queue control on each row.
- **The benefits (tips) are owner-managed data**, not a constant: a `Benefit`
  table the owner edits at `/admin/benefits`, seeded with the original five.
  `Story.tip` stays a plain string so a past request survives an edit.
- **A feature request's priority is editable in any status, and both `/frr`
  views filter** by priority/status/category. The filter is ANDed onto
  `featureScope`, so it can only ever narrow a caller's own set.
- **An optional free-text note** rides along on a request and shows on the
  ticket for the owner. Slicer settings themselves belong to the pipeline in
  Bambuddy, not to the request.

## The tip jar, as a switch

Tips came from an office setting ("what's in it for you — a beer?"), and they
do not suit every deployment. So the tip jar is a module the owner turns on or
off at `/admin/benefits`, and it starts **off**.

- **The switch is data, not configuration.** One row in `app_settings`
  (`src/lib/settings.ts`), flipped from the admin page, audited as
  `tipjar.enabled` / `tipjar.disabled`. An env var would have meant a restart
  to change it; this is the owner's call, not the deployer's. A missing row
  reads as the defaults, so nothing seeds it.
- **Off means off everywhere.** The intake form asks for nothing, the board
  shows no tip pill, `/me` loses the beer count, and the API sends `tip` as
  `""`. The stored `Story.tip` values are kept, so turning it back on restores
  them.
- **On, the catalogue is authoritative.** A posted tip must be the label of an
  active benefit, checked in `createStoryFromLink` before Bambuddy is asked
  anything. Off, a posted tip is ignored rather than refused, so a script
  written while it was on keeps working.
- **The catalogue stays editable while it is off**, so the owner can set the
  list up before anyone sees it.

## What is deliberately not built

- **Email/Slack notification delivery.** `Notification` rows and the `notify()`
  helper exist and the Activity panel reads them; only the in-app record is
  written so far.
- **A designed whole-board empty state.** There is a minimal one that says what
  is true rather than showing a blank page, but the handoff asks for a design
  decision here — treat it as a placeholder.

## Layout

```
prisma/
  schema.prisma          auth tables (Better Auth's shapes) + domain models
  seed.ts                bootstraps the single admin, prints its setup link
  reset-token.ts         set-password token format, shared with the app
src/lib/
  auth.ts                Better Auth config — the invite gate lives here
  auth-client.ts         browser client (username, passkey, admin)
  auth-rules.ts          username and password rules, shared with the forms
  password-reset.ts      minting, reading and restoring set-password links
  authz.ts               requireUser/requireAdmin/storyScope + status flow
  invites.ts             invite lifecycle: mint, resend, revoke, consume
  email.ts               Resend → SMTP → console, plus templates
  tokens.ts              CSPRNG tokens, digests, initials
src/app/
  signin/                passkey button over a username/password form
  invite/[token]/        the registration page and its server action
  set-password/          where a reset link lands; sets no session
  welcome/               passkey enrolment after registration
  admin/invites/         the guest list (admin only)
src/lib/
  scope.ts               pure rules: scopes, flows, deriveStatus (no server-only)
  csp.ts                 Content-Security-Policy builder + nonce
  audit.ts               the append-only trail
  bambuddy.ts            the Bambuddy client — resolve, import, slice, queue, spools
  bambuddy-sync.ts       intake handoff and status sync; nothing here takes an Actor
  catalog.ts             quantity presets and shared formatting
  stories.ts             every operation on a ticket — the rules, once
  notifications.ts       the Activity feed, scoped by recipient
  api.ts                 the JSON boundary: 401/403, Origin, wire format
  openapi.ts             the OpenAPI 3.1 document, app half + Better Auth half
  features.ts            every operation on a feature request — the 'frr' track
  benefits.ts            the owner-managed benefits (tip) catalogue
  settings.ts            instance-wide switches, one row — the tip jar
src/app/
  board/                 the kanban backlog, scoped per role
  upload/                the intake form: link, live spool picker, wish
  story/[id]/            story detail (read half)
  queue/                 the owner's view: needs a look, ready to print
  api/stories/           the tickets, intake, decline, flag, the conversation
  api/cron/sync/         the scheduled Bambuddy sync, behind CRON_SECRET
  api/notifications/     the Activity feed
  api/openapi.json/      the document
  docs/                  the Swagger console (a route, not a page)
  frr/                   the feature-request track: board, new, queue, [id]
  history/               finished prints, filterable, with re-queue
scripts/
  deploy-wizard.sh       pick an image, verify it, deploy, auto-rollback
  vendor-swagger.ts      copies Swagger UI into public/docs at build time
  verify-auth.ts         registration, sign-in and password reset
  verify-queue.ts        the owner's queue, decline, flag, withdraw, re-queue
  verify-passkey.ts      WebAuthn in a real browser
  verify-api.ts          the JSON API, the document and the console
  verify-frr.ts          the feature-request track, filed and triaged
  verify-benefits.ts     the benefits catalogue and the tip jar switch
  security-probe.ts      OWASP-mapped security probes
src/app/admin/
  invites/               the guest list
  benefits/              the tip jar switch and its catalogue (admin only)
  audit/                 the audit log, admin only
```
