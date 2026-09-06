import { TrackerApp } from "@/components/TrackerApp"

export default function Home() {
  return (
    <main className="shell">
      <h1 className="brand">Nugget</h1>
      <p className="tagline">Your cycle data stays yours — track privately, opt in to research on your terms.</p>
      <TrackerApp />
      <p className="foot">
        No account. No wallet. No fake credits. Age band + cycle data opt into an encrypted pool; the
        buyer runs Chainlink CRE to aggregate and spit out public stats only.
      </p>
    </main>
  )
}
