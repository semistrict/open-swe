import { useEffect, useState } from "react"

type Loader = () => Promise<unknown>

/** Modules already loaded, by loader, so a later mount has one at once. */
const loaded = new WeakMap<Loader, unknown>()

/**
 * A module loaded apart from the page, fetched as soon as the component
 * mounts and handed back once it has arrived (`null` until then, or while
 * `enabled` is false). Unlike `React.lazy`, which suspends on its first render
 * even when the module is already loaded, this renders a loaded module in the
 * same frame as whatever shows it.
 *
 * `load` must be a module-level function: it is the cache key.
 */
export function usePreloadedModule<T>(
  load: () => Promise<T>,
  enabled = true
): T | null {
  const [module, setModule] = useState<{ value: T } | null>(() =>
    loaded.has(load) ? { value: loaded.get(load) as T } : null
  )
  useEffect(() => {
    if (!enabled || module) return
    let live = true
    load().then(
      (value) => {
        loaded.set(load, value)
        if (live) setModule({ value })
      },
      (error: unknown) => {
        console.warn("Could not load part of the page", error)
      }
    )
    return () => {
      live = false
    }
  }, [enabled, load, module])
  return module?.value ?? null
}
