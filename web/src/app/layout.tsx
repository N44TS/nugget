import type { Metadata } from "next"
import { DM_Sans, Nunito } from "next/font/google"
import "./globals.css"

const display = Nunito({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-display",
})

const sans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-sans",
})

export const metadata: Metadata = {
  title: "Nugget — your cycle, your data",
  description: "Track privately. Opt in to earn. Buyers only see anonymous aggregates.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${sans.variable}`}>{children}</body>
    </html>
  )
}
