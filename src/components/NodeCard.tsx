import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  Radio,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { CountryFlag } from "@/components/CountryFlag"
import { Meter } from "@/components/Meter"
import type { Node } from "@/lib/api"
import { bytes, daysUntil, FOREVER, osName, pair, percent, rate, uptime } from "@/lib/format"
import { useNodeLatency, type LatencyProbe } from "@/lib/latency"
import { cn } from "@/lib/utils"

function monthUsage(node: Node): number {
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
    case "up": return tx
    case "down": return rx
    case "max": return Math.max(rx, tx)
    default: return rx + tx
  }
}

function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

export function Status({ node }: { node: Node }) {
  const down = node.last_seen ? Date.now() / 1000 - node.last_seen : 0
  const label = node.online
    ? `在线 ${node.metrics ? uptime(node.metrics.uptime) : ""}`
    : deployed(node)
      ? `离线 ${down >= 60 ? uptime(down) : ""}`
      : "未接入"
  return (
    <Badge variant="outline" className={cn("tnum shrink-0 gap-1.5 font-normal", !node.online && "text-muted-foreground")}>
      <span className={cn("size-1.5 rounded-full", node.online ? "bg-[var(--online)]" : "bg-muted-foreground/40")} />
      {label.trim()}
    </Badge>
  )
}

export function Country({ node }: { node: Node }) {
  if (!node.country) return null
  return (
    <Badge variant="outline" className="shrink-0 gap-1 font-normal text-muted-foreground">
      <CountryFlag country={node.country} />{node.country}
    </Badge>
  )
}

function pingTone(latency: number | null) {
  if (latency === null) return "missing"
  if (latency < 100) return "good"
  if (latency < 180) return "fair"
  if (latency < 300) return "slow"
  return "bad"
}

function lossTone(loss: number | null) {
  if (loss === null) return "missing"
  if (loss === 0) return "good"
  if (loss < 5) return "fair"
  if (loss < 20) return "slow"
  return "bad"
}

function SpeedMeter({ label, direction, value }: { label: string; direction: "up" | "down"; value: number | null }) {
  const safe = Math.max(0, value ?? 0)
  const tone = safe < 1024 ? "cool" : safe < 1024 ** 2 ? "warm" : "hot"
  // A logarithmic fill keeps B/s, KB/s and MB/s meaningful on one compact bar.
  const active = safe > 0 ? Math.max(1, Math.min(20, Math.round(Math.log10(safe + 1) / Math.log10(10 * 1024 ** 2) * 20))) : 0
  const Arrow = direction === "up" ? ArrowUp : ArrowDown
  return (
    <div className="min-w-0" data-speed-tone={tone}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--speed-color)]"><Arrow className="size-3" />{label}</span>
        <strong className="tnum truncate text-base text-[var(--speed-color)]">{value === null ? "—" : rate(safe)}</strong>
      </div>
      <div className="speed-segments mt-1.5" title={`${label}实时速度：${value === null ? "暂无数据" : rate(safe)}`}>
        {Array.from({ length: 20 }, (_, index) => <span key={index} data-active={index < active ? "true" : "false"} />)}
      </div>
    </div>
  )
}

const CARD_TIME = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit",
})

function LatencyBlocks({ probe, kind }: { probe: LatencyProbe; kind: "latency" | "loss" }) {
  const samples: Array<LatencyProbe["samples"][number] | null> = probe.samples.length < 24
    ? [...Array<null>(24 - probe.samples.length).fill(null), ...probe.samples]
    : probe.samples
  return (
    <div className="latency-segments" aria-label={`${probe.name}${kind === "latency" ? "延迟" : "丢包"}走势`}>
      {samples.map((sample, index) => {
        const value = sample ? (kind === "latency" ? sample.latency : sample.loss) : null
        const detail = sample
          ? `${CARD_TIME.format(sample.ts * 1000)} · ${kind === "latency" ? (sample.latency === null ? "超时" : `${sample.latency.toFixed(1)} ms`) : `${sample.loss.toFixed(1)}%`}`
          : "暂无采样"
        return (
          <span
            key={index}
            data-tone={kind === "latency" ? pingTone(value) : lossTone(value)}
            data-tooltip={detail}
            aria-label={detail}
          />
        )
      })}
    </div>
  )
}

function LatencyRow({ probe }: { probe: LatencyProbe }) {
  return (
    <div className="latency-probe-row grid grid-cols-2 gap-4">
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px]">
          <span className="truncate text-muted-foreground" title={probe.name}>{probe.name}</span>
          <strong className="tnum shrink-0 font-semibold text-[var(--online)]">{probe.latency === null ? "—" : `${Math.round(probe.latency)} ms`}</strong>
        </div>
        <LatencyBlocks probe={probe} kind="latency" />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">丢包</span>
          <strong className={cn("tnum shrink-0 font-semibold", probe.loss > 0 ? "text-warn" : "text-[var(--online)]")}>{probe.loss.toFixed(1)}%</strong>
        </div>
        <LatencyBlocks probe={probe} kind="loss" />
      </div>
    </div>
  )
}

function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

function Expiry({ node }: { node: Node }) {
  const days = daysUntil(node.expires_at)
  if (days === null) return <span title="永不到期">{FOREVER}</span>
  const tone = days < 0 ? "text-destructive" : days <= 7 ? "text-warn" : ""
  return <span className={cn("tnum", tone)}>{days < 0 ? `已过期 ${-days} 天` : `${days} 天后到期`}</span>
}

export function NodeCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.metrics
  const loadPct = m && node.cpu_cores > 0 ? Math.min(100, (m.load[0] / node.cpu_cores) * 100) : null
  const usedTraffic = monthUsage(node)
  const remainingTraffic = node.traffic_limit > 0 ? Math.max(0, node.traffic_limit - usedTraffic) : null
  const latency = useNodeLatency(node.id, deployed(node))

  return (
    <Card
      onClick={onOpen}
      className="node-card min-w-0 cursor-pointer gap-0 p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-ring hover:shadow-md"
      role="button"
      tabIndex={0}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), onOpen())}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <CountryFlag country={node.country} />
            <h3 className="truncate text-[15px] font-bold">{node.name}</h3>
          </div>
          <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
            {node.os ? osName(node.os) : "等待首次上报"}
            {node.virt && node.virt !== "none" ? ` · ${node.virt}` : ""}
            {node.arch ? ` · ${node.arch}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
          <span className={cn("size-2 rounded-full", node.online ? "bg-[var(--online)] shadow-[0_0_0_3px_var(--online-soft)]" : "bg-muted-foreground/40")} />
          {node.online ? "在线" : "离线"}
        </div>
      </div>

      {deployed(node) ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3.5">
            <Meter
              label={<span className="inline-flex items-center gap-1"><Cpu className="size-3" />CPU</span>}
              pct={m ? m.cpu : null}
              tone="cpu"
              foot={`${node.cpu_cores} 核`}
            />
            <Meter
              label={<span className="inline-flex items-center gap-1"><MemoryStick className="size-3" />内存</span>}
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              tone="memory"
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              label={<span className="inline-flex items-center gap-1"><HardDrive className="size-3" />磁盘</span>}
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              tone="disk"
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            <Meter
              label={<span className="inline-flex items-center gap-1"><Gauge className="size-3" />负载</span>}
              pct={loadPct}
              tone="load"
              foot={m ? m.load.map((value) => value.toFixed(2)).join(" ") : "—"}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t pt-3.5 text-xs">
            <SpeedMeter label="上行" direction="up" value={m?.net_tx ?? null} />
            <SpeedMeter label="下行" direction="down" value={m?.net_rx ?? null} />
            <span className="tnum inline-flex items-center justify-between gap-1 text-muted-foreground"><span>出站</span>{bytes(node.total_tx)}</span>
            <span className="tnum inline-flex items-center justify-between gap-1 text-muted-foreground"><span>入站</span>{bytes(node.total_rx)}</span>
          </div>

          <div className="mt-3 border-t pt-3">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1 text-muted-foreground"><Database className="size-3" />剩余流量</span>
              <span className="tnum truncate text-muted-foreground">{remainingTraffic === null ? FOREVER : bytes(remainingTraffic)} · {trafficFoot(node)}</span>
            </div>
            <Meter label="" pct={node.traffic_limit > 0 ? percent(usedTraffic, node.traffic_limit) : null} empty={FOREVER} foot="" tone="traffic" />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-4 border-t py-3 text-[11px]">
            <span className="inline-flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1 text-muted-foreground"><Network className="size-3" />TCP 连接</span><strong className="tnum text-[var(--online)]">{m?.tcp ?? "—"}</strong></span>
            <span className="inline-flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1 text-muted-foreground"><Radio className="size-3" />UDP 连接</span><strong className="tnum text-[var(--online)]">{m?.udp ?? "—"}</strong></span>
          </div>

          <div className="space-y-2.5 border-t py-3">
            {latency.probes.length > 0 ? latency.probes.map((probe) => (
              <LatencyRow key={probe.id} probe={probe} />
            )) : (
              <p className="text-[10px] text-muted-foreground">{latency.loaded ? "暂无网络延迟数据" : "正在加载网络延迟…"}</p>
            )}
          </div>

          <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className={cn("size-1.5 rounded-full", node.online ? "bg-[var(--online)]" : "bg-muted-foreground/40")} />{node.online && m ? uptime(m.uptime) : "离线"}</span>
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3" /><Expiry node={node} /></span>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">还没有接入。在后台生成安装命令并执行一次。</p>
      )}
    </Card>
  )
}
