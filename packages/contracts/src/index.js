const API = {
  host: '127.0.0.1',
  port: 49732,
  apiVersion: '1',
  protocolVersion: '1',
};

const HEADER = {
  client: 'X-Client',
  protocolVersion: 'X-Protocol-Version',
  apiVersion: 'X-API-Version',
  authorization: 'Authorization',
};

const CLIENT = {
  extension: 'fetchv-extension',
};

const TOKEN = {
  pairingTtlMs: 10 * 60 * 1000,
};

module.exports = {
  API,
  HEADER,
  CLIENT,
  TOKEN,
};
