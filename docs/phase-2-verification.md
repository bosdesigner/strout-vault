# Phase 2 verification

Evidence for the Phase 2 pull request (people, companies, projects, review
queue, workspace switcher, hand-tagging on the recording page). Everything ran
against a local PostgreSQL 16 and the `local` storage driver; nothing touched
Neon, B2 or R2.

## 1. Unit and API tests (`npm test`)

80 tests across 8 files, all passing: the 65 Phase 1 tests plus
`tests/api/phase2.test.ts` (15 tests):

```
 ✓ tests/api/phase2.test.ts (15 tests)
   people and companies › lists everyone with role chips per workspace
   people and companies › filters by workspace, role, status, market, kind and text
   people and companies › lists markets for the filter
   people and companies › returns the full person page: contact, roles, affiliations, timeline, open facts, projects
   people and companies › edits contact fields and the name
   people and companies › adds and updates roles (never deletes; mark former instead)
   people and companies › creates a person with a first role and links an organization
   projects › lists projects with counts, scoped by workspace
   projects › returns parties with roles, linked interactions and facts; edits fields; adds people
   projects › creates a project
   review queue › lists open proposals with the person, speaker label and the moment in the call
   review queue › approving a participant match tags the person, assigns their lines and closes the item
   review queue › rejecting marks the item without touching participants or segments
   tagging on the recording page › adds a participant with a speaker label and assigns the lines
   tagging on the recording page › links a project by hand

 Test Files  8 passed (8)
      Tests  80 passed (80)
```

The review-approval test checks the whole effect of an approval in the
database: the `interaction_participants` row (with `speaker_label`), every
`segments.speaker_party_id` for that label, `review_queue.status =
'approved'` with `decided_at`, a second decision refused with 409, and the open
count going down by one.

## 2. End-to-end tests (`npm run test:e2e`)

27 passing (17 from Phase 1 plus `tests/e2e/phase2.spec.ts` on Desktop Chrome
and the iPhone 13 viewport):

```
  ✓ [desktop] phase2.spec.ts › people › list shows role chips per workspace and filters by role and workspace
  ✓ [desktop] phase2.spec.ts › people › person page: edit contact fields, add a role, see timeline and open facts
  ✓ [desktop] phase2.spec.ts › projects › list and detail with parties, recordings and facts
  ✓ [desktop] phase2.spec.ts › review queue › approve with the keyboard applies the participant match
  ✓ [desktop] phase2.spec.ts › recording page tagging › tag a participant with a speaker label and link a project
  ✓ [iphone]  phase2.spec.ts › (the same five)
  27 passed (58.4s)
```

What they check:

- **people** — the list shows "Another Story · contractor · Houston (Conroe)" on Kevin McGuire; the Role filter narrows to 3 contractors; switching the top-bar workspace to Strout Architecture narrows to 1.
- **person page** — edit Location through the contact form and it survives a reload; add a Strout Architecture · prospect role and it appears in the Roles card.
- **projects** — the list has the 6 seeded projects; Heights Bungalow Addition shows Maria Delgado, its recordings and its facts.
- **review queue** — the first proposal reads "Speaker N is probably <person> (0.xx)" and links to `/r/:id?t=<sec>`; `j`/`k` move the selection; `a` approves and the item leaves the queue; the API then shows the person tagged with that speaker label and every line of that label assigned to them; `r` rejects the next item.
- **recording page tagging** — tag Rachel Kim as an unassigned speaker label from the People tab ("N transcript lines assigned"), then link a project; both survive a reload.

## 3. Screenshots

Every Phase 2 page at 1440 px and 390 px in
[`docs/screenshots/phase-2/`](screenshots/phase-2/), produced by
`SCREENSHOT_PHASE=phase-2 npm run screenshots` (no page overflowed its
viewport).

| page | 1440 | 390 |
|---|---|---|
| People & companies | [people-1440](screenshots/phase-2/people-1440.png) | [people-390](screenshots/phase-2/people-390.png) |
| People, filtered to contractors | [people-filtered-1440](screenshots/phase-2/people-filtered-1440.png) | [people-filtered-390](screenshots/phase-2/people-filtered-390.png) |
| Person | [person-1440](screenshots/phase-2/person-1440.png) | [person-390](screenshots/phase-2/person-390.png) |
| Projects | [projects-1440](screenshots/phase-2/projects-1440.png) | [projects-390](screenshots/phase-2/projects-390.png) |
| Project | [project-1440](screenshots/phase-2/project-1440.png) | [project-390](screenshots/phase-2/project-390.png) |
| Review queue | [review-1440](screenshots/phase-2/review-1440.png) | [review-390](screenshots/phase-2/review-390.png) |
| Recording, People tab (tag a person, link a project) | [recording-people-1440](screenshots/phase-2/recording-people-1440.png) | [recording-people-390](screenshots/phase-2/recording-people-390.png) |
| Library scoped by the workspace switcher | [library-workspace-1440](screenshots/phase-2/library-workspace-1440.png) | [library-workspace-390](screenshots/phase-2/library-workspace-390.png) |

Fixed after looking at them: the projects grid overflowed at 390 px (long
party lists), and the second header row on phones could not fit the workspace
switcher and four section links, so phones now get a bottom tab bar (Library,
People, Projects, Review with its open count) and the switcher has the header
row to itself.

## 4. Build and `/healthz`

`npm run typecheck`, `npm run build` and the Phase 1 clean-clone check are
unchanged by this phase (no new environment variables, no new migrations).
