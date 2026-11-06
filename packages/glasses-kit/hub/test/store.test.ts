import { describe, expect, it } from "vitest";
import { MemoryUnitStore, withReadCache, type UnitStore } from "../src/store.js";

/** A store whose database can be "dropped" (like a flaky hotspot losing Supabase). */
function flaky(): { store: UnitStore; down: (d: boolean) => void } {
  const mem = new MemoryUnitStore();
  let isDown = false;
  const guard = <T>(f: () => Promise<T>) => (isDown ? Promise.reject(new Error("Can't reach database server")) : f());
  return {
    down: (d) => (isDown = d),
    store: {
      kind: "postgres",
      getUnit: (id) => guard(() => mem.getUnit(id)),
      registerUnit: (id, h) => guard(() => mem.registerUnit(id, h)),
      findByOwnerHash: (h) => guard(() => mem.findByOwnerHash(h)),
      setOwner: (id, h) => guard(() => mem.setOwner(id, h)),
      close: () => mem.close(),
    },
  };
}

describe("withReadCache", () => {
  it("serves known units and owners while the database is down", async () => {
    const f = flaky();
    const s = withReadCache(f.store);
    await s.registerUnit("unit-a", "h1");
    await s.setOwner("unit-a", "owner1");
    expect(await s.findByOwnerHash("owner1")).toMatchObject({ unitId: "unit-a" });
    f.down(true);
    expect(await s.getUnit("unit-a")).toMatchObject({ unitSecretHash: "h1", ownerTokenHash: "owner1" });
    expect(await s.findByOwnerHash("owner1")).toMatchObject({ unitId: "unit-a" });
    await expect(s.findByOwnerHash("someone-else")).rejects.toThrow(); // unknown: no guessing
    await expect(s.setOwner("unit-a", null)).rejects.toThrow(); // writes never pretend to succeed
  });

  it("tracks owner changes so a stale owner isn't served", async () => {
    const f = flaky();
    const s = withReadCache(f.store);
    await s.registerUnit("unit-b", "h2");
    await s.setOwner("unit-b", "old");
    await s.setOwner("unit-b", "new");
    f.down(true);
    await expect(s.findByOwnerHash("old")).rejects.toThrow();
    expect(await s.findByOwnerHash("new")).toMatchObject({ unitId: "unit-b" });
  });
});
