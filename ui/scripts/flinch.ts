/**
 * Turn a flinch (src/lib/flinch) into evidence an agent can look at:
 *
 *   report.md     what changed on screen around the flinch: short-lived and
 *                 remounted elements, text and attribute flips, layout shifts,
 *                 long frames, slow interactions, console errors
 *   frames/       the rrweb replay rendered frame by frame, each labelled
 *   sheets/       contact sheets of consecutive frames, for one-image review
 *   slowmo.mp4    the frames as a slow-motion video
 *   video-review.md  a video model's account of the slow-motion video
 *
 * Usage: node ui/scripts/flinch.ts [flinch.json] [--before ms] [--fps n] [--slow n]
 *        [--model openrouter/model] [--no-video-review]
 * Defaults to the newest file in logs/flinches/.
 */
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { chromium } from "@playwright/test"
import type { Page } from "@playwright/test"

import type { FlinchBundle } from "../src/lib/flinch/recorder.ts"

type RrwebEvent = FlinchBundle["events"][number]

const UI_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const FLINCH_DIR = join(UI_DIR, "..", "logs", "flinches")
const RRWEB_DIST = join(UI_DIR, "node_modules", "rrweb", "dist")
const DEFAULT_VIDEO_MODEL = "google/gemini-3.8-flash"
/** The taste spec the ui-jank skill keeps; the video reviewer judges against it. */
const TASTE_SPEC = join(
  UI_DIR,
  "..",
  ".claude",
  "skills",
  "ui-jank",
  "TASTE.md"
)
/** Elements that live shorter than this, or come back this fast, read as flicker. */
const FLICKER_MS = 300
/** A value that changes and changes back within this reads as a flip. */
const FLIP_MS = 500
const LABEL_HEIGHT = 28
const DRAWN_TAGS = new Set([
  "img",
  "svg",
  "video",
  "canvas",
  "picture",
  "iframe",
])
const DRAWN_ROLES = new Set(["progressbar", "status", "img", "alert"])
const SHEET_COLUMNS = 4
const SHEET_ROWS = 3

// rrweb's wire format (EventType / IncrementalSource / NodeType in @rrweb/types).
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3
const META = 4
const MUTATION = 0
const TEXT_NODE = 3

interface SerializedNode {
  id: number
  type: number
  tagName?: string
  attributes?: Record<string, string | number | boolean | null>
  textContent?: string
  childNodes?: Array<SerializedNode>
}

interface MutationData {
  source: number
  adds?: Array<{ parentId: number; node: SerializedNode }>
  removes?: Array<{ parentId: number; id: number }>
  texts?: Array<{ id: number; value: string | null }>
  attributes?: Array<{ id: number; attributes: Record<string, string | null> }>
}

interface TrackedNode {
  id: number
  parentId: number | null
  tag: string
  text: string
  attributes: Record<string, string>
  addedAt: number | null
  children: Set<number>
}

type FindingKind =
  | "short-lived element"
  | "remounted element"
  | "text flip"
  | "attribute flip"
  | "layout shift"
  | "long frame"
  | "slow interaction"
  | "console"

interface Finding {
  kind: FindingKind
  at: number
  /** When the transient state it describes began, for findings about one. */
  since?: number
  detail: string
}

interface Span {
  start: number
  end: number
}

interface Frame {
  index: number
  at: number
  file: string
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    before: { type: "string", default: "3000" },
    fps: { type: "string", default: "30" },
    slow: { type: "string", default: "10" },
    model: {
      type: "string",
      default: process.env.FLINCH_VIDEO_MODEL ?? DEFAULT_VIDEO_MODEL,
    },
    "no-video-review": { type: "boolean", default: false },
  },
})

function newestFlinch(): string {
  const files = existsSync(FLINCH_DIR)
    ? readdirSync(FLINCH_DIR).filter((name) => name.endsWith(".json"))
    : []
  const newest = files.sort().at(-1)
  if (!newest)
    throw new Error(
      `No flinches in ${FLINCH_DIR}; press Alt+Shift+F in the dashboard`
    )
  return join(FLINCH_DIR, newest)
}

// --- What changed on screen ------------------------------------------------------------

class DomTimeline {
  readonly nodes = new Map<number, TrackedNode>()
  readonly findings: Array<Finding> = []
  private readonly removed: Array<{
    parentId: number
    signature: string
    at: number
  }> = []
  private readonly textHistory = new Map<
    string,
    Array<{ value: string; at: number }>
  >()
  private readonly attributeHistory = new Map<
    string,
    Array<{ value: string; at: number }>
  >()

  replay(events: Array<RrwebEvent>): void {
    for (const event of events) {
      if (event.type === FULL_SNAPSHOT) {
        this.nodes.clear()
        const { node } = event.data as { node: SerializedNode }
        this.track(node, null, null)
      } else if (event.type === INCREMENTAL) {
        const data = event.data as MutationData
        if (data.source === MUTATION) this.mutate(data, event.timestamp)
      }
    }
  }

  private track(
    node: SerializedNode,
    parentId: number | null,
    at: number | null
  ): void {
    const attributes = Object.fromEntries(
      Object.entries(node.attributes ?? {}).map(([name, value]) => [
        name,
        String(value),
      ])
    )
    this.nodes.set(node.id, {
      id: node.id,
      parentId,
      tag:
        node.type === TEXT_NODE ? "#text" : (node.tagName ?? `#${node.type}`),
      text: node.type === TEXT_NODE ? (node.textContent ?? "") : "",
      attributes,
      addedAt: at,
      children: new Set(),
    })
    if (parentId !== null) this.nodes.get(parentId)?.children.add(node.id)
    for (const child of node.childNodes ?? []) this.track(child, node.id, at)
  }

  private mutate(data: MutationData, at: number): void {
    for (const { parentId, id } of data.removes ?? []) {
      const node = this.nodes.get(id)
      if (!node) continue
      // Removals already name the root of what left the page.
      if (this.visible(node)) {
        const signature = this.signature(node)
        if (node.addedAt !== null && at - node.addedAt <= FLICKER_MS) {
          this.findings.push({
            kind: "short-lived element",
            at,
            since: node.addedAt,
            detail: `${this.describe(node)} was on screen for ${Math.round(at - node.addedAt)}ms`,
          })
        }
        this.removed.push({ parentId, signature, at })
      }
      this.forget(id)
    }
    for (const { parentId, node } of data.adds ?? []) {
      this.track(node, parentId, at)
      const tracked = this.nodes.get(node.id)
      if (!tracked || !this.visible(tracked) || !this.subtreeRoot(tracked))
        continue
      const signature = this.signature(tracked)
      const gone = this.removed.find(
        (removal) =>
          removal.parentId === parentId &&
          removal.signature === signature &&
          at - removal.at <= FLICKER_MS
      )
      if (gone) {
        this.findings.push({
          kind: "remounted element",
          at,
          since: gone.at,
          detail: `${this.describe(tracked)} was removed and re-added ${Math.round(at - gone.at)}ms later`,
        })
      }
    }
    for (const { id, value } of data.texts ?? []) {
      const node = this.nodes.get(id)
      if (!node) continue
      node.text = value ?? ""
      this.flip(
        this.textHistory,
        String(id),
        node.text,
        at,
        ({ previous, since }) => ({
          kind: "text flip",
          at,
          since,
          detail: `text in ${this.describe(this.parent(node) ?? node)} went "${clip(previous)}" → … → back within ${FLIP_MS}ms`,
        })
      )
    }
    for (const { id, attributes } of data.attributes ?? []) {
      const node = this.nodes.get(id)
      if (!node) continue
      for (const [name, value] of Object.entries(attributes)) {
        if (value === null) delete node.attributes[name]
        else node.attributes[name] = value
        if (name !== "class" && name !== "style" && name !== "hidden") continue
        this.flip(
          this.attributeHistory,
          `${id}:${name}`,
          value ?? "",
          at,
          ({ since }) => ({
            kind: "attribute flip",
            at,
            since,
            detail: `${name} on ${this.describe(node)} changed and changed back within ${FLIP_MS}ms`,
          })
        )
      }
    }
  }

  private flip(
    histories: Map<string, Array<{ value: string; at: number }>>,
    key: string,
    value: string,
    at: number,
    finding: (transient: { previous: string; since: number }) => Finding
  ): void {
    const history = histories.get(key) ?? []
    const recent = history.filter((entry) => at - entry.at <= FLIP_MS)
    const earlier = recent.slice(0, -1).find((entry) => entry.value === value)
    const latest = recent.at(-1)
    if (earlier && latest && latest.value !== value)
      this.findings.push(finding({ previous: earlier.value, since: latest.at }))
    histories.set(key, [...recent, { value, at }])
  }

  private forget(id: number): void {
    const node = this.nodes.get(id)
    if (!node) return
    for (const child of node.children) this.forget(child)
    if (node.parentId !== null)
      this.nodes.get(node.parentId)?.children.delete(id)
    this.nodes.delete(id)
  }

  /** Whether this node, not an ancestor, is what was added: report a subtree once. */
  private subtreeRoot(node: TrackedNode): boolean {
    const parent = this.parent(node)
    return !parent || parent.addedAt === null || parent.addedAt !== node.addedAt
  }

  private parent(node: TrackedNode): TrackedNode | undefined {
    return node.parentId === null ? undefined : this.nodes.get(node.parentId)
  }

  private inHead(node: TrackedNode): boolean {
    for (
      let current: TrackedNode | undefined = node;
      current;
      current = this.parent(current)
    ) {
      if (
        ["head", "script", "style", "noscript", "template"].includes(
          current.tag
        )
      )
        return true
    }
    return false
  }

  /** Whether removing or adding this would show: text, or anything drawn without text. */
  private visible(node: TrackedNode): boolean {
    if (this.inHead(node)) return false
    return this.textOf(node).trim().length > 0 || this.drawsSomething(node)
  }

  private drawsSomething(node: TrackedNode): boolean {
    if (DRAWN_TAGS.has(node.tag)) return true
    if (
      DRAWN_ROLES.has(node.attributes.role ?? "") ||
      node.attributes["aria-busy"] === "true"
    )
      return true
    return [...node.children].some((child) => {
      const tracked = this.nodes.get(child)
      return tracked !== undefined && this.drawsSomething(tracked)
    })
  }

  private textOf(node: TrackedNode): string {
    if (node.tag === "#text") return node.text
    return [...node.children]
      .map((child) => this.nodes.get(child))
      .map((child) => (child ? this.textOf(child) : ""))
      .join(" ")
      .replace(/\s+/g, " ")
  }

  private firstDrawn(node: TrackedNode): TrackedNode | undefined {
    if (DRAWN_TAGS.has(node.tag) || DRAWN_ROLES.has(node.attributes.role ?? ""))
      return node
    for (const child of node.children) {
      const tracked = this.nodes.get(child)
      const drawn = tracked && this.firstDrawn(tracked)
      if (drawn) return drawn
    }
    return undefined
  }

  private label(node: TrackedNode): string {
    const classes = (node.attributes.class ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
    const name =
      node.attributes["aria-label"] ??
      node.attributes.alt ??
      node.attributes.role
    return `<${node.tag}${classes.length ? ` .${classes.join(".")}` : ""}>${name ? ` "${name}"` : ""}`
  }

  private signature(node: TrackedNode): string {
    return `${node.tag}|${this.textOf(node).trim().slice(0, 80)}`
  }

  describe(node: TrackedNode): string {
    const element = node.tag === "#text" ? (this.parent(node) ?? node) : node
    const path: Array<string> = []
    for (
      let current: TrackedNode | undefined = this.parent(element);
      current && path.length < 3;
      current = this.parent(current)
    ) {
      if (current.tag.startsWith("#")) break
      path.unshift(current.tag)
    }
    const label = element.attributes["aria-label"] ?? ""
    const classes = (element.attributes.class ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
    const text = clip(this.textOf(element).trim())
    const drawn = text ? undefined : this.firstDrawn(element)
    return [
      `<${[path.join(" > "), element.tag].filter(Boolean).join(" > ")}${classes.length ? ` .${classes.join(".")}` : ""}>`,
      label ? `aria-label="${label}"` : "",
      text ? `"${text}"` : "",
      drawn ? `drawing ${this.label(drawn)}` : "",
    ]
      .filter(Boolean)
      .join(" ")
  }

  describeId(id: number | null): string {
    const node = id === null ? undefined : this.nodes.get(id)
    return node ? this.describe(node) : `node ${id ?? "?"}`
  }
}

/**
 * Spans in which the browser painted nothing new: long animation frames, during
 * which the screen held what it showed when the frame began. A DOM state that
 * came and went inside one was never seen.
 */
function unpaintedSpans(bundle: FlinchBundle): Array<Span> {
  return bundle.signals.longFrames.map((frame) => ({
    start: frame.at,
    end: frame.at + frame.duration,
  }))
}

/** What the screen showed at `at`: the state as of the last paint. */
function presentedAt(at: number, unpainted: Array<Span>): number {
  return unpainted.find((span) => at > span.start && at < span.end)?.start ?? at
}

function wasPainted(finding: Finding, unpainted: Array<Span>): boolean {
  const { since } = finding
  return (
    since === undefined ||
    !unpainted.some((span) => since >= span.start && finding.at <= span.end)
  )
}

/** Spans in which the page was hidden, and so painted nothing at all. */
function hiddenSpans(bundle: FlinchBundle, until: number): Array<Span> {
  const changes = bundle.signals.visibility ?? []
  return changes.flatMap((change, index) =>
    change.state === "hidden"
      ? [{ start: change.at, end: changes[index + 1]?.at ?? until }]
      : []
  )
}

function clip(text: string, length = 60): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function signalFindings(
  bundle: FlinchBundle,
  dom: DomTimeline
): Array<Finding> {
  const { signals } = bundle
  return [
    ...signals.layoutShifts
      .filter((shift) => !shift.hadRecentInput)
      .map((shift) => ({
        kind: "layout shift" as const,
        at: shift.at,
        detail: `score ${shift.value.toFixed(3)}: ${shift.sources
          .map(
            (source) =>
              `${dom.describeId(source.nodeId)} moved ${Math.round(source.currentRect.y - source.previousRect.y)}px down, ${Math.round(source.currentRect.x - source.previousRect.x)}px right`
          )
          .join("; ")}`,
      })),
    ...signals.longFrames.map((frame) => ({
      kind: "long frame" as const,
      at: frame.at,
      detail: `${Math.round(frame.duration)}ms frame (${Math.round(frame.blockingDuration)}ms blocking)${frame.scripts.length ? `: ${frame.scripts.map((script) => `${script.sourceFunctionName || script.invoker} ${Math.round(script.duration)}ms`).join(", ")}` : ""}`,
    })),
    ...signals.interactions.map((interaction) => ({
      kind: "slow interaction" as const,
      at: interaction.at,
      detail: `${interaction.name} on ${dom.describeId(interaction.nodeId)} took ${Math.round(interaction.duration)}ms to paint (input delay ${Math.round(interaction.inputDelay)}ms, handlers ${Math.round(interaction.processing)}ms)`,
    })),
    ...signals.console.map((entry) => ({
      kind: "console" as const,
      at: entry.at,
      detail: `${entry.level}: ${clip(entry.message, 160)}`,
    })),
  ]
}

interface FindingGroup extends Finding {
  count: number
}

/** One line per burst: the same kind of change to sibling elements in one frame. */
function groupFindings(findings: Array<Finding>): Array<FindingGroup> {
  const groups = new Map<string, FindingGroup>()
  for (const finding of findings) {
    // Siblings differ only in their text, so the quoted text is not part of the key.
    const element = finding.detail.replace(/"[^"]*"/g, "")
    const key = `${finding.kind}|${Math.round(finding.at)}|${element}`
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { ...finding, count: 1 })
  }
  return [...groups.values()]
}

// --- Seeing it --------------------------------------------------------------------------

function viewportOf(events: Array<RrwebEvent>): {
  width: number
  height: number
} {
  const meta = events.find((event) => event.type === META)?.data as
    | { width: number; height: number }
    | undefined
  return { width: meta?.width ?? 1280, height: meta?.height ?? 800 }
}

async function openReplayer(
  page: Page,
  events: Array<RrwebEvent>,
  appUrl: string
): Promise<void> {
  // The recording keeps relative asset URLs; replaying from the app's origin
  // resolves them the way the page did, when its dev server is still running.
  await page.goto(new URL("/ok", appUrl).toString()).catch(() => undefined)
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#000">
       <div id="replay"></div>
       <div id="label" style="position:fixed;left:0;right:0;bottom:0;height:${LABEL_HEIGHT}px;
         background:#111;color:#fff;font:14px/28px ui-monospace,monospace;padding:0 10px"></div>
     </body></html>`
  )
  await page.addStyleTag({ path: join(RRWEB_DIST, "style.css") })
  await page.addScriptTag({ path: join(RRWEB_DIST, "rrweb.umd.cjs") })
  await page.evaluate((recordedJson) => {
    const recorded = JSON.parse(recordedJson) as Array<RrwebEvent>
    const { Replayer } = (
      window as unknown as { rrweb: typeof import("rrweb") }
    ).rrweb
    const replayer = new Replayer(recorded, {
      root: document.getElementById("replay") as HTMLElement,
      mouseTail: false,
      skipInactive: false,
      triggerFocus: false,
      showWarning: false,
      // Paused, rrweb would hold every animation at its first keyframe, so an
      // entrance (streamed words, a sliding bubble) stays invisible in every
      // frame. Pin each one at its end instead: frames show where motion lands.
      pauseAnimation: false,
      insertStyleRules: [
        "*, *::before, *::after { animation-delay: -1000s !important; animation-play-state: paused !important; transition: none !important; }",
      ],
    })
    ;(
      window as unknown as { replayer: InstanceType<typeof Replayer> }
    ).replayer = replayer
  }, JSON.stringify(events))
}

async function renderFrame(
  page: Page,
  offset: number,
  label: string,
  file: string
): Promise<void> {
  await page.evaluate(
    ({ seekTo, text }) => {
      const replayer = (
        window as unknown as { replayer: { pause: (at: number) => void } }
      ).replayer
      replayer.pause(seekTo)
      ;(document.getElementById("label") as HTMLElement).textContent = text
      return new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
    },
    { seekTo: offset, text: label }
  )
  await page.screenshot({ path: file })
}

function relative(at: number, flinchedAt: number): string {
  const ms = Math.round(at - flinchedAt)
  return `${ms >= 0 ? "+" : "−"}${Math.abs(ms)}ms`
}

async function contactSheets(
  page: Page,
  frames: Array<Frame>,
  dir: string
): Promise<Array<string>> {
  const perSheet = SHEET_COLUMNS * SHEET_ROWS
  const sheets: Array<string> = []
  for (let start = 0; start < frames.length; start += perSheet) {
    const chunk = frames.slice(start, start + perSheet)
    const cells = chunk
      .map(
        (frame) =>
          `<img src="data:image/png;base64,${readFileSync(frame.file).toString("base64")}" style="width:100%;display:block">`
      )
      .join("")
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.setContent(
      `<!doctype html><body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${SHEET_COLUMNS},1fr);gap:4px">${cells}</body>`
    )
    const file = join(
      dir,
      `sheet-${String(sheets.length + 1).padStart(2, "0")}.png`
    )
    await page.screenshot({ path: file, fullPage: true })
    sheets.push(file)
  }
  return sheets
}

function slowMotionVideo(
  frames: Array<Frame>,
  fps: number,
  slow: number,
  file: string
): boolean {
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-framerate",
        String(fps / slow),
        "-start_number",
        String(frames[0]?.index ?? 0),
        "-i",
        join(dirname(frames[0]?.file ?? ""), "%05d.png"),
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        file,
      ],
      { stdio: "inherit" }
    )
    return true
  } catch (error) {
    console.warn(
      `No slow-motion video (is ffmpeg installed?): ${String(error)}`
    )
    return false
  }
}

// --- A video model's eyes ---------------------------------------------------------------

function openRouterKey(): string | null {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  const file = join(homedir(), ".openrouter", "api_key")
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null
}

async function videoReview(
  video: string,
  model: string,
  context: { note: string; slow: number; fps: number; findings: string }
): Promise<string> {
  const key = openRouterKey()
  if (!key)
    return "Skipped: set OPENROUTER_API_KEY or write it to ~/.openrouter/api_key."
  const prompt = `You are reviewing a web app's UI for jank: small, almost imperceptible glitches that make it feel low quality.

The video is a frame-by-frame replay of the last few seconds before a person reacted to something that felt wrong. It plays ${context.slow}x slower than real time (${context.fps} captured frames per real second). The bar at the bottom of every frame shows its frame number and its time relative to the moment the person reacted.

${context.note ? `What the person said: "${context.note}"\n\n` : ""}Judge it against how this app should feel, the team's taste spec:

${existsSync(TASTE_SPEC) ? readFileSync(TASTE_SPEC, "utf8") : "(no taste spec found)"}

An automated DOM analysis flagged these moments (times relative to the reaction):
${context.findings || "(nothing flagged)"}

Report each glitch you see with the frame numbers it spans, what exactly changed on screen, and how noticeable it would be at full speed. Say plainly if you see nothing wrong. Do not speculate about code.`
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "video_url",
                video_url: {
                  url: `data:video/mp4;base64,${readFileSync(video).toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    }
  )
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string }
  }
  if (!response.ok)
    return `Video review failed (${response.status}): ${body.error?.message ?? "no detail"}`
  return body.choices?.[0]?.message?.content ?? "The model returned no review."
}

// --- Putting it together ----------------------------------------------------------------

async function main(): Promise<void> {
  const source = positionals[0] || newestFlinch()
  const bundle = JSON.parse(readFileSync(source, "utf8")) as FlinchBundle
  const events = [...bundle.events].sort((a, b) => a.timestamp - b.timestamp)
  const first = events[0]
  const last = events.at(-1)
  if (!first || !last) throw new Error(`${source} has no recorded events`)

  const out = join(dirname(source), basename(source, ".json"))
  rmSync(out, { recursive: true, force: true })
  const framesDir = join(out, "frames")
  const sheetsDir = join(out, "sheets")
  mkdirSync(framesDir, { recursive: true })
  mkdirSync(sheetsDir, { recursive: true })

  const dom = new DomTimeline()
  dom.replay(events)
  const unpainted = unpaintedSpans(bundle)
  const findings = [...dom.findings, ...signalFindings(bundle, dom)]
    .filter((finding) => wasPainted(finding, unpainted))
    .sort((a, b) => a.at - b.at)

  // People react a beat after they see something, so the window ends at the flinch,
  // or just after the last thing that changed if the page was idle by then.
  const fps = Number(values.fps)
  const slow = Number(values.slow)
  const end = Math.min(bundle.flinchedAt, last.timestamp + 300)
  const start = Math.max(first.timestamp, end - Number(values.before))
  const step = 1000 / fps

  const viewport = viewportOf(events)
  const browser = await chromium.launch()
  const frames: Array<Frame> = []
  try {
    const page = await browser.newPage({
      viewport: {
        width: viewport.width,
        height: viewport.height + LABEL_HEIGHT,
      },
    })
    await openReplayer(page, events, bundle.url)
    for (let at = start, index = 0; at <= end; at += step, index += 1) {
      const file = join(framesDir, `${String(index).padStart(5, "0")}.png`)
      await renderFrame(
        page,
        presentedAt(at, unpainted) - first.timestamp,
        `frame ${index}   ${relative(at, bundle.flinchedAt)}`,
        file
      )
      frames.push({ index, at, file })
    }
    const sheets = await contactSheets(page, frames, sheetsDir)
    const video = join(out, "slowmo.mp4")
    const hasVideo =
      frames.length > 1 && slowMotionVideo(frames, fps, slow, video)

    const inWindow = (finding: Finding) =>
      finding.at >= start - 2000 && finding.at <= bundle.flinchedAt
    const hidden = hiddenSpans(bundle, end).filter(
      (span) => span.start < end && span.end > start
    )
    const hiddenWarning = hidden.length
      ? `**Recorded in a hidden tab** (${hidden.map((span) => `${relative(Math.max(span.start, start), bundle.flinchedAt)} to ${relative(Math.min(span.end, end), bundle.flinchedAt)}`).join(", ")}): the browser painted nothing then and throttled timers and animation frames, so the frames show DOM states nobody saw, at distorted times. Re-record in a visible tab before trusting them.\n\n`
      : ""
    const findingLines = groupFindings(findings.filter(inWindow))
      .map(
        (group) =>
          `- ${relative(group.at, bundle.flinchedAt)} (frame ${Math.max(0, Math.round((group.at - start) / step))}) **${group.kind}**${group.count > 1 ? ` ×${group.count}` : ""}: ${group.detail}`
      )
      .join("\n")
    const review =
      hasVideo && !values["no-video-review"]
        ? await videoReview(video, values.model, {
            note: bundle.note,
            slow,
            fps,
            findings: hiddenWarning + findingLines,
          })
        : "Skipped."
    writeFileSync(join(out, "video-review.md"), `${review}\n`)

    const report = `# Flinch ${basename(source, ".json")}

- Page: ${bundle.url}
- Note: ${bundle.note || "(none)"}
- Viewport: ${viewport.width}×${viewport.height}
- Frames: ${frames.length} at ${fps} fps, ${relative(start, bundle.flinchedAt)} to ${relative(end, bundle.flinchedAt)} (frames/, label bar shows frame and time)
- Contact sheets: ${sheets.map((sheet) => basename(sheet)).join(", ")} (sheets/, ${SHEET_COLUMNS * SHEET_ROWS} consecutive frames each, left to right)
- Slow motion: ${hasVideo ? `slowmo.mp4 (${slow}× slower)` : "not rendered"}

## What changed on screen

${hiddenWarning}${findingLines || "Nothing flagged in the window; look at the frames."}

## Video review (${values.model})

${review}
`
    writeFileSync(join(out, "report.md"), report)
    console.log(join(out, "report.md"))
  } finally {
    await browser.close()
  }
}

await main()
