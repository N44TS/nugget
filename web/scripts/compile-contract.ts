import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import solc from "solc"

const sourcePath = path.resolve(import.meta.dir, "../../contracts/NuggetBatchEscrow.sol")
const source = await readFile(sourcePath, "utf8")
const input = {
  language: "Solidity",
  sources: { "NuggetBatchEscrow.sol": { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
}
const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>
  contracts?: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>
}
const errors = output.errors?.filter((item) => item.severity === "error") ?? []
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"))
const contract = output.contracts?.["NuggetBatchEscrow.sol"]?.NuggetBatchEscrow
if (!contract) throw new Error("NuggetBatchEscrow was not compiled")
const outputDir = path.resolve(import.meta.dir, "../src/lib/generated")
await mkdir(outputDir, { recursive: true })
await writeFile(
  path.join(outputDir, "NuggetBatchEscrow.json"),
  `${JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2)}\n`,
)
console.log("Compiled NuggetBatchEscrow")
