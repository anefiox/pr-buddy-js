import semver from 'semver';

const metadataLimit = 8 * 1024 * 1024;
const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const tag = /^[a-z0-9][a-z0-9._-]*$/i;

function registryDependency(name, spec) {
  return name.length <= 214 && packageName.test(name) && typeof spec === 'string' &&
    spec.length <= 256 && (semver.validRange(spec) !== null || tag.test(spec));
}

async function fetchPackage(name, fetchMetadata, signal) {
  try {
    const response = await fetchMetadata('https://registry.npmjs.org/' + encodeURIComponent(name), {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      redirect: 'error',
      signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { state: response.status === 404 ? 'missing' : 'unavailable' };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > metadataLimit) {
        await reader.cancel();
        return { state: 'unavailable' };
      }
      chunks.push(value);
    }
    const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (metadata.name !== name || !metadata.versions || typeof metadata.versions !== 'object' ||
        Array.isArray(metadata.versions)) return { state: 'unavailable' };
    return { state: 'found', metadata };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function checkNpmRegistry(dependencies, fetchMetadata = fetch) {
  const eligible = dependencies.filter(({ name, spec }) => registryDependency(name, spec));
  const names = [...new Set(eligible.map(({ name }) => name))];
  const results = new Map();
  const signal = AbortSignal.timeout(6000);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(names.length, 6) }, async () => {
    while (cursor < names.length && !signal.aborted) {
      const name = names[cursor++];
      results.set(name, await fetchPackage(name, fetchMetadata, signal));
    }
  }));
  return new Map(eligible.map(dependency => [
    dependency, classify(dependency, results.get(dependency.name))
  ]));
}

function classify({ name, spec }, result) {
  const prefix = 'npm dependency ' + name;
  if (result?.state === 'missing') {
    return { severity: 'warning', message: prefix + ' was not found on the public registry.' };
  }
  if (result?.state !== 'found') {
    return { severity: 'info', message: prefix + ' added. Public registry lookup was unavailable.' };
  }
  const { metadata } = result;
  const range = semver.validRange(spec);
  const distTag = metadata['dist-tags']?.[spec];
  const versions = range === null ?
    (typeof distTag === 'string' && Object.hasOwn(metadata.versions, distTag) ? [distTag] : []) :
    Object.keys(metadata.versions).filter(version => semver.satisfies(version, range));
  if (!versions.length) {
    return { severity: 'warning', message: prefix + ' has no published version matching the added dependency spec.' };
  }
  if (versions.every(version => typeof metadata.versions[version]?.deprecated === 'string' &&
      metadata.versions[version].deprecated.trim())) {
    return { severity: 'warning', message: prefix + ' is deprecated for all matching published versions.' };
  }
  return { severity: 'info', message: prefix + ' added. A matching version is published on the public registry.' };
}
