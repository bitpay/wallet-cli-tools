'use strict';

var ReadableStream = require('stream').Readable;
var assert = require('assert');
var inherits = require('util').inherits;

var WalletTransaction = require('../../models/transaction');
var utils = require('../../utils');

function TransactionsCSVStream(walletId, opts) {
  ReadableStream.call(this);
  this._walletId = walletId;
  this._client = opts.client;
  this._limit = opts.limit;
  this._end = opts.end;
  this._ended = false;
  this._header = 'Date,Height,Txid,Type,Bitcoin,Destination Address\n';
  this._headerSent = false;
  this._position = {
    height: opts.height,
    index: opts.index
  };
}
inherits(TransactionsCSVStream, ReadableStream);

TransactionsCSVStream.prototype._transactionToCSV = function(transaction) {
  /* jshint maxstatements: 25 */

  var result = '';

  function formatRow(data) {
    return data.join(',') + '\n';
  }

  var walletDetails = WalletTransaction.getTransactionDetails(transaction);
  var walletDelta = walletDetails.outputSatoshis - walletDetails.inputSatoshis;

  if (walletDelta === 0) {
    // There was no change in balance, the export does not need to
    // include any information.
    return result;
  }

  for (var j = 0; j < transaction.outputs.length; j++) {
    var output = transaction.outputs[j];

    if (walletDelta > 0) {

      // Since we're receiving more than spending, we can consider any output
      // that is for this wallet an amount received
      if (output.wallet) {

        // If this output is only part of the total received, use
        // the amount specified in the output. If the output is greater
        // than the wallet received, only consider the amount that is received
        // considering the additonal amount as "change".
        var received = Math.min(output.satoshis, walletDelta);

        // Subtract the received amount from the delta, for the next
        // iteration to use.
        walletDelta -= received;

        result += formatRow([
          utils.timestampToISOString(transaction.blockTimestamp),
          transaction.height,
          transaction.hash,
          walletDetails.type,
          utils.satoshisToBitcoin(received),
          output.address
        ]);

      }
    } else if (walletDelta < 0) {

      // Since we're sending more than we're recieving, we can consider
      // any output other than our own to be sending to this output address.
      // Any output that is our own is "change".
      if (!output.wallet) {

        // It's only possible to send the amount we supplied, other inputs
        // could have supplied additional amounts, so we will only consider
        // the amount sent be up to the amount supplied.
        var sent = Math.min(output.satoshis, walletDelta * -1);

        // It's also possible that this output is one of many, and in that
        // case we should keep track of the remaining available to be sent
        // for the next iteration. In the case that there isn't any remaining
        // to be sent, it should include each with an amount of zero. And
        // information that is not in the blockchain would be necessary to
        // determine the percentage sent to each output.
        walletDelta += sent;

        result += formatRow([
          utils.timestampToISOString(transaction.blockTimestamp),
          transaction.height,
          transaction.hash,
          walletDetails.type,
          utils.satoshisToBitcoin(sent * -1),
          output.address
        ]);

      }
    }
  }

  // Any remaining spent amount is considered paying to miners
  // and does not have an output and considered the "fee".
  if (walletDelta < 0) {
    result += formatRow([
      utils.timestampToISOString(transaction.blockTimestamp),
      transaction.height,
      transaction.hash,
      'fee',
      utils.satoshisToBitcoin(walletDelta),
      null
    ]);
  }

  return result;
};

TransactionsCSVStream.prototype._read = function() {
  var self = this;

  if (this._ended) {
    return this.push(null);
  }

  if (!this._headerSent) {
    this._headerSent = true;
    this.push(this._header);
    return;
  }

  var query = {
    height: this._position.height,
    index: this._position.index,
    limit: this._limit
  };

  function getRows(transactions) {
    var result = '';
    for (var i = 0; i < transactions.length; i++) {
      var tx = transactions[i];
      if (tx.height <= self._end) {
        self._ended = true;
        break;
      }
      var rows = self._transactionToCSV(tx);
      result += rows;
    }
    return result;
  }

  this._client._get('/wallets/' + this._walletId + '/transactions', query, function(err, res, body) {
    if (err) {
      Error.captureStackTrace(err);
      return self.emit('error', err);
    }
    if (self._position.height && self._position.index) {
      assert(self._position.height === body.start.height);
      assert(self._position.index === body.start.index);
    }
    if (!body.end) {
      self._ended = true;
      self.push(getRows(body.transactions));
    } else if (body.end.height === self._position.height && body.end.index === self._position.index) {
      self._ended = true;
    } else {
      self._position = body.end;
      if (self._position.height <= self._end) {
        self._ended = true;
      }
      self.push(getRows(body.transactions));
    }
  });
};

module.exports = TransactionsCSVStream;
