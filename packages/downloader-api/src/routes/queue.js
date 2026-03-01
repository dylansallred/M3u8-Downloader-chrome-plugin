const logger = require('../utils/logger');
const {
  queueMoveValidation,
  queueSettingsValidation,
  jobIdValidation,
  renameTitleValidation
} = require('../utils/validators');

function registerQueueRoutes(app, queueManager) {
  // GET /api/queue - Get all jobs in queue
  app.get('/api/queue', (req, res) => {
    try {
      const queue = queueManager.getQueue();
      const settings = queueManager.getSettings();
      res.json({ queue, settings });
    } catch (err) {
      console.error('Failed to get queue:', err.message);
      res.status(500).json({ error: 'Failed to get queue' });
    }
  });

  // POST /api/queue/:id/rename - Update job title/download name
  app.post('/api/queue/:id/rename', [...jobIdValidation, ...renameTitleValidation], (req, res) => {
    const jobId = req.params.id;
    const { title } = req.body || {};

    const success = queueManager.renameJob(jobId, title.trim());

    if (success) {
      logger.info('Queue job renamed', { jobId, title: title.trim() });
      res.json({ ok: true, title: title.trim() });
    } else {
      res.status(404).json({ error: 'Job not found or cannot rename' });
    }
  });

  // POST /api/queue/:id/pause - Pause a job
  app.post('/api/queue/:id/pause', jobIdValidation, (req, res) => {
    const jobId = req.params.id;
    const success = queueManager.pauseJob(jobId);
  
    if (success) {
      logger.info('Queue job paused', { jobId });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Cannot pause job (not downloading or not found)' });
    }
  });

  // POST /api/queue/:id/resume - Resume a paused job
  app.post('/api/queue/:id/resume', jobIdValidation, (req, res) => {
    const jobId = req.params.id;
    const success = queueManager.resumeJob(jobId);
  
    if (success) {
      logger.info('Queue job resumed', { jobId });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Cannot resume job (not paused or not found)' });
    }
  });

  // POST /api/queue/:id/start - Manually start a queued/paused job (respects maxConcurrent)
  app.post('/api/queue/:id/start', jobIdValidation, (req, res) => {
    const jobId = req.params.id;
    const success = queueManager.startJob(jobId);

    if (success) {
      logger.info('Queue job manually started', { jobId });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Cannot start job (not queued/paused, at capacity, or not found)' });
    }
  });

  // DELETE /api/queue/:id - Remove job from queue
  app.delete('/api/queue/:id', jobIdValidation, (req, res) => {
    const jobId = req.params.id;
    const deleteFiles = req.query.deleteFiles === 'true';
    const success = queueManager.removeJob(jobId, deleteFiles);
  
    if (success) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Job not found in queue' });
    }
  });

  // POST /api/queue/:id/move - Move job to new position
  app.post('/api/queue/:id/move', [...jobIdValidation, ...queueMoveValidation], (req, res) => {
    const jobId = req.params.id;
    const { position } = req.body || {};
  
    if (typeof position !== 'number') {
      return res.status(400).json({ error: 'Missing position in request body' });
    }
  
    const success = queueManager.moveJob(jobId, position);
  
    if (success) {
      logger.info('Queue job moved', { jobId, position });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Cannot move job (not queued/paused or not found)' });
    }
  });

  // POST /api/queue/settings - Update queue settings
  app.post('/api/queue/settings', queueSettingsValidation, (req, res) => {
    const { maxConcurrent, autoStart } = req.body || {};
    const settings = queueManager.updateSettings({ maxConcurrent, autoStart });
    logger.info('Queue settings updated', { settings });
    res.json({ settings });
  });

  // POST /api/queue/start-all - Start all queued jobs (respecting maxConcurrent)
  app.post('/api/queue/start-all', (req, res) => {
    queueManager.settings.autoStart = true;
    queueManager.processQueue();
    logger.info('Queue start-all invoked');
    res.json({ ok: true });
  });

  // POST /api/queue/pause-all - Pause all active downloads
  app.post('/api/queue/pause-all', (req, res) => {
    let pausedCount = 0;
    queueManager.queue.forEach(job => {
      if (job.queueStatus === 'downloading') {
        if (queueManager.pauseJob(job.id)) {
          pausedCount++;
        }
      }
    });
    logger.info('Queue pause-all invoked', { pausedCount });
    res.json({ ok: true, pausedCount });
  });

  // POST /api/queue/clear-completed - Remove all completed jobs
  app.post('/api/queue/clear-completed', (req, res) => {
    const completedJobs = queueManager.queue.filter(
      job => job.queueStatus === 'completed' || job.queueStatus === 'failed' || job.queueStatus === 'cancelled'
    );
  
    let removedCount = 0;
    completedJobs.forEach(job => {
      if (queueManager.removeJob(job.id, false)) {
        removedCount++;
      }
    });
  
    logger.info('Queue clear-completed invoked', { removedCount });
    res.json({ ok: true, removedCount });
  });
}

module.exports = registerQueueRoutes;
