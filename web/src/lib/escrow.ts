import {
  concatHex,
  encodePacked,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem"

export const nuggetBatchEscrowAbi = [
  {
    type: "function",
    name: "fundBatch",
    stateMutability: "payable",
    inputs: [{ name: "batchId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "settleBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "eligibleCount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "wallet", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const

export const batchCommitment = (batchId: string): Hex => keccak256(stringToHex(batchId))
export const purchaseBatchId = (payoutWindowId: string, paymentTxHash: string): string =>
  `${payoutWindowId}:${paymentTxHash.toLowerCase()}`
export const rewardLeaf = (wallet: string): Hex => keccak256(encodePacked(["address"], [getAddress(wallet)]))

const hashPair = (a: Hex, b: Hex): Hex => keccak256(concatHex(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]))

export const buildRewardTree = (wallets: string[]) => {
  const leaves = [...new Set(wallets.map((wallet) => rewardLeaf(wallet)))].sort()
  if (leaves.length === 0) throw new Error("Cannot build a reward tree with no wallets")
  const levels: Hex[][] = [leaves]
  while (levels[levels.length - 1]!.length > 1) {
    const previous = levels[levels.length - 1]!
    const next: Hex[] = []
    for (let index = 0; index < previous.length; index += 2) {
      next.push(hashPair(previous[index]!, previous[index + 1] ?? previous[index]!))
    }
    levels.push(next)
  }
  return { leaves, levels, root: levels[levels.length - 1]![0]! }
}

export const rewardProof = (wallets: string[], wallet: string): Hex[] => {
  const tree = buildRewardTree(wallets)
  let index = tree.leaves.indexOf(rewardLeaf(wallet))
  if (index < 0) throw new Error("Wallet is not eligible for this batch")
  const proof: Hex[] = []
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level]!
    proof.push(nodes[index ^ 1] ?? nodes[index]!)
    index = Math.floor(index / 2)
  }
  return proof
}

export const escrowAddress = (): Address | null => {
  const value = process.env.NUGGET_BATCH_ESCROW_ADDRESS ?? process.env.NEXT_PUBLIC_NUGGET_BATCH_ESCROW_ADDRESS
  return value && /^0x[a-fA-F0-9]{40}$/.test(value) ? getAddress(value) : null
}
