import { BuyerApp } from "@/components/BuyerApp"
import { PrivyShell } from "@/components/PrivyShell"
import { RewardWalletPreview } from "@/components/RewardWalletPreview"

export default function BuyerPage() {
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""

  return (
    <PrivyShell appId={privyAppId}>
      <main className="shell">
        <h1 className="brand">Nugget</h1>
        <p className="tagline">Buyer console — request confidential research aggregates.</p>
        <BuyerApp />
        {privyAppId && <RewardWalletPreview />}
        <p className="foot">
          No individual diaries. Aggregation happens in the CRE confidential workflow path.
        </p>
      </main>
    </PrivyShell>
  )
}
