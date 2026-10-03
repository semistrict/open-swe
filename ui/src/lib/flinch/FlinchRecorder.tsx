import { useEffect } from "react"
import { toast } from "sonner"

import { saveFlinch, startFlinchRecorder } from "@/lib/flinch/recorder"

declare global {
  interface Window {
    /** Lets an agent driving the browser flinch on purpose, with a note. */
    __openSweFlinch?: { flinch: (note?: string) => Promise<string> }
  }
}

async function flinch(note?: string): Promise<string> {
  try {
    const path = await saveFlinch(note)
    toast.success("Flinch saved", {
      description: path,
      action: {
        label: "Copy",
        onClick: () => void copyPath(path),
      },
    })
    return path
  } catch (error) {
    toast.error("Could not save the flinch", { description: String(error) })
    throw error
  }
}

async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path)
    toast.success("Flinch path copied")
  } catch (error) {
    // Keep the path on screen to select by hand.
    toast.error("Could not copy the flinch path", {
      description: path,
      duration: Infinity,
      closeButton: true,
    })
    console.warn("Could not copy the flinch path", error)
  }
}

/** Dev builds only: records continuously and saves the last ~30s on Alt+Shift+F. */
export default function FlinchRecorder() {
  useEffect(() => {
    startFlinchRecorder()
    window.__openSweFlinch = { flinch }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "KeyF" || !event.altKey || !event.shiftKey) return
      event.preventDefault()
      void flinch().catch(() => {})
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [])
  return null
}
