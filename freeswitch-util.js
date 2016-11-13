var _ = require('underscore');
var util = require('util');
var format = util.format;
var async = require('async');
var esl = require('esl');

module.exports = function(logger) {

  // FreeSWITCH connection.
  var connect = function(config, callback) {
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
      logger.info(format('connection to FreeSWITCH server %s:%d successful', host, port));
      this.api('status')
      .then(function(res){
        logger.debug(res.body);
      });
      callback(this);
    }
    var report = function(err) {
      logger.error(format('Error connecting to FreeSWITCH server %s:%d, %s', host, port, err));
    }
    logger.info(format('connecting to FreeSWITCH server %s:%d, password %s', host, port, password));
    esl.client(options, handler, report).connect(port, host);
  }

  var runFreeswitchCommand = function(FS, command, callback) {
    logger.debug(format("Running command '%s'", command));
    FS.api(command)
    .then(function(res) {
      logger.debug(format("Command '%s' result headers: %s", command, JSON.stringify(res.headers)));
      logger.debug(format("Command '%s' result body: %s", command, res.body));
      callback(null, res.body);
    })
    .catch(function(error) {
      if (_.isObject(error.res)) {
        logger.error(format("Command '%s' error: %s", command, error.res.body));
        callback(error.res.body, null);
      }
      else {
        logger.error(format("Command '%s' error: %s", command, JSON.stringify(error)));
        callback(error, null);
      }
    });
  }

  var runFreeswitchCommandSeries = function(FS, commands, seriesCallback) {
    var buildCommandFunc = function(command) {
      return function(callback) {
        runFreeswitchCommand(FS, command, callback);
      }
    }
    var series = _.map(commands, buildCommandFunc);
    async.series(series, seriesCallback);
  }
  return {
    connect: connect,
    runFreeswitchCommandSeries: runFreeswitchCommandSeries,
  }
}

