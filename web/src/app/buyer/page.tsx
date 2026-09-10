import { BuyerApp } from "@/components/BuyerApp"
import { PrivyShell } from "@/components/PrivyShell"
import { RewardWalletPreview } from "@/components/RewardWalletPreview"
import Image from "next/image"

export default function BuyerPage() {
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""

  return (
    <PrivyShell appId={privyAppId}>
      <main className="shell buyer-shell">
        <header className="hero buyer-hero">
          <div className="hero-copy">
            <h1 className="brand">Nugget Research
             <Image 
                  src="/nugget-logo.png" 
                  alt="Nugget logo" 
                  width={42} 
                  height={42} 
                  className="logo" 
                  priority 
                />
            </h1>
            <p className="tagline">Research signals, never individual diaries.</p>
          </div>
          <aside className="privacy-promise" aria-label="Research privacy promise">
            <span aria-hidden="true">🛡️</span>
            <div><strong>Aggregate-only access.</strong><span>The confidential workflow releases public group statistics, not personal records.</span></div>
          </aside>
        </header>
        <BuyerApp />
        {privyAppId && <RewardWalletPreview />}
        <p className="foot">
          No individual diaries. Aggregation happens in the CRE confidential workflow path.
        </p>
      </main>
    </PrivyShell>
  )
}
