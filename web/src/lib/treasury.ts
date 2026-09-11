import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import {
  loadRewardAllocations,
  markRewardAllocationPaid,
  markRewardBatchPaid,
} from "./server-batch"
import { batchCommitment, escrowAddress, nuggetBatchEscrowAbi } from "./escrow"

export type PayoutResult = {
  status: "paid" | "not-configured" | "held"
  batchId: string
  payouts: Array<{ walletAddress: string; amountWei: string; transactionHash: string }>
  error?: string
}

/**
 * Demo settlement relay. In a live CRE deployment, the DON's verified report
 * should invoke the same `settleBatch` call instead of this server signer.
 */
export async function settleEscrowBatch(
  batchId: string,
  rewardMerkleRoot: `0x${string}`,
  eligibleWalletCount: number,
): Promise<{ txHash: string } | null> {
  const contract = escrowAddress()
  if (!contract) return null
  const privateKey = process.env.SETTLEMENT_REPORTER_PRIVATE_KEY
  if (!privateKey) throw new Error("SETTLEMENT_REPORTER_PRIVATE_KEY is not configured")
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("SETTLEMENT_REPORTER_PRIVATE_KEY must be a 32-byte hex private key")
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(rewardMerkleRoot) || !Number.isSafeInteger(eligibleWalletCount) || eligibleWalletCount < 1) {
    throw new Error("CRE did not produce a valid reward settlement commitment")
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const client = createWalletClient({
    account,
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"),
  })
  const hash = await client.writeContract({
    address: contract,
    abi: nuggetBatchEscrowAbi,
    functionName: "settleBatch",
    args: [batchCommitment(batchId), rewardMerkleRoot, BigInt(eligibleWalletCount)],
  })
  return { txHash: hash }
}

export async function payRewards(batchId: string): Promise<PayoutResult> {
  const privateKey = process.env.TREASURY_PRIVATE_KEY
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
  const allocations = await loadRewardAllocations(batchId)
  const pending = allocations.filter((allocation) => allocation.status === "allocated")
  if (pending.length === 0) {
    return { status: allocations.length > 0 ? "paid" : "held", batchId, payouts: [] }
  }
  if (!privateKey) {
    return {
      status: "not-configured",
      batchId,
      payouts: [],
      error: "TREASURY_PRIVATE_KEY is not configured",
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("TREASURY_PRIVATE_KEY must be a 32-byte hex private key")
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const payouts: PayoutResult["payouts"] = []
  for (const allocation of pending) {
    const hash = await walletClient.sendTransaction({
      to: allocation.walletAddress as `0x${string}`,
      value: BigInt(allocation.amountWei),
      chain: sepolia,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`Payout transaction failed: ${hash}`)
    await markRewardAllocationPaid(allocation, hash)
    payouts.push({
      walletAddress: allocation.walletAddress,
      amountWei: allocation.amountWei,
      transactionHash: hash,
    })
  }
  await markRewardBatchPaid(batchId)
  return { status: "paid", batchId, payouts }
}
