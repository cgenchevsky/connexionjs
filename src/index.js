﻿'format cjs';
'use strict';

var DOMWindow = require('./environment.js').window
var emitter = require('./emitter.js')

var GLOBAL_NAME = 'connexion'

//include polyfills
require('./polyfills/polyfills.js');
require('es6-collections');

exports.version = '0.5.2';

exports.chanel = require('./postmessage.channel.js');

exports.listen = function (type, handler) {
	emitter.listen(type, handler)
	return this
}
exports.observe = function (type, handler) {
	emitter.observe(type, handler)
	return this
}
exports.listen.once = function (type, handler) {
	emitter.listen.once(type, handler)
	return this
}
exports.observe.once = function (type, handler) {
	emitter.observe.once(type, handler)
	return this
}
exports.unsubscribe = function (type, handler) {
	emitter.unsubscribe(type, handler)
	return this
}
exports.emit = function (type, detail) {
	emitter.emit(type, detail)
	return this
}

/**
 * Connexion public object.
 */
DOMWindow[GLOBAL_NAME] = exports
