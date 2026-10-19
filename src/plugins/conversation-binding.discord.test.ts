import { expectDefined } from "@openclaw/normalization-core";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  bindConversationNow,
  detachPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

type StoredDiscordBinding = {
  targetSessionKey: string;
  metadata?: Record<string, unknown>;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};
type DiscordBindingManager = {
  getByThreadId: (threadId: string) => StoredDiscordBinding | undefined;
  touchThread: (params: { threadId: string; at?: number }) => Promise<StoredDiscordBinding | null>;
  touchThreadSync: (
    params: Parameters<DiscordBindingManager["touchThread"]>[0],
  ) => StoredDiscordBinding | null;
  stop: () => Promise<void>;
};
type SessionUnbindParams = { targetSessionKey: string; sendFarewell?: boolean };
type IdleUpdateParams = { targetSessionKey: string; idleTimeoutMs: number };
type MaxAgeUpdateParams = { targetSessionKey: string; maxAgeMs: number };

const { loadDiscordThreadBindingTestHarness, resetThreadBindingsForTests } =
  await loadBundledPluginFacade<{
    loadDiscordThreadBindingTestHarness: () => Promise<{
      createTestThreadBindingManager: (params: {
        accountId: string;
        persist: boolean;
      }) => Promise<DiscordBindingManager>;
      installThreadBindingLifecycleTestHooks: () => void;
    }>;
    resetThreadBindingsForTests: () => Promise<void>;
  }>({ pluginId: "discord", artifactBasename: "test-api.js" });
const { createTestThreadBindingManager, installThreadBindingLifecycleTestHooks } =
  await loadDiscordThreadBindingTestHarness();
const {
  setDiscordRuntime,
  unbindThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKeyAsync,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKey,
  setThreadBindingMaxAgeBySessionKeyAsync,
} = await loadBundledPluginFacade<{
  setDiscordRuntime: (runtime: PluginRuntime) => void;
  unbindThreadBindingsBySessionKey: (params: SessionUnbindParams) => StoredDiscordBinding[];
  unbindThreadBindingsBySessionKeyAsync: (
    params: SessionUnbindParams,
  ) => Promise<StoredDiscordBinding[]>;
  setThreadBindingIdleTimeoutBySessionKey: (params: IdleUpdateParams) => StoredDiscordBinding[];
  setThreadBindingIdleTimeoutBySessionKeyAsync: (
    params: IdleUpdateParams,
  ) => Promise<StoredDiscordBinding[]>;
  setThreadBindingMaxAgeBySessionKey: (params: MaxAgeUpdateParams) => StoredDiscordBinding[];
  setThreadBindingMaxAgeBySessionKeyAsync: (
    params: MaxAgeUpdateParams,
  ) => Promise<StoredDiscordBinding[]>;
}>({ pluginId: "discord", artifactBasename: "runtime-api.js" });

installThreadBindingLifecycleTestHooks();

const identity = { pluginId: "codex", pluginName: "Codex", pluginRoot: "/plugins/codex-a" };
const conversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "thread-1",
  parentConversationId: "parent-1",
};

async function setup() {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-discord-binding-owner-",
  });
  const foreign = new PluginInstance("codex");
  const owners: Array<{ retire(): void; dispose(): Promise<unknown> }> = [];
  onTestFinished(async () => {
    await resetThreadBindingsForTests();
    for (const owner of owners) {
      owner.retire();
      await owner.dispose();
    }
    await foreign.dispose();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });
  const { createPluginRuntime } = await import("./runtime/index.js");
  const createOwner = () => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "discord", origin: "bundled" });
    const api = builder.createApi(record, { config: {}, registrationMode: "full" });
    const instance = expectDefined(getPluginInstance(record), "Discord registry instance");
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    instance.run(() => setDiscordRuntime(api.runtime));
    const owner = {
      instance,
      retire: () => markPluginRegistryRetired(builder.registry),
      dispose: () => instance.dispose(),
      start: (accountId = "default") =>
        instance.run(() => createTestThreadBindingManager({ accountId, persist: true })),
    };
    owners.push(owner);
    return owner;
  };
  const owner = createOwner();
  const manager = await owner.start();
  await owner.instance.run(() =>
    bindConversationNow({ identity, conversation, summary: "original" }),
  );
  // Observe durable rows even after retirement. The manager uses real registry authority.
  const observer = createPluginStateKeyedStoreV2ForTests<StoredDiscordBinding>(
    "discord",
    { namespace: "thread-bindings", maxEntries: 10_000 },
    { assertCurrent() {} },
  );
  const stored = () => observer.entries();
  const snapshot = await stored();
  expect(snapshot).toMatchObject([
    { key: "default:thread-1", value: { metadata: { summary: "original" } } },
  ]);
  const refresh = (summary: string, accountId = "default") =>
    foreign.run(() =>
      requestPluginConversationBinding({
        ...identity,
        conversation: { ...conversation, accountId },
        binding: { summary },
      }),
    );
  return { foreign, owner, manager, createOwner, stored, snapshot, refresh };
}

describe("Discord binding runtime ownership", () => {
  it("keeps a foreign-instance detach removed after manager restart", async () => {
    const { foreign, owner, manager, stored } = await setup();
    await expect(
      foreign.run(() =>
        detachPluginConversationBinding({ pluginRoot: identity.pluginRoot, conversation }),
      ),
    ).resolves.toEqual({ removed: true });
    expect(manager.getByThreadId("thread-1")).toBeUndefined();
    expect(await stored()).toEqual([]);
    await resetThreadBindingsForTests();
    await owner.start();
    expect(await getSessionBindingService().resolveByConversationAsync(conversation)).toBeNull();
  });

  it("persists a foreign-instance rebind and subsequent channel-owned binding", async () => {
    const { owner, stored, refresh } = await setup();
    expect(await refresh("refreshed")).toMatchObject({ status: "bound" });
    await owner.instance.run(() =>
      bindConversationNow({
        identity,
        conversation: { ...conversation, conversationId: "thread-2" },
        summary: "second",
      }),
    );
    expect(await stored()).toMatchObject([
      { key: "default:thread-1", value: { metadata: { summary: "refreshed" } } },
      { key: "default:thread-2", value: { metadata: { summary: "second" } } },
    ]);
  });

  it.each(["async", "sync"] as const)(
    "persists %s activity from a foreign instance",
    async (mode) => {
      const { foreign, manager, stored } = await setup();
      const at = Date.now() + 30_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      try {
        await foreign.run(() =>
          mode === "sync"
            ? manager.touchThreadSync({ threadId: "thread-1", at })
            : manager.touchThread({ threadId: "thread-1", at }),
        );
        expect(await stored()).toMatchObject([{ value: { lastActivityAt: at } }]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["async", "sync"] as const)(
    "persists %s session-wide updates and unbinds",
    async (mode) => {
      const { foreign, manager, stored } = await setup();
      const targetSessionKey = expectDefined(
        manager.getByThreadId("thread-1"),
        "seed binding",
      ).targetSessionKey;
      await foreign.run(() =>
        (mode === "sync"
          ? setThreadBindingIdleTimeoutBySessionKey
          : setThreadBindingIdleTimeoutBySessionKeyAsync)({
          targetSessionKey,
          idleTimeoutMs: 45_000,
        }),
      );
      expect(await stored()).toMatchObject([{ value: { idleTimeoutMs: 45_000 } }]);
      await foreign.run(() =>
        (mode === "sync"
          ? unbindThreadBindingsBySessionKey
          : unbindThreadBindingsBySessionKeyAsync)({ targetSessionKey, sendFarewell: false }),
      );
      expect(await stored()).toEqual([]);
    },
  );

  it("does not replace a live manager's runtime during candidate lookup", async () => {
    const { manager, createOwner, stored, refresh } = await setup();
    const candidate = createOwner();
    expect(await candidate.start()).toBe(manager);
    candidate.retire();
    await refresh("original owner");
    expect(await stored()).toMatchObject([{ value: { metadata: { summary: "original owner" } } }]);
  });

  it("does not let a retired manager borrow an active candidate's runtime", async () => {
    const { owner, manager, createOwner, stored, snapshot, refresh } = await setup();
    const candidate = createOwner();
    expect(await candidate.start()).toBe(manager);
    owner.retire();
    await refresh("retired write");
    expect(await stored()).toEqual(snapshot);
  });

  const mutations = [
    { mode: "sync", operation: "touch" },
    { mode: "async", operation: "touch" },
    { mode: "sync", operation: "idle timeout" },
    { mode: "async", operation: "idle timeout" },
    { mode: "sync", operation: "max age" },
    { mode: "async", operation: "max age" },
    { mode: "sync", operation: "unbind" },
    { mode: "async", operation: "unbind" },
    { mode: "async", operation: "rebind" },
    { mode: "async", operation: "detach" },
  ] as const;
  it.each(
    mutations.flatMap((mutation) =>
      (["active", "retired-before-stop", "stopped"] as const).map((state) => ({
        mode: mutation.mode,
        operation: mutation.operation,
        state,
      })),
    ),
  )("guards $mode $operation while $state", async ({ mode, operation, state }) => {
    const { foreign, owner, manager, stored, snapshot, refresh } = await setup();
    const targetSessionKey = expectDefined(
      manager.getByThreadId("thread-1"),
      "seed binding",
    ).targetSessionKey;
    if (state !== "active") {
      owner.retire();
    }
    if (state === "stopped") {
      await manager.stop();
    }
    const at = Date.now() + 30_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      const mutate = async () => {
        switch (operation) {
          case "touch":
            return mode === "sync"
              ? manager.touchThreadSync({ threadId: "thread-1", at })
              : manager.touchThread({ threadId: "thread-1", at });
          case "idle timeout":
            return (
              mode === "sync"
                ? setThreadBindingIdleTimeoutBySessionKey
                : setThreadBindingIdleTimeoutBySessionKeyAsync
            )({
              targetSessionKey,
              idleTimeoutMs: 45_000,
            });
          case "max age":
            return (
              mode === "sync"
                ? setThreadBindingMaxAgeBySessionKey
                : setThreadBindingMaxAgeBySessionKeyAsync
            )({
              targetSessionKey,
              maxAgeMs: 90_000,
            });
          case "unbind":
            return (
              mode === "sync"
                ? unbindThreadBindingsBySessionKey
                : unbindThreadBindingsBySessionKeyAsync
            )({ targetSessionKey, sendFarewell: false });
          case "rebind":
            return refresh("guarded refresh");
          case "detach":
            return detachPluginConversationBinding({
              pluginRoot: identity.pluginRoot,
              conversation,
            });
          default:
            throw new Error("Unsupported binding mutation");
        }
      };
      const result = foreign.run(mutate);
      if (state === "stopped" && operation === "touch") {
        await expect(result).rejects.toThrow(/stopping|was retired/);
      } else {
        await result;
      }
      if (state !== "active") {
        expect(await stored()).toEqual(snapshot);
      } else if (operation === "unbind" || operation === "detach") {
        expect(await stored()).toEqual([]);
      } else {
        const expected =
          operation === "touch"
            ? { lastActivityAt: at }
            : operation === "idle timeout"
              ? { idleTimeoutMs: 45_000 }
              : operation === "max age"
                ? { maxAgeMs: 90_000 }
                : { metadata: { summary: "guarded refresh" } };
        expect(await stored()).toMatchObject([{ value: expected }]);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("captures the replacement runtime after the previous manager stops", async () => {
    const { owner, manager, createOwner, stored, refresh } = await setup();
    await manager.stop();
    owner.retire();
    const replacement = await createOwner().start();
    expect(replacement).not.toBe(manager);
    await manager.stop();
    await expect(manager.touchThread({ threadId: "thread-1" })).rejects.toThrow("stopping");
    await refresh("replacement");
    expect(await stored()).toMatchObject([{ value: { metadata: { summary: "replacement" } } }]);
  });

  it("keeps overlapping accounts bound to their own runtime", async () => {
    const { createOwner, stored, refresh } = await setup();
    const second = createOwner();
    await second.start("second");
    await second.instance.run(() =>
      bindConversationNow({
        identity,
        conversation: { ...conversation, accountId: "second" },
        summary: "second account",
      }),
    );
    await refresh("second refreshed", "second");
    await refresh("first refreshed");
    second.retire();
    await refresh("first still active");
    expect(await stored()).toMatchObject([
      { key: "default:thread-1", value: { metadata: { summary: "first still active" } } },
      { key: "second:thread-1", value: { metadata: { summary: "second refreshed" } } },
    ]);
  });
});
