/** App title — displayed in the nav header and browser tab */
export const APP_TITLE = "Zelis Claim-to-Cash"

/** Path to the logo in /public (used in the header and as favicon) */
export const LOGO_SRC = "/icon.svg"

export const NAV = [
  { href: "/", label: "Command Center" },
  { href: "/exceptions", label: "Exceptions" },
  { href: "/integrity", label: "Integrity" },
  { href: "/payments", label: "Payments" },
  { href: "/governance", label: "AI Governance" },
  { href: "/architecture", label: "Architecture" },
] as const
