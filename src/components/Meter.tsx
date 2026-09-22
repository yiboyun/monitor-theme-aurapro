import type { ReactNode } from "react"

type Props = {
  label: ReactNode
  pct: number | null
  foot: ReactNode
  empty?: ReactNode
  tone?: "cpu" | "memory" | "disk" | "load" | "traffic"
}

/**
 * One metric: name and percentage on top, bar in the middle, raw numbers
 * underneath. Monochrome, since the length of the bar carries the message.
 */
export function Meter({ label, pct, foot, empty = "—", tone = "cpu" }: Props) {
  // null means the metric has no ceiling to fill, so the bar stays empty rather
  // than reporting 0%. What replaces the percentage depends on the reason:
  // unknown for a node with no metrics, ∞ for a plan with no limit.
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  // A lightly loaded machine commonly sits below one sixteenth of the scale.
  // Keep a truthful numeric label but light one segment for every non-zero value
  // so CPU, load and a freshly used traffic quota do not look missing.
  const active = filled > 0 ? Math.max(1, Math.round((filled / 100) * 16)) : 0
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className="tnum text-xs font-medium">
          {pct === null ? empty : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`}
        </span>
      </div>
      <div
        className="meter-segments mt-1.5"
        data-tone={tone}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(filled)}
      >
        {Array.from({ length: 16 }, (_, index) => (
          <span key={index} data-active={index < active ? "true" : "false"} />
        ))}
      </div>
      <div className="tnum mt-1.5 truncate text-xs text-muted-foreground">{foot}</div>
    </div>
  )
}
