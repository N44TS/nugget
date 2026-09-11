import { TrackerApp } from "@/components/TrackerApp"
import { PrivyShell } from "@/components/PrivyShell"
import Image from "next/image"

export default function Home() {
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""

  return (
    <PrivyShell appId={privyAppId}>
      <main className="shell contributor-shell">
        <header className="hero" aria-labelledby="page-title">
          <div className="hero-copy">
            <h1 id="page-title" className="brand">Nugget
                 <Image 
      src="/nugget-logo2.0.png" 
      alt="Nugget logo" 
      width={42} 
      height={42} 
      className="logo" 
      priority 
    />
    </h1>
            <p className="tagline">A private place to track your cycle — with an optional way to contribute anonymous insights to research.</p>
          </div>
          <aside className="privacy-promise" aria-label="Privacy promise">
            <span aria-hidden="true">🔒</span>
            <div><strong>Your entries stay on your device.</strong><span>You decide whether to share an anonymous summary.</span></div>
          </aside>
        </header>
        <nav className="journey" aria-label="Your Nugget journey">
          <span><b>1</b> Set your profile</span>
          <span><b>2</b> Log privately</span>
          <span><b>3</b> Contribute, if you want</span>
        </nav>
        <TrackerApp showRewards={Boolean(privyAppId)} />
        <p className="foot">
          No account or wallet is required to track or contribute. Health data enters an encrypted pool;
          the buyer runs Chainlink CRE to aggregate and publish public stats only.
        </p>
      </main>
    </PrivyShell>
  )
}
