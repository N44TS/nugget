import { x25519 } from "@noble/curves/ed25519.js"
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { sha256 } from "@noble/hashes/sha2.js"

export type CreEncryptedContribution = {
  encoding: "nugget1-x25519-xchacha20poly1305-b64"
  ephemeralPublicKey: string
  nonce: string
  payload: string
}

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

export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const keyBytes = (key: string): Uint8Array => sha256(new TextEncoder().encode(key))

const sharedKey = (sharedSecret: Uint8Array): Uint8Array => sha256(sharedSecret)

export const encryptAuthenticatedUtf8 = (plain: string, key: string, nonce: Uint8Array): string =>
  bytesToBase64(
    xchacha20poly1305(keyBytes(key), nonce).encrypt(new TextEncoder().encode(plain)),
  )

export const decryptAuthenticatedUtf8 = (
  payload: string,
  key: string,
  nonce: Uint8Array,
): string =>
  new TextDecoder().decode(
    xchacha20poly1305(keyBytes(key), nonce).decrypt(base64ToBytes(payload)),
  )

export const encryptForCre = (
  plain: string,
  recipientPublicKey: Uint8Array,
  ephemeralPrivateKey = x25519.utils.randomSecretKey(),
): CreEncryptedContribution => {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, recipientPublicKey)
  return {
    encoding: "nugget1-x25519-xchacha20poly1305-b64",
    ephemeralPublicKey: bytesToBase64(x25519.getPublicKey(ephemeralPrivateKey)),
    nonce: bytesToBase64(nonce),
    payload: bytesToBase64(
      xchacha20poly1305(sharedKey(sharedSecret), nonce).encrypt(new TextEncoder().encode(plain)),
    ),
  }
}

export const wrapEncryptedBatch = (plainJson: string, key: string) => {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  return {
    encoding: "nugget1-xchacha20poly1305-b64" as const,
    nonce: bytesToBase64(nonce),
    payload: encryptAuthenticatedUtf8(plainJson, key, nonce),
  }
}
