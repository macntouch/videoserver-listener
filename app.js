#!/usr/bin/env node

var util = require('util');
var format = util.format;
var errorhandler = require('errorhandler');
var _ = require('underscore');
var express = require('express');
var https = require('https');
var morgan = require('morgan');
var winston = require("winston");
var fs = require('fs');
var esl = require('esl');
var async = require('async');
var bodyParser = require('body-parser');
var config = require('./config');

esl.debug = config.esl_debug;

var SERVER_TOKEN = config.server_token || 'ff50a71e-956d-9feb-f1cd-fe4b9f2d7470';

var app = express();

if (process.env.NODE_ENV !== "production") {
  app.use(errorhandler({
    dumpExceptions: true,
    showStack: true
  }));
  app.use(morgan('dev'));
}

var level;
var transports;
if (process.env.NODE_ENV === "production") {
  var logDir = config.logDir || __dirname;
  level = 'info';
  transports = [
    new (winston.transports.File)({ filename: logDir + '/server.log' }),
  ];
}
else {
  level = 'debug';
  transports = [
    new (winston.transports.Console)({colorize: true}),
  ];
}

var logger = new winston.Logger({
  level: level,
  transports: transports,
});

app.use(bodyParser.json());

app.use(function (req, res, next) {
  var token = (_.isObject(req.body) && !_.isEmpty(req.body.token)) ? req.body.token : req.query.token;
  logger.debug(util.format('verifying token %s against server token %s', token, SERVER_TOKEN));
  if (token === SERVER_TOKEN) {
    next();
  }
  else {
    logger.warn(util.format('server token validation failed on token %s', token));
    return res.status(401).send("Unauthorized");
  }
});

var successResponse = function(res, data) {
  var data = {
    success: true,
    data: data,
  };
  return res.json(data);
}

var errorResponse = function(res, status, message) {
  var data = {
    success: false,
    status: status,
    message: message,
  };
  return res.status(status).json(data);
}

app.get('/', function (req, res) {
  res.send('Stirlab videoserver listener server, this page does nothing, you must make a valid api call');
});

var runCommandSeries = function(FS, commands, seriesCallback) {
  var buildCommandFunc = function(command) {
    return function(cb) {
      logger.debug(format("Running command '%s'", command));
      FS.api(command)
      .then(function(res) {
        logger.debug(format("Command '%s' result headers: %s", command, JSON.stringify(res.headers)));
        logger.debug(format("Command '%s' result body: %s", command, res.body));
        if (res.body.match(/-ERR/)) {
          cb(res.body, null);
        }
        else {
          cb(null, res.body);
        }
      });
    }
  }
  var series = _.map(commands, buildCommandFunc);
  async.series(series, seriesCallback);
}

var buildFreeswitchRoutes = function(FS) {
  app.post('/conference/:conferenceId/commands', function (req, res) {
    var commands = req.body.commands;
    if (_.isArray(commands)) {
      var buildCommand = function(command) {
        var fullCommand = format('conference %s %s', req.params.conferenceId, command);
        return fullCommand;
      }
      var series = _.map(commands, buildCommand);
      var seriesCallback = function(err, results) {
        if (err) {
          return errorResponse(res, 500, err);
        }
        else {
          return successResponse(res, results);
        }
      }
      runCommandSeries(FS, series, seriesCallback);
    }
    else {
      return errorResponse(res, 400, "Bad request, commands array required.");
    }
  });
}

// FreeSWITCH.
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
  buildFreeswitchRoutes(this);
}
var report = function(err) {
  logger.error(format('Error connecting to FreeSWITCH server %s:%d, %s', host, port, err));
}
logger.info(format('connecting to FreeSWITCH server %s:%d, password %s', host, port, password));
esl.client(options, handler, report).connect(port, host);

var options = {
  key: fs.readFileSync(config.ssl_key).toString(),
  cert: fs.readFileSync(config.ssl_cert).toString(),
};
logger.info(format('Starting HTTPS server on port %d', config.ssl_port));
https.createServer(options, app).listen(config.ssl_port);

