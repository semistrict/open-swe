/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLoadingIndicator } from "./useNoticeableWait"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("useLoadingIndicator", () => {
  it("never shows for a wait that ends before it is noticeable", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useLoadingIndicator(active),
      { initialProps: { active: true } }
    )
    act(() => vi.advanceTimersByTime(250))
    rerender({ active: false })
    act(() => vi.advanceTimersByTime(1000))

    expect(result.current).toBe(false)
  })

  it("stays up long enough to read once shown, then goes", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useLoadingIndicator(active),
      { initialProps: { active: true } }
    )
    act(() => vi.advanceTimersByTime(300))
    expect(result.current).toBe(true)

    // The wait ends 50 ms after the indicator appeared.
    act(() => vi.advanceTimersByTime(50))
    rerender({ active: false })
    act(() => vi.advanceTimersByTime(400))
    expect(result.current).toBe(true)

    act(() => vi.advanceTimersByTime(50))
    expect(result.current).toBe(false)
  })
})
