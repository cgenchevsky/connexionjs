﻿'use strict'

var ConnexionEvent = require('../../../src/types/event.js')

describe('event', function () {
	var message = {
		type: 'test',
		emitter: 'system',
		detail: {
			a: 1,
			b: 2
		}
	}

	it('is a constructor', function () {
		var defaultEvent = new ConnexionEvent()
		var messageEvent = new ConnexionEvent(message)
		expect(defaultEvent).toEqual(jasmine.any(ConnexionEvent))
		expect(messageEvent).toEqual(jasmine.any(ConnexionEvent))
	})

	describe('if argument is not passed, has correct property', function () {
		var event = new ConnexionEvent()

		it('emitter', function () {
			expect(event.emitter).toBe('')
		})
		it('type', function () {
			expect(event.type).toBe('*')
		})
		it('timeStamp', function () {
			expect(typeof event.timeStamp).toBe('number')
			//expect(event.timeStamp).toBe(new Date().getTime())
		})
		it('detail', function () {
			expect(event.detail).toEqual({})
		})
	})

	describe('has correct values if Event is passed as argument', function () {
		var event = new ConnexionEvent(message)

		it('emitter', function () {
			expect(event.emitter).toBe(message.emitter)
		})
		it('type', function () {
			expect(event.type).toBe(message.type)
		})
		it('timeStamp', function () {
			expect(typeof event.timeStamp).toBe('number')
			//expect(event.timeStamp).toBe(new Date().getTime())
		})
		it('detail', function () {
			expect(event.detail).toEqual(message.detail)
		})
	})
})

