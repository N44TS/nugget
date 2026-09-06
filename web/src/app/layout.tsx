import type { Metadata } from "next"
import { Fraunces, Figtree } from "next/font/google"
import "./globals.css"

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
})

const sans = Figtree({
  subsets: ["latin"],
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
