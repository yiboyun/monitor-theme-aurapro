import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Server } from "lucide-react"

import { Card } from "@/components/ui/card"
import { speedHistory, type Node } from "@/lib/api"
import { bytes, rate } from "@/lib/format"
import { cn } from "@/lib/utils"

function Tile({ icon: Icon, label, children, metric }: {
  icon: typeof Server
  label: string
  children: React.ReactNode
  metric: string
}) {
  return (
    <Card className="summary-card gap-0 p-4" data-metric={metric}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      {children}
    </Card>
  )
}

function Flow({ down, up, compact = false }: { down: number; up: number; compact?: boolean }) {
  return (
    <div className={cn("tnum flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", compact && "gap-x-2")}>
      <span className="inline-flex items-center gap-1">
        <ArrowUp className="size-3 text-[var(--traffic-up)]" />
        {compact ? bytes(up).replace(" ", "") : bytes(up)}
      </span>
      <span className="inline-flex items-center gap-1">
        <ArrowDown className="size-3 text-[var(--traffic-down)]" />
        {compact ? bytes(down).replace(" ", "") : bytes(down)}
      </span>
    </div>
  )
}

function totalLabel(value: number) {
  const [amount, unit = "B"] = bytes(value).split(" ")
  return { amount, unit }
}

export function Summary({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((node) => node.online)
  const sum = (pick: (node: Node) => number) => nodes.reduce((total, node) => total + pick(node), 0)
  const now = speedHistory.at(-1) ?? { rx: 0, tx: 0 }
  const realtime = totalLabel(now.rx + now.tx)
  const monthDown = sum((node) => node.month_rx)
  const monthUp = sum((node) => node.month_tx)
  const todayDown = sum((node) => node.day_rx)
  const todayUp = sum((node) => node.day_tx)
  const month = totalLabel(monthDown + monthUp)
  const today = totalLabel(todayDown + todayUp)
  const onlinePercent = nodes.length > 0 ? (online.length / nodes.length) * 100 : 0

  return (
    <section className="summary-grid grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="节点总览">
      <Tile icon={Server} label="在线节点" metric="online">
        <div className="tnum mt-2 flex items-baseline gap-1 text-2xl font-bold tracking-tight">
          {online.length}<span className="text-xs font-semibold text-muted-foreground">/ {nodes.length}</span>
        </div>
        <div className="mt-auto pt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-[var(--online)] transition-[width] duration-500" style={{ width: `${onlinePercent}%` }} />
          </div>
        </div>
      </Tile>

      <Tile icon={Activity} label="实时带宽" metric="bandwidth">
        <div className="tnum mt-2 flex items-baseline gap-1 text-2xl font-bold tracking-tight text-[var(--bandwidth)]">
          {realtime.amount}<span className="text-xs font-semibold text-muted-foreground">{realtime.unit}/s</span>
        </div>
        <div className="mt-auto pt-2">
          <div className="tnum flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><ArrowUp className="size-3" />{rate(now.tx)}</span>
            <span className="inline-flex items-center gap-1"><ArrowDown className="size-3" />{rate(now.rx)}</span>
          </div>
        </div>
      </Tile>

      <Tile icon={ArrowDownUp} label="本月流量" metric="month">
        <div className="tnum mt-2 flex items-baseline gap-1 text-2xl font-bold tracking-tight">
          {month.amount}<span className="text-xs font-semibold text-muted-foreground">{month.unit}</span>
        </div>
        <div className="mt-auto pt-2"><Flow down={monthDown} up={monthUp} compact /></div>
      </Tile>

      <Tile icon={ArrowDownUp} label="今日流量" metric="today">
        <div className="tnum mt-2 flex items-baseline gap-1 text-2xl font-bold tracking-tight">
          {today.amount}<span className="text-xs font-semibold text-muted-foreground">{today.unit}</span>
        </div>
        <div className="mt-auto pt-2"><Flow down={todayDown} up={todayUp} compact /></div>
      </Tile>
    </section>
  )
}
