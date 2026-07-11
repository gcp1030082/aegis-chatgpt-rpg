import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AegisService } from "../src/service.js";
import { FileGameStore } from "../src/storage/file-store.js";

describe("AegisService", () => {
  let directory: string;
  let store: FileGameStore;
  let service: AegisService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aegis-test-"));
    store = new FileGameStore(directory);
    await store.initialize();
    service = new AegisService(store, {
      maxDiffBytes: 512 * 1024,
      maxStateBytes: 2 * 1024 * 1024,
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates, commits, retries idempotently, saves, and restores", async () => {
    await service.createGame("main", "測試世界");
    const first = await service.applyDiff(
      "main",
      0,
      "turn-1",
      { player: { name: "洛恩", money: 10 }, history: ["醒來。"] },
      "角色甦醒",
    );
    expect(first.game.revision).toBe(1);

    const replay = await service.applyDiff("main", 0, "turn-1", { player: { money: 999 } });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.player.money).toBe(10);

    const save = await service.createSave("main", "起點", "save-1");
    expect(save.sourceRevision).toBe(1);
    const repeatedSave = await service.createSave("main", "起點", "save-1");
    expect(repeatedSave.saveId).toBe(save.saveId);

    await service.applyDiff("main", 1, "turn-2", { player: { money: 3 } });
    const loaded = await service.loadSave("main", save.saveId, 2, "load-1");
    expect(loaded.game.revision).toBe(3);
    expect(loaded.game.player.money).toBe(10);
    expect((await service.listSaves("main"))).toHaveLength(1);
  });

  it("rejects stale writes", async () => {
    await service.createGame("main");
    await service.applyDiff("main", 0, "turn-1", { player: { money: 1 } });
    await expect(
      service.applyDiff("main", 0, "turn-stale", { player: { money: 2 } }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
});
