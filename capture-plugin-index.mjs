// Executed only inside the secretless test container, after CLI processes exit.
// Preserve the real persisted index, including install ownership and integrity.
import { readPluginInstallIndex } from '/source/scripts/e2e/lib/plugin-index-sqlite.mjs';
process.stdout.write(JSON.stringify(readPluginInstallIndex(), null, 2) + '\n');
