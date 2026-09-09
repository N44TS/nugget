"use client"

import { usePrivy } from "@privy-io/react-auth"

export function RewardWalletPreview() {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const wallet = user?.linkedAccounts.find((account) => account.type === "wallet")

  return (
    <section className="panel" aria-labelledby="reward-wallet-heading">
      <h2 id="reward-wallet-heading">Buyer organization wallet</h2>
      <p className="lede">
        Sign in as an organization buyer and Privy will create an embedded Ethereum wallet for you.
        Contributors do not need an account or wallet.
      </p>
      {!ready ? (
        <p className="muted">Loading wallet connection…</p>
      ) : authenticated && wallet ? (
        <>
          <p className="muted">Connected: {wallet.address}</p>
          <button type="button" className="btn" onClick={logout}>Disconnect wallet</button>
        </>
      ) : (
        <button type="button" className="btn primary" onClick={() => login()}>
          Sign in and create buyer wallet
        </button>
      )}
    </section>
  )
}
