# Phase 0 — CRE hello-confidential

## Goal
`cre workflow simulate` succeeds for the official hello-confidential template.

## Checklist
- [x] Install CRE CLI (`cre` v1.32.0 → `~/.cre/bin`)
- [x] Install Bun
- [x] `cre login` (nataliee0006@gmail.com / org_KKp6rCvGjKc7385q)
- [x] `cre init` → `cre-hello-confidential` / `hello-confidential-workflows-ts`
- [x] Configure `.env` with `SECRET_API_TOKEN` (any non-empty value for sim)
- [x] `bun install` + `bun test` (9 pass)
- [x] `cre workflow simulate` **GREEN** — see `simulate-evidence.txt`

## Simulate result (2026-09-05)
```
Trigger requested TEE Execution … AWS Nitro in us-west-2
[USER LOG] Enclave computation complete. verdict=APPROVE
✓ Workflow Simulation Result:
"APPROVE (score: 929, secret reached API: true)"
```

## Re-run simulate
```bash
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$PATH"
cd /Users/natalie/Desktop/nugget/cre-hello-confidential
cre workflow simulate my-workflow --target staging-settings --non-interactive --trigger-index 0
```

## Notes
- Deploy access: **not enabled** yet (fine — prize path is simulate).
- Optional stretch later: request Confidential Workflows beta for Vault DON + confidential DON.
- **Phase 1 next:** reshape `my-workflow/workflow.ts` for Nugget k-anon aggregates (do not start until we agree).

## Account links
- CRE: https://app.chain.link/cre/discover
- Confidential access form: https://docs.chain.link/cre/account/confidential-workflows-access
