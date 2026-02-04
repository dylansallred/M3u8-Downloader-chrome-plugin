const { body, param, validationResult } = require('express-validator');
const logger = require('./logger');

function isValidUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Invalid protocol');
    }

    const hostname = url.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.endsWith('.local')
    ) {
      throw new Error('Private hosts not allowed');
    }
    return true;
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }
}

function isSafeFilename(value) {
  if (typeof value !== 'string') {
    throw new Error('Filename must be a string');
  }
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error('Path traversal detected');
  }
  if (value.includes('\0')) {
    throw new Error('Null byte detected');
  }
  return true;
}

const jobValidation = [
  body('queue.url').exists().bail().custom(isValidUrl),
  body('queue.title').optional().isString().isLength({ max: 255 }),
  body('threads').optional().isInt({ min: 1, max: 16 }),
  body('settings.customName').optional().custom(isSafeFilename),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Job validation failed', { errors: errors.array() });
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  }
];

const queueMoveValidation = [
  param('id').exists().isString().notEmpty(),
  body('position').exists().isInt({ min: 0 }),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Queue move validation failed', { errors: errors.array() });
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  }
];

const queueSettingsValidation = [
  body('maxConcurrent').optional().isInt({ min: 1, max: 16 }),
  body('autoStart').optional().isBoolean(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Queue settings validation failed', { errors: errors.array() });
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  }
];

const historyFileParamValidation = [
  param('fileName').exists().bail().custom(isSafeFilename),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('History fileName validation failed', { errors: errors.array() });
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  }
];

const jobIdValidation = [
  param('id')
    .exists()
    .isString()
    .matches(/^[a-z0-9-]+$/i)
    .isLength({ min: 1, max: 50 })
    .withMessage('Invalid job ID format'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Job ID validation failed', { errors: errors.array() });
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  }
];

const renameTitleValidation = [
  body('title')
    .exists()
    .isString()
    .trim()
    .isLength({ min: 1, max: 255 })
    .matches(/^[^<>:"/\\|?*\x00-\x1F]+$/)
    .withMessage('Invalid title format - must be 1-255 characters and cannot contain invalid filename characters'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Rename title validation failed', { errors: errors.array() });
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
  }
];

module.exports = {
  jobValidation,
  queueMoveValidation,
  queueSettingsValidation,
  historyFileParamValidation,
  jobIdValidation,
  renameTitleValidation,
};
