﻿'use strict';
var environment = require('./environment.js'),
	emitter = require('./emitter.js'),
	event = require('./event.js');

var channel = exports, //exportable
	eventKey = event.key,
	emitterEmit = emitter.emit,
	globalScope = environment.global,
	isNodeJs = environment.isNodeJs;

var whenGuiReady = new Promise(function(resolve, reject) {
	if (globalScope.process /*&& ('node-webkit' in global.process.versions)*/) {
		var timerId = setInterval(function() {
			if (globalScope.window) {
				clearInterval(timerId);
				var gui = globalScope.window.nwDispatcher.requireNwGui();
				resolve(gui);
			}
		}, 10);
	}
	else {
		reject(new Error('Not a Node-Webkit environment'));
	}
});

/**
 * Creates a collection of all child frames/iframes windows objects. Takes into a count deeper nested frames.
 * @param [Window] topWin - Main document window, where to search child frames
 * @returns [Array] - Array of all child windows.
 */
channel.getAllChildWindows = function (topWin) {
	var wins = [],
		frames = topWin.frames,
		win,
		i = frames.length;

	while (i--) {
		win = frames[i];
		wins.push(win);
		//include deeper level frames
		wins = wins.concat(channel.getAllChildWindows(win));
	}

	return wins;
};

channel.getCurrentNWWindow = function() {
	return whenGuiReady.then(function(gui) {
		return gui.Window.get();
	});
};

/**
 * Sends a message to other windows with an event object attached.
 */
channel.sendMessage = function (connexionMessage) {
	var browserWindow = globalScope.window || {},
		location = browserWindow.location,
		origin = location && (location.origin || (location.protocol + '//' + location.host)) || '*',
		browserFrames = browserWindow.top && [browserWindow.top].concat(channel.getAllChildWindows(browserWindow.top)) || [];

	origin = '*'; //!!!!!!!!
	
	if (isNodeJs) {
		channel.getCurrentNWWindow().then(function(nwWindow) {
			browserFrames.forEach(function(win) {
				nwWindow.eval(win.frameElement || null, 'window.postMessage(\'' + connexionMessage + '\', "' + origin + '");');
			});
		});
	}
	else {
		browserFrames.forEach(function(win) {
			try {
				win.postMessage(connexionMessage, origin);
			} catch (err) {
				console.error(err, connexionMessage);
				//var e;
				//e = win.document.createEvent('Event')
				//e.initEvent('message', false, false)
				//e.data = message
				//e.origin = origin
				//e.source = window
				//win.dispatchEvent(e)
			}
		});
	}
}

channel.sendEvent = function (event) {
	var connexionMessage = channel._createEvent(event);
	channel.sendMessage(connexionMessage);
}

channel.sendSetup = function (setup) {
	var connexionMessage = channel._createSetup(setup);
	channel.sendMessage(connexionMessage);
}

channel.sendSetupResponse = function (setup) {
	var connexionMessage = channel._createSetupResponse(setup);
	channel.sendMessage(connexionMessage);
}

/**
 * Subscribes to messages from other windows.
 */
channel.onMessage = function (handler, messageCriteria, once) {
	var browserWindow = globalScope.window;
	if (browserWindow && browserWindow.addEventListener && typeof handler === 'function') {
		browserWindow.addEventListener('message', function onMessagePosted(e) {
			//e.data
			//e.source - some window, which called `postMessage`
			//e.origin
			var event = new this.MessageEvent('message', e), //fixes crahes in NWjs, when read `e.data`
				message = event.data,
				data,
				setup,
				setupResponse;

			if (!message) {
				return; //EXIT, if message is empty
			}

			if (typeof message === 'string') {
				message = JSON.parse(message);
			}

			if (messageCriteria in message) {
				data = message[messageCriteria];
				if (
					data //if message is from Connexion
					&& (
						(('key' in data) && data.key !== eventKey) //filter events that are sent back
						|| (data.length && data[0].event.key !== eventKey) //filter setuped data that is sent back
					)
				) {
					if (once) { //detach handler if should be handled only once
						this.removeEventListener('message', onMessagePosted, false);
					}
					handler(data);
				}
			}
		}, false);
	}
};

channel.onEvent = function (handler) {
	return channel.onMessage(function (event) {
		if (event //if message is from a Connexion
			&& event.key !== eventKey //filter messages that are sent back
		) {
			handler(event);
		}
	}, '__connexionEvent__');
};

channel.onSetup = function (handler) {
	return channel.onMessage(handler, '__connexionSetup__');
};

channel.onceSetupResponse = function (handler) {
	return channel.onMessage(handler, '__connexionSetupResponse__', true);
};

/**
 * Initiates event in a current window.
 */
channel.invokeEvent = function (event) {
	//use event object declaretion as a first parameter
	return emitterEmit.call(emitter, event);
}

/**
 * Message creator 
 */
channel._createEvent = function (event) {
	var data = {
		__connexionEvent__: event
	}
	return JSON.stringify(data);
}

/**
 * Setup data creator
 */
channel._createSetup = function (setupData) {
	var data = {
		__connexionSetup__: [{ event: { key: eventKey }}]
	}
	return JSON.stringify(data);
}

/**
 * Setup response data creator
 */
channel._createSetupResponse = function (setupData) {
	var data = {
		__connexionSetupResponse__: setupData
	}
	return JSON.stringify(data);
}

channel.getStreamsData = function () {
	var eventStreams = emitter.subjects,
		eventTypes = Object.keys(emitter.subjects);
	return eventTypes.map(function (eventType) {
		var stream = eventStreams[eventType];
		return {
			name: eventType,
			event: stream.value
		};
	});
};

channel.setStreamsData = function (streamsData) {
	var eventStreams = emitter.subjects,
		eventTypes = Object.keys(emitter.subjects);

	streamsData.forEach(function (data) {
		var name = data.name,
			event = data.event,
			stream,
			streamValue;
		
		if (!name || name === '*') { //Skip 'any event' declaretion. It will be defined in local instance dinamically by another event.
			return; //EXIT
		}
		if (!event.timeStamp) { //Skip events that wasn't emitted yet (timeStamp = 0)
			return; //EXIT
		}

		//if an event is completely new, than a local event, then emit a newer event to update a value in listeners
		if (!(name in eventStreams)) {
			channel.invokeEvent(event);
		}
		// or an event is later, than a local event, then emit a newer event to update a value in listeners
		else {
			stream = eventStreams[name];
			streamValue = stream.value;
			if (event.timeStamp > streamValue.timeStamp) {
				channel.invokeEvent(event);
			}
		}
	});
};

channel.attachMessageHandlers = function () {
	channel.onEvent(channel.invokeEvent);
	channel.onSetup(function (setup) {
		channel.sendSetupResponse(channel.getStreamsData());
		channel.setStreamsData(setup);
	});
	channel.onceSetupResponse(channel.setStreamsData);
}




//send past events to other instances
channel.sendSetup(channel.getStreamsData());

//augment `emit`
emitter.emit = function (type, detail) {
	var event = emitterEmit.call(emitter, type, detail);
	channel.sendEvent(event);
}

//attach "on message" handler
if (isNodeJs) { //NW
	channel.getCurrentNWWindow().then(function (win) {
		//listen, when new page is open
		win.on('loaded', function () {
			var browserWindow = globalScope.window;
			//listen main window only once
			if (!browserWindow.__ConnexionNodeChannel) {
				browserWindow.__ConnexionNodeChannel = true; //mark as listened by Node
				channel.attachMessageHandlers();
			}
		});
	});
}
else { //Browser
	channel.attachMessageHandlers();
}


//globalScope.channel = channel;
//globalScope.emitter = emitter;