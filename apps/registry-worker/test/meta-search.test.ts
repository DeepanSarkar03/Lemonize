import { describe, expect, it } from 'vitest';
import { publicPackageSearchQueries } from '../src/routes/meta.js';

describe('public package search', () => {
  it('filters visibility and publication state before applying the result limit', () => {
    const queries = publicPackageSearchQueries().map((value) => JSON.parse(value));

    expect(queries).toEqual([
      { method: 'equal', attribute: 'status', values: ['active', 'published'] },
      {
        method: 'or',
        values: [
          { method: 'equal', attribute: 'visibility', values: ['public'] },
          { method: 'isNull', attribute: 'visibility' },
        ],
      },
      { method: 'greaterThan', attribute: 'publishedVersionCount', values: [0] },
      { method: 'orderDesc', attribute: '$updatedAt' },
      { method: 'limit', values: [50] },
    ]);
  });
});
