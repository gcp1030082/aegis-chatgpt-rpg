# AEGIS MCP architecture

## Ownership

| Data | Owner | Lifetime |
|---|---|---|
| World, player, NPC, inventory, quests, history | MCP backend | Durable |
| Save slots | MCP backend | Durable |
| Selected widget tab | ChatGPT widget | Message-scoped |
| Conversation prose | ChatGPT thread | Conversation-scoped |
| Runtime context | Generated from authoritative State | One turn |

## Turn protocol

1. The model receives the player's exact input.
2. The model calls `aegis_prepare_turn`.
3. The server reads State at revision `N`, selects relevant state and rules, and returns a runtime contract.
4. The model resolves only the supplied action.
5. If nothing persistent changed, the model narrates without a write.
6. If State changed, the model calls `aegis_apply_state_diff` with revision `N` and a unique idempotency key.
7. The server validates the complete next state and performs compare-and-swap.
8. Only after success does the model narrate the mutation as completed.
9. On `REVISION_CONFLICT`, the model starts again from step 2.

## Failure model

- Invalid diff: reject the whole transaction.
- State too large: reject the whole transaction.
- Stale revision: reject and request a fresh turn context.
- Duplicate idempotency key: return the already committed current state without a second mutation.
- Missing save: do not modify the active state.
- Storage failure: do not narrate a durable change.
