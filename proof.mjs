// Runs only our harness on the host. All product/toolchain execution is in Docker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const pr = process.env.PROOF_PR;
const expected = { '137233': '451a32c657fb1ac7f2fc167294f364c93819decf', '137250': 'ec516390d97512019f058caafcda267b35d00317' };
if (!expected[pr] || process.env.PROOF_SHA !== expected[pr]) throw new Error('Unrecognized source identity');
const source = path.resolve('source');
const harness = path.resolve('harness');
const out = path.resolve('evidence');
fs.mkdirSync(out, { recursive: true });
// Task-owned container state; never uses the runner HOME or an operator config.
const app = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-proof-${pr}-`));
fs.mkdirSync(path.join(app, 'home'));
fs.mkdirSync(path.join(app, 'package'));
const image = 'node:24-bookworm';
const summary = {
  pr, sourceCommit: expected[pr], harnessCommit: process.env.PROOF_HARNESS_SHA,
  startedAt: new Date().toISOString(), stableVersion: '2026.10.1', candidateVersion: '2026.9.9',
  stableReleaseTagCommit: 'e178c39e9aae3fa440735217f9aef9574f286677',
  packaging: 'Canonical custom distribution: --bundle-plugin slack (and discord for selector controls), all from pinned source; no version relabeling.',
  transition: pr === '137250' ? '2026.10.1 -> 2026.9.9: downgrade/replacement, NOT forward upgrade' : 'current-head built CLI',
  forwardUpgrade: 'NOT_RUN: candidate version is older than latest stable',
  liveSlackActions: 'NONE: only capability discovery; capability commands have Docker --network none',
  checks: [], commands: [],
};
let sequence = 0;
function save() { fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); }
function check(name, passed, detail = null) { summary.checks.push({ name, status: passed ? 'PASS' : 'FAIL', detail }); save(); }
// Containers have exited before collection. Reject links at every component,
// including ancestors: container-owned paths must never resolve on the host.
function appPath(file, createDirectory = false) {
  const relative = path.relative(app, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid app path');
  let current = app;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (createDirectory && !fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (createDirectory && !stat.isDirectory())) throw new Error('Unsafe container-owned path');
  }
  return file;
}
function readApp(file) { return fs.readFileSync(appPath(file)); }
function jsonFile(file) { return JSON.parse(readApp(file)); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function writeJson(name, data) { fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n'); }
async function run(label, command, args, seconds = 120) {
  const id = `${String(++sequence).padStart(3, '0')}-${label}`;
  const stdoutFile = `${id}.stdout.txt`, stderrFile = `${id}.stderr.txt`;
  const stdout = fs.openSync(path.join(out, stdoutFile), 'w');
  const stderr = fs.openSync(path.join(out, stderrFile), 'w');
  const started = Date.now();
  console.log(`START ${id}: ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`);
  const result = await new Promise(resolve => {
    // GNU timeout bounds the complete Docker client/container command, including descendants.
    const child = spawn('timeout', ['--signal=TERM', '--kill-after=15s', `${seconds}s`, command, ...args], { stdio: ['ignore', stdout, stderr] });
    child.on('error', error => resolve({ code: null, signal: null, error: String(error) }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const record = { id, command, args, timeoutSeconds: seconds, startedAt: new Date(started).toISOString(), elapsedSeconds: (Date.now() - started) / 1000, ...result, stdoutFile, stderrFile };
  summary.commands.push(record); save();
  console.log(`END ${id}: exit=${result.code}, elapsed=${record.elapsedSeconds}s`);
  return { ...record, stdout: fs.readFileSync(path.join(out, stdoutFile), 'utf8'), stderr: fs.readFileSync(path.join(out, stderrFile), 'utf8') };
}
async function must(label, command, args, seconds) {
  const result = await run(label, command, args, seconds);
  check(label, result.code === 0, { commandId: result.id });
  if (result.code !== 0) throw new Error(`${label} failed: ${result.code}; see ${result.stderrFile}`);
  return result;
}
function containerArgs({ network = 'bridge', caseName, build = false } = {}) {
  const home = caseName ? `/app/cases/${caseName}/home` : '/app/home';
  const env = {
    HOME: home, CI: '1', NO_COLOR: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    PATH: '/harness:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NODE_OPTIONS: '--max-old-space-size=6144',
    OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_NO_ONBOARD: '1',
  };
  if (caseName) Object.assign(env, {
    OPENCLAW_STATE_DIR: `/app/cases/${caseName}/state`,
    OPENCLAW_CONFIG_PATH: `/app/cases/${caseName}/openclaw.json`,
    npm_config_prefix: `/app/cases/${caseName}/prefix`,
    npm_config_cache: '/app/npm-cache',
    PATH: `/app/cases/${caseName}/prefix/bin:${env.PATH}`,
  });
  return ['run', '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user', `${process.getuid()}:${process.getgid()}`, '--network', network,
    // Defensive block for install/update phases; offline capability phases deny all networking.
    '--add-host=slack.com:127.0.0.1', '--add-host=api.slack.com:127.0.0.1',
    '-v', `${harness}:/harness:ro`, '-v', `${app}:/app`,
    ...(build ? ['-v', `${source}:/source`, '-w', '/source'] : ['-w', '/app']),
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image];
}
async function docker(label, args, opts = {}, seconds = 120) {
  const containerName = `oc-proof-${pr}-${process.pid}-${sequence + 1}`;
  const options = containerArgs(opts);
  options.splice(1, 0, '--name', containerName);
  const result = await run(label, 'docker', [...options, ...args], seconds);
  // A killed Docker client can leave its container alive. Stop this exact
  // task-owned container before any host collection of its writable mounts.
  if (result.code === 124 || result.code === 137 || result.code === null) {
    const cleanup = await run(`${label}-timeout-cleanup`, 'docker', ['rm', '--force', containerName], 60);
    if (cleanup.code !== 0 && !cleanup.stderr.includes('No such container')) {
      throw new Error('Container cleanup unconfirmed; refusing to collect mutable state');
    }
  }
  return result;
}
async function requiredDocker(label, args, opts = {}, seconds = 120) {
  const result = await docker(label, args, opts, seconds);
  check(label, result.code === 0, { commandId: result.id });
  if (result.code !== 0) throw new Error(`${label} failed: ${result.code}`);
  return result;
}
const rootActions = { messages: false, pins: false, reactions: false, memberInfo: false, emojiList: false };
function slack(accounts) { return { enabled: true, botToken: 'xoxb-proof-root-not-a-real-token', appToken: 'xapp-proof-root-not-a-real-token', groupPolicy: 'allowlist', channels: {}, actions: rootActions, accounts }; }
function newCase(name, config) {
  const dir = path.join(app, 'cases', name);
  for (const sub of ['home', 'state', 'prefix']) appPath(path.join(dir, sub), true);
  fs.writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  writeJson(`${name}-seed.json`, config);
  return dir;
}
function installed(name) { return path.join(app, 'cases', name, 'prefix/lib/node_modules/openclaw'); }
function identity(name, phase) {
  const root = installed(name);
  const value = {
    package: jsonFile(path.join(root, 'package.json')).version,
    buildInfo: fs.existsSync(path.join(root, 'dist/build-info.json')) ? jsonFile(path.join(root, 'dist/build-info.json')) : null,
    bundledPlugins: Object.fromEntries(['slack', 'discord'].filter(id => fs.existsSync(path.join(root, `dist/extensions/${id}/package.json`))).map(id => [id, jsonFile(path.join(root, `dist/extensions/${id}/package.json`))])),
  };
  writeJson(`${name}-${phase}-identity.json`, value);
  return value;
}
function snapshot(name, phase) {
  const file = path.join(app, 'cases', name, 'openclaw.json');
  const raw = readApp(file);
  fs.writeFileSync(path.join(out, `${name}-${phase}-config.json`), raw);
  return { sha256: sha256(raw), config: JSON.parse(raw) };
}
async function cli(label, caseName, args, network = 'none', seconds = 180) {
  return docker(label, ['openclaw', ...args], { caseName, network }, seconds);
}
function report(result, channel, accountId) {
  try {
    const data = JSON.parse(result.stdout);
    return data.channels?.find(item => item.channel === channel && (!accountId || item.accountId === accountId));
  } catch { return undefined; }
}
async function pluginProvenance(name, phase, ids, candidate) {
  const result = await cli(`${name}-${phase}-plugins`, name, ['plugins', 'list', '--json']);
  let data; try { data = JSON.parse(result.stdout); } catch { data = null; }
  for (const id of ids) {
    const plugin = data?.plugins?.find(item => item.id === id);
    check(`${name} ${phase} selected ${id} provenance`, result.code === 0 && !!plugin && (!candidate || (
      plugin.origin === 'bundled' && plugin.version === '2026.9.9' &&
      plugin.source?.startsWith(`/app/cases/${name}/prefix/lib/node_modules/openclaw/dist/extensions/${id}/`)
    )), { commandId: result.id, plugin });
  }
}
async function capProof() {
  const name = 'selectors';
  newCase(name, { gateway: { mode: 'local' }, channels: {
    slack: slack({ ops: { botToken: 'xoxb-proof-ops-not-real' }, sales: { botToken: 'xoxb-proof-sales-not-real' } }),
    discord: { enabled: true, token: 'proof-discord-not-real', groupPolicy: 'allowlist' },
  } });
  await requiredDocker('install-candidate', ['npm', 'install', '-g', '/app/package/candidate.tgz', '--no-audit', '--no-fund'], { caseName: name }, 900);
  const id = identity(name, 'candidate');
  check('installed candidate identity', id.package === '2026.9.9' && id.buildInfo?.commit === expected[pr], id.buildInfo);
  await cli('candidate-version', name, ['--version']);
  await pluginProvenance(name, 'candidate', ['slack', 'discord'], true);
  for (const [option, base] of [['channel', []], ['agent', ['--channel', 'all']], ['target', ['--channel', 'discord']], ['target-without-channel', []], ['account', ['--channel', 'slack']]]) {
    const selector = option === 'target-without-channel' ? 'target' : option;
    for (const [kind, value] of [['empty', ''], ['whitespace', ' \t ']]) {
      const result = await cli(`${option}-${kind}`, name, ['channels', 'capabilities', ...base, `--${selector}`, value, '--json', '--timeout', '1000']);
      let data; try { data = JSON.parse(result.stdout); } catch { data = null; }
      check(`${option} ${kind} rejects for its own blank-selector reason`, result.code === 1 && data?.ok === false && data?.error?.type === 'cli_error' && data?.error?.message === `--${selector} must not be blank`, { commandId: result.id, error: data?.error });
    }
  }
  for (const [label, args, channels] of [
    ['omitted-channel-and-target', [], ['slack', 'discord']],
    ['omitted-agent', ['--channel', 'all'], ['slack', 'discord']],
    ['omitted-target', ['--channel', 'discord'], ['discord']],
    ['omitted-account', ['--channel', 'slack'], ['slack']],
  ]) {
    const result = await cli(label, name, ['channels', 'capabilities', ...args, '--json', '--timeout', '1000']);
    let data; try { data = JSON.parse(result.stdout); } catch { data = null; }
    const accounts = data?.channels?.map(item => `${item.channel}:${item.accountId}`) ?? [];
    check(label, result.code === 0 && channels.every(channel => report(result, channel)) && (!channels.includes('slack') || ['slack:ops', 'slack:sales'].every(id => accounts.includes(id))), { commandId: result.id, accounts, note: 'Probe errors are expected offline; discovery/selector success is assessed independently.' });
  }
  snapshot(name, 'final');
}
async function slackProof() {
  for (const name of ['partial', 'empty']) {
    try {
      newCase(name, { gateway: { mode: 'local' }, channels: { slack: slack({ work: { name: `Synthetic ${name} override`, botToken: 'xoxb-proof-work-not-a-real-token', actions: name === 'partial' ? { reactions: true } : {} } }) } });
      await requiredDocker(`${name}-install-stable`, ['npm', 'install', '-g', 'openclaw@2026.10.1', '--no-audit', '--no-fund'], { caseName: name }, 900);
      const stable = identity(name, 'stable');
      check(`${name} stable identity`, stable.package === '2026.10.1', stable.buildInfo);
      await cli(`${name}-stable-version`, name, ['--version']);
      if (!stable.bundledPlugins.slack) {
        const plugin = await cli(`${name}-install-stable-slack`, name, ['plugins', 'install', '@openclaw/slack@2026.10.1', '--force', '--pin', '--accept-capabilities'], 'bridge', 900);
        check(`${name} install stable Slack`, plugin.code === 0, { commandId: plugin.id });
        if (plugin.code !== 0) throw new Error('Stable Slack plugin installation failed');
      }
      await pluginProvenance(name, 'stable', ['slack'], false);
      const beforeResult = await cli(`${name}-before-actions`, name, ['channels', 'capabilities', '--channel', 'slack', '--account', 'work', '--json', '--timeout', '1000']);
      check(`${name} baseline action discovery`, beforeResult.code === 0 && !!report(beforeResult, 'slack', 'work'), { commandId: beforeResult.id, actions: report(beforeResult, 'slack', 'work')?.actions });
      const before = snapshot(name, 'before-update');
      // This is the installed stable updater, not a direct candidate npm install.
      const update = await cli(`${name}-published-driver-replacement`, name, ['update', '--tag', '/app/package/candidate.tgz', '--yes', '--no-restart', '--json'], 'bridge', 1200);
      const after = snapshot(name, 'after-update');
      const actual = identity(name, 'after-update');
      check(`${name} updater completed replacement`, update.code === 0 && actual.package === '2026.9.9' && actual.buildInfo?.commit === expected[pr], { commandId: update.id, observedVersion: actual.package, observedCommit: actual.buildInfo?.commit });
      const preservation = {
        beforeSha256: before.sha256, afterSha256: after.sha256, byteIdentical: before.sha256 === after.sha256,
        wholeConfigEqual: isDeepStrictEqual(before.config, after.config),
        slackEqual: isDeepStrictEqual(before.config.channels.slack, after.config.channels.slack),
        gatewayEqual: isDeepStrictEqual(before.config.gateway, after.config.gateway),
        changedTopLevelKeys: [...new Set([...Object.keys(before.config), ...Object.keys(after.config)])].filter(key => !isDeepStrictEqual(before.config[key], after.config[key])),
        explicitAccountActions: after.config.channels.slack.accounts.work.actions,
      };
      writeJson(`${name}-preservation.json`, preservation);
      check(`${name} operator Slack and Gateway configuration preserved`, preservation.slackEqual && preservation.gatewayEqual, preservation);
      await cli(`${name}-after-version`, name, ['--version']);
      await pluginProvenance(name, 'after-update', ['slack'], true);
      const afterResult = await cli(`${name}-after-actions`, name, ['channels', 'capabilities', '--channel', 'slack', '--account', 'work', '--json', '--timeout', '1000']);
      const actions = report(afterResult, 'slack', 'work')?.actions;
      const wanted = name === 'partial' ? ['send', 'broadcast', 'react', 'reactions'] : ['send', 'broadcast'];
      check(`${name} candidate action availability`, actual.buildInfo?.commit === expected[pr] && afterResult.code === 0 && Array.isArray(actions) && isDeepStrictEqual([...actions].sort(), wanted.sort()), { commandId: afterResult.id, actions, wanted });
    } catch (error) { check(`${name} scenario completion`, false, String(error)); }
  }
}
try {
  await must('checkout-head', 'git', ['-C', source, 'rev-parse', 'HEAD']);
  const head = summary.commands.at(-1);
  if (fs.readFileSync(path.join(out, head.stdoutFile), 'utf8').trim() !== expected[pr]) throw new Error('Source checkout mismatch');
  await must('initial-status', 'git', ['-C', source, 'status', '--porcelain']);
  if (fs.readFileSync(path.join(out, summary.commands.at(-1).stdoutFile), 'utf8').trim()) throw new Error('Source dirty');
  await must('pull-runtime', 'docker', ['pull', image], 300);
  await must('runtime-image-identity', 'docker', ['image', 'inspect', image, '--format', '{{json .RepoDigests}}']);
  await requiredDocker('node-version', ['node', '--version']);
  await requiredDocker('npm-version', ['npm', '--version']);
  await requiredDocker('stable-registry-metadata', ['npm', 'view', 'openclaw@2026.10.1', 'version', 'gitHead', 'dist', '--json', '--prefer-online']);
  const latest = await requiredDocker('latest-registry-version', ['npm', 'view', 'openclaw@latest', 'version', '--json', '--prefer-online']);
  const latestValue = JSON.parse(latest.stdout);
  check('pinned baseline is still latest stable', latestValue === '2026.10.1' || (Array.isArray(latestValue) && latestValue.length === 1 && latestValue[0] === '2026.10.1'), { commandId: latest.id });
  await requiredDocker('pnpm-version', ['pnpm', '--version'], { build: true });
  await requiredDocker('frozen-install', ['pnpm', 'install', '--frozen-lockfile'], { build: true }, 1200);
  await requiredDocker('canonical-package', ['node', 'scripts/package-openclaw-for-docker.mjs', '--source-dir', '/source', '--output-dir', '/app/package', '--output-name', 'candidate.tgz', '--allow-unreleased-changelog', '--bundle-plugin', 'slack', ...(pr === '137233' ? ['--bundle-plugin', 'discord'] : [])], { build: true }, 3900);
  const tarball = readApp(path.join(app, 'package/candidate.tgz'));
  summary.candidateTarballSha256 = sha256(tarball); save();
  // Preserve a manifest/provenance receipt, not the hundreds-of-MB install trees.
  await requiredDocker('packed-build-info', ['tar', '-xOf', '/app/package/candidate.tgz', 'package/dist/build-info.json']);
  await requiredDocker('packed-manifest', ['tar', '-xOf', '/app/package/candidate.tgz', 'package/package.json']);
  if (pr === '137233') await capProof(); else await slackProof();
  const finalStatus = await requiredDocker('final-source-status', ['git', 'status', '--porcelain', '--untracked-files=no'], { build: true, network: 'none' });
  check('tracked source remains clean after packaging', finalStatus.stdout.trim() === '', { commandId: finalStatus.id });
} catch (error) {
  summary.fatal = String(error); console.error(summary.fatal);
} finally {
  summary.finishedAt = new Date().toISOString();
  summary.result = summary.fatal || summary.checks.some(item => item.status === 'FAIL') ? 'FAIL_OR_INCOMPLETE' : 'PASS_REQUESTED_EXECUTED_CELLS_ONLY';
  save();
  const transcript = [`# PR #${pr}: isolated proof transcript`, '', `Source: ${expected[pr]}`, `Harness: ${summary.harnessCommit}`, `Transition: ${summary.transition}`, `Packaging: ${summary.packaging}`, `Forward upgrade: ${summary.forwardUpgrade}`, '', ...summary.commands.flatMap(command => [
    `## ${command.id}`, '', `Started: ${command.startedAt}; elapsed: ${command.elapsedSeconds}s; exit: ${command.code}; signal: ${command.signal}`, '',
    'Command (JSON argv; timeout wrapper recorded in summary.json):', '```json', JSON.stringify([command.command, ...command.args]), '```', '',
    'stdout:', '```text', fs.readFileSync(path.join(out, command.stdoutFile), 'utf8'), '```', '',
    'stderr:', '```text', fs.readFileSync(path.join(out, command.stderrFile), 'utf8'), '```', '',
  ]), '## Scenario verdicts', '', '```json', JSON.stringify(summary.checks, null, 2), '```', '', `Overall: ${summary.result}`, ...(summary.fatal ? [summary.fatal] : []), ''];
  fs.writeFileSync(path.join(out, 'transcript.md'), transcript.join('\n'));
  process.exitCode = summary.result === 'FAIL_OR_INCOMPLETE' ? 1 : 0;
}
