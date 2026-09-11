import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import artifact from "../src/lib/generated/NuggetBatchEscrow.json"

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY
const reporter = process.env.SETTLEMENT_REPORTER_ADDRESS
const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
if (!deployerKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
  throw new Error("DEPLOYER_PRIVATE_KEY must be 0x followed by a 32-byte hex private key")
}
if (!reporter || !/^0x[a-fA-F0-9]{40}$/.test(reporter)) {
  throw new Error("SETTLEMENT_REPORTER_ADDRESS must be a valid Ethereum address")
}

const account = privateKeyToAccount(deployerKey as `0x${string}`)
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode as `0x${string}`,
  args: [reporter as `0x${string}`, 30 * 24 * 60 * 60],
})
const receipt = await publicClient.waitForTransactionReceipt({ hash })
console.log(JSON.stringify({ transactionHash: hash, contractAddress: receipt.contractAddress }, null, 2))
