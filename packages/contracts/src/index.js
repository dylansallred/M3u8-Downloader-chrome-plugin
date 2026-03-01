const API = {
  host: '127.0.0.1',
  port: 49732,
  apiVersion: '1',
  protocolVersion: '1',
  minProtocolVersion: '1',
  maxProtocolVersion: '1',
  minExtensionVersion: '1.0.0',
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

module.exports = {
  API,
  HEADER,
  CLIENT,
};
