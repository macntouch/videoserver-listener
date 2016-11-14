var _ = require('underscore');
var Backbone = require('backbone');
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
  this.autoMonitor = false;
  this.makeCollections();
  this.configXml = null;
  this.activeLayouts= null;
  this.init(callback);
}

FreeswitchLayoutManager.prototype.makeCollections = function() {
  var self = this;
  var layoutModel = Backbone.Model.extend({});
  var layoutCollection = Backbone.Collection.extend({
    model: layoutModel,
    comparator: 'slots',
  });
  var layoutGroupModel = Backbone.Model.extend({
    initialize: function(options) {
      var layouts = new layoutCollection(null, this);
      this.set("layouts", layouts);
    },
  });
  this.layoutGroups = new (Backbone.Collection.extend({
    model: layoutGroupModel,
  }))();
  var userModel = Backbone.Model.extend({
    defaults: {
      reservationId: null,
    },
    initialize: function(options) {
      this.conferenceId = this.collection.conferenceId;
      this.on('change:reservationId', self.reservationChanged, self);
    },
  });
  var userCollection = Backbone.Collection.extend({
    model: userModel,
    initialize: function(models, options) {
      this.conferenceId = options.conferenceId;
    },
  });
  var reservationModel = Backbone.Model.extend({
    defaults: {
      memberId: null,
      floor: false,
    },
    initialize: function(options) {
      this.conferenceId = this.collection.conferenceId;
    },
  });
  var reservationCollection = Backbone.Collection.extend({
    model: reservationModel,
    initialize: function(models, options) {
      this.conferenceId = options.conferenceId;
    },
  });
  var conferenceModel = Backbone.Model.extend({
    defaults: {
      activeLayout: null,
    },
    initialize: function(options) {
      var users = new userCollection(null, {conferenceId: this.id}, this);
      var slots = new reservationCollection(null, {conferenceId: this.id}, this);
      this.listenTo(users, 'add', self.userJoined.bind(self));
      this.listenTo(users, 'remove', self.userLeft.bind(self));
      this.on('change:activeLayout', self.setLayout, self);
      this.set("users", users);
      this.set("slots", slots);
    },
  });
  this.conferences = new (Backbone.Collection.extend({
    model: conferenceModel,
  }))();
}

FreeswitchLayoutManager.prototype.setLayoutGroup = function(groupName) {
  var group = this.layoutGroups.get(groupName);
  if (group) {
    this.logger.info(format("activating layout group %s", groupName));
    this.activeLayouts = group.get('layouts');
  }
  else {
    this.logger.error(format("layout group %s does not exist", groupName));
  }
}

FreeswitchLayoutManager.prototype.findLayoutByUserCount = function(conference) {
  var users = conference.get('users');
  var candidates = this.activeLayouts.filter(function(layout) {
    var slots = layout.get('slots');
    return slots >= users.length;
  }, this);
  var layout = _.first(candidates);
  return layout;
}

FreeswitchLayoutManager.prototype.newLayout = function(conference) {
  var layout = this.findLayoutByUserCount(conference);
  conference.set('activeLayout', layout);
}

FreeswitchLayoutManager.prototype.setLayout = function(conference, layout) {
  var users = conference.get('users');
  var slots = conference.get('slots');
  var slotCount = layout.get('slots');
  var newSlots = [];
  for (var i = 1; i <= slotCount; i++) {
    newSlots.push({id: i});
  }
  slots.reset(newSlots);
  // Wasteful to send individual commands with this many operations, so lock
  // regular changes.
  users.each(function(user) {
    user.set('reservationId', null, {silent: true});
  });
  var commands = [
    format('conference %s vid-res-id all clear', conference.id),
    format('conference %s vid-layout %s', conference.id, layout.id),
  ];
  users.each(function(user) {
    this.findEmptySlot(slots, user, true);
    commands.push(format('conference %s vid-res-id %s %s', conference.id, user.id, user.get('reservationId')));
  }, this);
  this.util.runFreeswitchCommandSeries(commands, null, this.FS);
}

FreeswitchLayoutManager.prototype.manageSlot = function(user, reservationId) {
  var commandString = 'conference %s vid-res-id %s %s';
  if (!reservationId) {
    commandString += ' clear';
  }
  var command = format(commandString, user.conferenceId, user.id, reservationId);
  this.util.runFreeswitchCommand(command, null, this.FS);
}

FreeswitchLayoutManager.prototype.reservationChanged = function(user, reservationId) {
  this.manageSlot(user, reservationId);
}

FreeswitchLayoutManager.prototype.findEmptySlot = function(slots, user, silent) {
  silent = _.isUndefined(silent) ? false : silent;
  var slot = slots.findWhere({memberId: null});
  if (slot) {
    slot.set('memberId', user.id, {silent: silent});
    user.set('reservationId', slot.id, {silent: silent});
    return true;
  }
  return false;
}

FreeswitchLayoutManager.prototype.userJoined = function(user) {
  var conference = this.conferences.get(user.conferenceId);
  if (conference) {
    var slots = conference.get('slots');
    if (!this.findEmptySlot(slots, user)) {
      this.newLayout(conference);
    }
  }
}

FreeswitchLayoutManager.prototype.userLeft = function(user) {
  var conference = this.conferences.get(user.conferenceId);
  if (conference) {
    var users = conference.get('users');
    var slots = conference.get('slots');
    var layout = conference.get('activeLayout');
    var prevLayout = layout.id;
    var lowThreshold = layout.get('lowThreshold');
    if (!lowThreshold || (users.length < lowThreshold)) {
      this.newLayout(conference);
    }
    var layout = conference.get('activeLayout');
    if (layout.id == prevLayout) {
      var reservationId = user.get('reservationId');
      if (reservationId) {
        var slot = slots.get(reservationId);
        slot && slot.set('memberId', null);
      }
    }
  }
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
        var memberId = fields[0];
        memberId && ids.push(memberId);
      }
    }
    callback(ids);
  }
  this.getConferenceStatus(conferenceId, statusCallback);
}

FreeswitchLayoutManager.prototype.conferenceEvent = function(msg) {
  var action = msg.body['Action'];
  var conferenceId = msg.body['Conference-Name'];
  var memberId = msg.body['Member-ID'];
  this.logger.debug(format("Got action %s on conference %s", action, conferenceId));
  var conference;
  switch (action) {
    case 'conference-create':
      this.logger.debug(format("conference %s created", conferenceId));
      if (this.autoMonitor) {
        this.monitorConference(conferenceId);
      }
      break;
    case 'conference-destroy':
      this.logger.debug(format("conference %s destroyed", conferenceId));
      this.unmonitorConference(conferenceId);
      break;
  }
  conference = conference ? conference : this.conferences.get(conferenceId);
  if (conference) {
    var users = conference.get('users');
    switch (action) {
      case 'add-member':
        this.logger.debug(format("Member %s joined conference %s", memberId, conferenceId));
        users.add({id: memberId});
        break;
      case 'del-member':
        this.logger.debug(format("Member %s left conference %s", memberId, conferenceId));
        users.remove(memberId);
        break;
      case 'floor-change':
        this.logger.debug(format("Member %s took floor in conference %s", memberId, conferenceId));
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
  var conference = this.conferences.get(conferenceId);
  if (!conference) {
    this.logger.info(format("starting monitoring for conference %s", conferenceId));
    var callback = function(ids) {
      var conference = this.conferences.add({id: conferenceId});
      var users = conference.get('users');
      for (var id in ids) {
        users.add({id: ids[id]}, {silent: true});
      }
      this.newLayout(conference);
    };
    this.getConferenceIds(conferenceId, callback.bind(this));
  }
}

FreeswitchLayoutManager.prototype.unmonitorConference = function(conferenceId) {
  this.logger.info(format("stopping monitoring for conference %s", conferenceId));
  this.conferences.remove(conferenceId);
}

FreeswitchLayoutManager.prototype.monitorAll = function() {
  this.autoMonitor = true;
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
  this.conferences.each(function(conference) {
    this.unmonitorConference(conference.id);
  }, this);
  this.autoMonitor = false;
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
      id: layout.$.name,
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
    var layoutGroup = this.layoutGroups.add({id: group.$.name});
    var layouts = layoutGroup.get('layouts');
    for (var key in group.layout) {
      var layoutName = group.layout[key];
      var layoutData = this.parseConferenceLayout(layoutName);
      if (layoutData) {
        this.logger.info("adding conference layout %s to group %s, slots %d, low threshold %s, floor %s", layoutName, group.$.name, layoutData.slots, layoutData.lowThreshold, layoutData.hasFloor);
        layouts.add(layoutData);
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

FreeswitchLayoutManager.prototype.init = function(callback) {
  var parseConfigCallback = function() {
    this.conferenceAddEventListener();
    callback && callback();
  }
  this.parseConferenceLayoutConfig(parseConfigCallback.bind(this));
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
