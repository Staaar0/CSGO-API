import test from 'node:test';
import assert from 'node:assert/strict';
import * as esmFs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { auditLocalizationSources, discoverGenerators, discoverGroupInputs, generate, LOCALES, trackWrites, useSnapshots } from './generate.mjs';
import { SUPPORTED_LOCALES, validateOutputs } from './validate.mjs';

const runner = `
import { loadData, getManifestId } from './services/main.js';
import { loadTranslations } from './services/translations.js';
import { getAgents } from './services/agents.js';
import { getInventory } from './services/inventory.js';
try {
 await loadTranslations(language);
 getAgents();
 getInventory();
} catch (error) {}
`;

test('discovers new category generators while requiring inventory last', () => {
  assert.deepEqual(discoverGenerators(runner).map(item => item.name), ['getAgents', 'getInventory']);
  const extended = runner.replace('try {', "import { getPets } from './services/pets.js';\ntry {").replace('getAgents();', 'getAgents(); getPets();');
  assert.deepEqual(discoverGenerators(extended).map(item => item.name), ['getAgents', 'getPets', 'getInventory']);
  assert.throws(() => discoverGenerators(runner.replace('getAgents();\n getInventory();', 'getInventory();\n getAgents();')), /final generator/);
});

test('refuses changed generation control flow and unknown imported category functions', () => {
  assert.throws(() => discoverGenerators(runner.replace('getAgents();', 'if (enabled) getAgents();')), /Unsupported upstream generation statement/);
  assert.throws(() => discoverGenerators(runner.replace('try {', "import { getPets } from './services/pets.js';\ntry {")), /imported but not recognized/);
});

test('reads upstream grouping inputs without executing upstream cache/API code', () => {
  assert.deepEqual(discoverGroupInputs('const inputFilePathsTemplate = ["./public/api/{lang}/agents.json", "./public/api/{lang}/pets.json",];'), ['agents.json', 'pets.json']);
  assert.throws(() => discoverGroupInputs('const inputFilePathsTemplate = ["./public/api/{lang}/agents.json", ...additional];'), /Unsupported upstream group inputs/);
  assert.throws(() => discoverGroupInputs('const inputFilePathsTemplate = ["./public/api/{lang}/all.json"];'), /recursive/);
});

test('drains fs callback writes omitted from generator return values', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'csgo-write-test-'));
  const originalWrite = esmFs.writeFile;
  const writes = trackWrites(directory);
  let callbackFinished = false;
  try {
    // Mirrors upstream saveDataJson callers that do not return their write Promise.
    esmFs.writeFile(path.join(directory, 'agents.json'), '[{"id":"agent-1"}]', error => {
      assert.ifError(error);
      callbackFinished = true;
    });
    await writes.drain();
    assert.equal(callbackFinished, true);
    assert.equal(await fsp.readFile(path.join(directory, 'agents.json'), 'utf8'), '[{"id":"agent-1"}]');
    assert.throws(() => esmFs.writeFile(path.join(directory, '..', 'outside.json'), 'bad', () => {}), /outside current locale/);
  } finally {
    writes.restore();
    assert.equal(esmFs.writeFile, originalWrite);
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('write errors propagate even when a generator ignores callbacks', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'csgo-write-error-test-'));
  const writes = trackWrites(directory);
  let callbackError;
  try {
    esmFs.writeFile(path.join(directory, 'missing', 'agents.json'), '[]', error => { callbackError = error; });
    await assert.rejects(writes.drain(), /Upstream output writes failed/);
    assert.equal(callbackError.code, 'ENOENT');
  } finally {
    writes.restore();
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('reports possible dictionary fallbacks without calling identical proper names untranslated', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'csgo-source-audit-'));
  try {
    await fsp.mkdir(path.join(directory, 'static'));
    await fsp.writeFile(path.join(directory, 'static/csgo_english.json'), JSON.stringify({ lang: { Tokens: { Item: 'Valve', Missing: 'New item', Empty: 'Description' } } }));
    await fsp.writeFile(path.join(directory, 'static/csgo_french.json'), JSON.stringify({ lang: { Tokens: { ITEM: 'Valve', Empty: '' } } }));
    const report = await auditLocalizationSources(directory, [
      { folder: 'en', url: 'https://example.test/static/csgo_english.json' },
      { folder: 'fr', url: 'https://example.test/static/csgo_french.json' },
    ]);
    assert.equal(report.status, 'dictionary-coverage-only');
    assert.equal(report.locales.fr.missingEnglishKeys, 1);
    assert.equal(report.locales.fr.presentButFalsyEnglishKeys, 1);
    assert.equal(report.locales.fr.potentialEnglishFallbackKeys, 2);
    assert.equal(report.locales.fr.valuesIdenticalToEnglish, 1);
    assert.deepEqual(report.locales.fr.missingKeySample, ['missing']);
    assert.match(report.detail, /actual API fallback use is not measured/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});


async function generationFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'csgo-batch-generate-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await fsp.mkdir(path.join(source, 'utils'), { recursive: true });
  await fsp.mkdir(path.join(source, 'services'));
  const save = (file, text) => fsp.writeFile(path.join(source, file), text);
  await save('package.json', JSON.stringify({ type: 'module' }));
  await save('utils/translations.json', JSON.stringify(Object.fromEntries(SUPPORTED_LOCALES.map(code => [code, { name: '{item_name}' }]))));
  await save('constants.js', `export const LANGUAGES_URL = ${JSON.stringify(SUPPORTED_LOCALES.map(code => ({ folder: code, language: code, url: `https://example.test/csgo_${code.replace('-', '_')}.json` })))};`);
  await save('update.js', runner);
  await save('group.js', 'const inputFilePathsTemplate = ["./public/api/{lang}/agents.json"];');
  await save('services/main.js', 'export async function loadData() {}');
  await save('services/state.js', 'export let code; export function setCode(value) { code = value; }');
  await save('services/translations.js', "import {setCode} from './state.js'; export async function loadTranslations(language) {setCode(language.folder);}");
  await save('services/agents.js', `import fs from 'node:fs'; import {code} from './state.js'; export function getAgents() {fs.writeFile('./public/api/' + code + '/agents.json', JSON.stringify([{id:'agent-1',name:code,image:'fixed'}]), error => {if(error) throw error;});}`);
  await save('services/inventory.js', `import fs from 'node:fs'; import {code} from './state.js'; export function getInventory() {fs.writeFile('./public/api/' + code + '/inventory.json', JSON.stringify({agent:{name:code,image:'fixed'}}), error => {if(error) throw error;});}`);
  for (const code of ['en', 'zh-CN']) {
    const directory = path.join(source, 'public/api', code);
    await fsp.mkdir(directory, { recursive: true });
    const agent = { id: 'agent-1', name: code, image: 'fixed' };
    for (const [filename, value] of Object.entries({ 'agents.json': [agent], 'inventory.json': {agent:{name:code,image:'fixed'}}, 'all.json': { 'agent-1': agent } })) {
      await fsp.writeFile(path.join(directory, filename), JSON.stringify(value));
    }
  }
  return { source, output };
}

test('generates only an exact selected batch while copying en and zh-CN byte for byte', async t => {
  const { source, output } = await generationFixture(t);
  const report = await generate({ source, output, languages: 'fr,ru' });
  assert.deepEqual(report.locales, ['en', 'zh-CN', 'ru', 'fr']);
  assert.deepEqual(report.generated, ['ru', 'fr']);
  assert.equal(report.templateAudit.locales, 28);
  assert.deepEqual((await fsp.readdir(path.join(output, 'api'))).sort(), ['en', 'fr', 'ru', 'zh-CN']);
  for (const code of ['en', 'zh-CN']) {
    assert.deepEqual(await fsp.readFile(path.join(output, 'api', code, 'all.json')), await fsp.readFile(path.join(source, 'public/api', code, 'all.json')));
  }
  const validation = await validateOutputs(path.join(output, 'api'), source, { locales: ['ru', 'fr'] });
  assert.equal(validation.locales, 4);
});

test('defaults to 27 locales without Thai and refuses invalid selected batches before writes', async t => {
  assert.equal(LOCALES.length, 27);
  assert.equal(LOCALES.includes('th'), false);
  const { source, output } = await generationFixture(t);
  await assert.rejects(generate({ source, output, languages: 'ru,unknown' }), /Unsupported language selection/);
  await assert.rejects(fsp.stat(output), { code: 'ENOENT' });
});


const FILE_RAW = 'https://raw.githubusercontent.com/ByMykel/counter-strike-file-tracker/main/static/';
const IMAGE_RAW = 'https://raw.githubusercontent.com/ByMykel/counter-strike-image-tracker/refs/heads/main/static/';
const MANIFEST_API = 'https://api.github.com/repos/ByMykel/counter-strike-file-tracker/contents/static/manifestId.txt';

async function nativeSnapshotFixture(t) {
  const fixture = await generationFixture(t);
  const { source } = fixture;
  const fileTracker = path.join(path.dirname(source), 'file-tracker');
  const imageTracker = path.join(path.dirname(source), 'image-tracker');
  await fsp.mkdir(path.join(fileTracker, 'static'), { recursive: true });
  await fsp.mkdir(path.join(imageTracker, 'static'), { recursive: true });
  for (const code of ['en', 'zh-CN', 'ru', 'fr']) {
    await fsp.writeFile(path.join(fileTracker, 'static', `csgo_${code.replace('-', '_')}.json`),
      JSON.stringify({ tag: code, lang: { Tokens: { example: `Official ${code}` } } }));
  }
  await fsp.writeFile(path.join(fileTracker, 'static/items_game.json'), '{"source":"pinned items"}');
  await fsp.writeFile(path.join(fileTracker, 'static/manifestId.txt'), '1234567890123456789\n');
  await fsp.writeFile(path.join(imageTracker, 'static/images.json'), '{"source":"pinned images"}');
  await fsp.writeFile(path.join(imageTracker, 'static/default_generated.json'), '{"source":"pinned defaults"}');
  await fsp.writeFile(path.join(source, 'constants.js'), `export const LANGUAGES_URL = ${JSON.stringify(SUPPORTED_LOCALES.map(code => ({ folder: code, language: code, url: `${FILE_RAW}csgo_${code.replace('-', '_')}.json` })))};`);
  // Mirrors October 2026 upstream: native fetch, with no node_modules or Axios.
  await fsp.writeFile(path.join(source, 'utils/http.js'), `export async function getJson(url) {const response = await fetch(url); if (!response.ok) throw new Error('Request failed: ' + response.status); return response.json();}`);
  await fsp.writeFile(path.join(source, 'services/main.js'), `import {getJson} from '../utils/http.js'; export async function loadData() {
    const items = await getJson(${JSON.stringify(`${FILE_RAW}items_game.json`)});
    const images = await getJson(${JSON.stringify(`${IMAGE_RAW}images.json`)});
    const defaults = await getJson(${JSON.stringify(`${IMAGE_RAW}default_generated.json`)});
    if (items.source !== 'pinned items' || images.source !== 'pinned images' || defaults.source !== 'pinned defaults') throw new Error('Unpinned loader data');
  }`);
  await fsp.writeFile(path.join(source, 'services/translations.js'), `import {getJson} from '../utils/http.js'; import {setCode} from './state.js'; export async function loadTranslations(language) {const data = await getJson(language.url); if (data.tag !== language.folder) throw new Error('Wrong localization'); setCode(data.tag);}`);
  return { ...fixture, fileTracker, imageTracker };
}

async function legacyAxiosFixture(source) {
  const packageRoot = path.join(source, 'node_modules/axios');
  await fsp.mkdir(packageRoot, { recursive: true });
  await fsp.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'axios', type: 'module', exports: { '.': './index.js', './package.json': './package.json' },
  }));
  // A tiny installed-package fixture exercises the documented Axios adapter
  // boundary without downloading dependencies during tests.
  await fsp.writeFile(path.join(packageRoot, 'index.js'), `const axios = {defaults: {adapter: async () => {throw new Error('Real HTTP forbidden');}}}; axios.get = async (url, options = {}) => {const response = await axios.defaults.adapter({...options, url, method: options.method || 'get'}); return {...response, data: JSON.parse(response.data)};}; export default axios;`);
  return (await import(pathToFileURL(path.join(packageRoot, 'index.js')).href)).default;
}

test('native snapshot fetch returns real Responses from raw and API bytes without Axios', async t => {
  const { source, fileTracker, imageTracker } = await nativeSnapshotFixture(t);
  await assert.rejects(fsp.access(path.join(source, 'node_modules')), { code: 'ENOENT' });
  const originalFetch = globalThis.fetch;
  const snapshots = await useSnapshots(source, fileTracker, imageTracker);
  try {
    const response = await fetch(`${FILE_RAW}items_game.json`);
    assert.equal(response instanceof Response, true);
    assert.equal(response.ok, true);
    assert.deepEqual(await response.clone().json(), { source: 'pinned items' });
    assert.equal(await response.text(), '{"source":"pinned items"}');
    assert.deepEqual(await (await fetch(new URL(`${IMAGE_RAW}images.json`))).json(), { source: 'pinned images' });
    assert.deepEqual(await (await fetch(new Request(`${IMAGE_RAW}default_generated.json`))).json(), { source: 'pinned defaults' });
    const payload = await (await fetch(`${MANIFEST_API}?ref=main`)).json();
    const original = await fsp.readFile(path.join(fileTracker, 'static/manifestId.txt'));
    assert.deepEqual(Buffer.from(payload.content, 'base64'), original);
    assert.equal(payload.sha, createHash('sha1').update(Buffer.from(`blob ${original.length}\0`)).update(original).digest('hex'));
    assert.equal(snapshots.files['counter-strike-file-tracker/static/manifestId.txt'], createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(Object.keys(snapshots.files).sort(), [
      'counter-strike-file-tracker/static/items_game.json', 'counter-strike-file-tracker/static/manifestId.txt',
      'counter-strike-image-tracker/static/default_generated.json', 'counter-strike-image-tracker/static/images.json',
    ]);
  } finally {
    snapshots.restore();
  }
  assert.equal(globalThis.fetch, originalFetch);
});

test('snapshot fetch applies Request method overrides and blocks unpinned network requests', async t => {
  const { source, fileTracker, imageTracker } = await nativeSnapshotFixture(t);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  const forbiddenNetwork = async () => {networkCalls += 1; throw new Error('Unexpected real network');};
  globalThis.fetch = forbiddenNetwork;
  let snapshots;
  try {
    snapshots = await useSnapshots(source, fileTracker, imageTracker);
    const postRequest = new Request(`${FILE_RAW}items_game.json`, { method: 'POST' });
    assert.deepEqual(await (await fetch(postRequest, { method: 'GET' })).json(), { source: 'pinned items' });
    await assert.rejects(fetch(new Request(`${FILE_RAW}items_game.json`), { method: 'POST' }), /Unsupported upstream HTTP method/);
    await assert.rejects(fetch(new Request(`${FILE_RAW}items_game.json`, { method: 'HEAD' })), /Unsupported upstream HTTP method/);
    for (const url of [
      'https://example.test/items_game.json',
      'http://raw.githubusercontent.com/ByMykel/counter-strike-file-tracker/main/static/items_game.json',
      'https://raw.githubusercontent.com:8443/ByMykel/counter-strike-file-tracker/main/static/items_game.json',
      'https://raw.githubusercontent.com/other/counter-strike-file-tracker/main/static/items_game.json',
      'https://api.github.com/repos/ByMykel/another-repository/contents/static/images.json',
      `${FILE_RAW}nested/items_game.json`,
    ]) await assert.rejects(fetch(url), /Unexpected network destination|Unsupported upstream/);
    const aborted = AbortSignal.abort(new Error('Cancelled snapshot read'));
    await assert.rejects(fetch(`${FILE_RAW}items_game.json`, { signal: aborted }), /Cancelled snapshot read/);
    await assert.rejects(fetch(`${FILE_RAW}missing.json`), { code: 'ENOENT' });
    assert.equal(networkCalls, 0);
  } finally {
    snapshots?.restore();
    assert.equal(globalThis.fetch, forbiddenNetwork);
    globalThis.fetch = originalFetch;
  }
});

test('generates a pinned native-fetch upstream with no Axios and restores fetch on success', async t => {
  const fixture = await nativeSnapshotFixture(t);
  const originalFetch = globalThis.fetch;
  const forbiddenNetwork = async () => {throw new Error('Unexpected real network');};
  globalThis.fetch = forbiddenNetwork;
  try {
    const report = await generate({ ...fixture, languages: 'ru,fr' });
    assert.equal(globalThis.fetch, forbiddenNetwork);
    assert.equal(report.inputMode, 'pinned-local-snapshots');
    assert.deepEqual(report.generated, ['ru', 'fr']);
    assert.equal(Object.keys(report.inputFileSha256).length, 5);
    assert.deepEqual(report.localizationSources.locales.ru.missingKeySample, []);
    for (const code of ['en', 'zh-CN']) {
      assert.deepEqual(await fsp.readFile(path.join(fixture.output, 'api', code, 'all.json')),
        await fsp.readFile(path.join(fixture.source, 'public/api', code, 'all.json')));
    }
    assert.equal((await validateOutputs(path.join(fixture.output, 'api'), fixture.source, { locales: ['ru', 'fr'] })).locales, 4);
    await assert.rejects(fsp.access(path.join(fixture.source, 'node_modules')), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bridges an existing legacy Axios adapter alongside native fetch and restores both', async t => {
  const { source, fileTracker, imageTracker } = await nativeSnapshotFixture(t);
  const axios = await legacyAxiosFixture(source);
  const originalAdapter = axios.defaults.adapter;
  const originalFetch = globalThis.fetch;
  const snapshots = await useSnapshots(source, fileTracker, imageTracker);
  try {
    assert.notEqual(axios.defaults.adapter, originalAdapter);
    assert.deepEqual((await axios.get(`${FILE_RAW}items_game.json`)).data, { source: 'pinned items' });
    const payload = (await axios.get(MANIFEST_API)).data;
    assert.equal(Buffer.from(payload.content, 'base64').toString('utf8'), '1234567890123456789\n');
    assert.deepEqual(await (await fetch(`${IMAGE_RAW}images.json`)).json(), { source: 'pinned images' });
    await assert.rejects(axios.get('https://example.test/blocked'), /Unexpected network destination/);
    await assert.rejects(axios.get(`${FILE_RAW}items_game.json`, { method: 'POST' }), /Unsupported upstream HTTP method/);
  } finally {
    snapshots.restore();
  }
  assert.equal(axios.defaults.adapter, originalAdapter);
  assert.equal(globalThis.fetch, originalFetch);
});

test('restores native fetch, installed Axios, writes, and cwd after an upstream loader failure', async t => {
  const fixture = await nativeSnapshotFixture(t);
  const axios = await legacyAxiosFixture(fixture.source);
  const originalAdapter = axios.defaults.adapter;
  const originalFetch = globalThis.fetch;
  const originalWrite = esmFs.writeFile;
  const originalCwd = process.cwd();
  await fsp.writeFile(path.join(fixture.source, 'services/main.js'), `export async function loadData() {await fetch('https://example.test/unpinned');}`);
  await assert.rejects(generate({ ...fixture, languages: 'ru' }), /Unexpected network destination/);
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(axios.defaults.adapter, originalAdapter);
  assert.equal(esmFs.writeFile, originalWrite);
  assert.equal(process.cwd(), originalCwd);
});

test('does not hide a broken installed Axios package or leave fetch overridden', async t => {
  const { source, fileTracker, imageTracker } = await nativeSnapshotFixture(t);
  const packageRoot = path.join(source, 'node_modules/axios');
  await fsp.mkdir(packageRoot, { recursive: true });
  await fsp.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'axios', type: 'module' }));
  // Resolution succeeds, but loading the installed package's missing index fails.
  const originalFetch = globalThis.fetch;
  await assert.rejects(useSnapshots(source, fileTracker, imageTracker), /ENOENT|Cannot find module/);
  assert.equal(globalThis.fetch, originalFetch);
});
