# HPA-215 Practical Gameplay UX Epic Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close HPA-215 truthfully after verifying that its active gameplay UX scope is shipped, without creating another implementation ticket or changing production code.

**Architecture:** This is a Linear-only closeout. GitHub is read-only evidence: merged child PRs prove the shipped outcomes. Linear remains the source of truth for the epic description, child statuses, relations, closeout comment, and final `Done` state. Every write is preceded and followed by a fresh read so stale issue text is never spliced back into Linear.

**Tech Stack:** Linear, GitHub, Markdown.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-16-hpa-215-gameplay-ux-epic-closeout-design.md`.
- Make no production, test, schema, API, persistence, worker, infrastructure, or dependency changes.
- Do not create a new Perseus implementation issue during closeout.
- Do not reopen HPA-237 or any deferred item.
- Do not change the Perseus Linear project status.
- Treat the live HPA-215 description as authoritative; never overwrite it from a copied/stale body.
- Preserve Goal, Delivery principles, Deferred until demonstrated need, and Non-goals semantically unchanged.
- Stop before closing if a new active direct child or blocker appears.

---

## Task 1: Revalidate the epic and shipped evidence

**Systems:**

- Linear: HPA-215 and its direct children
- GitHub: `cwchanap/perseus`

**Interfaces:**

- Consumes: live HPA-215 description, relations, direct-child statuses, current open PR list.
- Produces: a read-only closeout decision: `ready` or `not ready`.

- [ ] **Step 1: Fetch HPA-215 with relations**

Read HPA-215 with relations enabled. Record the current description and confirm `blockedBy` is empty.

Expected: HPA-215 is still open (`Backlog` or `In Progress`) and has no blocker.

- [ ] **Step 2: List every direct child**

List issues with `parentId=HPA-215`. Confirm these exact statuses:

```text
HPA-217 Done
HPA-218 Done
HPA-219 Done
HPA-220 Done
HPA-221 Done
HPA-222 Done
HPA-223 Done
HPA-224 Done
HPA-226 Done
HPA-236 Done
HPA-237 Canceled
```

If any listed completed item is no longer `Done`, or any new direct child is active, stop. Do not update HPA-215.

- [ ] **Step 3: Confirm there is no competing implementation PR**

List open pull requests for `cwchanap/perseus`.

Expected: zero implementation PRs other than this planning-only HPA-215 closeout PR.

If another open PR clearly belongs to HPA-215 or one of its children, inspect it before continuing.

- [ ] **Step 4: Pin the shipped evidence used by closeout**

Use this evidence map; do not broaden the verification campaign:

```text
HPA-224 -> PR #55 -> truthful completion summary
HPA-219 -> PR #56 -> mobile tap-to-place + inventory drawer
HPA-220 -> PR #57 -> inventory filters + shuffle
HPA-218 -> PR #52 -> gallery progress + Continue
HPA-217 -> PR #58 -> responsive toolbar
HPA-222 -> PR #59 -> persistent Reference + assistance labeling
HPA-223 -> PR #61 -> keyboard navigation + announcements
HPA-221 -> PR #39 -> setup/pause/restart/save-exit baseline
HPA-226 -> PR #35 -> deterministic gameplay E2E infrastructure
```

Expected: `ready` to close. No new browser/unit test run is required because this task changes no repository behavior and the acceptance evidence is the already-merged feature work.

---

## Task 2: Make the live HPA-215 description truthful and add closeout evidence

**Systems:**

- Linear: HPA-215 only

**Interfaces:**

- Consumes: the fresh HPA-215 description captured in Task 1.
- Produces: updated description plus one top-level closeout comment.

- [ ] **Step 1: Re-fetch HPA-215 immediately before writing**

Do not reuse a description fetched before a long review or tool sequence. Fetch HPA-215 again and use that exact body as the edit base.

Expected: no new blocker and no material description change that invalidates Task 1.

- [ ] **Step 2: Apply only the four description edits**

Starting from the current live description:

1. Replace the heading:

```markdown
## Active scope and suggested order
```

with:

```markdown
## Shipped scope

All active scope in this roadmap is complete as of 2026-08-16.
```

2. Keep the existing child list and HPA-221 baseline paragraph under that heading.
3. Change each of the seven checklist items under `## Epic acceptance criteria` from `- [ ]` to `- [x]` without changing the criterion text.
4. Leave `# Goal`, `## Delivery principles`, `## Deferred until demonstrated need`, and `## Non-goals` semantically unchanged.

Do not add PR links throughout the description; evidence belongs in the closeout comment.

- [ ] **Step 3: Save the description and re-fetch it**

After saving, fetch HPA-215 again and verify:

```text
heading == "Shipped scope"
completion sentence is present
checked acceptance boxes == 7
unchecked epic acceptance boxes == 0
Deferred until demonstrated need is present
Non-goals is present
```

If any preservation check fails, fix the description before continuing.

- [ ] **Step 4: Add exactly one top-level closeout comment**

Use this comment body:

```markdown
HPA-215 closeout evidence:

- HPA-224 / PR #55 — truthful completion summary
- HPA-219 / PR #56 — mobile tap-to-place and inventory drawer
- HPA-220 / PR #57 — inventory filters and shuffle
- HPA-218 / PR #52 — gallery progress and Continue
- HPA-217 / PR #58 — responsive puzzle toolbar
- HPA-222 / PR #59 — persistent Reference and assistance labeling
- HPA-223 / PR #61 — practical keyboard navigation and core announcements
- HPA-221 / PR #39 — setup, pause/resume, restart, save/discard exit, and Relaxed-mode baseline
- HPA-226 / PR #35 — deterministic gameplay E2E infrastructure reused by the later slices

All seven epic acceptance criteria are satisfied by shipped work. HPA-237 and the existing "Deferred until demonstrated need" list remain deferred; closeout does not create replacement scope.
```

Do not add a second summary comment unless the first write fails and a re-fetch confirms it was not created.

---

## Task 3: Mark HPA-215 Done and verify the project has no stale active epic work

**Systems:**

- Linear: HPA-215, direct children, Perseus project issue list

**Interfaces:**

- Consumes: Task 2's verified description/comment state.
- Produces: HPA-215 in `Done` with deferred work unchanged.

- [ ] **Step 1: Re-check relations immediately before status change**

Fetch HPA-215 with relations one last time.

Expected: `blockedBy` remains empty.

If a blocker appeared, stop and leave the issue open.

- [ ] **Step 2: Set HPA-215 status to `Done`**

Update only the issue state/status. Do not alter project, priority, labels, assignee, parent, or relations in this step.

- [ ] **Step 3: Verify HPA-215 final state**

Fetch HPA-215 and assert all of the following:

```text
status == Done
heading == Shipped scope
checked acceptance boxes == 7
closeout comment exists
blockedBy == empty
```

- [ ] **Step 4: Verify children and deferred scope remain unchanged**

List direct children again.

Expected:

```text
HPA-217/HPA-218/HPA-219/HPA-220/HPA-221/HPA-222/HPA-223/HPA-224/HPA-226/HPA-236 == Done
HPA-237 == Canceled
```

- [ ] **Step 5: Verify no new active Perseus implementation issue was created by closeout**

List the Perseus project's non-archived issues and confirm this closeout introduced no new issue and did not change project status.

The project may remain available for future Perseus work; this plan closes HPA-215 only.

---

## Final verification

The closeout passes when:

```text
HPA-215 status: Done
Epic acceptance criteria: 7/7 checked
Active direct children: 0
HPA-237: Canceled
New issues created by closeout: 0
Production/test files changed: 0
Perseus project status changed: no
```

No repository implementation PR follows this plan. Once the planning documents are accepted, execution is a small Linear metadata operation. Future Perseus work should start from a new demonstrated need rather than from reopening this completed epic.
