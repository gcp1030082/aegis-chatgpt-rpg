# AEGIS MCP architecture

## Ownership

| Data | Owner | Lifetime |
|---|---|---|
| World, player, player-known map/NPC/compendium, inventory, quests, history | MCP backend | Durable |
| Disaster-recovery snapshots | MCP backend, developer-only | Durable |
| Selected widget tab | ChatGPT widget | Message-scoped |
| Conversation prose | ChatGPT thread | Conversation-scoped |
| Runtime context | Generated from authoritative State | One turn |

## Turn protocol

1. The model receives the player's exact input.
2. The model silently calls `aegis_prepare_turn`; this tool never renders a widget.
3. The server reads State at revision `N`, selects relevant state and rules, and returns a runtime contract.
4. The model resolves only the supplied action.
5. If nothing persistent changed, the model does not create a meaningless revision.
6. If State changed, the model calls `aegis_apply_state_diff` with revision `N` and a unique idempotency key.
7. The server validates the complete next state and performs compare-and-swap.
8. Only after success does the model narrate the mutation as completed.
9. After every required write is complete, the model calls `aegis_show_dashboard` at most once with the final state.
10. The widget deduplicates by `gameId + revision`, rejects stale revisions, and changes tabs locally without tools or mutations.
11. On `REVISION_CONFLICT`, the model starts again from step 2 and must not render the rejected intermediate state.

Travel and other long events can include an `outcome_diff` in `aegis_advance_time`, so elapsed time, survival costs, location, newly known map entries, NPCs, compendium entries, quests, and the event result commit atomically in one revision.

## Failure model

- Invalid diff: reject the whole transaction.
- State too large: reject the whole transaction.
- Stale revision: reject and request a fresh turn context.
- Duplicate idempotency key: return the already committed current state without a second mutation.
- Missing save: do not modify the active state.
- Storage failure: do not narrate a durable change.
