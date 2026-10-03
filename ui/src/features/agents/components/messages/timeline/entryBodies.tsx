import { memo } from "react"

import { MessageImage } from "../MessageImage"
import { ToolResultBody } from "./ToolResultBody"
import type {
  AnyImageChunk,
  ToolExecutionChunk,
} from "@/features/agents/lib/types"

export const ShellEntryBody = memo(function ShellEntryBody({
  chunk,
  loadedText,
  loadError,
}: {
  chunk: ToolExecutionChunk
  /** Full output fetched on expand; the chunk alone holds only a preview. */
  loadedText?: string | null
  loadError?: string | null
}) {
  const command =
    typeof chunk.input?.command === "string" ? chunk.input.command : ""
  const output = loadedText ?? chunk.output ?? ""
  const pendingOutput = Boolean(chunk.loadOutput) && loadedText == null

  return (
    <div className="space-y-1.5">
      {command && (
        <pre className="cursor-text overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre text-foreground/85 select-text">
          <span className="text-muted-foreground/80">$ </span>
          {command}
        </pre>
      )}
      {output && <ToolResultBody value={output} />}
      {loadError && <p className="text-[12px] text-destructive">{loadError}</p>}
      {!loadError && pendingOutput && (
        <p className="font-mono text-[12px] text-muted-foreground">
          {output ? "Loading the rest of the output…" : "Loading output…"}
        </p>
      )}
      {!output && !pendingOutput && chunk.status === "in_progress" && (
        <p className="font-mono text-[12px] text-muted-foreground">Running…</p>
      )}
      {!output && !pendingOutput && chunk.status === "pending" && (
        <p className="font-mono text-[12px] text-warning-foreground">
          Waiting for approval…
        </p>
      )}
    </div>
  )
})

/** A tool result that is an image (a read of a PNG, say): the image itself, then any text. */
export const ToolImagesBody = memo(function ToolImagesBody({
  images,
  output,
}: {
  images: Array<AnyImageChunk>
  output?: string | null
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((image, index) => (
          <MessageImage
            key={index}
            chunk={image}
            className="block h-auto max-h-80 max-w-full rounded-md border border-border/60 object-contain"
          />
        ))}
      </div>
      {output && <ToolResultBody value={output} />}
    </div>
  )
})
