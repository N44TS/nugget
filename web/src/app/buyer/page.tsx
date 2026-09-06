import { BuyerApp } from "@/components/BuyerApp"

export default function BuyerPage() {
  return (
    <main className="shell">
      <h1 className="brand">Nugget</h1>
      <p className="tagline">Buyer console — request confidential research aggregates.</p>
      <BuyerApp />
      <p className="foot">
        No individual diaries. Aggregation happens in the CRE confidential workflow path.
      </p>
    </main>
  )
}
