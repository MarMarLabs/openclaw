import { EventEmitter } from "node:events";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";
import { getThreadBindingManager } from "./thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
type LifecycleParams = Parameters<typeof runDiscordGatewayLifecycle>[0];
const managers: LifecycleParams["threadBindings"][] = [];
const service = getSessionBindingService();
const conversation = { channel: "discord", accountId: "default", conversationId: "user:123" };
const bind = () =>
  service.bind({
    conversation,
    targetSessionKey: "agent:main:subagent:replacement",
    targetKind: "session",
    placement: "current",
  });

installThreadBindingLifecycleTestHooks();
afterEach(async () => {
  for (const manager of managers) {
    await manager.stop();
  }
  managers.length = 0;
  await resetThreadBindingsForTests();
  vi.useRealTimers();
});

async function createManager(params: Parameters<typeof createTestThreadBindingManager>[0] = {}) {
  const manager = await createTestThreadBindingManager(params);
  managers.push(manager);
  return manager;
}

function startLifecycle(
  threadBindings: LifecycleParams["threadBindings"],
  voiceManager: LifecycleParams["voiceManager"] = null,
) {
  const abort = new AbortController();
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const gateway: MutableDiscordGateway = {
    id: "gateway",
    options: { intents: 0 },
    emitter: new EventEmitter(),
    isConnected: true,
    sequence: null,
    ws: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    updatePresence: vi.fn(),
    updateVoiceState: vi.fn(),
    fetchGuildEmojis: (_guildId, fetcher) => fetcher(),
    listVoiceChannelStates: () => null,
    takeVoiceStateTransition: () => null,
  };
  const gatewaySupervisor = createDiscordGatewaySupervisor({
    gateway,
    runtime,
    isDisallowedIntentsError: () => false,
  });
  const task = runDiscordGatewayLifecycle({
    accountId: "default",
    gateway,
    gatewaySupervisor,
    runtime,
    abortSignal: abort.signal,
    isDisallowedIntentsError: () => false,
    voiceManager,
    voiceManagerRef: { current: voiceManager },
    threadBindings,
  }).finally(() => gatewaySupervisor.dispose());
  return { abort, task };
}

it.each(["bind", "touch"] as const)(
  "keeps %s available when a restart overtakes old provider cleanup",
  async (operation) => {
    const cleanupEntered = createDeferred<void>();
    const finishCleanup = createDeferred<void>();
    const old = await createManager();
    await bind();
    const voiceManager = {
      autoJoin: async () => {},
      destroy: async () => {
        cleanupEntered.resolve();
        await finishCleanup.promise;
      },
    } as LifecycleParams["voiceManager"];
    const oldLifecycle = startLifecycle(old, voiceManager);
    oldLifecycle.abort.abort();
    await cleanupEntered.promise;

    // A timed-out channel stop can start a new task without retiring the plugin.
    const current = await createManager();
    const currentLifecycle = startLifecycle(current);
    try {
      finishCleanup.resolve();
      await oldLifecycle.task;
      if (operation === "bind") {
        await expect(bind()).resolves.toMatchObject({
          targetSessionKey: "agent:main:subagent:replacement",
        });
      } else {
        const at = Date.now() + 1_000;
        await expect(
          current.touchThread({ threadId: conversation.conversationId, at, persist: false }),
        ).resolves.toMatchObject({ lastActivityAt: at });
      }
      expect(current.isStopping()).toBe(false);
    } finally {
      finishCleanup.resolve();
      currentLifecycle.abort.abort();
      await Promise.all([oldLifecycle.task, currentLifecycle.task]);
    }
    expect(getThreadBindingManager()).toBeNull();
    await expect(bind()).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
    await expect(
      current.touchThread({ threadId: conversation.conversationId, persist: false }),
    ).rejects.toThrow("manager is stopping");
  },
);

it("keeps the replacement live after the old stop, then tears down on its own stop", async () => {
  vi.useFakeTimers();
  const old = await createManager({ enableSweeper: true });
  const current = await createManager({ enableSweeper: true });
  await Promise.all([old.stop(), old.stop()]);
  expect(old.isStopping()).toBe(true);
  expect(getThreadBindingManager()).toBe(current);
  expect(vi.getTimerCount()).toBe(1);
  await expect(bind()).resolves.toMatchObject({
    targetSessionKey: "agent:main:subagent:replacement",
  });

  await Promise.all([current.stop(), current.stop()]);
  expect(getThreadBindingManager()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await expect(bind()).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
  await expect(bindTestThread(current)).rejects.toThrow("manager is stopping");
  await expect(current.touchThread({ threadId: conversation.conversationId })).rejects.toThrow(
    "manager is stopping",
  );
});
