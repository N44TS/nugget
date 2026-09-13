# <img width="62" height="50" alt="Image" src="https://github.com/user-attachments/assets/0c9c9d17-db56-4169-b099-8b787df4de3f" /> Nugget.

Private period tracker that pays you. 

<img width="400" height="449" alt="Image" src="https://github.com/user-attachments/assets/faf854af-cb58-483f-a517-d5216dee0ba7" />

Nugget is a decentralised, privacy-preserving health app built on Chainlink CRE confidential workflow and Privy. It uses TEE's to ensure user data privacy while enabling period tracking and giving people who have periods the opportunity to earn from their data, anonymously. 

Women weren't even legally required to be included in clinical research until 1993! Most period-tracking apps sell your data without you knowing, or "protect" it by just holding onto it themselves. Nugget does neither: your data is encrypted before it ever leaves your device, aggregated privately inside a Chainlink confidential compute enclave, and you get paid for your contribution — without ever revealing who you are.

Decentralisation is one of the most important parts of this app. Merkle trees and a smart-contract escrow let a contributor's data be used and paid for without that payment ever being traceable back to them.

Video walkthrough with subtitles for hard of hearing (or just snacking and cant hear over the munch crunch crunch): https://www.veed.io/view/947cca44-19f4-496c-a5c3-eee37642c23b?source=editor&panel=share

Test out the Live Demo! - but its on Render so might take a mintute to load up: [nugget](https://nugget-j3xq.onrender.com)


## Table of Contents

- [Nugget](#-nugget)
  * [Table of Contents](#table-of-contents)
  * [Features Summary](#features-summary)
  * [How it works](#how-it-works)
  * [Usage](#usage)
  * [Prerequisites](#prerequisites)
  * [Privacy design](#privacy-design)
  * [Conclusion](#conclusion)

## Features Summary

- **Anonymous contribution**: contributors log cycle data (period dates, symptoms, age band) in the app. Data is encrypted client-side before it ever leaves the device — nothing is stored or transmitted in plaintext, and no account, email, or social login is required.

- **Confidential aggregation via Chainlink CRE**: encrypted contributions are decrypted and aggregated only inside a Chainlink CRE confidential handler (`handlerInTee`), which enforces a k-anonymity threshold and outputs only public, aggregate statistics — never raw or individually identifiable data.

- **Zero-crypto-friction contributor wallets**: I wanted to abstract away all the annoying crypto stuff. Contributors get a Privy guest wallet with one click — no seed phrase, no login — and can immediately start receiving rewards to that address. They can later export the wallet or send funds elsewhere; there's as little "touching crypto" as possible.

- **Buyer-funded escrow, not a company bank account**: buyers (researchers, femtech companies) pay into a smart contract, not to us. The contract holds the funds and only releases them according to its own rules.

- **Self-service, trustless reward claiming**: once CRE decides who's eligible for a reward, that decision is sealed on-chain as a Merkle root. Each eligible contributor then claims their own share directly from the contract with a personal proof — no server-run payout loop, no one holding funds on their behalf.

- **Wallet identity and health data are never linked** — not in the database, not on-chain, not by us. See [Privacy design](#privacy-design).

## How it works

1. Contributor logs their cycle → data is encrypted on their own device.
2. Encrypted data is sent to Supabase, where it just sits, waiting.
3. A buyer pays into the escrow contract — this is what triggers everything.
4. That payment triggers Chainlink CRE to fetch the encrypted pool from Supabase.
5. Inside the CRE enclave: decrypt → check there's enough people to stay anonymous (k-anonymity) → aggregate into stats.
6. CRE sends out two things: a public report for the buyer, and a sealed eligibility list (a Merkle root) for the contract — never a wallet address directly.
7. The contract records that root. Eligible contributors can now claim.
8. A contributor's app checks Supabase for their own personal proof, and they submit it to the contract themselves.
9. The contract checks the proof, and pays out directly from the funds the buyer deposited.

Why the whole system works without ever knowing who the person is: the contract doesn't check "is this a real verified person" — it just checks "does this wallet address match one on the sealed list." The Privy wallet is simultaneously their identity in the system and their payment destination, with no name ever attached to it.

## Usage

*Sepolia testnet only — no real funds required.*

1. **Contributor**: log a cycle (period dates, symptoms, age band), optionally opt in to the research pool, optionally create a reward wallet (Privy, one click, no login).
2. **Buyer**: go to `/buyer`, sign in, pay the report fee — this triggers the CRE aggregation live.
3. **Contributor claims**: once eligible, a "claim reward" button appears — click it, sign with your Privy wallet, funds arrive directly from the contract.

## Prerequisites

- A small amount of Sepolia ETH.

## Privacy design

- `/api/contribute` (health data) only ever handles an encrypted envelope and a batch ID. No wallet address is accepted, stored, or referenced anywhere in this path.
- `/api/rewards/opt-in` (wallet registration) only ever knows a wallet address and a payout window — never a reference to any specific health submission.
- These write to separate database tables with no join between them.
- Reward payout groups respect the same k-anonymity minimum as the data aggregate itself.

## limitations

- **CRE is demonstrated via simulation (`cre workflow simulate`), not a live deployment.** Confidential-workflow deploy access is gated beta and I didn't get access. Simulation is explicitly an accepted, valid way to satisfy the track's requirements — but it is not yet running on Chainlink's live DON.
- Here is a terminal output example of it though: 
<img width="200" height="148" alt="Image" src="https://github.com/user-attachments/assets/3721d768-ab32-463f-b239-0455658aada9" />

- **Sybil resistance is an open problem, not yet solved.** A cooldown period before a freshly created wallet counts toward payout eligibility is the planned mitigation for this mvp.


## Conclusion

I reaslied Nugget might be a Web3 version of "your data, your choice, your cut" for women's health — but private by architecture instead of policy promise, with real money changing hands in a way no single party fully controls. The core loop, from an anonymous cycle log to a Chainlink-verified payout, works end to end today. Nobody — not me, not a hacker, not even Chainlink — ever needs to see a list connecting a real person to their health data to make the payment happen. The blockchain only ever sees one sealed envelope, and individual stubs being redeemed against it.

## How it works chart
<img width="250" height="160" alt="Image" src="https://github.com/user-attachments/assets/8b34d46b-d805-4535-8cc6-2489bd67dc5a" />


## Demo testing notes

To test the contributor and buyer flows at the same time, use two different
browsers or separate browser profiles. Privy keeps the signed-in session and
embedded wallet within a browser session, so using one browser for both roles
can show the same address on both sides. 
