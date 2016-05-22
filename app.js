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
var roomManagerConfig = require(config.openhangoutRoot + '/server/config');
var RoomManager = require(config.openhangoutRoot + '/server/room-manager')(roomManagerConfig);

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
    return res.status(401).send("Unauthorized, valid server token required");
  }
});

var successResponse = function(res, data) {
  var json = {
    success: true,
    data: data,
  };
  return res.json(json);
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

var runFreeswitchCommandSeries = function(FS, commands, seriesCallback) {
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

// FreeSWITCH routes.
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
      runFreeswitchCommandSeries(FS, series, seriesCallback);
    }
    else {
      return errorResponse(res, 400, "Bad request, commands array required.");
    }
  });
}

// FreeSWITCH connection.
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

// Openhangout routes.
var runRoomManagerRequestSeries = function(ids, method, seriesCallback) {
  var buildRequestFunc = function(id) {
    return function(cb) {
      var roomManagerCallback = function(cb, result) {
        cb(null, result);
      }
      logger.debug(format("Executing %s with id %s", method, id));
      RoomManager[method](id, _.bind(roomManagerCallback, this, cb));
    }
  }
  var series = _.map(ids, buildRequestFunc);
  async.series(series, seriesCallback);
}

var roomManagerRequestResult = function(res, err, results) {
  if (err) {
    return errorResponse(res, 500, err);
  }
  else {
    return successResponse(res, results);
  }
}

app.get('/room-manager/rooms/', function(req, res) {
  var rooms = RoomManager.getRooms();
  return successResponse(res, rooms);
});


app.post('/room-manager/rooms/', function(req, res) {
  var ids = req.body.ids;
  if (_.isArray(ids)) {
    logger.debug(format('Request to create rooms', ids));
    runRoomManagerRequestSeries(ids, 'createRoom', _.bind(roomManagerRequestResult, this, res));
  }
  else {
    return errorResponse(res, 400, "Bad request, ids array required.");
  }
});

app.delete('/room-manager/rooms/', function(req, res) {
  var ids = req.body.ids;
  if (_.isArray(ids)) {
    logger.debug(format('Request to delete rooms', ids));
    runRoomManagerRequestSeries(ids, 'deleteRoom', _.bind(roomManagerRequestResult, this, res));
  }
  else {
    return errorResponse(res, 400, "Bad request, ids array required.");
  }
});

// NOTE: This endpoint returns only the token instead of wrapping it in
// success/error objects, better fit since the client calls it directly.
app.post('/room-manager/:roomName/create-token', function(req, res) {
  var tokenCallback = function(err, result) {
    if (err) {
      return res.status(result).send(err);
    }
    else {
      return res.send(result);
    }
  }
  logger.debug('Request to create token:', req.params.roomName, req.body.username, req.body.role);
  return RoomManager.createToken(req.params.roomName, req.body.username, req.body.role, tokenCallback);
});

var loadRoomsCallback = function(err, result) {
  if (err) {
    logger.error('Error loading rooms from room manager', err, result);
  }
  else {
    logger.info(format('Successfully loaded rooms from room manager'));
  }
}
RoomManager.updateRooms(loadRoomsCallback);
