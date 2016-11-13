var _ = require('underscore');
var util = require('util');
var format = util.format;
var async = require('async');
var esl = require('esl');

FreeswitchUtil = function(logger) {
  this.logger = logger;
  this.FS = null;
}

// FreeSWITCH connection.
FreeswitchUtil.prototype.connect = function(config, callback) {
  var obj = this;
  // debug is global to the esl instance, so the last set value from a
  // connect() call will be used.
  esl.debug = config.esl_debug;
  var host = config.esl_host || 'localhost';
  var port = config.esl_port || 8021;
  var password = config.esl_password || 'Cluecon';
  var options = {
    password: password,
  };
  var handler = function() {
    obj.logger.info(format('connection to FreeSWITCH server %s:%d successful', host, port));
    // Last connected is stored as default.
    obj.FS = this;
    obj.FS.api('status')
    .then(function(res){
      obj.logger.debug(res.body);
      callback(obj.FS);
    });
  }
  var report = function(err) {
    this.logger.error(format('Error connecting to FreeSWITCH server %s:%d, %s', host, port, err));
  }
  this.logger.info(format('connecting to FreeSWITCH server %s:%d, password %s', host, port, password));
  esl.client(options, handler, report.bind(this)).connect(port, host);
}

FreeswitchUtil.prototype.runFreeswitchCommand = function(command, callback, FS) {
  FS = FS ? FS : this.FS;
  this.logger.debug(format("Running command '%s'", command));
  FS.api(command)
  .then(function(res) {
    this.logger.debug(format("Command '%s' result headers: %s", command, JSON.stringify(res.headers)));
    this.logger.debug(format("Command '%s' result body: %s", command, res.body));
    callback(null, res.body);
  }.bind(this))
  .catch(function(error) {
    if (_.isObject(error.res)) {
      this.logger.error(format("Command '%s' error: %s", command, error.res.body));
      callback(error.res.body, null);
    }
    else {
      this.logger.error(format("Command '%s' error: %s", command, JSON.stringify(error)));
      callback(error, null);
    }
  }.bind(this));
}

FreeswitchUtil.prototype.runFreeswitchCommandSeries = function(commands, seriesCallback, FS) {
  FS = FS ? FS : this.FS;
  var buildCommandFunc = function(command) {
    return function(callback) {
      this.runFreeswitchCommand(command, callback, FS);
    }.bind(this);
  }
  var series = _.map(commands, buildCommandFunc, this);
  async.series(series, seriesCallback);
}

module.exports = FreeswitchUtil;
