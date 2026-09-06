/**
 * Prove :3000 and :3001 share one pool, then CRE sees n=2.
 * Both servers must already be running.
 */
const ports = [3000, 3001]

console.log("Clear pool via 3000…")
let res = await fetch("http://127.0.0.1:3000/api/pool/reset", { method: "POST" })
if (!res.ok) {
  console.error("Start web on 3000 and 3001 first.")
  process.exit(1)
}

for (const port of ports) {
  const contribution = {
    claimId: `dual-${port}-${Date.now()}`,
    cycleLengthDays: 28,
    periodLengthDays: 5,
    symptoms: ["cramps"],
    ageBand: port === 3000 ? "35-44" : "25-34",
  }
  res = await fetch(`http://127.0.0.1:${port}/api/contribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contribution }),
  })
  const json = await res.json()
  console.log(`port ${port} → ok=${json.ok} poolSize=${json.pool?.size} dataDir=${json.dataDir}`)
  if (!json.ok || json.pool?.size !== ports.indexOf(port) + 1) {
    console.error("FAIL: expected growing pool size", json)
    process.exit(1)
  }
}

res = await fetch("http://127.0.0.1:3000/api/buyer/run-cre", { method: "POST" })
const cre = await res.json()
console.log("CRE", cre.creSummary)
console.log("n=", cre.report?.contributorCount, "poolSize=", cre.poolSize)
if (cre.report?.contributorCount !== 2) {
  console.error("FAIL expected n=2")
  process.exit(1)
}
console.log("OK dual-port + CRE")
