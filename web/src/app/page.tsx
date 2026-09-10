import { TrackerApp } from "@/components/TrackerApp"
import { ContributorRewardWallet } from "@/components/ContributorRewardWallet"
import { PrivyShell } from "@/components/PrivyShell"

export default function Home() {
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""

  return (
    <PrivyShell appId={privyAppId}>
      <main className="shell">
        <h1 className="brand">Nugget</h1>
        <p className="tagline">Your cycle data stays yours — track privately, opt in to research on your terms.</p>
        <TrackerApp />
        {privyAppId && <ContributorRewardWallet />}
        <p className="foot">
          No account or wallet is required to track or contribute. Health data enters an encrypted pool;
          the buyer runs Chainlink CRE to aggregate and publish public stats only.
        </p>
      </main>
    </PrivyShell>
  )
}
