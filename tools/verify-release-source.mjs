import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/;

export function verifyReleaseSource({ repository, event, ref, workflowSha, releaseTag, releaseSha,
  candidateSha, candidateBaseSha, releaseOnMain, mainOnRelease, baseOnRelease, baseOnMain } = {}) {
  if (repository !== 'MertD95/watchparty') throw new Error('Unexpected release repository.');
  if (!['release', 'workflow_dispatch'].includes(event)) throw new Error('Untrusted release event.');
  if (typeof releaseTag !== 'string' || !TAG.test(releaseTag)) throw new Error('An existing stable version tag is required.');
  if (typeof releaseSha !== 'string' || !SHA.test(releaseSha)) throw new Error('An exact release commit is required.');
  if (event === 'workflow_dispatch' && ref !== 'refs/heads/main') throw new Error('Manual packaging and submission require trusted main.');
  if (event === 'release' && (ref !== `refs/tags/${releaseTag}` || workflowSha !== releaseSha)) {
    throw new Error('Release tag, workflow ref and exact commit must agree.');
  }
  if (releaseOnMain !== true) {
    // This exception is intentionally a single immutable candidate, not a
    // branch pattern. Manual runs still execute trusted-main workflow tools;
    // only the separately checked-out package source can be this exact SHA.
    // An explicitly pinned common baseline lets main's release tooling evolve
    // without moving an already uploaded/reviewed tag. This additional path is
    // never available to a release event, whose workflow comes from that tag.
    const trustedMainBaseline = event === 'workflow_dispatch'
      && typeof candidateBaseSha === 'string' && SHA.test(candidateBaseSha)
      && baseOnRelease === true && baseOnMain === true;
    if (typeof candidateSha !== 'string' || !SHA.test(candidateSha)
      || candidateSha !== releaseSha || (mainOnRelease !== true && !trustedMainBaseline)) {
      throw new Error('Release must be reachable from main or be the exact authorized candidate with trusted ancestry.');
    }
  }
  return { releaseTag, releaseSha };
}

function isAncestor(older, newer) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('Unable to verify release ancestry.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const releaseTag = process.env.RELEASE_TAG;
    if (typeof releaseTag !== 'string' || !TAG.test(releaseTag)) throw new Error('An existing stable version tag is required.');
    const releaseSha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${releaseTag}^{commit}`],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const releaseOnMain = isAncestor(releaseSha, 'origin/main');
    const mainOnRelease = isAncestor('origin/main', releaseSha);
    const candidateBaseSha = process.env.CHROME_RELEASE_CANDIDATE_BASE_SHA;
    const checkBaseline = !releaseOnMain && !mainOnRelease && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      && typeof candidateBaseSha === 'string' && SHA.test(candidateBaseSha);
    const source = verifyReleaseSource({ repository: process.env.GITHUB_REPOSITORY, event: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF, workflowSha: process.env.GITHUB_SHA, releaseTag, releaseSha,
      candidateSha: process.env.CHROME_RELEASE_CANDIDATE_SHA, candidateBaseSha,
      releaseOnMain, mainOnRelease, baseOnRelease: checkBaseline && isAncestor(candidateBaseSha, releaseSha),
      baseOnMain: checkBaseline && isAncestor(candidateBaseSha, 'origin/main') });
    if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output file is required.');
    appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${source.releaseTag}\nrelease_sha=${source.releaseSha}\n`);
    console.log('Exact release identity and trusted ancestry verified.');
  } catch (error) {
    console.error(error?.message || 'Release source verification failed.');
    process.exitCode = 1;
  }
}
