var _ = require('underscore');
var util = require('util');
var format = util.format;
var freeswitchUtil = require('./freeswitch-util');

var FreeswitchLayoutManager = function(FS, config, logger) {
  this.FS = FS;
  this.config = config;
  this.logger = logger;
  this.util = new freeswitchUtil(this.logger);
  this.conferenceMonitors = {};
}

FreeswitchLayoutManager.prototype.getConferenceStatus = function(conferenceId, callback) {
  var statusCallback = function(err, result) {
    callback(err, result);
  }
  var command = format('conference %s list', conferenceId);
  this.util.runFreeswitchCommand(command, statusCallback, this.FS);
}

FreeswitchLayoutManager.prototype.getConferenceIds = function(conferenceId, callback) {
  var ids = [];
  var statusCallback = function(err, result) {
    if (!err) {
      var lines = result.split("\n");
      for (var num in lines) {
        var fields = lines[num].split(";");
        var callerId = fields[4];
        callerId && ids.push(callerId);
      }
    }
    callback(ids);
  }
  this.getConferenceStatus(conferenceId, statusCallback);
}

FreeswitchLayoutManager.prototype.conferenceEvent = function(msg) {
  var action = msg.body['Action'];
  var conferenceId = msg.body['Conference-Name'];
  var callerId = msg.body['Caller-Caller-ID-Number'];
  this.logger.debug(format("Got action %s on conference %s", action, conferenceId));
  if (this.conferenceMonitors[conferenceId]) {
    switch (action) {
      case 'add-member':
        this.logger.debug(format("User %s joined conference %s", callerId, conferenceId));
        break;
      case 'del-member':
        this.logger.debug(format("User %s left conference %s", callerId, conferenceId));
        break;
      case 'floor-change':
        break;
    }
  }
}

FreeswitchLayoutManager.prototype.conferenceAddEventListener = function(callback) {
  this.FS.on('CUSTOM', this.conferenceEvent.bind(this));
  this.FS.send('event json CUSTOM conference::maintenance')
    .then(function(res) {
      this.logger.info("subscribed to conference events");
    }.bind(this))
    .catch(function(err) {
      this.logger.error("error subscribing to conference events: ", JSON.stringify(err));
    }.bind(this));
};

FreeswitchLayoutManager.prototype.monitorConference = function(conferenceId) {
  this.logger.info(format("starting monitoring for conference %s", conferenceId));
  var callback = function(ids) {
    console.log(ids);
  };
  this.conferenceMonitors[conferenceId] = true;
  this.getConferenceIds(conferenceId, callback);
}

FreeswitchLayoutManager.prototype.unmonitorConference = function(conferenceId) {
  this.logger.info(format("stopping monitoring for conference %s", conferenceId));
  delete this.conferenceMonitors[conferenceId];
}

FreeswitchLayoutManager.prototype.monitorAll = function() {
  var conferenceListCallback = function(err, result) {
    if (!err) {
      var lines = result.split("\n");
      for (var num in lines) {
        var matches = lines[num].match(/^Conference ([0-9a-zA-Z_-]+)/);
        if (matches && matches[1]) {
          this.logger.info(format("Monitoring conference: %s", + matches[1]));
          this.monitorConference(matches[1]);
        }
      }
    }
  }
  this.util.runFreeswitchCommand('conference list summary', conferenceListCallback.bind(this), this.FS);
}

FreeswitchLayoutManager.prototype.unmonitorAll = function() {
  for (var conferenceId in this.conferenceMonitors) {
    this.unmonitorConference(conferenceId);
  }
}

module.exports = FreeswitchLayoutManager;
