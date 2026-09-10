"use client"

import { usePrivy, useGuestAccounts } from "@privy-io/react-auth"
import { useEffect, useState } from "react"

const WALLET_KEY = "nugget.rewardWallet.address.v1"
const WALLET_BATCH_KEY = "nugget.rewardWallet.batchId.v1"
const MIN_CONTRIBUTIONS = 2

type ContributorRewardWalletProps = {
  contributionCount: number
  rewardBatchId: string | null
}

export function ContributorRewardWallet({ contributionCount, rewardBatchId }: ContributorRewardWalletProps) {
  const { ready, authenticated, user } = usePrivy()
  const { createGuestAccount } = useGuestAccounts()
  const [address, setAddress] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)

  useEffect(() => {
    setAddress(localStorage.getItem(WALLET_KEY))
    setBatchId(localStorage.getItem(WALLET_BATCH_KEY) ?? rewardBatchId)
  }, [rewardBatchId])

  const createWallet = async () => {
    setCreating(true)
    setError(null)
    try {
      const guestUser = authenticated ? user : await createGuestAccount()
      const wallet = guestUser?.linkedAccounts.find((account) => account.type === "wallet")
      if (!wallet) throw new Error("No wallet is available for reward registration")
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
      localStorage.setItem(WALLET_BATCH_KEY, result.batchId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create reward wallet")
    } finally {
      setCreating(false)
    }
  }

  const eligible = contributionCount >= MIN_CONTRIBUTIONS

  return (
    <section className="reward-wallet" aria-labelledby="contributor-reward-wallet-heading">
      <h3 id="contributor-reward-wallet-heading">Contributor rewards</h3>
      <p className="lede">
        After two anonymous contributions, register a wallet for any future rewards from a qualifying batch. For the strongest privacy, use a separate guest wallet.
      </p>
      {address ? (
        <p className="muted">
          Reward wallet ready: {address}
          {batchId && <> · registered for batch {batchId}</>}
        </p>
      ) : eligible ? (
        <button
          type="button"
          className="btn primary"
          onClick={createWallet}
          disabled={creating || !ready}
        >
          {!ready ? "Loading wallet system…" : creating ? "Registering reward wallet…" : authenticated ? "Register connected wallet" : "Create reward wallet"}
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
