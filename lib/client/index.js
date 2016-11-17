'use strict';

var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var https = require('https');
var inherits = require('util').inherits;
var querystring = require('querystring');
var url = require('url');
var _ = require('lodash');

var bitcore = require('bitcore-lib');
var secp = require('secp256k1');

var CSVStream = require('./streams/csv');
var ListStream = require('./streams/list');
var RawTransactionsStream = require('./streams/rawtransactions');
var TransactionsStream = require('./streams/transactions');
var TxidsStream = require('./streams/txids');
var utils = require('../utils');
var version = require('../../package.json').version;

function Client(options) {
  if (!(this instanceof Client)) {
    return new Client(options);
  }
  if (!options) {
    options = {};
  }
  this.saveKnownHostHandler = options.saveKnownHostHandler || false;
  this.knownHosts = options.knownHosts || false;
  if (options.apiPrivateKey && !Buffer.isBuffer(options.apiPrivateKey)) {
    this.apiPrivateKey = new Buffer(options.apiPrivateKey, 'hex');
  } else {
    this.apiPrivateKey = options.apiPrivateKey || false;
  }
  if (options.apiPublicKey && !Buffer.isBuffer(options.apiPublicKey)) {
    this.apiPublicKey = new Buffer(options.apiPublicKey, 'hex');
  } else {
    this.apiPublicKey = options.apiPublicKey || false;
  }
  this.network = bitcore.Networks.get(options.network);
  this.url = options.url;
  assert(this.network, 'Network is expected.');
  assert(this.url, 'Url is expected.');
  this.bitcoinHeight = null;
  this.bitcoinHash = null;
  this.socket = null;
}
inherits(Client, EventEmitter);


Client.prototype.disconnect = function() {
};

Client.prototype._maybeCallback = function(callback, err) {
  if (callback) {
    return callback(err);
  }
  if (err) {
    this.emit('error', err);
  }
};

Client.prototype.getNetworkName = function() {
  var network = this.network.name;
  if (this.network.regtestEnabled) {
    network = 'regtest';
  }
  return network;
};


Client.prototype._getResponseError = function(res, body) {
  var err = null;
  if (res.statusCode === 404) {
    err = new Error('404 Not Found');
    err.statusCode = 404;
  } else if (res.statusCode === 400) {
    err = new Error('400 Bad Request: ' + body);
    err.statusCode = 400;
  } else if (res.statusCode === 401) {
    err = new Error('401 Unauthorized: ' + body);
    err.statusCode = 401;
  } else if (res.statusCode >= 500) {
    err = new Error(res.statusCode + ' Server Error: ' + body);
    err.statusCode = res.statusCode;
  } else if (res.headers['x-bitcoin-network']) {
    var serverNetwork = res.headers['x-bitcoin-network'];
    if (this.getNetworkName() !== serverNetwork) {
      err = new Error('Network mismatch, server network is: ' + serverNetwork);
    }
  }
  return err;
};


Client.prototype._signRequest = function(options, callback) {
  /* jshint maxstatements: 30 */

  var self = this;

  var parsedUrl = url.parse(options.url);
  var data = new Buffer(JSON.stringify(options.body) || 0);
  var path = options.endpoint;
  if (options.qs) {
    path += '?' + querystring.stringify(options.qs);
  }

  var isTLS = (parsedUrl.protocol === 'https:');
  var _http = isTLS ? https : http;

  var opts = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 80,
    path: path,
    method: options.method,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
    }
  };

  if (this.apiPublicKey) {
    var nonce = utils.generateNonce();
    var fullUrl = options.url + path;
    var hashedData = utils.generateHashForRequest(opts.method, fullUrl, data, nonce);
    var sigObj = secp.sign(hashedData, this.apiPrivateKey);
    var signatureExport = secp.signatureExport(sigObj.signature);

    opts.headers['x-identity'] = this.apiPublicKey.toString('hex');
    opts.headers['x-signature'] = signatureExport.toString('hex');
    opts.headers['x-nonce'] = nonce.toString('hex');
  }

  if (this.knownHosts) {
    opts.ca = this.knownHosts;
  } else {
    opts.rejectUnauthorized = false;
  }

  if (_.isObjectLike(options.body) && options.body.filepath) {
    opts.headers['content-type'] = 'multipart/form-data';
  }
  var called = false;
  var req = _http.request(opts, function(res) {
    var body = '';
    res.setEncoding('utf8');

    var certificate = false;
    if (isTLS) {
      certificate = res.socket.getPeerCertificate(false);
    }

    res.on('data', function(chunk) {
      body += chunk;
    });

    function finish(err) {
      if (err) {
        return callback(err);
      }
      callback(null, res, body);
    }

    res.on('end', function() {
      if (!called) {
        called = true;

        // Ask to save the known host if we're running as the CLI
        if (certificate && certificate.fingerprint &&
          self.saveKnownHostHandler) {
          self.saveKnownHostHandler(certificate, finish);
        } else {
          finish();
        }
      }
    });
  });

  req.on('error', function(e) {
    if (!called) {
      called = true;
      callback(e);
    }
  });

  if (_.isObjectLike(options.body) && options.body.filepath) {
    var fs = require('fs');
    var stream = fs.createReadStream(options.body.filepath);
    stream.pipe(req);
  } else {
    req.write(data);
    req.end();
  }

};

Client.prototype._request = function(method, endpoint, params, callback) {
  var self = this;

  var options = {
    method: method,
    url: self.url,
    json: true,
    endpoint: endpoint,
    headers: {
      'user-agent': 'wallet-' + version,
    }
  };

  if (params && method.toUpperCase() === 'GET') {
    options.qs = params;
  } else if (params) {
    options.headers['content-type'] = 'application/json';
    options.body = params;
  }

  self._signRequest(options, function(err, res, body) {
    if (err) {
      return callback(err);
    }
    err = self._getResponseError(res, body);
    if (err) {
      return callback(err);
    }
    var json;
    if (body) {
      try {
        json = JSON.parse(body);
      } catch(e) {
        return callback(e);
      }
    }
    self.bitcoinHeight = parseInt(res.headers['x-bitcoin-height']);
    self.bitcoinHash = res.headers['x-bitcoin-hash'];
    callback(err, res, json);
  });
};

Client.prototype._put = function(endpoint, callback) {
  this._request('PUT', endpoint, false, callback);
};

Client.prototype._get = function(endpoint, params, callback) {
  this._request('GET', endpoint, params, callback);
};

Client.prototype._post = function(endpoint, body, callback) {
  this._request('POST', endpoint, body, callback);
};

/**
 * TODO
 * - have an option for a watch only wallet (no encryption needed)
 * - for spending wallets, create a new secret for wallet
 * - encrypt that secret with the hash of a passphrase
 * - store that secret to encrypt all private keys for the wallet
 * - be able to define the type of wallet: non-hd, hd(bip44), hd(bip45)
 */
Client.prototype.createWallet = function(walletId, callback) {
  this._put('/wallets/' + walletId, callback);
};

Client.prototype.importAddress = function(walletId, address, callback) {
  this._put('/wallets/' + walletId + '/addresses/' + address, callback);
};

Client.prototype.importAddresses = function(walletId, filepath, callback) {
  this._post('/wallets/' + walletId + '/addresses', { filepath: filepath }, callback);
};

Client.prototype.getTransactions = function(walletId, options, callback) {
  this._get('/wallets/' + walletId + '/transactions', options, callback);
};

Client.prototype.getUTXOs = function(walletId, options, callback) {
  this._get('/wallets/' + walletId + '/utxos', options, callback);
};

Client.prototype.getTxids = function(walletId, options, callback) {
  this._get('/wallets/' + walletId + '/txids', options, callback);
};

Client.prototype.getBalance = function(walletId, callback) {
  this._get('/wallets/' + walletId + '/balance', {}, callback);
};

Client.prototype.getInfo = function(callback) {
  this._get('/info', {}, callback);
};

Client.prototype.getHeightsFromTimestamps = function(options, callback) {
  this._get('/info/timestamps', options, callback);
};

Client.TransactionsStream = TransactionsStream;
Client.prototype.getTransactionsStream = function(walletId, options) {
  options.client = this;
  var stream = new TransactionsStream(walletId, options);
  return stream;
};

Client.RawTransactionsStream = RawTransactionsStream;
Client.prototype.getRawTransactionsStream = function(walletId, options) {
  options.client = this;
  var stream = new RawTransactionsStream(walletId, options);
  return stream;
};

Client.TxidsStream = TxidsStream;
Client.prototype.getTxidsStream = function(walletId, options) {
  options.client = this;
  var stream = new TxidsStream(walletId, options);
  return stream;
};

Client.CSVStream = CSVStream;
Client.prototype.getTransactionsCSVStream = function(walletId, options) {
  options.client = this;
  var stream = new CSVStream(walletId, options);
  return stream;
};

Client.ListStream = ListStream;
Client.prototype.getTransactionsListStream = function(walletId, options) {
  options.client = this;
  var stream = new ListStream(walletId, options);
  return stream;
};

module.exports = Client;
