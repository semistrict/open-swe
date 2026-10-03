# Taste spec

How the Open SWE dashboard should feel. Each rule is the behaviour to build; under it are the flinches that taught it, newest first, with their status. `mise run flinch` hands this file to the video reviewer as its rubric, so write rules a person watching the replay could check.

## Content that was on screen stays on screen

Revisiting something the person already saw renders it immediately from what the client holds, then reconciles in place. Hydration, refetches, and route changes update content where it stands; a placeholder only ever fills space that has never had content.

- **2026-10-03, open.** Opening Concierge again showed `AgentThreadView`'s pulsing "Loading conversation" logo for 86 ms (frames 37-38, flinch `2026-10-03T04-52-55-124Z`) in place of a transcript already loaded once, with the composer gone. `isHydrating` replaces the whole view on every open of a transcript-v2 thread.

## A view switches in one step

Navigation keeps the old view whole until the new one can render, then swaps it in a single frame, or shows the new view's frame (header, composer, layout) at once and fills it in. The sidebar's selection and the main pane change together.

- **2026-10-03, open.** Going back to Concierge from New Thread: for ~100 ms the sidebar already selected Concierge while the pane still showed New Thread with its logo removed and its heading still up (frames 169-171, flinch `2026-10-03T04-52-55-124Z`).

## Loading states earn their place

A loading indicator appears only once the wait is long enough to notice (about 300 ms), and once shown it stays long enough to read (about 500 ms). A fast load shows the content and nothing else.

## Layout holds still

Space for content that arrives later is reserved at its final size, so nothing already on screen moves when it lands. The composer, headers, and sidebar keep their positions through loads and navigation.

## Feedback is immediate

Every click and keystroke changes something visible within 100 ms: the pressed state, the optimistic result, or the selection. An optimistic update that turns out wrong transitions to the real state; the person sees one change, not a change and its reversal.

## Focus, selection, and scroll survive updates

A refetch, a streamed message, or a re-render keeps the person's focus, text selection, and scroll position. Scroll follows new content only while the person is already at the bottom.
