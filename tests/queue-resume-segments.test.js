const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const QueueManager = require('../packages/downloader-engine/src/core/QueueManager');

function createQueueManagerFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-manager-'));
  const queueFilePath = path.join(tempRoot, 'queue.json');
  const jobs = new Map();
  const queueManager = new QueueManager({
    queueFilePath,
    fsPromises: fs.promises,
    jobs,
    runJob: async () => {},
    runDirectJob: async () => {},
    initialSettings: { autoStart: false, maxConcurrent: 1 },
  });

  return {
    tempRoot,
    queueFilePath,
    jobs,
    queueManager,
  };
}

test('queue recovery clears partial-segment resume state for interrupted downloads', async () => {
  const { queueFilePath, jobs, queueManager, tempRoot } = createQueueManagerFixture();
  try {
    const persistedJob = {
      id: 'job-recover',
      queueStatus: 'downloading',
      status: 'downloading',
      resumePartialSegments: true,
      filePath: path.join(tempRoot, 'job-recover', 'job-recover.ts'),
    };
    fs.writeFileSync(queueFilePath, JSON.stringify({
      queue: [persistedJob],
      settings: { autoStart: false, maxConcurrent: 1 },
    }), 'utf8');

    await queueManager.loadQueue();

    const recovered = jobs.get('job-recover');
    assert.ok(recovered);
    assert.equal(recovered.queueStatus, 'queued');
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.resumePartialSegments, false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test('explicit resume preserves partial segments for the same paused job', async () => {
  const { queueManager, jobs, tempRoot } = createQueueManagerFixture();
  try {
    const job = {
      id: 'job-resume',
      queueStatus: 'paused',
      status: 'pending',
      resumePartialSegments: false,
      filePath: path.join(tempRoot, 'job-resume', 'job-resume.ts'),
    };

    queueManager.queue = [job];
    jobs.set(job.id, job);

    const resumed = queueManager.resumeJob(job.id);

    assert.equal(resumed, true);
    assert.equal(job.queueStatus, 'queued');
    assert.equal(job.status, 'pending');
    assert.equal(job.resumePartialSegments, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
