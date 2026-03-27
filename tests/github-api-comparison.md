# DCP vs JSON — GitHub API Token Comparison

## Purpose

Measure token reduction when converting real GitHub API responses to DCP format.
Target: `list_issues`, `list_pull_requests` — high field count, repeated structure.

## Method

1. Fetch real data from GitHub API (e.g. hiatamaworkshop repos)
2. Save raw JSON response
3. Run through `dcp-wrap init` to generate schema
4. Run through `dcp-wrap encode` to produce DCP output
5. Compare: byte size, estimated token count (chars/4 approximation)

## Expected

- 40-60% token reduction based on specification benchmarks
- More fields per record → higher reduction ratio
- Schema inference should handle GitHub's nested objects (user.login, labels[])

## Status

Pending — next step after this memo.
