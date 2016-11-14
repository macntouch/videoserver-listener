var _ = require('underscore');
var fs = require('fs');
var util = require('util');
var format = util.format;
var xml2js = require('xml2js');
var xmlParser = new xml2js.Parser();
var freeswitchUtil = require('./freeswitch-util');

var FreeswitchLayoutManager = function(FS, config, callback, logger) {
  this.FS = FS;
  this.config = config;
  this.logger = logger;
  this.util = new freeswitchUtil(this.logger);
  this.conferenceMonitors = {};
  this.configXml = null;
  this.parseConferenceLayoutConfig(callback);
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
      case 'conference-create':
        this.logger.debug(format("conference %s created", conferenceId));
        break;
      case 'conference-destroy':
        this.logger.debug(format("conference %s destroyed", conferenceId));
        break;
      case 'add-member':
        this.logger.debug(format("User %s joined conference %s", callerId, conferenceId));
        break;
      case 'del-member':
        this.logger.debug(format("User %s left conference %s", callerId, conferenceId));
        break;
      case 'floor-change':
        this.logger.debug(format("User %s took floor in conference %s", callerId, conferenceId));
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

FreeswitchLayoutManager.prototype.isPositiveInt = function(id) {
  if(_.isNaN(id)) {
    return false;
  }
  if(!_.isNumber(id)) {
    return false;
  }
  if(id.toString().indexOf(".") > -1) {
    return false;
  }
  if (parseInt(id) < 1) {
    return false;
  }
  return true;
}

FreeswitchLayoutManager.prototype.parseConferenceLayout = function(layoutName) {
  this.logger.debug("searching for conference layout %s", layoutName);
  var layouts = this.configXml.configuration['layout-settings'][0].layouts[0].layout;
  var findLayout = function() {
    for (var key in layouts) {
      if (layouts[key].$.name == layoutName) {
        return layouts[key];
      }
    }
  }
  var layout = findLayout();
  if (layout) {
    this.logger.debug("examining conference layout %s", layout.$.name);
    count = 0;
    usedIds = [];
    var layoutData = {
      hasFloor: false,
      slots: 0,
      lowThreshold: null,
    }
    for (var key in layout.image) {
      var image = layout.image[key].$;
      if (image['floor-only'] == 'true') {
        if (image.reservation_id) {
          this.logger.warn("conference layout %s image has floor and reservation_id, skipping layout", layoutName);
          return;
        }
        else {
          layoutData.hasFloor = true;
        }
      }
      else if (image.reservation_id) {
        var id = parseFloat(image.reservation_id);
        if (this.isPositiveInt(id)) {
          if (usedIds.indexOf(id) !== -1) {
            this.logger.warn("conference layout %s image duplicate reservation_id %d, skipping layout", layoutName, id);
            return;
          }
          else {
            count++;
            usedIds.push(id);
            var slots = id > layoutData.slots ? id : layoutData.slots;
            layoutData.slots = slots;
          }
        }
        else {
          this.logger.warn("conference layout %s image has non-integer reservation_id %s, skipping layout", layoutName, image.reservation_id);
          return;
        }
      }
      else {
        this.logger.warn("conference layout %s image has missing reservation_id, skipping layout", layoutName);
        return;
      }
    }
    if (layoutData.slots == count) {
      if (layout.$.low_threshold) {
        var threshold = parseFloat(layout.$.low_threshold);
        if (!this.isPositiveInt(threshold) || threshold > layoutData.slots) {
          this.logger.warn("conference layout %s has invalid low_threshold value %s, skipping layout", layoutName, layout.$.low_threshold);
          return;
        }
        else {
          layoutData.lowThreshold = threshold;
          return layoutData;
        }
      }
      else {
        return layoutData;
      }
    }
    else {
      this.logger.warn("conference layout %s largest reservation_id %d doesn't match count %d, skipping layout", layoutName, layoutData.slots, count);
      return;
    }
  }
  else {
    this.logger.warn("conference layout %s not found", layoutName);
    return;
  }
}

FreeswitchLayoutManager.prototype.parseConferenceGroup = function(group) {
  this.logger.debug("examining conference layout group %s", group.$.name);
  if (group.$.managed_reservations == 'true') {
    this.logger.info("conference layouts group %s is managed", group.$.name);
    for (var key in group.layout) {
      var layoutName = group.layout[key];
      var layoutData = this.parseConferenceLayout(layoutName);
      if (layoutData) {
        this.logger.info("adding conference layout %s to group %s, slots %d, low threshold %s, floor %s", layoutName, group.$.name, layoutData.slots, layoutData.lowThreshold, layoutData.hasFloor);
      }
    }
  }
}

FreeswitchLayoutManager.prototype.parseConferenceGroups = function() {
  var groups = this.configXml.configuration['layout-settings'][0].groups;
  for (var key in groups) {
    var group = groups[key].group[0];
    this.parseConferenceGroup(group);
  }
}

FreeswitchLayoutManager.prototype.parseConferenceLayoutConfig = function(callback) {
  var layoutFile = this.config.freeswitch_dir + '/conf/autoload_configs/conference_layouts.conf.xml';
  fs.readFile(layoutFile, function(err, data) {
    if (err) {
      this.logger.error("error loading conference layouts file %s", layoutFile);
    }
    else {
      xmlParser.parseString(data, function (err, xml) {
        if (err) {
          this.logger.error("error parsing conference layouts file %s", layoutFile);
        }
        else {
          this.configXml = xml;
          this.parseConferenceGroups();
          callback && callback();
        }
      }.bind(this));
    }
  }.bind(this));
}

module.exports = FreeswitchLayoutManager;
