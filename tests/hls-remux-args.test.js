const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../packages/downloader-engine/src/core/VideoConverter');

test('remux prefers original HLS segment boundaries when available', () => {
  const job = {
    id: 'job-123',
    segmentFiles: [
      '/tmp/job-123/seg-0.ts',
      '/tmp/job-123/seg-1.ts',
    ],
    tsParts: [
      '/downloads/job-123.ts',
      '/downloads/job-123-part1.ts',
    ],
  };

  const input = __test.resolveRemuxInput(job, '/downloads/job-123.ts', '/downloads');

  assert.deepEqual(input, {
    mode: 'concat',
    entries: job.segmentFiles,
    concatListPath: '/downloads/ts-segments-job-123.txt',
  });
});

test('remux falls back to merged TS parts when original segment files are unavailable', () => {
  const job = {
    id: 'job-456',
    tsParts: [
      '/downloads/job-456.ts',
      '/downloads/job-456-part1.ts',
    ],
  };

  const input = __test.resolveRemuxInput(job, '/downloads/job-456.ts', '/downloads');

  assert.deepEqual(input, {
    mode: 'concat',
    entries: job.tsParts,
    concatListPath: '/downloads/ts-parts-job-456.txt',
  });
});

test('remux args enable timestamp regeneration for concat inputs', () => {
  const args = __test.buildRemuxArgs({
    job: {
      id: 'job-789',
      subtitlePath: null,
    },
    input: {
      mode: 'concat',
      entries: ['/tmp/seg-0.ts', '/tmp/seg-1.ts'],
      concatListPath: '/downloads/ts-segments-job-789.txt',
    },
    mp4Path: '/downloads/job-789.mp4',
    withSubs: false,
  });

  assert.ok(args.includes('-fflags'));
  assert.ok(args.includes('+genpts+discardcorrupt'));
  assert.ok(args.includes('-f'));
  assert.ok(args.includes('concat'));
  assert.ok(args.includes('-max_interleave_delta'));
  assert.ok(args.includes('0'));
  assert.ok(args.includes('-movflags'));
  assert.ok(args.includes('+faststart'));
});
