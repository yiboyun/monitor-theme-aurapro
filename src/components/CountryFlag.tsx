import { Globe2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Windows renders regional-indicator emoji as letters on many installations.
 * Use an actual flag image and leave a globe underneath as an offline fallback.
 */
export function CountryFlag({ country, className }: { country: string; className?: string }) {
  const code = country.trim().toLowerCase()
  if (!/^[a-z]{2}$/.test(code)) return <Globe2 className={cn("size-4 text-muted-foreground", className)} aria-hidden />

  return (
    <span className={cn("relative inline-grid h-3.5 w-[19px] shrink-0 place-items-center overflow-hidden rounded-[2px]", className)} aria-hidden>
      <Globe2 className="size-3 text-muted-foreground" />
      <img
        className="absolute inset-0 h-full w-full object-cover"
        src={`https://flagcdn.com/24x18/${code}.png`}
        width="24"
        height="18"
        loading="lazy"
        referrerPolicy="no-referrer"
        alt=""
        onError={(event) => { event.currentTarget.hidden = true }}
      />
    </span>
  )
}
