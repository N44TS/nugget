"use client"

import { PrivyProvider } from "@privy-io/react-auth"

export function PrivyShell({
  appId,
  children,
}: {
  appId: string
  children: React.ReactNode
}) {
  if (!appId) return children

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users",
          },
        },
        appearance: {
          walletChainType: "ethereum-only",
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}
