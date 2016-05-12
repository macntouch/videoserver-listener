var conferenceName = 'demo';

var participants = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
var configurations = [
  {
    listener: 1,
    participants: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    listener: 11,
    participants: [12, 13, 14, 15, 16, 17, 18, 19, 20],
  },
];

var sendAll = function(command, participants) {
  for (var currentParticipant = 0; currentParticipant < participants.length; currentParticipant++) {
    var participant = participants[currentParticipant];
    for (var otherParticipant = 0; otherParticipant < participants.length; otherParticipant++) {
      var other = participants[otherParticipant];
      if (participant !== other) {
        console.log(format("conference %s relate %s %s %s", conferenceName, participant, other, command));
      }
    }
  }
}

var eavesdrop = function(config) {
  for (var i = 0; i < config.participants.length; i++) {
    console.log(format("conference %s relate %s %s clear", conferenceName, config.listener, config.participants[i]));
  }
}

var groupEavesdrop = function(configurations, participants) {
  sendAll('clear', participants);
  sendAll('nohear', participants);
  for (var i = 0; i < configurations.length; i++) {
    eavesdrop(configurations[i]);
  }
}

groupEavesdrop(configurations, participants);

