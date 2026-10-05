import { Skeleton } from "@/components/ui/skeleton"

/** The main pane's placeholder while what it will show is still unknown. */
export function PaneSkeleton() {
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center p-6">
      <Skeleton className="h-40 w-full max-w-md" />
    </main>
  )
}
