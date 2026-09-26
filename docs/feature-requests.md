# Feature requests — the 'frr' track

[← back to the README](../README.md)

A second backlog, alongside the print one: anyone can file a feature request,
and the printer owner triages it through its own stages, with the same kind of
board, conversation, notifications and audit trail a print has. It lives at
**`/frr`**.

## For everyone

- **`/frr`** — the rail. Your own requests (the owner sees everyone's), one
  column per stage, with anything closed gathered under *Closed* so you keep
  your history without a second page. A **filter bar** narrows by priority,
  status and category (the choices ride in the URL, applied server-side, so a
  filter can only ever shrink what you were already allowed to see).
- **`/frr/new`** — file one: a title, what-and-why, a **priority**
  (low / medium / high) and a **category** (UI / API / bug / other).
- **`/frr/[id]`** — the request in full: where it sits in the flow, the
  conversation, a **priority** control (the requester may change it in **any**
  status — a closed request can still be re-ranked; the owner may change any),
  and — while nobody has started on it — a **Withdraw** control for the person
  who filed it.

## For the owner

- **`/frr/queue`** — triage, reached by the **Triage** button on `/frr`.
  *Waiting on you* (still `Requested`) comes first, ordered high-priority
  first; everything in flight is a list with one control each. The same
  **filter bar** (priority / status / category) narrows the view. Owner-only —
  a client gets a 404, exactly like the print queue.

  The nav points at the board rather than here, for both roles: the board is
  the shared view of everything asked for, and triage is a step off it. That
  mirrors the print track, where *The rail* and *The pass* sit side by side.
- Move a request one step at a time: **Requested → Accepted → In progress →
  Shipped → Done**, or **Decline** it (terminal, and only from `Requested`).
  Every move notifies the requester and writes an audit row.

## How it mirrors the print backlog

The point of the feature was "handle them exactly as the current backlog", so
the 'frr' track was built as a deliberate parallel of the print one rather than
a new set of ideas.

One difference arrived later. A print's status is no longer moved by hand: it
is read from Bambuddy (see
[architecture](architecture.md#status-is-derived-not-clicked)), and declining
is the only move a person makes. A feature request has no machine behind it,
so the owner still steps it forward. That is where the two tracks now differ;
everything else in the table still lines up.

| Print backlog | Feature track |
| --- | --- |
| `Story` | `FeatureRequest` |
| `PPP-104` | `FRR-104` (`featureRef`) |
| `storyScope` | `featureScope` — a client sees their own, the owner sees all |
| `BOARD` + `deriveStatus` (Requested→Slicing→Ready→Printing→Done, read from Bambuddy) | `FEATURE_FLOW` (Requested→Accepted→In progress→Shipped→Done, stepped by the owner) |
| `assertDecline` — Declined from Requested only | `assertFeatureTransition` — forward-only, one step, Declined from Requested |
| `/board` `/queue` `/story/[id]` | `/frr` `/frr/queue` `/frr/[id]` |
| `src/lib/stories.ts` | `src/lib/features.ts` |

The pure rules sit beside the print ones in
[`src/lib/scope.ts`](../src/lib/scope.ts), and are **kept parallel rather than
merged into one generic helper on purpose**: the print rules are load-bearing
and exercised directly by the suites, so a shared cleverness that a change to
one backlog could quietly bend for the other is a worse trade than a little
duplication. The *shape* is the same, which is what makes the owner's
experience familiar, but each backlog stays independently legible and
testable.

## What it shares, and what stays separate

- **Its own tables** — `featureRequest` and `featureComment`. `Story` and the
  print flow are untouched; there is no `kind` flag threading feature logic
  through intake, the Bambuddy sync or the API.
- **Shared infrastructure, extended additively** — one `Notification` row can
  point at a story *or* a feature (a nullable `featureId`), and the Activity
  feed routes to `/story` or `/frr` on whichever is set. The audit trail gains
  `feature.*` verbs. Neither change alters how a print behaves.
- **Nothing outside the database.** A feature request is text; nothing is
  held in Bambuddy for it, so withdrawing one just removes the row and its
  conversation.

## Verifying it

`npm run verify:frr` drives the real forms the way a JavaScript-off browser
does — file, triage, the whole flow, decline, the conversation, withdrawal,
and the scope rule (a client cannot see or comment on another's request; the
owner cannot withdraw one). It is the print `verify:queue`'s sibling and runs
in CI against the built image.

## Not built (yet)

There is **no JSON API** for feature requests. The print backlog has one (see
[the API](api.md)); the feature track is UI-only for now, because the request
was specifically about filing and triaging on the board. The service layer in
`src/lib/features.ts` is already shaped like `stories.ts`, so adding
`/api/features` later is the same exercise the print API was — say the word.
