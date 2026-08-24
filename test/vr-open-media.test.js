import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const catalogUrl = new URL('../vr/open-media/catalog.json', import.meta.url);

test('Quest open-media catalog is pinned, explicit, and license-attributed', async () => {
  const catalog = JSON.parse(await readFile(catalogUrl, 'utf8'));
  assert.equal(catalog.version, 1);
  assert.equal(catalog.items.length, 4);

  const ids = new Set();
  const files = new Set();
  for (const item of catalog.items) {
    assert.equal(ids.has(item.id), false, `duplicate id: ${item.id}`);
    assert.equal(files.has(item.file), false, `duplicate file: ${item.file}`);
    ids.add(item.id);
    files.add(item.file);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.byteLength) && item.byteLength > 0);
    assert.ok(['flat', 'equirect-180', 'equirect-360'].includes(item.projection));
    assert.ok(['mono', 'side-by-side-left-right', 'top-bottom'].includes(item.stereo));
    assert.match(item.sourcePage, /^https:\/\//);
    assert.match(item.downloadUrl, /^https:\/\//);
    assert.ok(item.license.length > 0);
    assert.ok(item.credit.length > 0);
  }

  assert.equal(catalog.items.filter((item) => item.projection === 'equirect-360').length, 2);
  assert.equal(catalog.items.find((item) => item.id === 'everest-satellite-flyover').projection, 'flat');
  assert.equal(catalog.items.find((item) => item.id === 'meta-doggie-sbs').stereo, 'side-by-side-left-right');
});
