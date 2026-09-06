import type { CycleEntry } from "./types"
import { bytesToBase64, xorDecryptUtf8, xorEncryptUtf8 } from "./crypto"

const VAULT_KEY = "nugget.device.vault.v1"
const DEVICE_KEY = "nugget.device.key.v1"
const RECEIPTS_KEY = "nugget.receipts.v1"

export type LocalReceipt = {
  claimId: string
  batchId: string
  inEncryptedPool: boolean
}

const getOrCreateDeviceKey = (): string => {
  if (typeof window === "undefined") return "server"
  let key = localStorage.getItem(DEVICE_KEY)
  if (!key) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    localStorage.setItem(DEVICE_KEY, key)
  }
  return key
}

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const loadEntries = (): CycleEntry[] => {
  if (typeof window === "undefined") return []
  const raw = localStorage.getItem(VAULT_KEY)
  if (!raw) return []
  try {
    const plain = xorDecryptUtf8(base64ToBytes(raw), getOrCreateDeviceKey())
    const parsed = JSON.parse(plain) as CycleEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const saveEntries = (entries: CycleEntry[]): void => {
  const plain = JSON.stringify(entries)
  const cipher = xorEncryptUtf8(plain, getOrCreateDeviceKey())
  localStorage.setItem(VAULT_KEY, bytesToBase64(cipher))
}

export const loadReceipts = (): LocalReceipt[] => {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(RECEIPTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as LocalReceipt[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const saveLocalReceipt = (receipt: LocalReceipt): LocalReceipt[] => {
  const next = [receipt, ...loadReceipts().filter((r) => r.claimId !== receipt.claimId)]
  localStorage.setItem(RECEIPTS_KEY, JSON.stringify(next))
  return next
}
