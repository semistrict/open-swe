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

## When the user flinches

1. `mise run flinch` analyzes the newest file in `logs/flinches/`; pass a path for another.
2. Find the moment: read `report.md`, `video-review.md`, and the contact sheets around each frame they name. Done when you can point to the exact frames and the element that changed in them.
3. Find the cause in the code and fix it.
4. Flinch the same flow yourself until it comes back clean.
5. Record the lesson in [TASTE.md](TASTE.md): extend the rule it violated with this instance, or add a rule if none covers it. Done when the entry names the flow, the frames' evidence, the cause, and the fix.

## Flinching a flow yourself

The dev server must be running (`mise run dev-ui`; the replay loads images and fonts from it). Drive a tab that is on screen: a hidden tab paints nothing and throttles its timers, so what it records is not what anyone sees, and the report says so at the top. `agent-browser --headed` opens a visible one; sign it in through the local dev login first:

```bash
agent-browser --headed open http://localhost:2024/dashboard/api/auth/dev-login
```

Perform the interaction (`agent-browser open`, `click`, or `eval`), then within a few seconds:

```bash
agent-browser eval '(async () => await window.__openSweFlinch.flinch("what you just did"))()'
```

It returns the saved path. Run `mise run flinch` (add `-- --before 6000` to widen the window, `--fps 60` for finer frames), then read the outputs next to the file:

- `report.md`: DOM-level findings, each at its frame number. **short-lived element** (on screen under 300 ms) and **remounted element** catch flicker and flashes; **text flip** and **attribute flip** catch values that bounce; **layout shift**, **long frame**, and **slow interaction** come from the browser itself.
- `sheets/`: 12 consecutive labeled frames per image. View the sheets around every frame a finding or the review names: they are what you see, and the final word.
- `video-review.md`: a video model's frame-numbered account of the slow-motion replay. It catches teardown-order and visual glitches the DOM analysis has no rule for.

The three sources disagree in useful ways. The DOM report is exact but only knows its rules; the video review sees anything but sometimes over-reports; the frames settle both. A broken image or missing font in every frame, including stable ones, is a replay artifact (the dev server was down during analysis), not jank. Canvas content is not replayed, and the TanStack devtools are excluded from recordings. Frames pin CSS animations at their end and skip transitions, so they show where motion lands, not the motion. The DOM changes far more often than the screen does: inside a **long frame** nothing is painted, so frames there show what the screen held when it began, and DOM states that came and went inside one are dropped from the report. Clicks the replay emulates carry a hover state, which a scripted `element.click()` never had.
