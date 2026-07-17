import { describe, expect, it } from 'vitest';
import {
  InvalidNpmPathError,
  classifyPath,
  packumentPath,
  rewritePackumentTarballs,
  selectPackumentRepresentation,
  tarballPath,
} from '../src/protocol.js';

describe('npm URL protocol', () => {
  it('accepts encoded and slash-form scoped packuments', () => {
    expect(classifyPath('/@scope%2Fpackage')).toEqual({
      kind: 'packument',
      packageName: '@scope/package',
    });
    expect(classifyPath('/%40scope%2fpackage')).toEqual({
      kind: 'packument',
      packageName: '@scope/package',
    });
    expect(classifyPath('/@scope/package')).toEqual({
      kind: 'packument',
      packageName: '@scope/package',
    });
    expect(packumentPath('@scope/package')).toBe('/@scope%2Fpackage');
  });

  it('recognizes scoped and unscoped tarball paths', () => {
    expect(classifyPath('/left-pad/-/left-pad-1.3.0.tgz')).toEqual({
      kind: 'tarball',
      packageName: 'left-pad',
      filename: 'left-pad-1.3.0.tgz',
    });
    const scoped = classifyPath('/@scope/pkg/-/pkg-2.0.0-beta.1.tgz');
    expect(scoped).toEqual({
      kind: 'tarball',
      packageName: '@scope/pkg',
      filename: 'pkg-2.0.0-beta.1.tgz',
    });
    if (scoped?.kind === 'tarball') {
      expect(tarballPath(scoped)).toBe('/@scope/pkg/-/pkg-2.0.0-beta.1.tgz');
    }
  });

  it('rejects malformed encodings and unsafe filenames', () => {
    expect(() => classifyPath('/bad%ZZname')).toThrow(InvalidNpmPathError);
    expect(() => classifyPath('/pkg/-/not-a-tarball.zip')).toThrow(InvalidNpmPathError);
    expect(() => classifyPath('/@scope//name')).toThrow(InvalidNpmPathError);
  });

  it('negotiates npm corgi and full packuments', () => {
    expect(
      selectPackumentRepresentation(
        'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*; q=0.1',
      ),
    ).toEqual({ variant: 'corgi', accept: 'application/vnd.npm.install-v1+json' });
    expect(selectPackumentRepresentation('application/json')).toEqual({
      variant: 'full',
      accept: 'application/json',
    });
    expect(
      selectPackumentRepresentation('application/vnd.npm.install-v1+json; q=0, application/json; q=1'),
    ).toEqual({ variant: 'full', accept: 'application/json' });
  });

  it('rewrites only exact HTTPS registry tarball fields', () => {
    const packument = {
      homepage: 'https://registry.npmjs.org/leave-this-alone',
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
            integrity: 'sha512-original-integrity',
            shasum: '0123456789abcdef',
          },
        },
        '2.0.0': {
          dist: { tarball: 'https://registry.npmjs.org.evil.example/pkg.tgz' },
        },
        '3.0.0': {
          dist: { tarball: 'http://registry.npmjs.org/pkg/-/pkg-3.0.0.tgz' },
        },
        '4.0.0': {
          dist: { tarball: 'https://cdn.example.test/pkg-4.0.0.tgz' },
        },
      },
    };

    expect(rewritePackumentTarballs(packument)).toBe(packument);
    expect(packument.versions['1.0.0'].dist).toEqual({
      tarball: 'https://npm.lemonize.cyou/pkg/-/pkg-1.0.0.tgz',
      integrity: 'sha512-original-integrity',
      shasum: '0123456789abcdef',
    });
    expect(packument.versions['2.0.0'].dist.tarball).toBe(
      'https://registry.npmjs.org.evil.example/pkg.tgz',
    );
    expect(packument.versions['3.0.0'].dist.tarball).toBe(
      'http://registry.npmjs.org/pkg/-/pkg-3.0.0.tgz',
    );
    expect(packument.versions['4.0.0'].dist.tarball).toBe(
      'https://cdn.example.test/pkg-4.0.0.tgz',
    );
    expect(packument.homepage).toBe('https://registry.npmjs.org/leave-this-alone');
  });

  it('rewrites tarballs to an explicitly configured staging origin', () => {
    const packument = {
      versions: {
        '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' } },
      },
    };
    rewritePackumentTarballs(packument, 'https://npm-staging.lemonize.cyou');
    expect(packument.versions['1.0.0'].dist.tarball).toBe(
      'https://npm-staging.lemonize.cyou/pkg/-/pkg-1.0.0.tgz',
    );
  });
});
