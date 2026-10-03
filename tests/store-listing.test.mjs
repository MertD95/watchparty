import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const listing = JSON.parse(fs.readFileSync(new URL('../store-listing.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const privacy = fs.readFileSync(new URL('../landing/privacy.html', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('store copy stays in sync with the manifest and explains real requirements', () => {
  assert.equal(listing.title, manifest.name);
  assert.equal(listing.shortDescription, manifest.description);
  assert.ok(listing.shortDescription.length <= 132);
  assert.ok(listing.detailedDescription.length < 16000);
  assert.match(listing.detailedDescription, /Each person needs their own access/);
  assert.match(listing.detailedDescription, /not affiliated with or endorsed by Stremio/);
  assert.match(listing.detailedDescription, /not a guarantee of frame-perfect/);
});

test('every production API permission has a current store justification', () => {
  for (const permission of manifest.permissions) {
    assert.ok(listing.permissionJustifications[permission]?.length > 40, permission);
  }
  assert.equal(listing.remoteCode.usesRemoteCode, false);
  assert.match(listing.permissionJustifications.declarativeNetRequestWithHostAccess, /11470/);
  assert.match(listing.permissionJustifications.scripting, /after installation or an update/);
});

test('privacy disclosures distinguish encrypted chat from ordinary room metadata', () => {
  assert.match(listing.detailedDescription, /Public-room chat is not end-to-end encrypted/);
  assert.match(listing.detailedDescription, /membership and playback events are not end-to-end encrypted/);
  assert.match(privacy, /Public-room chat is not end-to-end encrypted/);
  assert.match(privacy, /reactions and playback events are not end-to-end encrypted/);
  assert.match(privacy, /authentication key is retained only in the service worker's memory, not in persistent or session extension storage/);
  assert.match(listing.dataDisclosures.authenticationInformation, /not sent to the WatchParty room backend/);
});

test('listing assets use supported store dimensions and never claim an API update', () => {
  assert.deepEqual([listing.screenshots.width, listing.screenshots.height], [1280, 800]);
  assert.equal(listing.screenshots.recommendedScenes.length, listing.screenshots.maximumCount);
  assert.deepEqual(listing.screenshots.smallPromotionalTile, { width: 440, height: 280 });
  assert.match(listing.publishingNote, /not evidence that the live listing has changed/);
  assert.match(listing.publishingNote, /signed-in developer dashboard/);
});

test('copy-ready description and upload images match the reviewed listing', () => {
  const assetRoot = new URL('../store-assets/chrome-web-store/', import.meta.url);
  const description = fs.readFileSync(new URL('listing-description.txt', assetRoot), 'utf8');
  assert.equal(description.replace(/\r\n/g, '\n').trim(), listing.detailedDescription.trim());
  for (const [filename, width, height] of [
    ['01-watch-together-1280x800.png', 1280, 800],
    ['02-share-a-room-1280x800.png', 1280, 800],
    ['03-simple-settings-1280x800.png', 1280, 800],
    ['small-promo-440x280.png', 440, 280],
    ['marquee-1400x560.png', 1400, 560],
  ]) {
    const png = fs.readFileSync(new URL(filename, assetRoot));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), filename);
    assert.equal(png.readUInt32BE(16), width, filename);
    assert.equal(png.readUInt32BE(20), height, filename);
    assert.equal(png[24], 8, '8 bits per RGB channel');
    assert.equal(png[25], 2, 'RGB without alpha');
  }
  const privacyText = fs.readFileSync(new URL('privacy-and-permissions.txt', assetRoot), 'utf8');
  assert.ok(privacyText.includes(listing.singlePurpose));
  for (const explanation of Object.values(listing.permissionJustifications)) {
    assert.ok(privacyText.includes(explanation));
  }
  const checklist = fs.readFileSync(new URL('dashboard-checklist.txt', assetRoot), 'utf8');
  assert.match(checklist, /SAVE DRAFT ONLY/);
});
