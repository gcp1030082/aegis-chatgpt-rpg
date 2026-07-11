# AEGIS repository guidance

## Invariants

- Persistent State is authoritative. Narrative output never creates State by itself.
- Every state mutation must be atomic, revision-checked, size-limited, and validated.
- Retried writes must be idempotent.
- Never expose internal State Diff, validation, revision, or transaction steps as player-visible RPG prose.
- Interface queries do not advance time.
- Preserve player agency: never infer a major player choice that was not supplied.

## Commands

- Install: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Full verification: `npm run check && npm run build`
- Development server: `npm run dev`

## Change expectations

- Add or update tests for State Diff, storage, migration, or tool-contract changes.
- Never place credentials or real player data in fixtures.
- Keep data tools separate from rendering tools.
- Set accurate MCP tool impact annotations.
- Treat `legacy/aegis_companion_v6_7_7.html` as an immutable source artifact unless a migration task explicitly requires changing it.
