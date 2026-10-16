# AGENTS.md — GitHub Actions

This checkout is a self-hosted local fork, so the remote CI lanes, runner routing, packaging and publication workflows were removed. Two governance workflows remain only because a local gate parses them:

- `workflows/issue-policy.yml` and `workflows/issue-lifecycle.yml` — `pnpm run test:issue-management` reads both files and asserts their rules, so keep them in sync with that test.

Do not reintroduce CI lanes, self-hosted runner routing, or packaging and publication workflows here.
