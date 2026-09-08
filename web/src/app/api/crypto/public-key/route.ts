import { NextResponse } from "next/server"

const PUBLIC_KEY_BYTES = 32

export async function GET() {
  const publicKey = process.env.CRE_PUBLIC_KEY
  if (!publicKey) {
    return NextResponse.json({ error: "CRE public key is not configured" }, { status: 503 })
  }

  try {
    const decoded = Buffer.from(publicKey, "base64")
    if (decoded.length !== PUBLIC_KEY_BYTES) throw new Error("invalid key length")
  } catch {
    return NextResponse.json({ error: "CRE public key is invalid" }, { status: 500 })
  }

  return NextResponse.json(
    { encoding: "x25519-public-key-b64", publicKey },
    { headers: { "Cache-Control": "no-store" } },
  )
}
