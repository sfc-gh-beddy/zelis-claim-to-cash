export const money = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? "—"
    : v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits })

export const moneyShort = (v: number | null | undefined) => {
  if (v === null || v === undefined) return "—"
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return money(v, 0)
}

export const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(digits)}%`

export const int = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-US"))

export const minutes = (m: number | null | undefined) => {
  if (m === null || m === undefined) return "—"
  if (m < 60) return `${Math.round(m)} min`
  const h = Math.floor(m / 60)
  return `${h}h ${Math.round(m - h * 60)}m`
}

/** Simulated business clock: minute 0 = 08:00. */
export const simClock = (minute: number | null | undefined) => {
  if (minute === null || minute === undefined) return "—"
  const t = 480 + minute
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
}

export const shortTs = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) : "—")

export const label = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ")
