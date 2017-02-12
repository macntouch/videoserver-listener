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
var async = require('async');
var bodyParser = require('body-parser');
var config = require('./config');
var roomManagerConfig = require(config.openhangoutRoot + '/server/config');
var RoomManager = require(config.openhangoutRoot + '/server/room-manager')(roomManagerConfig);
var freeswitchUtil = require('./freeswitch-util');
var freeswitchLayoutManager = require('./freeswitch-layout-manager');

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

var fsUtil = new freeswitchUtil(logger);

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
  logger.debug('success response', json);
  return res.json(json);
}

var errorResponse = function(res, status, message) {
  var json = {
    success: false,
    status: status,
    message: message,
  };
  logger.error('error response', json);
  return res.status(status).json(json);
}

app.get('/', function (req, res) {
  res.send('Stirlab videoserver listener server, this page does nothing, you must make a valid api call');
});

// FreeSWITCH routes.
var buildFreeswitchRoutes = function(FS, fsLayoutManager) {
  app.post('/commands', function (req, res) {
    var commands = req.body.commands;
    if (_.isArray(commands)) {
      var seriesCallback = function(err, results) {
        if (err) {
          return errorResponse(res, 500, err);
        }
        else {
          return successResponse(res, results);
        }
      }
      fsUtil.runFreeswitchCommandSeries(commands, seriesCallback, FS);
    }
    else {
      return errorResponse(res, 400, "Bad request, commands array required.");
    }
  });
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
      fsUtil.runFreeswitchCommandSeries(series, seriesCallback, FS);
    }
    else {
      return errorResponse(res, 400, "Bad request, commands array required.");
    }
  });
  app.post('/conference/:conferenceId/control', function (req, res) {
    var action = req.body.action;
    var params = req.body && JSON.stringify(req.body);
    logger.debug(format('Got control action %s, params %s', action, params));
    var validActions = [
      'enable-managed',
      'disable-managed',
    ];
    var conference;
    if (validActions.indexOf(action) === -1) {
      return errorResponse(res, 400, format("Bad request, action required, must be one of %s.", validActions));
    }
    else if (!(conference = fsLayoutManager.getConference(req.params.conferenceId))) {
      return errorResponse(res, 400, format("Bad request, conference %s not found.", req.params.conferenceId));
    }
    else {
      switch(action) {
        case 'enable-managed':
          var layoutGroup = req.body.group;
          if (_.isEmpty(layoutGroup)) {
            return errorResponse(res, 400, "Bad request, group required.");
          }
          else if (!fsLayoutManager.getLayoutGroup(layoutGroup)) {
            return errorResponse(res, 400, format("Bad request, group %s not found.", layoutGroup));
          }
          else {
            var callback = function(err) {
              if (err) {
                return errorResponse(res, 400, format("Error enabling conference: %s.", err));
              }
              else {
                logger.debug(format('Enabled conference %s, layoutGroup %s', conference.id, layoutGroup));
                return successResponse(res, 'enabled');
              }
            }
            fsLayoutManager.enableConference(conference, layoutGroup, callback);
          }
          break;
        case 'disable-managed':
          var layout = req.body.layout;
          if (_.isEmpty(layout)) {
            return errorResponse(res, 400, "Bad request, layout required.");
          }
          else {
            var callback = function(err) {
              if (err) {
                return errorResponse(res, 400, format("Error disabling conference: %s.", err));
              }
              else {
                logger.debug(format('Disabled conference %s, switching to layout %s', conference.id, layout));
                var command = format('conference %s vid-layout %s', conference.id, layout);
                fsUtil.runFreeswitchCommand(command, null, FS);
                return successResponse(res, 'disabled');
              }
            }
            fsLayoutManager.disableConference(conference, callback);
          }
          break;
      }
    }
  });
}

var connectCallback = function(FS) {
  var layoutInitCallback = function() {
    fsLayoutManager.monitorAll('circleanywhere');
  }
  var fsLayoutManager = new freeswitchLayoutManager(FS, config, layoutInitCallback, logger);
  buildFreeswitchRoutes(FS, fsLayoutManager);
}
fsUtil.connect(config, connectCallback);

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

app.get('/monitor/', function(req, res) {
  logger.debug('Got monitor request');
  return successResponse(res, 'up');
});

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

app.post('/room-manager/:roomName/create-token', function(req, res) {
  var tokenCallback = function(err, result) {
    if (err) {
      return errorResponse(res, result, err);
    }
    else {
      return successResponse(res, result);
    }
  }
  logger.debug('Request to create token:', req.params.roomName, req.body.userId, req.body.role);
  return RoomManager.createUserToken(req.params.roomName, req.body.userId, req.body.role, tokenCallback);
});

var loadRoomsCallback = function(err, result) {
  if (err) {
    logger.error('Error loading rooms from room manager', err, result);
  }
  else {
    logger.info(format('Successfully loaded rooms from room manager'));
  }
}
RoomManager.init(function(err) {
  if (err) {
    logger.error('Error loading room plugin:', err);
    return;
  }
  RoomManager.updateRooms(loadRoomsCallback);
});
