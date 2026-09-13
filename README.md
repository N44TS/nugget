# <img width="62" height="50" alt="Image" src="https://github.com/user-attachments/assets/0c9c9d17-db56-4169-b099-8b787df4de3f" /> Nugget.

Private period tracker that pays you. 

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
  * [Honest limitations](#honest-limitations)
  * [License](#license)
  * [Credits](#credits)
  * [FAQs](#faqs)
  * [Conclusion](#conclusion)
  * [In-depth: how payment and Merkle claiming actually works](#in-depth-how-payment-and-merkle-claiming-actually-works)

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
3. **Watch it happen**: the CRE simulation output streams into the Render logs in real time; the resulting report and escrow settlement transaction appear in the app.
4. **Contributor claims**: once eligible, a "claim reward" button appears — click it, sign with your Privy wallet, funds arrive directly from the contract.

## Prerequisites

- A small amount of Sepolia ETH.

## Privacy design

- `/api/contribute` (health data) only ever handles an encrypted envelope and a batch ID. No wallet address is accepted, stored, or referenced anywhere in this path.
- `/api/rewards/opt-in` (wallet registration) only ever knows a wallet address and a payout window — never a reference to any specific health submission.
- These write to separate database tables with no join between them.
- Reward payout groups respect the same k-anonymity minimum as the data aggregate itself.
- **Honest framing**: this is *pseudonymity*, not full anonymity. Wallet activity is publicly observable on Sepolia forever, and a sufficiently motivated observer could still attempt network-level timing correlation between requests. We chose to state this plainly rather than overclaim it.

## Honest limitations

- **CRE is demonstrated via simulation (`cre workflow simulate`), not a live deployment.** Confidential-workflow deploy access is a gated beta we don't yet have. Simulation is explicitly an accepted, valid way to satisfy the track's requirements — but it is not yet running on Chainlink's live DON, and we say so rather than imply otherwise.
- **The eligible-wallet list is currently assembled by our own server after CRE finishes, not inside the TEE itself.** The contract still correctly enforces "no double claims" and "only pays wallets proven to be on the submitted list" — but right now, it trusts our server to have submitted the *correct* list. Closing this gap means feeding encrypted reward-wallet registrations into CRE directly, so the TEE derives the eligible list and Merkle root itself, and the app server never gets to choose who's paid. This is the single most valuable next step for the project.
- **Payout lifecycle**: rewards settle on a 14-day payout window (anyone with at least one valid contribution in that window shares that window's pool equally), while buyers can purchase a report covering a rolling six-month scope. This means a contributor can be rewarded from multiple buyer purchases over time, not just once ever — but the windowing logic is a recent addition and still being hardened.
- **Sybil resistance is an open problem, not yet solved.** A cooldown period before a freshly created wallet counts toward payout eligibility is the planned mitigation.

## License

This project is licensed under the MIT License.

## Credits

Built by @N44TS for ETHGlobal.

## FAQs

**Why can a contributor claim more than once?**
"Claim once" means once per buyer-funded release, not once ever. If five different buyers purchase reports that include your contribution window, you can receive five separate rewards.

**Does Chainlink CRE do anything beyond aggregating the cycle data?**
Today: it fetches encrypted contributions, decrypts them inside `handlerInTee`, validates and aggregates them, and enforces the k-anonymity threshold — the same core confidential job throughout. It does not yet generate the reward Merkle root itself; that's the next planned step (see Honest limitations).

**Is this more anonymous than a normal payout, in the strict cryptographic sense?**
Not yet, fully. Claiming makes a reward wallet's association with a payout window publicly visible on-chain — the same as any direct payout would be. What Merkle proofs *do* provide today: no full recipient list stored on-chain, cryptographic proof of eligibility, and enforced one-claim-per-release. A separate, dedicated reward wallet (not reused elsewhere) is what actually protects a contributor's identity.

**Why use a smart contract instead of just paying people directly?**
Because it makes the payout trust-minimized. Once the contract holds the funds, our own server can no longer decide, redirect, or skip a payout — it can only ever pay a wallet that proves it's on the sealed list, and only once.

## Conclusion

Nugget is an attempt to build the Web3 version of "your data, your choice, your cut" for women's health — genuinely private by architecture, not by policy promise, with real money changing hands in a way no single party (including us) fully controls. It's not finished — the honest limitations above are real and stated on purpose — but the core loop, from an anonymous cycle log to a Chainlink-verified payout, works end to end today.

## In-depth: how payment and Merkle claiming actually works

Imagine a locked tip jar and a raffle.

**The tip jar**: a buyer pays into the escrow contract. Think of it as a tip jar that only opens under specific rules — not something anyone, including us, can just dip into.

**The raffle seal**: Chainlink CRE looks at all the anonymous contributors in a payout window and decides who qualifies for a share — without ever revealing who they are. That decision gets compressed into a single scrambled fingerprint, a Merkle root, and only *that* fingerprint goes on-chain. It's like a wax seal on an envelope containing 50 raffle tickets: the seal proves the list is official and unforgeable, without saying who holds which ticket.

**The ticket stub**: each eligible contributor gets their own personal proof — a tiny piece of data that says "I'm one of the 50 on that sealed list," without revealing anyone else's. When they want their reward, they submit their stub to the contract. The contract checks it against the seal; if it matches, money comes out automatically, straight to their wallet. Try to reuse the same stub twice, and the contract remembers and blocks it.

Nobody — not me, not a hacker, not even Chainlink — ever needs to see a list connecting a real person to their health data to make the payment happen. The blockchain only ever sees one sealed envelope, and individual stubs being redeemed against it. That's what makes the payout trustworthy *and* private at the same time — normally you have to pick one or the other.

## Demo testing notes

To test the contributor and buyer flows at the same time, use two different
browsers or separate browser profiles. Privy keeps the signed-in session and
embedded wallet within a browser session, so using one browser for both roles
can show the same address on both sides. Contributors do not need to log in
with an external wallet.
