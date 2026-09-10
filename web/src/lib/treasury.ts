import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import {
  loadRewardAllocations,
  markRewardAllocationPaid,
  markRewardBatchPaid,
} from "./server-batch"

export type PayoutResult = {
  status: "paid" | "not-configured" | "held"
  batchId: string
  payouts: Array<{ walletAddress: string; amountWei: string; transactionHash: string }>
  error?: string
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
