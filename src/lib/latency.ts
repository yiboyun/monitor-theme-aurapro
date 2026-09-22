import { useEffect, useState } from "react"

import { api } from "@/lib/api"

type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  loss?: number
}

type PingResponse = {
  ping: PingPoint[]
  probes: Record<string, string>
  loss?: Record<string, number>
}

export type LatencyProbe = {
  id: number
  name: string
  latency: number | null
  loss: number
  samples: Array<{ ts: number; latency: number | null; loss: number }>
}

type Cached = { at: number; probes: LatencyProbe[] }
const cache = new Map<number, Cached>()
const FRESH_FOR = 55_000
const pending: Array<() => void> = []
let running = 0

function queued<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      running += 1
      job().then(resolve, reject).finally(() => {
        running -= 1
        pending.shift()?.()
      })
    }
    // The hub deliberately limits concurrent history queries. A dashboard with
    // many cards therefore walks the queue instead of making every node compete
    // for the same few slots and showing random cards as unavailable.
    if (running < 3) start()
    else pending.push(start)
  })
}

function summarize(data: PingResponse): LatencyProbe[] {
  const ids = [...new Set(data.ping.map((point) => point.task_id))]
  return ids.map((id) => {
    const points = data.ping
      .filter((point) => point.task_id === id)
      .sort((left, right) => left.ts - right.ts)
      .slice(-24)
    const latest = [...points].reverse().find((point) => point.latency !== null)
    return {
      id,
      name: data.probes[String(id)] ?? `探测 ${id}`,
      latency: latest?.latency ?? null,
      // This is the hub's loss for the whole requested window. Per-bucket loss
      // cannot be averaged because buckets contain different sample counts.
      loss: data.loss?.[String(id)] ?? 0,
      samples: points.map((point) => ({
        ts: point.ts,
        latency: point.latency,
        loss: point.loss ?? 0,
      })),
    }
  }).slice(0, 2)
}

/** A small, shared cache prevents list remounts from re-querying every node. */
export function useNodeLatency(nodeId: number, enabled: boolean) {
  const [probes, setProbes] = useState<LatencyProbe[]>(() => cache.get(nodeId)?.probes ?? [])
  const [loaded, setLoaded] = useState(() => cache.has(nodeId))

  useEffect(() => {
    if (!enabled) return
    let active = true
    const load = () => {
      const current = cache.get(nodeId)
      if (current && Date.now() - current.at < FRESH_FOR) {
        if (active) { setProbes(current.probes); setLoaded(true) }
        return
      }
      queued(() => api<PingResponse>(`/nodes/${nodeId}/metrics?hours=1&points=24&series=ping`))
        .then((data) => {
          const next = summarize(data)
          cache.set(nodeId, { at: Date.now(), probes: next })
          if (active) { setProbes(next); setLoaded(true) }
        })
        .catch(() => { if (active) setLoaded(true) })
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [enabled, nodeId])

  return { probes, loaded }
}
