/**
 * Dev-only "flinch" recorder: the last ~30s of what the page did, saved the moment
 * someone reacts to it (Alt+Shift+F, or `window.__openSweFlinch.flinch()` from an
 * agent driving the browser).
 *
 * rrweb records the DOM as a replayable stream; PerformanceObservers record what
 * the browser measured on the same wall clock. Nodes are referenced by rrweb's
 * mirror ids, so `mise run flinch` can find every shifted or slow element in the
 * replay. Bundles are written to logs/flinches/ by the Vite dev server.
 */
import { EventType, record } from "rrweb"
import type { eventWithTime } from "rrweb"

/** One rrweb checkout per segment; two retained segments keep 20-30s of history. */
const CHECKOUT_EVERY_MS = 15_000
const RETAINED_SEGMENTS = 2
const RETAINED_SIGNAL_MS = 60_000
const MAX_CONSOLE_ENTRIES = 200
const DEVTOOLS_SELECTOR = "#tanstack_devtools"

export interface LayoutShiftSignal {
  at: number
  value: number
  hadRecentInput: boolean
  sources: Array<{
    nodeId: number | null
    previousRect: Rect
    currentRect: Rect
  }>
}

export interface LongFrameSignal {
  at: number
  duration: number
  blockingDuration: number
  scripts: Array<{
    invoker: string
    sourceURL: string
    sourceFunctionName: string
    duration: number
  }>
}

export interface InteractionSignal {
  at: number
  name: string
  duration: number
  inputDelay: number
  processing: number
  nodeId: number | null
}

export interface ResourceSignal {
  at: number
  name: string
  initiatorType: string
  duration: number
}

export interface ConsoleSignal {
  at: number
  level: "error" | "warn"
  message: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface FlinchBundle {
  version: 1
  /** Epoch ms of the flinch, on the same clock as rrweb event timestamps. */
  flinchedAt: number
  note: string
  url: string
  viewport: { width: number; height: number; devicePixelRatio: number }
  userAgent: string
  events: Array<eventWithTime>
  signals: {
    layoutShifts: Array<LayoutShiftSignal>
    longFrames: Array<LongFrameSignal>
    interactions: Array<InteractionSignal>
    resources: Array<ResourceSignal>
    console: Array<ConsoleSignal>
  }
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
  sources: Array<{
    node: Node | null
    previousRect: DOMRectReadOnly
    currentRect: DOMRectReadOnly
  }>
}

interface LongAnimationFrameEntry extends PerformanceEntry {
  blockingDuration: number
  scripts: Array<{
    invoker: string
    sourceURL: string
    sourceFunctionName: string
    duration: number
  }>
}

interface EventTimingEntry extends PerformanceEntry {
  processingStart: number
  processingEnd: number
  target: Node | null
}

const segments: Array<Array<eventWithTime>> = [[]]
const signals: FlinchBundle["signals"] = {
  layoutShifts: [],
  longFrames: [],
  interactions: [],
  resources: [],
  console: [],
}
let started = false

function epoch(startTime: number): number {
  return performance.timeOrigin + startTime
}

function nodeId(node: Node | null): number | null {
  if (!node) return null
  const id = record.mirror.getId(node)
  return id > 0 ? id : null
}

function rect(r: DOMRectReadOnly): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

function prune<T extends { at: number }>(
  list: Array<T>,
  limit = Infinity
): void {
  const oldest = Date.now() - RETAINED_SIGNAL_MS
  while (
    list.length > 0 &&
    ((list[0]?.at ?? 0) < oldest || list.length > limit)
  ) {
    list.shift()
  }
}

function observe(
  type: string,
  onEntry: (entry: PerformanceEntry) => void,
  init?: object
): void {
  if (!PerformanceObserver.supportedEntryTypes.includes(type)) return
  new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe(
    {
      type,
      buffered: true,
      ...init,
    }
  )
}

function observePerformance(): void {
  observe("layout-shift", (entry) => {
    const shift = entry as LayoutShiftEntry
    signals.layoutShifts.push({
      at: epoch(shift.startTime),
      value: shift.value,
      hadRecentInput: shift.hadRecentInput,
      sources: shift.sources.map((source) => ({
        nodeId: nodeId(source.node),
        previousRect: rect(source.previousRect),
        currentRect: rect(source.currentRect),
      })),
    })
    prune(signals.layoutShifts)
  })
  observe("long-animation-frame", (entry) => {
    const frame = entry as LongAnimationFrameEntry
    signals.longFrames.push({
      at: epoch(frame.startTime),
      duration: frame.duration,
      blockingDuration: frame.blockingDuration,
      scripts: frame.scripts.map((script) => ({
        invoker: script.invoker,
        sourceURL: script.sourceURL,
        sourceFunctionName: script.sourceFunctionName,
        duration: script.duration,
      })),
    })
    prune(signals.longFrames)
  })
  observe(
    "event",
    (entry) => {
      const event = entry as EventTimingEntry
      signals.interactions.push({
        at: epoch(event.startTime),
        name: event.name,
        duration: event.duration,
        inputDelay: event.processingStart - event.startTime,
        processing: event.processingEnd - event.processingStart,
        nodeId: nodeId(event.target),
      })
      prune(signals.interactions)
    },
    { durationThreshold: 16 }
  )
  observe("resource", (entry) => {
    const resource = entry as PerformanceResourceTiming
    signals.resources.push({
      at: epoch(resource.startTime),
      name: resource.name,
      initiatorType: resource.initiatorType,
      duration: resource.duration,
    })
    prune(signals.resources)
  })
}

function captureConsole(): void {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: Array<unknown>) => {
      signals.console.push({
        at: Date.now(),
        level,
        message: args
          .map((arg) => (typeof arg === "string" ? arg : safeJson(arg)))
          .join(" "),
      })
      prune(signals.console, MAX_CONSOLE_ENTRIES)
      original(...args)
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function startFlinchRecorder(): void {
  if (started) return
  started = true
  record({
    emit(event, isCheckout) {
      // A checkout flags both its Meta and its FullSnapshot; the Meta opens the segment.
      if (isCheckout && event.type === EventType.Meta) {
        segments.push([])
        while (segments.length > RETAINED_SEGMENTS) segments.shift()
      }
      segments[segments.length - 1]?.push(event)
    },
    checkoutEveryNms: CHECKOUT_EVERY_MS,
    // Developer tooling, not the product: its churn would bury the app's.
    blockSelector: DEVTOOLS_SELECTOR,
    sampling: { mousemove: 50, scroll: 16 },
  })
  observePerformance()
  captureConsole()
}

export function flinchBundle(note = ""): FlinchBundle {
  return {
    version: 1,
    flinchedAt: Date.now(),
    note,
    url: location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    userAgent: navigator.userAgent,
    events: segments.flat(),
    signals: structuredClone(signals),
  }
}

/** Save a flinch through the dev server; resolves to the written file's path. */
export async function saveFlinch(note = ""): Promise<string> {
  const response = await fetch("/__flinch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flinchBundle(note)),
  })
  if (!response.ok)
    throw new Error(`Saving the flinch failed: ${response.status}`)
  const { path } = (await response.json()) as { path: string }
  return path
}
