import type { ResolvedColorMode, Theme, ThemeSwatchPalette } from "../appearance/types.ts"
import { cn } from "#lib/utils"

const FALLBACK_SWATCH: Record<ResolvedColorMode, ThemeSwatchPalette> = {
  light: {
    shell: "#eceff3",
    canvas: "#f5f6f7",
    surface: "#ffffff",
    border: "#dce0e5",
    selected: "#e9f0fc",
    fg: "#0f1115",
    muted: "#61666b",
    brand: "#1764c0",
    warn: "#875b0c",
    info: "#1764c0",
    ok: "#187442",
  },
  dark: {
    shell: "#101012",
    canvas: "#151517",
    surface: "#232324",
    border: "#383b42",
    selected: "#24344c",
    fg: "#f9fafb",
    muted: "#cfd3d6",
    brand: "#8dbbff",
    warn: "#f4ca7b",
    info: "#8dbbff",
    ok: "#7ddba4",
  },
}

function getSwatch(theme: Theme, mode: ResolvedColorMode): ThemeSwatchPalette {
  return theme.swatch?.[mode] ?? FALLBACK_SWATCH[mode]
}

function ThemeSwatch({
  theme,
  mode,
  className,
}: {
  theme: Theme
  mode: ResolvedColorMode
  className?: string
}) {
  const c = getSwatch(theme, mode)
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex h-4 w-6 shrink-0 items-end rounded-[3px] p-0.5", className)}
      style={{
        backgroundColor: c.shell,
        boxShadow: "inset 0 0 0 1px rgb(128 128 128 / 0.24)",
      }}
    >
      <span
        className="flex h-full w-full flex-col justify-center gap-0.5 rounded-[1.5px] px-0.5"
        style={{
          backgroundColor: c.canvas,
          boxShadow: `inset 0 0 0 0.5px ${c.border}`,
        }}
      >
        <span className="h-[2px] w-3/5 rounded-full" style={{ backgroundColor: c.fg }} />
        <span className="h-[2px] w-2/5 rounded-full" style={{ backgroundColor: c.brand }} />
      </span>
    </span>
  )
}

function ThemePreviewSvg({
  theme,
  mode,
  className,
}: {
  theme: Theme
  mode: ResolvedColorMode
  className?: string
}) {
  const c = getSwatch(theme, mode)
  return (
    <svg
      aria-hidden="true"
      className={cn("block aspect-[16/10] w-full border-b border-border", className)}
      preserveAspectRatio="xMidYMin slice"
      viewBox="0 0 160 100"
    >
      <rect fill={c.shell} height="100" width="160" />
      <rect fill={c.brand} height="11" rx="3" width="11" x="6" y="10" />
      <rect fill={c.selected} height="11" rx="3" width="11" x="6" y="27" />
      <rect fill={c.muted} height="11" opacity="0.35" rx="3" width="11" x="6" y="43" />
      <rect fill={c.canvas} height="86" rx="5" stroke={c.border} width="129" x="24.5" y="7.5" />
      <rect fill={c.fg} height="5" rx="2.5" width="44" x="34" y="16" />
      <rect fill={c.brand} height="9" rx="4" width="22" x="122" y="14" />
      <rect fill={c.surface} height="50" rx="4" stroke={c.border} width="109" x="34.5" y="32.5" />
      <circle cx="43" cy="44" fill={c.warn} r="2.5" />
      <rect fill={c.fg} height="4" opacity="0.8" rx="2" width="48" x="50" y="42" />
      <circle cx="43" cy="57" fill={c.info} r="2.5" />
      <rect fill={c.fg} height="4" opacity="0.8" rx="2" width="38" x="50" y="55" />
      <circle cx="43" cy="70" fill={c.ok} r="2.5" />
      <rect fill={c.fg} height="4" opacity="0.8" rx="2" width="42" x="50" y="68" />
    </svg>
  )
}

export { ThemePreviewSvg, ThemeSwatch }
