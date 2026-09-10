"use client"

import { useGuestAccounts } from "@privy-io/react-auth"
import { useEffect, useState } from "react"
import { loadReceipts } from "@/lib/storage"

const WALLET_KEY = "nugget.rewardWallet.address.v1"
const MIN_CONTRIBUTIONS = 2

export function ContributorRewardWallet() {
  const { createGuestAccount } = useGuestAccounts()
  const [address, setAddress] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [contributionCount, setContributionCount] = useState(0)

  useEffect(() => {
    setAddress(localStorage.getItem(WALLET_KEY))
    setContributionCount(loadReceipts().length)
  }, [])

  const createWallet = async () => {
    setCreating(true)
    setError(null)
    try {
      const user = await createGuestAccount()
      const wallet = user.linkedAccounts.find((account) => account.type === "wallet")
      if (!wallet) throw new Error("Privy did not return a reward wallet")
      const response = await fetch("/api/rewards/opt-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address }),
      })
      const responseText = await response.text()
      let result: { ok?: boolean; error?: string; batchId?: string } = {}
      if (responseText) {
        try {
          result = JSON.parse(responseText) as typeof result
        } catch {
          throw new Error("Reward opt-in returned an invalid server response")
        }
      }
      if (!response.ok || !result.ok || !result.batchId) {
        throw new Error(result.error ?? "Reward opt-in could not be saved")
      }
      setAddress(wallet.address)
      localStorage.setItem(WALLET_KEY, wallet.address)
      setBatchId(result.batchId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create reward wallet")
    } finally {
      setCreating(false)
    }
  }

  const eligible = contributionCount >= MIN_CONTRIBUTIONS

  return (
    <section className="panel" aria-labelledby="contributor-reward-wallet-heading">
      <h2 id="contributor-reward-wallet-heading">Optional contributor rewards</h2>
      <p className="lede">
        Create a separate Privy guest wallet if you want to receive future batch rewards.
        It is not attached to your health contribution.
      </p>
      {address ? (
        <p className="muted">
          Reward wallet ready: {address}
          {batchId && <> · eligible for batch {batchId}</>}
        </p>
      ) : eligible ? (
        <button type="button" className="btn primary" onClick={createWallet} disabled={creating}>
          {creating ? "Creating reward wallet…" : "Opt in to future rewards"}
        </button>
      ) : (
        <p className="muted">
          Log and opt in {MIN_CONTRIBUTIONS - contributionCount} more cycle
          {MIN_CONTRIBUTIONS - contributionCount === 1 ? "" : "s"} to unlock reward opt-in.
        </p>
      )}
      {error && <p className="banner err" role="alert">{error}</p>}
    </section>
  )
}