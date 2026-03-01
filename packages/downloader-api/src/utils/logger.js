const winston = require('winston');
const path = require('path');

const logDir = path.join(__dirname, '..', '..', 'logs');
const isTest = process.env.NODE_ENV === 'test';
const disableFileLogs = process.env.DISABLE_FILE_LOGS === '1' || isTest;
const loggerLevel = process.env.LOG_LEVEL || (isTest ? 'error' : 'info');

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }),
];

if (!disableFileLogs) {
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log')
    })
  );
}

const logger = winston.createLogger({
  level: loggerLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'local-downloader' },
  transports
});

module.exports = logger;
