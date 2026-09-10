## Contract changes

- Describe any behavior, vocabulary, or fixture drift.

## Offline fixture or replay evidence

- List the offline fixtures or replay inputs used.
- Paste the local verification output for the commands below.

## Workflow/docs/template contract impact

- Call out any workflow contract, docs contract, or template contract changes.
- Note any package boundary, provider routing, fallback policy, or local-vs-CI behavior updates.

## Local verification

- [ ] `pnpm -r check`
- [ ] `pnpm --filter platform-contracts test -- --governance`
- [ ] `pnpm --filter rolepilot-engine test:ci`

## Workflow names and admin follow-up

- [ ] No GitHub admin follow-up needed
- [ ] Required checks or branch protection need manual GitHub updates

## Notes for reviewers

- Required workflow: `PR Checks`
- Required job: `pr-checks`
- Required CI must stay offline-safe and must not depend on live providers or provider credentials

## Evidence

```text
Paste command output here
```
