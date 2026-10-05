---
name: ui-jank
description: Jank in the dashboard UI, and the flinch loop that captures it. Use when changing anything a person sees in ui/, when verifying a UI change, or when the user says something feels off, janky, flickery, jumpy, or that they flinched.
---

# Jank

Jank is what makes the dashboard feel lower quality without being a bug: a frame of a loading state, a row that jumps, a logo that blinks out, a pane that switches in two pieces. People feel it long before they can describe it, so the loop here never waits for a description. A **flinch** is the moment someone reacts: Alt+Shift+F in a dev build saves the last ~30 seconds of the page (an rrweb DOM recording plus layout-shift, long-frame, interaction, network, and console signals) to `logs/flinches/`. `mise run flinch` turns that into evidence you can see.

[TASTE.md](TASTE.md) is the taste spec: how this dashboard should feel, as rules learned from real flinches. It is also the rubric the video reviewer in `mise run flinch` judges against.

## Changing UI

1. Read [TASTE.md](TASTE.md) before writing code. Done when every rule that touches the surface you are changing shapes your plan.
2. Build the change.
3. Flinch the flows you touched yourself (below). Done when a fresh flinch of each flow comes back clean: every finding in `report.md` and every glitch in `video-review.md` is fixed, or shown in the frames to be a replay artifact or intended.
4. Run the perf budgets (`tests/e2e/perf_budgets.spec.ts`, see the e2e README). Done when it passes; when your change made a flow cheaper, ratchet its ceilings down in the same commit. A fix for a flinch on one of its flows belongs there as a ceiling, so it stays fixed.

## When the user flinches

1. `mise run flinch` analyzes the newest file in `logs/flinches/`; pass a path for another.
2. Find the moment: read `report.md`, `video-review.md`, and the contact sheets around each frame they name. Done when you can point to the exact frames and the element that changed in them.
3. Confirm it was painted (below). Done when the glitch reproduces in a visible tab and survives the paint check, or is withdrawn as an artifact.
4. Find the cause in the code and fix it (below for where to look).
5. Flinch the same flow yourself until it comes back clean.
6. Record the lesson in [TASTE.md](TASTE.md): extend the rule it violated with this instance, or add a rule if none covers it. Done when the entry names the flow, the frames' evidence, the cause, and the fix. A glitch that turns out to be an artifact is withdrawn there with the reason, and what fooled you goes into this skill, so the next reader is not fooled the same way.

## Flinching a flow yourself

The dev server must be running (`mise run dev-ui`; the replay loads images and fonts from it). Drive a tab that is on screen: a hidden tab paints nothing and throttles its timers, so what it records is not what anyone sees, and the report says so at the top. `agent-browser --headed` opens a visible one; sign it in through the local dev login first:

```bash
agent-browser --headed open http://localhost:2024/dashboard/api/auth/dev-login
```

Perform the interaction (`agent-browser open`, `click`, or `eval`), then within a few seconds:

```bash
agent-browser eval '(async () => await window.__openSweFlinch.flinch("what you just did"))()'
```

It returns the saved path. Run `mise run flinch` (add `-- --before 6000` to widen the window, `--fps 60` for finer frames), then read the outputs next to the file. The window defaults to the last 3 s, so widen it to cover the whole interaction; every frame is a PNG on disk, so keep the window and fps no larger than the moment needs.

Driving agent-browser: set text with `fill` (`press Meta+a` selects nothing in its Chromium, and `press <key>` sends only the keydown). It runs one command at a time, so a hung `screenshot` blocks everything after it; wrap calls in `timeout`.

- `report.md`: DOM-level findings, each at its frame number. **short-lived element** (on screen under 300 ms) and **remounted element** catch flicker and flashes; **text flip** and **attribute flip** catch values that bounce; **layout shift**, **long frame**, and **slow interaction** come from the browser itself. A layout shift names each moved element with how far it moved: read the pixels, not the score, which is weighted by area (a timestamp moving 24 px scores 0.000). Chrome leaves out shifts within 500 ms of a click or keypress and anything off screen, so a jump right after Enter shows only in the frames or in sampling (below).
- `sheets/`: 12 consecutive labeled frames per image. View the sheets around every frame a finding or the review names: they are what you see, and the final word.
- `video-review.md`: a video model's frame-numbered account of the slow-motion replay. It catches teardown-order and visual glitches the DOM analysis has no rule for.

The three sources disagree in useful ways. The DOM report is exact but only knows its rules; the video review sees anything but both over-reports and misses things, so check every claim it makes against the frames, and check the frames it was silent about; the frames settle both. A broken image or missing font in every frame, including stable ones, is a replay artifact (the dev server was down during analysis), not jank. Canvas content is not replayed, and the TanStack devtools are excluded from recordings. Frames pin CSS animations at their end and skip transitions, so they show where motion lands, not the motion. The DOM changes far more often than the screen does: inside a **long frame** nothing is painted, so frames there show what the screen held when it began, and DOM states that came and went inside one are dropped from the report. Clicks the replay emulates carry a hover state, which a scripted `element.click()` never had. Recordings carry stylesheets as Chrome serializes them, and Chrome empties a shorthand that holds `var()` (`background: linear-gradient(… var(--x) …)` comes out as `background-image: ;` and so on); text or decoration styled that way is missing from every frame. Search the recording JSON for `: ;` to find such rules, and write them as longhands. A replay's scroll position can sit short of the live page's (by ~65 px once, with no scroll event to explain it); check scroll claims on the live page.

## Confirming it was painted

A recording holds every state the DOM passed through, and a replay can show any of them, including ones the screen never displayed. Before fixing anything, prove the person could have seen it:

- **Was the tab visible?** A report from a hidden tab says so at the top. Re-record in a visible tab; on 2026-10-03, both "Concierge glitches" disappeared that way.
- **Was it painted?** Sample the state at each real frame, in a visible tab, across the interaction. A state that appears in no sample was never on screen:

```js
const frames = []; let on = true
const tick = () => { frames.push({ t: performance.now(), state: /* what the glitch is about */ }); if (on) requestAnimationFrame(tick) }
requestAnimationFrame(tick)
// …perform the interaction, wait, then: on = false
```

  The state is whatever the glitch is about: for a jump, the element's `getBoundingClientRect().top`; for a flash, a count of rows or whether a placeholder is present; for a scroll bug, `scrollTop`. Keep only the frames where it changed, and the sequence is what the screen showed: a bubble's top going `102 → 124` is the jump, a message count going `1 → 0 → 1` is the blink. Through agent-browser, keep the samples on `window` (one `eval` arms the sampler, a later one reads them) and perform the interaction between the two.

- **Is it fixed?** Run the same sampler after the change. Done when the value holds through the interaction (the bubble's top stays `102`, the count never reaches `0`), which is stronger evidence than a clean report.

## Where causes have been

The causes so far were not in the component that looked wrong, but in two sources of truth landing in different ticks or shapes:

- A cache write and component state set together, delivered to the screen separately (TanStack Query's notification scheduling).
- A router transition rendering the pane while store subscribers, like the sidebar, update at once.
- A poll fired at the moment of an optimistic change, racing the request that makes it true.
- An optimistic row shaped differently from the server's echo, or an indicator inserted above content and removed later.
- Work scheduled with `requestAnimationFrame` from a `ResizeObserver` callback, which lands a frame late.
- A cached status trusted for a decision after it went stale, such as steering a send into a run that had already ended.
- The server rendering something the browser decides differently: state initialized from localStorage makes hydration disagree (React error #418, reported via `window.reportError`, i.e. a Playwright `pageerror`, not a console message) and React redoes the page; a server-rendered contenteditable takes typing that the editor then wipes. Give such a route `ssr: false`, or move the state where the server can read it.
- `React.lazy` suspending on its first render even when the module is already loaded, which blanks what it replaces for a frame; use `usePreloadedModule`.
- One cache entry written by two paths: an optimistic seed overwritten by a background seeding pass (the sidebar copying list summaries into thread details).

[TASTE.md](TASTE.md) has each instance with its fix.
