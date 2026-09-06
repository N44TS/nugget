/** Matches CRE workflow nugget1-xor-b64 unlock path. */

export const xorEncryptUtf8 = (plain: string, key: string): Uint8Array => {
  const bytes = new TextEncoder().encode(plain)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i]! ^ key.charCodeAt(i % key.length)
  }
  return out
}

export const xorDecryptUtf8 = (cipherBytes: Uint8Array, key: string): string => {
  const out = new Uint8Array(cipherBytes.length)
  for (let i = 0; i < cipherBytes.length; i++) {
    out[i] = cipherBytes[i]! ^ key.charCodeAt(i % key.length)
  }
  return new TextDecoder().decode(out)
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

export const wrapEncryptedBatch = (plainJson: string, key: string) => ({
  encoding: "nugget1-xor-b64" as const,
  payload: bytesToBase64(xorEncryptUtf8(plainJson, key)),
})
