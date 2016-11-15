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
  this.autoMonitor = null;
  this.makeCollections();
  this.configXml = null;
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
      memberId: null,
      reservationId: null,
      callerName: null,
      floor: false,
      floorCandidate: false,
      talking: false,
      talkingTimer: null,
    },
    initialize: function(options) {
      this.conferenceId = this.collection.conferenceId;
      this.on('change:reservationId', self.reservationChanged, self);
      this.on('change:memberId', self.memberIdChanged, self);
      this.on('change:floor', self.floorChanged, self);
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
      callerId: null,
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
      activeLayoutGroup: null,
      activeLayout: null,
    },
    initialize: function(options) {
      var users = new userCollection(null, {conferenceId: this.id}, this);
      var slots = new reservationCollection(null, {conferenceId: this.id}, this);
      this.listenTo(users, 'add', self.userJoined.bind(self));
      this.listenTo(users, 'remove', self.userLeft.bind(self));
      this.on('change:activeLayoutGroup', self.setConferenceLayoutGroup, self);
      this.on('change:activeLayout', self.setLayout, self);
      this.set("users", users);
      this.set("slots", slots);
    },
  });
  this.conferences = new (Backbone.Collection.extend({
    model: conferenceModel,
  }))();
}


FreeswitchLayoutManager.prototype.getConference = function(conferenceId) {
  var conference = this.conferences.get(conferenceId);
  return conference;
}

FreeswitchLayoutManager.prototype.conferenceCommand = function(conference, command) {
  return format('conference %s %s', conference.id, command);
}

FreeswitchLayoutManager.prototype.resIdCommand = function(conference, user, reservationId) {
  var commandString = 'vid-res-id %s %s';
  var command = this.conferenceCommand(conference, format(commandString, user.get('memberId'), reservationId));
  return command;
}

FreeswitchLayoutManager.prototype.setConferenceLayoutGroup = function(conference, activeLayoutGroup) {
  if (activeLayoutGroup) {
    this.logger.info(format("activating layout group %s on conference %s", activeLayoutGroup.id, conference.id));
    this.newLayout(conference);
  }
  else {
    var previousGroup = conference.previous('activeLayoutGroup');
    this.logger.info(format("removing layout group %s from conference %s", previousGroup.id, conference.id));
    conference.set('activeLayout', null);
  }
}

FreeswitchLayoutManager.prototype.findLayoutByUserCount = function(conference) {
  var users = conference.get('users');
  var layoutGroup = conference.get('activeLayoutGroup');
  if (layoutGroup) {
    var layouts = layoutGroup.get('layouts');
    var candidates = layouts.filter(function(layout) {
      var slots = layout.get('slots');
      return slots >= users.length;
    }, this);
    var layout = _.first(candidates);
    layout && this.logger.debug(format("selected layout %s from group %s for %d users", layout.id, layoutGroup.id, users.length));
    return layout;
  }
}

FreeswitchLayoutManager.prototype.rebuildSlots = function(slots, layout) {
  this.logger.debug("clearing slots");
  var newSlots = [];
  if (layout) {
    this.logger.debug(format("rebuilding slots for layout %s", layout.id));
    var slotCount = layout.get('slots');
    for (var i = 1; i <= slotCount; i++) {
      newSlots.push({id: i});
    }
  }
  slots.reset(newSlots);
}

FreeswitchLayoutManager.prototype.upgradeLayout = function(conference, user) {
  var layout = this.findLayoutByUserCount(conference);
  if (layout) {
    var users = conference.get('users');
    var slots = conference.get('slots');
    this.rebuildSlots(slots, layout);
    slots.each(function(slot) {
      var reslotUser = users.findWhere({reservationId: slot.id});
      reslotUser && slot.set('callerId', reslotUser.id, {silent: true});
    }, this);
    this.findEmptySlot(slots, user, true);
    conference.set('activeLayout', layout, {silent: true});
    this.logger.debug(format("upgraded to layout %s for %d users", layout.id, users.length));
    var commands = [];
    commands.push(this.conferenceCommand(conference, format('vid-layout %s', layout.id)));
    commands.push(this.resIdCommand(conference, user, user.get('reservationId')));
    this.util.runFreeswitchCommandSeries(commands, null, this.FS);
  }
}

FreeswitchLayoutManager.prototype.newLayout = function(conference) {
  var layout = this.findLayoutByUserCount(conference);
  layout && conference.set('activeLayout', layout);
}

FreeswitchLayoutManager.prototype.setLayout = function(conference, layout) {
  var users = conference.get('users');
  var slots = conference.get('slots');
  // Wasteful to send individual commands with this many operations, so lock
  // regular changes.
  users.each(function(user) {
    user.set('reservationId', null, {silent: true});
  });
  this.rebuildSlots(slots, layout);
  var commands = [];
  commands.push(this.conferenceCommand(conference, 'vid-res-id all clear'));
  if (layout) {
    commands.push(this.conferenceCommand(conference, format('vid-layout %s', layout.id)));
    users.each(function(user) {
      this.findEmptySlot(slots, user, true);
      commands.push(this.resIdCommand(conference, user, user.get('reservationId')));
    }, this);
    this.logger.debug(format("set layout %s for %d users", layout.id, users.length));
  }
  this.util.runFreeswitchCommandSeries(commands, null, this.FS);
}

FreeswitchLayoutManager.prototype.manageUserReservationId = function(user) {
  var conference = this.getConference(user.conferenceId);
  if (conference) {
    var resId = user.get('reservationId');
    var prevResId = user.previous('reservationID');
    var resIdValue = (prevResId && !resId) ? 'clear' : resId;
    var command = this.resIdCommand(conference, user, resIdValue);
    this.util.runFreeswitchCommand(command, null, this.FS);
  }
}

FreeswitchLayoutManager.prototype.reservationChanged = function(user, reservationId) {
  this.manageUserReservationId(user);
}

FreeswitchLayoutManager.prototype.memberIdChanged = function(user, memberId) {
  var prevMemberId = user.previous('memberId');
  if (prevMemberId) {
    this.logger.info(format("user %s changed member id from %d to %d", user.get('callerName'), prevMemberId, memberId));
    var conference = this.getConference(user.conferenceId);
    if (conference) {
      var command = this.conferenceCommand(conference, format('kick %s', prevMemberId));
      this.util.runFreeswitchCommand(command, null, this.FS);
    }
  }
  this.manageUserReservationId(user);
}

FreeswitchLayoutManager.prototype.reSlotExistingUser = function(conference, model) {
  var users = conference.get('users');
  var slots = conference.get('slots');
  var existingSlot = slots.findWhere({callerId: model.id});
  if (existingSlot) {
    var user = users.get(model.id);
    if (user) {
      this.logger.info(format("re-slotting existing user %s in slot %d", user.get('callerName'), existingSlot.id));
      user.set('memberId', model.memberId);
      return true;
    }
  }
  return false;
}

FreeswitchLayoutManager.prototype.findEmptySlot = function(slots, user, silent) {
  silent = _.isUndefined(silent) ? false : silent;
  var slot = slots.findWhere({callerId: null});
  if (slot) {
    this.logger.debug(format("found empty slot %d for user %s", slot.id, user.get('callerName')));
    slot.set('callerId', user.id, {silent: silent});
    user.set('reservationId', slot.id, {silent: silent});
    return true;
  }
  return false;
}

FreeswitchLayoutManager.prototype.userJoined = function(user) {
  this.logger.debug(format("user %s joined", user.get('callerName')));
  var conference = this.getConference(user.conferenceId);
  if (conference) {
    var slots = conference.get('slots');
    if (!this.findEmptySlot(slots, user)) {
      this.upgradeLayout(conference, user);
    }
  }
}

FreeswitchLayoutManager.prototype.userLeft = function(user) {
  this.logger.debug(format("user %s left", user.get('callerName')));
  this.clearTalkingTimer(user);
  var conference = this.getConference(user.conferenceId);
  if (conference) {
    var users = conference.get('users');
    var slots = conference.get('slots');
    var layout = conference.get('activeLayout');
    if (layout) {
      var prevLayout = layout.id;
      var lowThreshold = layout.get('lowThreshold');
      if (!lowThreshold || (users.length < lowThreshold)) {
        this.logger.debug(format("triggering new layout with low theshold %s", lowThreshold));
        this.newLayout(conference);
      }
      var layout = conference.get('activeLayout');
      if (layout.id == prevLayout) {
        var reservationId = user.get('reservationId');
        if (reservationId) {
          var slot = slots.get(reservationId);
          if (slot) {
            this.logger.debug(format("removed user %s from slot %d", user.get('callerName'), slot.id));
            slot.set('callerId', null);
          }
        }
      }
    }
  }
}

FreeswitchLayoutManager.prototype.floorChanged = function(user, floor) {
  var conference = this.getConference(user.conferenceId);
  if (conference) {
    var resId;
    if (floor) {
      this.logger.debug(format("giving floor to user %s", user.get('callerName')));
      resId = 'floor';
    }
    else {
      this.logger.debug(format("removing user %s from floor", user.get('callerName')));
      resId = user.get('reservationId');
    }
    var command = this.resIdCommand(conference, user, resId);
    this.util.runFreeswitchCommand(command, null, this.FS);
  }
}


FreeswitchLayoutManager.prototype.clearTalkingTimer = function(user) {
  var timer = user.get('talkingTimer');
  if (timer) {
    clearTimeout(timer);
    this.logger.debug(format("cleared floor timer for user %s in conference %s", user.get('callerName'), user.conferenceId));
  }
}

FreeswitchLayoutManager.prototype.manageTalkingTimer = function(conference, user) {
  var talking = user.get('talking');
  var previousTalking = user.previous('talking');
  if (!previousTalking && talking) {
    var timer = setTimeout(this.checkFloor.bind(this, conference, user), this.config.conference_layout_floor_timer);
    user.set('talkingTimer', timer);
    this.logger.debug(format("set floor timer for user %s in conference %s", user.get('callerName'), conference.id));
  }
  else if (previousTalking && !talking) {
    this.clearTalkingTimer(user);
  }
}

FreeswitchLayoutManager.prototype.setUserTalking = function(conference, callerId, talking, floorCandidate) {
  var users = conference.get('users');
  var user = users.get(callerId);
  if (user) {
    var attrs = {
      talking: talking,
      floorCandidate: floorCandidate,
    };
    user.set(attrs);
    this.manageTalkingTimer(conference, user);
  }
}

FreeswitchLayoutManager.prototype.checkFloor = function(conference, user) {
  this.logger.debug(format("floor timer expired for user %s in conference %s", user.get('callerName'), conference.id));
  if (conference && user) {
    user.set('talkingTimer', null);
    var floorCandidate = user.get('floorCandidate');
    var talking = user.get('talking');
    this.logger.debug(format("floor check for user %s in conference %s: floorCandidate %s, talking %s", user.get('callerName'), conference.id, floorCandidate, talking));
    if (floorCandidate && talking) {
      this.userToFloor(conference, user);
    }
  }
}

FreeswitchLayoutManager.prototype.userToFloor = function(conference, user) {
  this.logger.debug(format("checking to move user %s to floor in conference %s", user.get('callerName'), conference.id));
  var activeLayout = conference.get('activeLayout');
  if (activeLayout) {
    var hasFloor = activeLayout.get('hasFloor');
    if (hasFloor) {
      if (user.get('floor')) {
        this.logger.debug(format("user %s already has floor in conference %s", user.get('callerName'), conference.id));
      }
      else {
        this.logger.debug(format("moving user %s to floor in conference %s", user.get('callerName'), conference.id));
        var users = conference.get('users');
        users.invoke('set', 'floor', false);
        user.set('floor', true);
      }
    }
  }
}

FreeswitchLayoutManager.prototype.getConferenceStatus = function(conferenceId, callback) {
  this.logger.info(format("retrieving member list for conference %s", conferenceId));
  var statusCallback = function(err, result) {
    callback(err, result);
  }
  var command = format('conference %s list', conferenceId);
  this.util.runFreeswitchCommand(command, statusCallback, this.FS);
}

FreeswitchLayoutManager.prototype.getConferenceMemberData = function(conferenceId, callback) {
  var models = [];
  var statusCallback = function(err, result) {
    if (!err) {
      var lines = result.split("\n");
      for (var num in lines) {
        var fields = lines[num].split(";");
        var attrs = fields[5].split("|");
        var floorCandidate = attrs.indexOf('floor') !== -1;
        var talking = attrs.indexOf('talking') !== -1;
        var model = {
          id: fields[4],
          memberId: fields[0],
          callerName: fields[3],
          floorCandidate: floorCandidate,
          talking: talking,
        };
        model.id && models.push(model);
      }
    }
    callback(models);
  }
  this.getConferenceStatus(conferenceId, statusCallback);
}

FreeswitchLayoutManager.prototype.conferenceEvent = function(msg) {
  var action = msg.body['Action'];
  var conferenceId = msg.body['Conference-Name'];
  var memberId = msg.body['Member-ID'];
  var callerName = msg.body['Caller-Caller-ID-Name'];
  var callerId = msg.body['Caller-Caller-ID-Number'];
  var floorCandidate = msg.body['Floor'] == 'true';
  var talking = msg.body['Talking'] == 'true';
  this.logger.debug(format("Got action %s on conference %s", action, conferenceId));
  var conference;
  switch (action) {
    case 'conference-create':
      this.logger.debug(format("conference %s created", conferenceId));
      if (this.autoMonitor) {
        this.monitorConference(conferenceId, this.autoMonitor);
      }
      break;
    case 'conference-destroy':
      this.logger.debug(format("conference %s destroyed", conferenceId));
      this.unmonitorConference(conferenceId);
      break;
  }
  conference = conference ? conference : this.getConference(conferenceId);
  if (conference) {
    var users = conference.get('users');
    switch (action) {
      case 'add-member':
        this.logger.debug(format("Member %s, user %s (%s) joined conference %s", memberId, callerName, callerId, conferenceId));
        var model = {
          id: callerId,
          memberId: memberId,
          callerName: callerName,
          floorCandidate: floorCandidate,
          talking: talking,
        };
        if (!this.reSlotExistingUser(conference, model)) {
          users.add(model);
        }
        break;
      case 'del-member':
        this.logger.debug(format("Member %s, user %s (%s) left conference %s", memberId, callerName, callerId, conferenceId));
        users.remove(callerId);
        break;
      case 'start-talking':
        this.logger.debug(format("Member %s, user %s (%s) started talking in conference %s", memberId, callerName, callerId, conferenceId));
        this.setUserTalking(conference, callerId, true, floorCandidate);
        break;
      case 'stop-talking':
        this.logger.debug(format("Member %s, user %s (%s) stopped talking in conference %s", memberId, callerName, callerId, conferenceId));
        this.setUserTalking(conference, callerId, false, floorCandidate);
        break;
      case 'floor-change':
        this.logger.debug(format("Member %s, user %s (%s) got audio floor in conference %s", memberId, callerName, callerId, conferenceId));
        this.setUserTalking(conference, callerId, talking, floorCandidate);
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

FreeswitchLayoutManager.prototype.monitorConference = function(conferenceId, activeLayoutGroup, populateUsers) {
  var conference = this.getConference(conferenceId);
  if (!conference) {
    conference = this.conferences.add({id: conferenceId});
  }
  this.logger.info(format("starting monitoring for conference %s", conferenceId));
  var populated = function() {
    conference.set('activeLayoutGroup', activeLayoutGroup);
  }
  if (populateUsers) {
    var callback = function(models) {
      var users = conference.get('users');
      for (var key in models) {
        users.add(models[key], {silent: true});
      }
      this.logger.info(format("populated conference %s with users %s", conferenceId, JSON.stringify(users.toJSON())));
      populated();
    };
    this.getConferenceMemberData(conference.id, callback.bind(this));
  }
  else {
    populated();
  }
}

FreeswitchLayoutManager.prototype.unmonitorConference = function(conferenceId) {
  this.logger.info(format("stopping monitoring for conference %s", conferenceId));
  this.conferences.remove(conferenceId);
}

FreeswitchLayoutManager.prototype.monitorAll = function(layoutGroup) {
  var activeLayoutGroup = this.layoutGroups.get(layoutGroup);
  if (activeLayoutGroup) {
    this.logger.info(format("setting layout group %s for auto monitor", activeLayoutGroup.id));
    this.autoMonitor = activeLayoutGroup;
    var conferenceListCallback = function(err, result) {
      if (!err) {
        var lines = result.split("\n");
        for (var num in lines) {
          var matches = lines[num].match(/^Conference ([0-9a-zA-Z_-]+)/);
          if (matches && matches[1]) {
            this.logger.info(format("Found conference: %s", matches[1]));
            this.monitorConference(matches[1], this.autoMonitor, true);
          }
        }
      }
    }
    this.util.runFreeswitchCommand('conference list summary', conferenceListCallback.bind(this), this.FS);
    return true;
  }
  else {
    this.logger.error(format("layout group %s does not exist", layoutGroup));
    return false;
  }
}

FreeswitchLayoutManager.prototype.unmonitorAll = function() {
  this.logger.info("stopping monitoring on all conferences");
  this.conferences.each(function(conference) {
    this.unmonitorConference(conference.id);
  }, this);
  this.autoMonitor = null;
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
  this.logger.debug(format("searching for conference layout %s", layoutName));
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
      if (image.reservation_id == 'floor') {
        this.logger.info("found floor slot for conference layout %s", layoutName);
        layoutData.hasFloor = true;
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
  this.logger.info("parsing conference groups");
  var groups = this.configXml.configuration['layout-settings'][0].groups;
  for (var key in groups) {
    var group = groups[key].group[0];
    this.parseConferenceGroup(group);
  }
}

FreeswitchLayoutManager.prototype.init = function(callback) {
  this.logger.info("initializing");
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
