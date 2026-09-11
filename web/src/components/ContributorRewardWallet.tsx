"use client"

import { usePrivy, useGuestAccounts } from "@privy-io/react-auth"
import { useEffect, useState } from "react"
import { encodeFunctionData } from "viem"
import { useSendTransaction } from "@privy-io/react-auth"
import { batchCommitment, nuggetBatchEscrowAbi } from "@/lib/escrow"
import { base64ToBytes, encryptForCre } from "@/lib/crypto"

const WALLET_KEY = "nugget.rewardWallet.address.v1"
const WALLET_BATCH_KEY = "nugget.rewardWallet.batchId.v1"
const MIN_CONTRIBUTIONS = 1
const escrowAddress = process.env.NEXT_PUBLIC_NUGGET_BATCH_ESCROW_ADDRESS ?? ""

type ContributorRewardWalletProps = {
  contributionCount: number
  rewardBatchId: string | null
  latestClaimId: string | null
}

export function ContributorRewardWallet({ contributionCount, rewardBatchId, latestClaimId }: ContributorRewardWalletProps) {
  const { ready, authenticated, user } = usePrivy()
  const { sendTransaction } = useSendTransaction()
  const { createGuestAccount } = useGuestAccounts()
  const [address, setAddress] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

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
      if (!latestClaimId) throw new Error("Make an anonymous contribution before registering a reward wallet")
      const keyResponse = await fetch("/api/crypto/public-key", { cache: "no-store" })
      const keyData = (await keyResponse.json()) as { publicKey?: string; error?: string }
      if (!keyResponse.ok || !keyData.publicKey) throw new Error(keyData.error ?? "CRE encryption key unavailable")
      const registration = encryptForCre(
        JSON.stringify({ claimId: latestClaimId, walletAddress: wallet.address }),
        base64ToBytes(keyData.publicKey),
      )
      const response = await fetch("/api/rewards/opt-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address, claimId: latestClaimId, batchId: rewardBatchId, registration }),
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

  const claimReward = async () => {
    if (!address || !batchId) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(escrowAddress)) {
      setError("Reward escrow is not configured yet.")
      return
    }
    setClaiming(true)
    setError(null)
    try {
      const response = await fetch(`/api/rewards/claim-proof?batchId=${encodeURIComponent(batchId)}&walletAddress=${encodeURIComponent(address)}`)
      const result = (await response.json()) as { ok?: boolean; proof?: `0x${string}`[]; error?: string }
      if (!response.ok || !result.ok || !result.proof) throw new Error(result.error ?? "Reward is not ready to claim")
      await sendTransaction({
        to: escrowAddress as `0x${string}`,
        chainId: 11155111,
        data: encodeFunctionData({
          abi: nuggetBatchEscrowAbi,
          functionName: "claim",
          args: [batchCommitment(batchId), result.proof],
        }),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reward claim failed")
    } finally {
      setClaiming(false)
    }
  }

  return (
    <section className="reward-wallet" aria-labelledby="contributor-reward-wallet-heading">
      <h3 id="contributor-reward-wallet-heading">Contributor rewards</h3>
      <p className="lede">
        Register a separate reward wallet after your first anonymous contribution. It is eligible only for the current 14-day payout window; future contributions stay opted in until you opt out.
      </p>
      {address ? (
        <>
          <p className="muted">
            Reward wallet ready: {address}
            {batchId && <> · registered for batch {batchId}</>}
          </p>
          {batchId && /^0x[a-fA-F0-9]{40}$/.test(escrowAddress) && (
            <button type="button" className="btn accent" onClick={claimReward} disabled={claiming || !ready}>
              {claiming ? "Claiming reward…" : "Claim reward when batch settles"}
            </button>
          )}
        </>
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
