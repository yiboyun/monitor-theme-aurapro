import { useEffect, useMemo, useState } from "react"
import { median } from "d3-array"
import {
  Area, AreaChart, Brush, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Country, Status } from "@/components/NodeCard"
import { api, type Node } from "@/lib/api"
import {
  axisBytes, axisTop, bytes, clockFor, quarters, cpuName, CYCLES, FOREVER, money, osName, pair, rate, timeTicks, uptime,
} from "@/lib/format"

type Point = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
}

type LivePoint = {
  ts: number
  tcp: number
  udp: number
  procs: number
}
// `latency` is the bucket's median round trip, null when every probe in it timed
// out. `band` is the range its answers spanned, absent when they spanned nothing.
// `loss` is the percentage that timed out, absent when none did.
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
/** Probe names by id, sent alongside the samples they label. */
type Probes = Record<string, string>
/**
 * Proportion of the whole window each probe lost, by id, absent for probes that
 * lost nothing. Sent because it cannot be derived here: every bucket's `loss` is
 * already a percentage of that bucket, so the sample counts it was divided by are
 * unavailable. Averaging them would weight a bucket holding one sample equally
 * with one holding twelve, and the window's first and last buckets are partial
 * regardless of what the probe does.
 */
type Loss = Record<string, number>

const RANGES = [
  { hours: 1, label: "1 小时" },
  { hours: 6, label: "6 小时" },
  { hours: 12, label: "12 小时" },
  { hours: 24, label: "24 小时" },
  { hours: 48, label: "2 天" },
  { hours: 168, label: "7 天" },
]

const RANGES_FOR = { resources: RANGES, latency: RANGES }

const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false }

// No grow-in animation: it would spend 1.5 s drawing a line across the panel on
// every range change, on a page meant to be read at a glance, and on the latency
// chart across seven hundred points per probe.
const SERIES = { dot: false as const, strokeWidth: 1.5, isAnimationActive: false }

// One width for every stacked panel's value axis. Sized to their own labels --
// 40px under "100%", 68px under "172 MB" -- the four plot areas would be offset by
// 28px, placing a CPU spike and the network spike that caused it at different x.
const Y_WIDTH = 68

// The palette is greyscale, so lightness alone is exhausted after two or three
// series and the dash pattern carries the rest.
// ponytail: the dash period is shorter than the jitter once every ping in the
// window is on the chart, so at the day range a dotted line and a dashed one both
// read as texture and only lightness separates them. A muted colour palette was
// built and measured but not adopted; restoring it means five oklch pairs and
// dropping `dash`.
const PALETTE = [
  { stroke: "#ff568b", dash: undefined },
  { stroke: "#14bfa5", dash: undefined },
  { stroke: "#5f8cff", dash: "6 3" },
  { stroke: "#e6a223", dash: "2 3" },
  { stroke: "#9d67ed", dash: "10 4 2 4" },
]

const TABS = [
  { key: "resources", label: "负载" },
  { key: "latency", label: "网络延迟" },
] as const

function Panel({ title, value, sub, tone, className, children }: { title: string; value?: string; sub?: string; tone: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`detail-chart-panel ${className ?? ""}`} data-tone={tone}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <h4 className="text-xs font-semibold">{title}</h4>
        {(value || sub) && <div className="tnum text-right text-[11px]"><div>{value}</div>{sub && <div className="mt-0.5 text-muted-foreground">{sub}</div>}</div>}
      </div>
      <div className="h-44 w-full text-muted-foreground">{children}</div>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Hampel filter (Hampel 1974; MATLAB ships it as `hampel`). A point more than
 * `sigmas` robust deviations from its window's median is replaced by that median,
 * while everything else passes through unchanged, which is what distinguishes it
 * from a rolling median or a moving average.
 *
 * 1.4826 rescales the median absolute deviation to a standard deviation for
 * normally distributed data; 3 sigma is the conventional cut.
 */
function despike(points: PingPoint[], window = 7, sigmas = 3): PingPoint[] {
  const half = window >> 1
  // ponytail: recomputes the window per point. A few thousand samples is
  // negligible; substitute a rolling structure if a chart ever needs 100k.
  return points.map((p, i) => {
    // A timeout is a gap rather than a high reading: neither smoothed, nor counted
    // towards what its neighbours are compared against.
    if (p.latency === null) return p
    const near = points
      .slice(Math.max(0, i - half), i + half + 1)
      .map((x) => x.latency)
      .filter((v) => v !== null)
    const mid = median(near) ?? p.latency
    const mad = median(near.map((v) => Math.abs(v - mid))) ?? 0
    const outlier = mad > 0 && Math.abs(p.latency - mid) > sigmas * 1.4826 * mad
    return outlier ? { ...p, latency: mid } : p
  })
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b py-2.5 text-[13px] leading-5 last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="tnum min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  )
}

function InfoPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-xl border bg-background/45 px-4 py-3"><h3 className="mb-1.5 text-sm font-bold">{title}</h3>{children}</section>
}

function TrafficStat({ label, rx, tx, loading = false }: { label: string; rx: number | null; tx: number | null; loading?: boolean }) {
  return (
    <div className="rounded-xl border bg-background/45 px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="tnum mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] font-medium">
        <span className="text-[var(--traffic-down)]">↓ {loading || rx === null ? "计算中…" : bytes(rx)}</span>
        <span className="text-[var(--traffic-up)]">↑ {loading || tx === null ? "计算中…" : bytes(tx)}</span>
      </div>
    </div>
  )
}

function monthUsage(node: Node) {
  if (node.traffic_mode === "up") return node.month_tx
  if (node.traffic_mode === "down") return node.month_rx
  if (node.traffic_mode === "max") return Math.max(node.month_rx, node.month_tx)
  return node.month_rx + node.month_tx
}

const DETAIL_TIME = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
})

function pingSampleTone(point: PingPoint) {
  if (point.latency === null) return "bad"
  if ((point.loss ?? 0) >= 20 || point.latency >= 300) return "bad"
  if ((point.loss ?? 0) >= 5 || point.latency >= 180) return "slow"
  if ((point.loss ?? 0) > 0 || point.latency >= 100) return "fair"
  return "good"
}

function nearestPing(points: PingPoint[], targetSeconds: number) {
  return points.reduce<PingPoint | null>((closest, point) => (
    !closest || Math.abs(point.ts - targetSeconds) < Math.abs(closest.ts - targetSeconds) ? point : closest
  ), null)
}

function trafficBetween(points: Point[], from: number, to: number) {
  const rows = points.filter((point) => point.ts >= from && point.ts < to).sort((left, right) => left.ts - right.ts)
  if (rows.length === 0) return { rx: 0, tx: 0 }
  const gaps = rows.slice(1).map((point, index) => point.ts - rows[index].ts).filter((gap) => gap > 0)
  const ordinaryGap = median(gaps) ?? 60
  return rows.reduce((total, point, index) => {
    // Limit a gap to two normal buckets. Otherwise an offline machine would be
    // charged its last reported rate for the whole time it was disconnected.
    const until = rows[index + 1]?.ts ?? Math.min(to, point.ts + ordinaryGap)
    const seconds = Math.max(0, Math.min(until - point.ts, ordinaryGap * 2))
    total.rx += point.net_rx * seconds
    total.tx += point.net_tx * seconds
    return total
  }, { rx: 0, tx: 0 })
}

function thinLive(points: LivePoint[], maximum = 900) {
  if (points.length <= maximum) return points
  const stride = Math.ceil(points.length / maximum)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

export function NodeDetail({ node }: { node: Node }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("resources")
  // Each tab keeps its own range: a 7-day trend and a 1-hour trace answer
  // different questions.
  const [ranges, setRanges] = useState({ resources: 1, latency: 1 })
  const hours = ranges[tab]
  const [smooth, setSmooth] = useState(false)
  // Probes switched off. Hiding a slow one is what makes the fast ones readable,
  // as the axis rescales to what remains.
  const [hiddenProbes, setHiddenProbes] = useState<number[]>([])
  const [hoveredPingTime, setHoveredPingTime] = useState<number | null>(null)
  const [data, setData] = useState<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss } | null>(null)
  const [trafficHistory, setTrafficHistory] = useState<Point[] | null>(null)
  const [liveRows, setLiveRows] = useState<LivePoint[]>(() => node.metrics ? [{
    ts: Date.now(), tcp: node.metrics.tcp, udp: node.metrics.udp, procs: node.metrics.procs,
  }] : [])
  // Retained rather than folded into an empty result: a refused request and an
  // empty window are different answers, and the hub has reason to refuse this one
  // -- it caps how many history windows it builds concurrently, since each holds
  // the connection the agents report through. Rendered as an empty window, a 503
  // would misdirect the reader.
  const [failed, setFailed] = useState("")
  // Where the brush has been dragged, so the axis reticks for the visible span
  // rather than retaining the whole window's ticks.
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  useEffect(() => {
    let active = true
    // The charts must not continue drawing the old range while the new one is in
    // flight.
    // oxlint-disable-next-line react/set-state-in-effect
    setData(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setZoom(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    // What this screen can resolve, in device pixels, which is the unit the line
    // is drawn in: a 1280-wide retina panel has 2560 of them for a day of minutes.
    // Read here rather than from a ref, since the hub only thins further, an
    // approximate figure suffices, and the viewport is known before layout. A
    // rotation keeps whatever it fetched with.
    //
    // The tab determines which half is requested; the other accounted for a third
    // to two thirds of every response and was never drawn.
    const points = Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1))
    const series = tab === "latency" ? "ping" : "metrics"
    api<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss }>(
      `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
    )
      .then((next) => { if (active) setData(next) })
      .catch((e: Error) => {
        // `|| "..."` as in App.tsx: HTTP/2 dropped statusText, so a bodiless
        // failure from a proxy arrives as the empty string and renders as no
        // error.
        if (active) { setFailed(e.message || "网络错误"); setData({ metrics: [], ping: [], probes: {} }) }
      })
    return () => { active = false }
  }, [node.id, hours, tab])

  useEffect(() => {
    let active = true
    // One point per ten minutes keeps seven-day traffic integration compact
    // while retaining the hub's averaged receive/transmit rates.
    api<{ metrics: Point[] }>(`/nodes/${node.id}/metrics?hours=168&points=1008&series=metrics`)
      .then((result) => { if (active) setTrafficHistory(result.metrics) })
      .catch(() => { if (active) setTrafficHistory([]) })
    return () => { active = false }
  }, [node.id])

  const m = node.metrics

  useEffect(() => {
    if (!m) return
    const ts = Math.floor(Date.now() / 10_000) * 10_000
    // This is intentionally session-local: the official history response does
    // not expose tcp/udp/procs yet. Replace the last ten-second bucket as live
    // WebSocket reports arrive, and keep at most seven days if a tab stays open.
    // oxlint-disable-next-line react/set-state-in-effect -- accumulate an external live stream for the chart.
    setLiveRows((rows) => {
      const next = { ts, tcp: m.tcp, udp: m.udp, procs: m.procs }
      if (rows.at(-1)?.ts === ts) return [...rows.slice(0, -1), next]
      return [...rows, next].slice(-60_480)
    })
  }, [m])

  const visibleLiveRows = useMemo(() => {
    const cutoff = Date.now() - hours * 3_600_000
    return thinLive(liveRows.filter((point) => point.ts >= cutoff))
  }, [hours, liveRows])
  const usedTraffic = monthUsage(node)
  const remainingTraffic = node.traffic_limit > 0 ? Math.max(0, node.traffic_limit - usedTraffic) : null
  const bootedAt = m?.uptime ? Date.now() - m.uptime * 1000 : null
  const trafficWindows = useMemo(() => {
    if (!trafficHistory) return null
    const now = Date.now()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const todaySeconds = today.getTime() / 1000
    return {
      yesterday: trafficBetween(trafficHistory, todaySeconds - 86400, todaySeconds),
      week: trafficBetween(trafficHistory, now / 1000 - 7 * 86400, now / 1000),
    }
  }, [trafficHistory])
  // One series per probe that reported, labelled from the names the samples
  // arrived with. Memoised, as are the two below: the node prop changes every few
  // seconds as live metrics arrive, and rebuilding the chart's data array on those
  // renders would reset the brush.
  const pingSeries = useMemo(
    () =>
      [...new Set((data?.ping ?? []).map((p) => p.task_id))]
        .map((id) => {
          // Timeouts are retained: dropping them would draw a probe losing half
          // its packets as an unbroken line, and one that never answered not at
          // all.
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          // Taken from the hub rather than summed from the buckets above, each of
          // which is already a percentage of its own bucket, so averaging them
          // would report one lost round in thirteen as 50%. Left unrounded, since
          // `Math.round` would render 0.28% and 0.00% as the same badge, and the
          // absence of a badge denotes no loss.
          const loss = data?.loss?.[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        })
        .filter((s) => s.points.length > 0),
    [data],
  )

  // The hub answers in seconds; the time axis requires milliseconds.
  const metricRows = useMemo(
    () => (data?.metrics ?? []).map((m) => ({ ...m, ts: m.ts * 1_000 })),
    [data],
  )

  // Axis tops for the two panels with no capacity to measure against. CPU and a
  // transfer rate do not express fullness: against a fixed 0-100, a machine
  // sitting at 0.4% draws as a line along the panel's floor. Memory and disk keep
  // their totals as tops, where fullness is the entire question.
  const tops = useMemo(() => {
    const max = (pick: (m: Point) => number) =>
      metricRows.reduce((hi, m) => Math.max(hi, pick(m)), 0)
    return {
      // A floor of 4%, or a machine that never exceeds 0.4% would get an axis of
      // 0-0.4 and render every scheduler blip as a peak. Capped at 100.
      cpu: axisTop(max((m) => m.cpu), 4, 10, 100),
      // Base 1024, so the steps are round in the unit `axisBytes` prints.
      rate: axisTop(max((m) => Math.max(m.net_rx, m.net_tx)), 1024, 1024),
    }
  }, [metricRows])

  const shownProbes = useMemo(
    () => pingSeries.filter((s) => !hiddenProbes.includes(s.id)),
    [pingSeries, hiddenProbes],
  )
  // Keyed on the full list, so a line keeps its shade when others are hidden.
  const style = (id: number) => PALETTE[pingSeries.findIndex((p) => p.id === id) % PALETTE.length]

  // The hub stamps every sample with its bucket rather than the second the probe
  // finished, so probes reporting at the bucket's rate share rows instead of each
  // contributing its own: a day of four probes is 717 rows rather than 2,868. A
  // slower probe leaves gaps in its own column, which is what `connectNulls`
  // addresses.
  //
  // Every probe and both versions of every sample are held here whether or not
  // they are on screen: recharts resets the brush when the data array changes
  // identity, and re-reads a controlled selection only when the index props
  // change, which they do not. Hiding a probe or enabling despiking therefore
  // selects a `dataKey` rather than rebuilding the array.
  const pingRows = useMemo(() => {
    const rows = new Map<
      number,
      { ts: number } & Record<string, number | [number, number] | null>
    >()
    for (const s of pingSeries) {
      const smoothed = despike(s.points)
      s.points.forEach((p, i) => {
        const row = rows.get(p.ts) ?? { ts: p.ts * 1_000 }
        row[`t${s.id}`] = p.latency
        row[`s${s.id}`] = smoothed[i].latency
        row[`l${s.id}`] = p.loss ?? 0
        // Raw, never despiked: the band exists to show what the line omits, and
        // smoothing it would omit the same points.
        row[`b${s.id}`] = p.band ?? null
        rows.set(p.ts, row)
      })
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts)
  }, [pingSeries])

  // A real time axis rather than the category axis recharts defaults to: on a
  // category axis ticks are selected by index, so a period the agent was offline
  // for collapses to nothing.
  const timeAxis = (rows: { ts: number }[], from = 0, to = rows.length - 1) => ({
    dataKey: "ts",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as const,
    // Explicit, or recharts places them at 05:14 and 10:22. Any that still collide
    // are dropped by `minTickGap`.
    ticks: rows.length ? timeTicks(rows[from].ts, rows[to].ts) : undefined,
    tickFormatter: clockFor(hours),
    minTickGap: hours > 24 ? 72 : 40,
    ...AXIS,
  })

  return (
    <div className="space-y-5">
      <a href="/" className="inline-flex text-xs text-muted-foreground transition-colors hover:text-foreground">‹ 返回</a>

      <Card className="gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-base font-bold">{node.name} 信息</h2>
          <Country node={node} />
          <Status node={node} />
          {node.agent_version && <Badge variant="outline" className="font-normal">agent {node.agent_version}</Badge>}
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <InfoPanel title="系统">
            <InfoRow label="状态" value={node.online ? "在线" : "离线"} />
            <InfoRow label="CPU" value={node.cpu_name ? `${cpuName(node.cpu_name)} (×${node.cpu_cores})` : `${node.cpu_cores} 核`} />
            <InfoRow label="架构" value={[node.arch, node.virt !== "none" ? node.virt : ""].filter(Boolean).join(" · ")} />
            <InfoRow label="操作系统" value={osName(node.os) || "—"} />
            <InfoRow label="内核版本" value={node.kernel || "—"} />
          </InfoPanel>
          <InfoPanel title="资源">
            <InfoRow label="内存" value={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)} />
            <InfoRow label="Swap" value={m ? pair(m.swap_used, m.swap_total) : bytes(node.swap_total)} />
            <InfoRow label="磁盘" value={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)} />
            <InfoRow label="负载" value={m ? m.load.map((value) => value.toFixed(2)).join(" | ") : "—"} />
            <InfoRow label="启动时间" value={bootedAt ? DETAIL_TIME.format(bootedAt) : "—"} />
            <InfoRow label="最后更新" value={node.last_seen ? DETAIL_TIME.format(node.last_seen * 1000) : "—"} />
          </InfoPanel>
          <InfoPanel title="网络">
            <InfoRow label="实时网络" value={m ? `↑ ${rate(m.net_tx)} · ↓ ${rate(m.net_rx)}` : "—"} />
            <InfoRow label="总流量" value={`↑ ${bytes(node.total_tx)} · ↓ ${bytes(node.total_rx)}`} />
            <InfoRow label="剩余流量" value={remainingTraffic === null ? FOREVER : bytes(remainingTraffic)} />
            <InfoRow label="价格" value={node.price > 0 ? `${money(node.price, node.currency)} / ${CYCLES[node.billing_cycle] ?? node.billing_cycle}` : "未设置"} />
            <InfoRow label="到期" value={node.expires_at || "未设置"} />
            <InfoRow label="运行时长" value={m ? uptime(m.uptime) : "—"} />
          </InfoPanel>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <TrafficStat label="今日流量" rx={node.day_rx} tx={node.day_tx} />
          <TrafficStat label="昨日流量" rx={trafficWindows?.yesterday.rx ?? null} tx={trafficWindows?.yesterday.tx ?? null} loading={!trafficHistory} />
          <TrafficStat label="近 7 天流量" rx={trafficWindows?.week.rx ?? null} tx={trafficWindows?.week.tx ?? null} loading={!trafficHistory} />
        </div>
        {node.remark && <p className="rounded-lg bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{node.remark}</p>}
      </Card>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="flex rounded-xl border bg-card p-1 shadow-sm">
          {TABS.map((t) => <Tab key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</Tab>)}
        </div>
        <div className="flex max-w-full overflow-x-auto rounded-xl border bg-card p-1 shadow-sm">
          {RANGES_FOR[tab].map((r) => (
            <Tab key={r.hours} active={hours === r.hours} onClick={() => setRanges((all) => ({ ...all, [tab]: r.hours }))}>{r.label}</Tab>
          ))}
        </div>
        {tab === "latency" && (
          <label className="flex cursor-pointer items-center gap-1.5 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
            <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} className="accent-foreground" />削峰
          </label>
        )}
      </div>

      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : failed ? (
        <p className="py-8 text-center text-sm text-destructive" role="alert">读取历史数据失败：{failed}</p>
      ) : tab === "latency" ? (
        pingSeries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有延迟数据</p>
        ) : (
          <Card className="gap-3 p-4">
            <div>
              <h3 className="text-sm font-bold">Ping 图表</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">覆盖完整 {hours} 小时，悬停曲线可查看该时刻的延迟与丢包</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {pingSeries.map((s) => {
                const shown = !hiddenProbes.includes(s.id)
                const latest = [...s.points].reverse().find((point) => point.latency !== null)
                return (
                  <button
                    key={s.id}
                    onClick={() => setHiddenProbes((hidden) => shown ? [...hidden, s.id] : hidden.filter((id) => id !== s.id))}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-opacity"
                    style={{ borderColor: style(s.id).stroke, opacity: shown ? 1 : 0.4 }}
                  >
                    <span className="size-2 rounded-full" style={{ background: style(s.id).stroke }} />
                    <strong>{s.name}</strong>
                    <span className="tnum" style={{ color: style(s.id).stroke }}>{latest?.latency === null || latest === undefined ? "—" : `${latest.latency.toFixed(1)} ms`}</span>
                    <span className="tnum text-muted-foreground">{s.loss.toFixed(1)}%</span>
                  </button>
                )
              })}
            </div>
            <div className="ping-overview-area space-y-1" data-hovering={hoveredPingTime !== null ? "true" : "false"}>
              {pingSeries.map((s) => (
                <div key={s.id} className="flex min-w-0 items-center gap-2">
                  <span className="w-16 shrink-0 truncate text-[9px] text-muted-foreground" title={s.name}>{s.name}</span>
                  <div className="ping-overview-strip">
                    {s.points.slice(-60).map((point, index) => {
                      const lines = pingSeries.map((probe) => {
                        const sample = nearestPing(probe.points, point.ts)
                        return `${probe.name}：${sample?.latency === null || !sample ? "超时" : `${sample.latency.toFixed(1)} ms`} · 丢包 ${(sample?.loss ?? 0).toFixed(1)}%`
                      })
                      const highlighted = hoveredPingTime !== null && nearestPing(s.points, hoveredPingTime)?.ts === point.ts
                      return (
                        <span
                          key={`${point.ts}-${index}`}
                          data-tone={pingSampleTone(point)}
                          data-highlight={highlighted ? "true" : "false"}
                          data-tooltip={`${DETAIL_TIME.format(point.ts * 1000)}\n${lines.join("\n")}`}
                          aria-label={`${DETAIL_TIME.format(point.ts * 1000)}，${lines.join("，")}`}
                          onMouseEnter={() => setHoveredPingTime(point.ts)}
                          onMouseLeave={() => setHoveredPingTime(null)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex h-[clamp(340px,56svh,560px)] min-h-72 flex-col gap-3">
            {/* `min-h-0` is what makes `flex-1` a real number rather than the
                content's own height: ResponsiveContainer reads its parent, and
                a flex child not told it may shrink reports whatever the SVG
                last was. The column above has a height in pixels, so this
                resolves at layout instead of coming back 0. */}
            <div className="min-h-0 w-full flex-1 text-muted-foreground">
              {shownProbes.length === 0 ? (
                <p className="py-8 text-center text-sm">没有选中任何探测</p>
              ) : (
                <ResponsiveContainer>
                  <ComposedChart data={pingRows}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis
                      {...timeAxis(
                        pingRows,
                        Math.min(zoom?.[0] ?? 0, pingRows.length - 1),
                        Math.min(zoom?.[1] ?? pingRows.length - 1, pingRows.length - 1),
                      )}
                    />
                    {/* Not anchored at zero: these lines live in a narrow band
                        far from it, and zero flattens every wobble. */}
                    <YAxis unit="ms" width={52} domain={["auto", "auto"]} {...AXIS} />
                    <Tooltip
                      shared
                      filterNull={false}
                      cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                      content={({ active, label, payload }) => {
                        if (!active || !payload?.length) return null
                        const row = payload[0]?.payload as Record<string, unknown> | undefined
                        return (
                          <div className="rounded-lg border bg-card/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur-sm">
                            <div className="tnum mb-1.5 text-muted-foreground">{DETAIL_TIME.format(Number(label))}</div>
                            <div className="space-y-1">
                              {shownProbes.map((probe) => {
                                const directValue = row?.[`${smooth ? "s" : "t"}${probe.id}`]
                                const directLoss = row?.[`l${probe.id}`]
                                const nearest = nearestPing(probe.points, Number(label) / 1000)
                                const value = typeof directValue === "number" ? directValue : nearest?.latency
                                const loss = typeof directLoss === "number" ? directLoss : nearest?.loss
                                return (
                                  <div key={probe.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                                    <span className="size-2 rounded-full" style={{ background: style(probe.id).stroke }} />
                                    <span>{probe.name}</span>
                                    <strong className="tnum text-right">
                                      {typeof value === "number" ? `${value.toFixed(1)} ms` : "—"}
                                      <span className="ml-1.5 font-normal text-muted-foreground">丢 {typeof loss === "number" ? loss.toFixed(1) : "0.0"}%</span>
                                    </strong>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      }}
                    />
                    {/* Behind the line, the range that bucket's answers
                        spanned -- Smokeping's "smoke". At the day window a
                        bucket moves 63 ms at the 90th percentile against the
                        25 ms the trend moves, so a line alone draws the smaller
                        of the two.

                        Only with one probe on screen: rendered for four, the
                        bands overlap into a fog and their extremes drag the
                        axis from 165-385 out to 140-420. */}
                    {shownProbes.length === 1 &&
                      shownProbes.map((s) => (
                        <Area
                          key={`band${s.id}`}
                          dataKey={`b${s.id}`}
                          stroke="none"
                          fill={style(s.id).stroke}
                          fillOpacity={0.16}
                          isAnimationActive={false}
                          tooltipType="none"
                          legendType="none"
                          connectNulls
                        />
                      ))}
                    {shownProbes.map((s) => (
                      <Line
                        key={s.id}
                        dataKey={`${smooth ? "s" : "t"}${s.id}`}
                        name={s.name}
                        stroke={style(s.id).stroke}
                        strokeDasharray={style(s.id).dash}
                        {...SERIES}
                        connectNulls
                      />
                    ))}
                    {/* Drag either handle to zoom into a stretch of the trend. */}
                    <Brush
                      dataKey="ts"
                      height={22}
                      travellerWidth={8}
                      tickFormatter={clockFor(hours)}
                      className="fill-muted"
                      stroke="var(--color-muted-foreground)"
                      onChange={(r) => setZoom([r.startIndex ?? 0, r.endIndex ?? pingRows.length - 1])}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            </div>
          </Card>
        )
      ) : data.metrics.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有历史数据</p>
      ) : (
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold">负载图表</h3>
            <span className="text-[11px] text-muted-foreground">最近 {hours} 小时</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          <Panel title="CPU" value={m ? `${m.cpu.toFixed(2)}%` : "—"} sub="使用率" tone="blue">
            <ResponsiveContainer>
              <AreaChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, tops.cpu]} ticks={quarters(tops.cpu)} unit="%" width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                  formatter={(v) => [`${Number(v).toFixed(1)}%`, "CPU"]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Area dataKey="cpu" stroke="#5f8cff" fill="#5f8cff" fillOpacity={0.15} {...SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* The axis top is the machine's memory, so the line's height is the
              fraction in use whatever range is picked. Tracking the window's
              own maximum, which is what an area chart does by default, puts
              127 MB of a 457 MB box at the top of the panel. The size is in the
              title because the axis top is claiming it. */}
          <Panel title="内存" value={m ? pair(m.mem_used, m.mem_total) : "—"} sub={m && m.swap_total > 0 ? `Swap ${pair(m.swap_used, m.swap_total)}` : undefined} tone="purple">
            <ResponsiveContainer>
              <AreaChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, node.mem_total]} ticks={quarters(node.mem_total)} tickFormatter={axisBytes} width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                  formatter={(v) => bytes(Number(v))}
                  contentStyle={{ fontSize: 12 }}
                />
                <Area dataKey="mem_used" name="内存" stroke="#9d67ed" fill="#9d67ed" fillOpacity={0.15} {...SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* A rate has no total to be a fraction of, so this one climbs the
              ladder like CPU rather than pinning to a capacity. */}
          <Panel title="网络" value={m ? `${rate(m.net_rx)} / ${rate(m.net_tx)}` : "—"} sub={`↓ ${bytes(node.total_rx)} · ↑ ${bytes(node.total_tx)}`} tone="green" className="xl:order-4">
            <ResponsiveContainer>
              <LineChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, tops.rate]} ticks={quarters(tops.rate)} tickFormatter={axisBytes} unit="/s" width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                  formatter={(v) => rate(Number(v))}
                  contentStyle={{ fontSize: 12 }}
                />
                <Line dataKey="net_rx" name="下行" stroke="#35b778" {...SERIES} />
                <Line dataKey="net_tx" name="上行" stroke="#5f8cff" {...SERIES} />
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          {/* The disk it is filling, for the same reason as memory: a node
              using 2.7% of its disk draws along the top of the panel when the
              axis tracks the window's own maximum. */}
          <Panel title="磁盘" value={m ? pair(m.disk_used, m.disk_total) : "—"} sub="已用空间" tone="orange" className="xl:order-3">
            <ResponsiveContainer>
              <AreaChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, node.disk_total]} ticks={quarters(node.disk_total)} tickFormatter={axisBytes} width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                  formatter={(v) => bytes(Number(v))}
                  contentStyle={{ fontSize: 12 }}
                />
                <Area dataKey="disk_used" name="硬盘" stroke="#ef7440" fill="#ef7440" fillOpacity={0.15} {...SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel
            title="连接数"
            value={m ? `TCP ${m.tcp} / UDP ${m.udp}` : "—"}
            sub="打开页面后实时记录"
            tone="purple"
            className="xl:order-5"
          >
            <ResponsiveContainer>
              <LineChart data={visibleLiveRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(visibleLiveRows)} />
                <YAxis domain={[0, "auto"]} allowDecimals={false} width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                  formatter={(value, name) => [Math.round(Number(value)), name]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Line dataKey="tcp" name="TCP" stroke="#9d67ed" {...SERIES} dot={visibleLiveRows.length < 2} />
                <Line dataKey="udp" name="UDP" stroke="#5f8cff" {...SERIES} dot={visibleLiveRows.length < 2} />
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          <Panel
            title="进程"
            value={m ? String(m.procs) : "—"}
            sub={m ? `负载 ${m.load.map((value) => value.toFixed(2)).join(" | ")} · 页面内实时记录` : "打开页面后实时记录"}
            tone="orange"
            className="xl:order-6"
          >
            <ResponsiveContainer>
              <AreaChart data={visibleLiveRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(visibleLiveRows)} />
                <YAxis domain={[0, "auto"]} allowDecimals={false} width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                  formatter={(value) => [Math.round(Number(value)), "进程"]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Area dataKey="procs" name="进程" stroke="#e6a223" fill="#e6a223" fillOpacity={0.13} {...SERIES} dot={visibleLiveRows.length < 2} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
          </div>
        </Card>
      )}
    </div>
  )
}
