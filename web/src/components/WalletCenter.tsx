"use client"

import { useExportWallet, useSendTransaction } from "@privy-io/react-auth"
import { useCallback, useEffect, useState } from "react"
import { createPublicClient, formatEther, http, parseEther } from "viem"
import { sepolia } from "viem/chains"

const rpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })

export function WalletCenter({
  address,
  title = "Wallet",
  allowExport = false,
}: {
  address: string
  title?: string
  allowExport?: boolean
}) {
  const { sendTransaction } = useSendTransaction()
  const { exportWallet } = useExportWallet()
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null)
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshBalance = useCallback(async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return
    setLoading(true)
    try {
      setBalanceWei(await publicClient.getBalance({ address: address as `0x${string}` }))
    } catch {
      setError("Could not load the Sepolia balance")
    } finally {
      setLoading(false)
    }
  }, [address])

  useEffect(() => {
    void refreshBalance()
  }, [refreshBalance])

  const send = async () => {
    setError(null)
    setMessage(null)
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      setError("Enter a valid Ethereum recipient address")
      return
    }
    if (!amount || Number(amount) <= 0) {
      setError("Enter an amount greater than zero")
      return
    }
    let value: bigint
    try {
      value = parseEther(amount)
    } catch {
      setError("Enter a valid ETH amount")
      return
    }
    if (balanceWei !== null && value >= balanceWei) {
      setError("Leave enough Sepolia ETH for network gas")
      return
    }
    setSending(true)
    try {
      const transaction = await sendTransaction({
        to: recipient as `0x${string}`,
        value,
        chainId: 11155111,
      })
      setMessage(`Transfer submitted. Transaction: ${transaction.hash.slice(0, 10)}…`)
      setRecipient("")
      setAmount("")
      await refreshBalance()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transfer failed")
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="wallet-center" aria-labelledby={`${title.toLowerCase().replace(/\s+/g, "-")}-heading`}>
      <div className="wallet-heading">
        <div>
          <h4 id={`${title.toLowerCase().replace(/\s+/g, "-")}-heading`}>{title}</h4>
          <p className="wallet-address">{address}</p>
        </div>
        <div className="wallet-balance">
          <span className="wallet-label">Sepolia balance</span>
          <strong>{loading ? "Loading…" : balanceWei === null ? "Unavailable" : `${formatEther(balanceWei)} ETH`}</strong>
        </div>
      </div>
      <div className="wallet-toolbar">
        <button type="button" className="wallet-link" onClick={() => void refreshBalance()} disabled={loading}>
          Refresh balance
        </button>
        <button
          type="button"
          className="wallet-link"
          aria-expanded={optionsOpen}
          aria-controls={`${title.toLowerCase().replace(/\s+/g, "-")}-options`}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          {optionsOpen ? "Close wallet options" : "Open wallet options"}
        </button>
      </div>
      {optionsOpen && (
        <div className="wallet-options" id={`${title.toLowerCase().replace(/\s+/g, "-")}-options`}>
          <div className="wallet-fields">
            <label>
              Send to
              <input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x…" inputMode="text" />
            </label>
            <label>
              Amount (ETH)
              <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0001" inputMode="decimal" />
            </label>
          </div>
          <div className="wallet-actions">
            <button type="button" className="btn primary" onClick={() => void send()} disabled={sending || loading}>
              {sending ? "Sending…" : "Send Sepolia ETH"}
            </button>
            {allowExport && (
              <button type="button" className="btn secondary" onClick={() => void exportWallet({ address })}>
                Export wallet with Privy
              </button>
            )}
          </div>
          <p className="muted">Transfers and export stay behind Privy confirmation screens.</p>
        </div>
      )}
      {message && <p className="banner ok" role="status">{message}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}
    </section>
  )
}
