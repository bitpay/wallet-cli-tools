'use strict';

var assert = require('assert');

var bitcore = require('bitcore-lib');

var utils = require('./utils');

var MAX_INT = 0xffffffff; // Math.pow(2, 32) - 1

exports.sanitizeRangeOptions = function(options) {
  if (!options) {
    options = {};
  }
  options.height = options.height || 0;
  options.index = options.index || 0;

  if (!options.limit) {
    options.limit = 10;
  } else if (options.limit > 500) {
    throw new Error('Limit exceeds maximum');
  }

  assert(bitcore.util.js.isNaturalNumber(options.height), '"height" is expected to be a natural number');
  assert(bitcore.util.js.isNaturalNumber(options.index), '"index" is expected to be a natural number');
  assert(bitcore.util.js.isNaturalNumber(options.limit), '"limit" is expected to be a natural number');

  assert(options.limit <= 500, '"limit" exceeds maximum');

  if (options.end) {
    assert(bitcore.util.js.isNaturalNumber(options.end.height), '"end height" is expected to be a natural number');
  }
  return options;
};

exports.checkRangeParams = function(req, res, next) {
  assert(req.bitcoinHeight, '"bitcoinHeight" is expected to be set on the request');

  var range = {
    height: parseInt(req.query.height),
    index: parseInt(req.query.index),
    limit: parseInt(req.query.limit),
    end: {
      height: req.bitcoinHeight,
      index: MAX_INT
    }
  };

  if (req.query.end) {
    range.end.height = parseInt(req.query.end) || req.bitcoinHeight;
  }

  try {
    range = exports.sanitizeRangeOptions(range);
  } catch(e) {
    return utils.sendError({
      message: 'Invalid params: ' + e.message,
      statusCode: 400
    }, res);
  }

  assert(range.height <= range.end.height, '\'Height\' param required to be less than \'End\' param.');
  req.range = range;
  next();
};

exports.checkAddress = function(req, res, next) {
  var address;
  var addressStr;

  if (req.body.address) {
    addressStr = req.body.address;
  } else {
    addressStr = req.params.address;
  }

  if(!addressStr) {
    return utils.sendError({
      message: 'Address param is expected',
      statusCode: 400
    }, res);
  }

  assert(req.network, '"network" is expected to be set on the request');

  try {
    address = new bitcore.Address(addressStr, req.network);
  } catch(e) {
    return utils.sendError({
      message: 'Invalid address: ' + e.message,
      statusCode: 400
    }, res);
  }

  req.address = address;
  next();
};

exports.checkAddresses = function(req, res, next) {
  var addresses = [];

  if (!req.body.addresses || !req.body.addresses.length || !Array.isArray(req.body.addresses)) {
    return utils.sendError({
      message: 'Addresses param is expected',
      statusCode: 400
    }, res);
  }

  assert(req.network, '"network" is expected to be set on the request');

  for (var i = 0; i < req.body.addresses.length; i++) {
    var address;
    try {
      address = new bitcore.Address(req.body.addresses[i], req.network);
    } catch(e) {
      return utils.sendError({
        message: 'Invalid address: ' + e.message,
        statusCode: 400
      }, res);
    }
    addresses.push(address);
  }

  req.addresses = addresses;
  next();
};

exports.checkWalletId = function(req, res, next) {

  if (!req.params.walletId) {
    return utils.sendError({
      message: 'Wallet id is expected',
      statusCode: 400
    }, res);
  }

  if (req.params.walletId.length !== 64 || !bitcore.util.js.isHexa(req.params.walletId)) {
    return utils.sendError({
      message: 'Wallet id is expected to be a hexadecimal string with length of 64',
      statusCode: 400
    }, res);
  }

  req.walletId = new Buffer(req.params.walletId, 'hex');
  next();

};

exports.checkAuthHeaders = function(req, res) {
  var identity = req.header('x-identity');
  var signature = req.header('x-signature');
  var nonce = req.header('x-nonce');
  if (identity && (identity.length > 130 || !bitcore.util.js.isHexa(identity))) {
    utils.sendError({
      message: 'x-identity is expected to be a hexadecimal string with length of less than 131',
      statusCode: 400
    }, res);
    return false;
  }
  if (signature && (signature.length > 142 || !bitcore.util.js.isHexa(signature))) {
    utils.sendError({
      message: 'x-signature is expected to be a hexadecimal string with length of less than 143',
      statusCode: 400
    }, res);
    return false;
  }
  if (nonce && (nonce.length > 128 || nonce.length % 2 !== 0 || !bitcore.util.js.isHexa(nonce))) {
    utils.sendError({
      message: 'x-nonce is expected to be a hexadecimal string with length of less than 129',
      statusCode: 400
    }, res);
    return false;
  }
  return true;
};

exports.checkDate = function(dateStrings) {
  var errors = [];
  if (!Array.isArray(dateStrings)) {
    dateStrings = [dateStrings];
  }
  for(var i = 0; i < dateStrings.length; i++) {
    internalDateCheck(dateStrings[i]);
  }

  function internalDateCheck(dateString) {
    var date = new Date(utils.toIntIfNumberLike(dateString));
    if (date.toString() === 'Invalid Date') {
      errors.push('The date supplied: \'' + dateString +
          '\' is not a valid date string. A valid date could be: \'2016-09-01\'.');
    }
  }
  return errors;
};

exports.checkDateFunction = function(callback) {
  var self = this;
  return function() {
    var args = Array.prototype.slice.call(arguments);
    var errors = self.checkDate([args[1], args[2]]);
    if (errors.length > 0) {
      args.unshift(errors);
    } else {
      args.unshift(null);
    }
    callback.apply(null, args);
  };
};

module.exports = exports;
