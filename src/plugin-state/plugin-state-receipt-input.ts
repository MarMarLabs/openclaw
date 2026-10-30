import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  pluginStatePublicationKey,
  type PluginStatePublicationEffect,
  type PluginStatePublicationScope,
} from "./plugin-state-publication.js";
import type { PluginStateWorkerOperations } from "./plugin-state-worker-contract.js";

type PluginStateCommand = SqliteWorkerCommand<PluginStateWorkerOperations>;

/** References live only in the admission carrying this already serialized command. */
export function preparePluginStateReceiptInput(
  command: SqliteWorkerCommand<PluginStateWorkerOperations>,
): ReadonlyMap<string, string> | undefined {
  switch (command.type) {
    case "pluginState.register":
    case "pluginState.registerIfAbsent":
    case "pluginState.replaceEntry":
    case "pluginState.compareUpdate":
    case "pluginState.replace": {
      const input = command.input;
      const entries = "entries" in input ? input.entries : "valueJson" in input ? [input] : [];
      return new Map(
        entries.map((entry) => [
          pluginStatePublicationKey({
            plugin_id: input.pluginId,
            namespace: input.namespace,
            entry_key: entry.key,
          }),
          entry.valueJson,
        ]),
      );
    }
    default:
      return undefined;
  }
}

export function publicationEffect(
  command: PluginStateCommand,
  scope: PluginStatePublicationScope | undefined,
): PluginStatePublicationEffect | undefined {
  if (command.type === "pluginState.observe") {
    return Object.freeze({ kind: "unchanged" });
  }
  // Only exact-key CAS writes have a bounded set of possible values: the
  // committed row on conflict/rollback, or this immutable serialized postimage.
  if (command.type === "pluginState.compareUpdate" && scope?.key !== undefined) {
    if (command.input.action === "keep") {
      return Object.freeze({ kind: "unchanged" });
    }
    if (command.input.ttlMs === undefined) {
      return Object.freeze({ kind: "postimage", valueJson: command.input.valueJson });
    }
  }
  return undefined;
}
