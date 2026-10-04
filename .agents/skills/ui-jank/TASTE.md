# Taste spec

How the Open SWE dashboard should feel. Each rule is the behaviour to build; under it are the flinches that taught it, newest first, with their status. `mise run flinch` hands this file to the video reviewer as its rubric, so write rules a person watching the replay could check.

## Content that was on screen stays on screen

Revisiting something the person already saw renders it immediately from what the client holds, then reconciles in place. Hydration, refetches, and route changes update content where it stands; a placeholder only ever fills space that has never had content.

- **2026-10-04, fixed.** Starting a new thread with Enter, the prompt vanished for a frame as the thread page took over from New Thread (rAF sampling: one frame with no message and the hydrating placeholder). The sidebar's `useSeedAgentThreadDetails` copies list summaries into thread details for every row but the open one; on New Thread nothing is open, so after the list refetch it overwrote the optimistic detail carrying the prompt as a pending message. It now leaves details with a pending send alone.
- **2026-10-03, withdrawn.** A recording seemed to show `AgentThreadView`'s pulsing "Loading conversation" logo for 86 ms on opening Concierge again (flinch `2026-10-03T04-52-55-124Z`, frames 37-38). That recording came from a hidden tab, whose throttled timers stretch every wait. Re-recorded on screen, two revisits render straight from the transcript cache, with no placeholder (flinch `2026-10-03T06-02-38-978Z`).

## A view switches in one step

Navigation keeps the old view whole until the new one can render, then swaps it in a single frame, or shows the new view's frame (header, composer, layout) at once and fills it in. The sidebar's selection and the main pane change together.

- **2026-10-03, withdrawn.** Replays seemed to show the sidebar selecting Concierge ~70-100 ms before the pane left New Thread (flinches `2026-10-03T04-52-55-124Z` and `2026-10-03T06-02-38-978Z`). The DOM did pass through that state, but inside a single ~100 ms long frame, so it was never painted; the first recording was also from a hidden tab. The analyzer now renders only what was painted, and the switch is one step.

## Loading states earn their place

A loading indicator appears only once the wait is long enough to notice (about 300 ms), and once shown it stays long enough to read (about 500 ms). A fast load shows the content and nothing else.

- **2026-10-04, fixed.** Opening a thread from the search palette flashed `AgentThreadView`'s pulsing "Loading conversation" logo for 60-100 ms before the transcript painted (flinch `2026-10-04T03-01-14-462Z`, frames 94-96; confirmed painted by rAF sampling in a visible tab). The placeholder now holds the space and shows the logo only after `useNoticeableWait` (300 ms), the hook `SendingStatus` also uses.
- **2026-10-03, fixed.** Every sent message showed "Sending" under its bubble for ~50 ms before the transcript echoed it (flinch `2026-10-03T05-28-48-951Z`, −6583 ms). `UserMessage` now holds that row empty and says "Sending" only after 300 ms.
- **2026-10-03, fixed.** The sidebar's running spinner showed for ~40 ms on send, then stayed off for the whole run (flinch `2026-10-03T05-37-26-540Z`, −5581 ms). Marking the thread running started the list poll at once, racing the send to the server; summaries followed LangGraph, which only turns busy once the queued run starts, so the poll said idle and polling stopped. Summaries of transcript threads now report running while the transcript has an open turn, the open thread mirrors its live transcript status into the cached thread, and a newly started poll waits one interval (flinch `2026-10-03T05-51-10-409Z`: on from send to reply).

## Layout holds still

Space for content that arrives later is reserved at its final size, so nothing already on screen moves when it lands. The composer, headers, and sidebar keep their positions through loads and navigation. An optimistic row has the shape of the row that replaces it.

- **2026-10-04, fixed.** Starting a new thread, the first bubble dropped 22 px when its "Ramon" label appeared ~1.5 s after sending (flinch `2026-10-04T03-56-50-367Z`, frame 100). The 2026-10-03 fix borrowed the sender from the viewer's latest message in the thread, and a new thread has none; the transcript's `turn.requested` row is plain text too, until the run re-records the message with its sender. Optimistic messages and live-turn messages still awaiting a name now hold the label row (rAF sampling: bubble top fixed at 102 px).
- **2026-10-04, fixed.** Reloading a repository thread, the sidebar's `open-swe` group showed only the open thread, then two more rows ~140 ms later, pushing "No repository" and everything below down 68 px; the nav also dropped a row when Concierge arrived with the profile (flinch `2026-10-04T03-15-02-763Z`, frames 0-2). Each repository group fetches its first page only after the repository list loads, and Concierge waits on session then profile. The sections now stay mounted but hidden until every expanded group has a page and then appear together (once; later expansions never hide them), and Concierge's row is held while its answer is pending (flinch `2026-10-04T03-23-39-963Z`: one step at frame 3). Trade-off: on reload the thread list lands ~100 ms after the main pane rather than in pieces.
- **2026-10-03, fixed.** A plain reply jumped up 39 px the moment its turn ended (flinch `2026-10-03T05-25-28-988Z`, frames 48-50). `AgentTurn` rendered its work fold row ("Writing response…") above the text while streaming, and dropped it at the end because there was no work to fold; the copy row under the reply also grew from 9 to 20 px. The fold row now appears only for turns with work, a plain reply shows the thread's "Working…" indicator until its text replaces it, and the copy row is sized from the start.
- **2026-10-03, fixed.** A sent bubble grew 20 px and shifted down when the transcript echoed it (flinch `2026-10-03T05-17-16-558Z`, −17.1 s): the optimistic row had no sender name or timestamp row, the echo had both. Optimistic rows now carry the viewer's sender attribution from their latest message in the thread and the timestamp row's height.

## Feedback is immediate

Every click and keystroke changes something visible within 100 ms: the pressed state, the optimistic result, or the selection. An optimistic update that turns out wrong transitions to the real state; the person sees one change, not a change and its reversal.

- **2026-10-03, fixed.** Sending flashed the composer's button Stop → Send → Stop within 20 ms (flinch `2026-10-03T05-28-48-951Z`, −6655 ms). The send set the thread `running` with `setQueryData`, but TanStack Query delivered that on `setTimeout(0)`, after the composer had already cleared its own `submitting` flag, so one render had neither. Cache notifications are now scheduled on a microtask (`ui/src/lib/query.ts`), landing in the same task as the state set beside them.

- **2026-10-04, fixed.** Choosing a thread in the search palette showed the full command list for ~110 ms as the palette closed (flinch `2026-10-04T03-01-14-462Z`, frames 90-93; rAF sampling: query `""` with 27 options painted before the dialog left). The query was cleared when `open` turned false, but the dialog stays painted through its fade-out. It is now cleared in `onOpenChangeComplete`.

## Focus, selection, and scroll survive updates

A refetch, a streamed message, or a re-render keeps the person's focus, text selection, and scroll position. Scroll follows new content only while the person is already at the bottom.

## Everything appears once

Each message, row, and item is on screen once, however many paths deliver it: the optimistic copy, the server's echo, a stream, and a refetch all land on the same row.

- **2026-10-03, fixed.** The user's earlier message ("now?") showed twice after they sent "telephone" six seconds after a reply (flinch `2026-10-03T06-14-10-478Z`, React's duplicate-key warning from −10.6 s). The commands proxy decided the thread was busy from a cached `latest_run_status` that only summary reads refresh, and the open thread had stopped polling once the transcript said the turn ended. So the send was steered into a run that had already finished. The follow-up run it dispatched opened its own turn for the newest human message in state, which was the previous message. The proxy now asks the run itself before trusting the cache, and the middleware requests a turn only for a message the transcript does not already hold.
