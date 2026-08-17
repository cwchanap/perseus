# HPA-215: Practical Gameplay UX Epic Closeout — Design

**Linear:** HPA-215  
**Status:** Design for closeout  
**Date:** 2026-08-16

## Context

HPA-215 is the only non-canceled, non-completed issue left in the Perseus Linear project. Every active child named by the epic is complete; HPA-237 is explicitly canceled/deferred under YAGNI. GitHub also has no open Perseus pull requests.

The active roadmap has already shipped:

| Outcome | Linear | Evidence |
| --- | --- | --- |
| Truthful completion summary | HPA-224 | PR #55 |
| Mobile tap-to-place + inventory drawer | HPA-219 | PR #56 |
| Inventory filters + shuffle | HPA-220 | PR #57 |
| Gallery progress + Continue | HPA-218 | PR #52 |
| Responsive toolbar | HPA-217 | PR #58 |
| Persistent Reference + assistance labeling | HPA-222 | PR #59 |
| Keyboard navigation + announcements | HPA-223 | PR #61 |
| Mission setup/pause/restart/save-exit baseline | HPA-221 | PR #39 |
| Deterministic gameplay E2E infrastructure | HPA-226 | PR #35 |

The remaining work is roadmap closeout, not another product slice.

## Goals

1. Close HPA-215 from existing shipped evidence.
2. Make its description read as completed scope instead of an active queue.
3. Check all seven epic acceptance criteria.
4. Preserve the delivery principles, deferred list, and non-goals.
5. Add one concise Linear closeout comment with the shipped evidence.
6. Mark the epic `Done` only after re-reading live Linear state and confirming no new active child or blocker appeared.

## Non-goals

- No production, test, schema, API, persistence, worker, or infrastructure changes.
- No new feature or cleanup ticket solely to keep the roadmap alive.
- No broad browser, accessibility, performance, or manual certification sweep.
- No reopening HPA-237 or any other deferred item.
- No change to the Perseus Linear project status.
- No rewriting child issues or historical PR descriptions.

## Options considered

### Option A — Close from shipped evidence (selected)

Minimally update HPA-215, add a closeout comment, and set it to `Done`.

This is the smallest truthful action. It preserves the epic as a useful historical decision and keeps deferred work deferred.

### Option B — Add a verification child

Rejected. HPA-226 already established deterministic gameplay infrastructure and each feature slice added focused coverage. There is no current regression or release requirement that justifies another certification pass.

### Option C — Keep HPA-215 open as a perpetual roadmap

Rejected. Its active scope and acceptance criteria are bounded and now complete. Future Perseus ideas should become new issues, or a new parent only when enough related work exists.

## Acceptance evidence

1. **Hard-coded rank removed; completion is truthful — satisfied.** HPA-224 / PR #55 replaced `S RANK` with factual result-class-driven completion information.
2. **Phone placement without long-distance dragging — satisfied.** HPA-219 / PR #56 shipped tap select-then-place plus a compact mobile inventory drawer and mobile geometry coverage.
3. **Large inventories have filters and shuffle — satisfied.** HPA-220 / PR #57 shipped All/Corners/Edges/Center and shuffle over unplaced pieces.
4. **Current-device sessions can Continue from gallery — satisfied.** HPA-218 / PR #52 shipped resumable-session discovery, progress, and navigation.
5. **Existing gameplay controls remain functional — satisfied.** HPA-221 / PR #39 owns pause/restart/save-exit; HPA-217 / PR #58 retains responsive toolbar actions; HPA-222 / PR #59 extends Reference; HPA-223 / PR #61 keeps existing callbacks and Undo/Redo shortcuts.
6. **Core controls work with pointer, touch, and keyboard — satisfied.** HPA-219 owns touch interaction; HPA-223 owns practical keyboard navigation while preserving pointer callbacks.
7. **Each feature has focused tests without new frameworks — satisfied.** The child PRs reused existing unit/component/E2E seams and HPA-226's fixture infrastructure.

## Closeout shape

The implementation must update the live HPA-215 issue in place rather than copying a stale description from git.

At execution time:

1. Fetch HPA-215 with relations and list direct children.
2. Confirm HPA-217, HPA-218, HPA-219, HPA-220, HPA-221, HPA-222, HPA-223, HPA-224, HPA-226, and HPA-236 are `Done`; HPA-237 remains `Canceled`.
3. Confirm HPA-215 has no blocker and no new active direct child.
4. In the current description only:
   - rename `## Active scope and suggested order` to `## Shipped scope`;
   - add one sentence that the active scope is complete as of 2026-08-16;
   - change all seven epic acceptance checkboxes to checked;
   - leave Goal, Delivery principles, Deferred until demonstrated need, and Non-goals semantically unchanged.
5. Add one top-level closeout comment listing the completed child/PR evidence and stating that deferred items remain deferred.
6. Set HPA-215 to `Done`.
7. Re-fetch HPA-215 and its children to verify final state.

## Failure handling

- If any named active child is no longer `Done`, leave HPA-215 open.
- If a new active direct child or blocker appears, inspect it before closing.
- If a Linear write partially succeeds, re-fetch before retrying.
- Do not reopen completed/canceled children to make statuses uniform.

## Verification

Closeout is complete when HPA-215 is `Done`, all seven acceptance boxes are checked, `Shipped scope` replaces the stale active-scope heading, the original principles/deferred/non-goals remain, the closeout comment records the evidence, HPA-237 remains canceled, and no new implementation issue or project-state change was created.

## Decision

Close HPA-215. The next Perseus task should come from a newly demonstrated product or maintenance need, not from extending a finished roadmap by inertia.
