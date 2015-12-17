"format register";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";
    
    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;
    
    // we never overwrite an existing define
    if (!defined[name])
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      
      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;
      
      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {
        
        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });
    
    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);
    
      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);
    
    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.declarative ? entry.module.exports : { 'default': entry.module.exports, '__useDefault': true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(main, declare) {

    var System;

    // if there's a system loader, define onto it
    if (typeof System != 'undefined' && System.register) {
      declare(System);
      System['import'](main);
    }
    // otherwise, self execute
    else {
      declare(System = {
        register: register, 
        get: load, 
        set: function(name, module) {
          modules[name] = module; 
        },
        newModule: function(module) {
          return module;
        },
        global: global 
      });
      System.set('@empty', System.newModule({}));
      load(main);
    }
  };

})(typeof window != 'undefined' ? window : global)
/* ('mainModule', function(System) {
  System.register(...);
}); */

('test/spec/spec', function(System) {

System.register("src/asynctask", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var Stack = [],
      ids = {},
      idCounter = 0,
      implementation,
      createTask,
      cancelTask = function() {};
  if (typeof Promise !== 'undefined') {
    createTask = function(callback) {
      new Promise(function(resolve, reject) {
        implementation = {reject: reject};
        resolve();
      }).then(callback);
    };
    cancelTask = function() {
      implementation.reject();
    };
  } else {
    createTask = function(callback) {
      implementation = setTimeout(callback, 0);
    };
    cancelTask = function() {
      clearTimeout(implementation);
    };
  }
  exports.setAsyncTask = function(taskFunc) {
    if (typeof taskFunc !== 'function') {
      return ;
    }
    var id = idCounter++;
    ids[id] = taskFunc;
    if (Stack.length) {
      Stack.push(taskFunc);
    } else {
      Stack.push(taskFunc);
      createTask(function() {
        var task;
        while (Stack.length) {
          task = Stack.shift();
          task();
        }
      });
    }
    return id;
  };
  exports.clearAsyncTask = function(id) {
    if (typeof id !== 'number' || !(id in ids) || !Stack.length) {
      return ;
    }
    var task,
        i = -1;
    while (++i in Stack) {
      task = Stack[i];
      if (task === ids[id]) {
        Stack.splice(i, 1);
        delete ids[id];
      }
    }
    if (!Stack.length) {
      cancelTask();
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("src/event", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var MediatorEvent = function(origin) {
    this.emitter = origin && origin.emitter || '';
    this.scope = origin && origin.scope || '';
    this.isCanceled = false;
    this.type = (origin && origin.type) || '*';
    this.timeStamp = (origin && origin.timeStamp) || new Date().getTime();
    this.detail = origin && origin.detail;
    this.detail = (this.detail && typeof this.detail === 'object') ? this.detail : {};
    this.key = MediatorEvent.key;
  };
  MediatorEvent.prototype.cancel = function() {
    this.isCanceled = true;
  };
  MediatorEvent.key = Math.round(Math.random() * Math.pow(10, 15));
  module.exports = MediatorEvent;
  global.define = __define;
  return module.exports;
});

System.register("src/promise", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var PromiseHelper = {};
  var promiseCollection = function(specificFunc) {
    return function(Iterable) {
      var PromArr = [],
          len,
          props = {
            length: 0,
            done: 0,
            error: 0,
            Results: [],
            ErrorResults: []
          };
      if (arguments.length > 1) {
        PromArr = Array.prototype.slice.call(arguments);
      } else if (Iterable instanceof Array || (typeof Iterable === 'object' && 0 in Iterable)) {
        PromArr = Iterable;
      } else if (arguments.length) {
        PromArr.push(Iterable);
      }
      len = props.length = PromArr.length;
      return new Promise(function(resolve, reject) {
        var itemCallbacks = specificFunc(props, resolve, reject),
            i = 0;
        var nextStep = function(promise, i) {
          var callback = function() {
            props.length = PromArr.length;
            if (len !== props.length) {
              len = props.length;
              iterationLoop();
            }
          };
          if (i == len - 1) {
            promise.then(callback, callback);
          }
          promise.then(itemCallbacks.itemResolved && itemCallbacks.itemResolved.bind(undefined, i), itemCallbacks.itemRejected && itemCallbacks.itemRejected.bind(undefined, i));
        };
        var iterationLoop = function() {
          var promise;
          while (i < len || ((len = props.length = PromArr.length) && i < len)) {
            if (i in PromArr) {
              promise = Promise.resolve(PromArr[i]);
              nextStep(promise, i);
            } else {
              if (itemCallbacks.itemSkipped) {
                itemCallbacks.itemSkipped(i);
              }
            }
            i += 1;
          }
        };
        iterationLoop();
      });
    };
  };
  PromiseHelper.anyPromises = promiseCollection(function(props, resolveCollection) {
    if (!props.length) {
      resolveCollection([]);
    }
    return {
      itemSkipped: function() {
        props.done += 1;
        if (props.done == props.length) {
          resolveCollection(props.Results);
        }
      },
      itemResolved: function(i, result) {
        props.done += 1;
        props.Results[i] = result;
        if (props.done == props.length) {
          resolveCollection(props.Results);
        }
      },
      itemRejected: function(i, err) {
        props.done += 1;
        props.Results[i] = err;
        if (props.done == props.length) {
          resolveCollection(props.Results);
        }
      },
      itemProgressed: undefined
    };
  });
  PromiseHelper.somePromises = promiseCollection(function(props, resolveCollection, rejectCollection) {
    return {
      itemSkipped: function() {
        props.done += 1;
        props.error += 1;
        if (props.error == props.length) {
          rejectCollection(props.ErrorResults);
        } else if (props.done == props.length) {
          resolveCollection(props.Results.filter(function(itm, j) {
            return j in props.Results;
          }));
        }
      },
      itemResolved: function(i, result) {
        props.done += 1;
        props.Results[i] = result;
        if (props.done == props.length) {
          resolveCollection(props.Results.filter(function(itm, j) {
            return j in props.Results;
          }));
        }
      },
      itemRejected: function(i, err) {
        props.done += 1;
        props.error += 1;
        props.ErrorResults[i] = err;
        if (props.error == props.length) {
          rejectCollection(props.ErrorResults);
        } else if (props.done == props.length) {
          resolveCollection(props.Results.filter(function(itm, j) {
            return j in props.Results;
          }));
        }
      },
      itemProgressed: undefined
    };
  });
  module.exports = PromiseHelper;
  global.define = __define;
  return module.exports;
});

(function() {
function define(){};  define.amd = {};
(function(a) {
  function b(a) {
    for (var b = a.length,
        c = new Array(b),
        d = 0; b > d; d++)
      c[d] = a[d];
    return c;
  }
  function c(a, b) {
    if (la && b.stack && "object" == typeof a && null !== a && a.stack && -1 === a.stack.indexOf(pa)) {
      for (var c = [],
          e = b; e; e = e.source)
        e.stack && c.unshift(e.stack);
      c.unshift(a.stack);
      var f = c.join("\n" + pa + "\n");
      a.stack = d(f);
    }
  }
  function d(a) {
    for (var b = a.split("\n"),
        c = [],
        d = 0,
        g = b.length; g > d; d++) {
      var h = b[d];
      e(h) || f(h) || !h || c.push(h);
    }
    return c.join("\n");
  }
  function e(a) {
    var b = h(a);
    if (!b)
      return !1;
    var c = b[0],
        d = b[1];
    return c === na && d >= oa && Ic >= d;
  }
  function f(a) {
    return -1 !== a.indexOf("(module.js:") || -1 !== a.indexOf("(node.js:");
  }
  function g() {
    if (la)
      try {
        throw new Error;
      } catch (a) {
        var b = a.stack.split("\n"),
            c = b[0].indexOf("@") > 0 ? b[1] : b[2],
            d = h(c);
        if (!d)
          return ;
        return na = d[0], d[1];
      }
  }
  function h(a) {
    var b = /at .+ \((.+):(\d+):(?:\d+)\)$/.exec(a);
    if (b)
      return [b[1], Number(b[2])];
    var c = /at ([^ ]+):(\d+):(?:\d+)$/.exec(a);
    if (c)
      return [c[1], Number(c[2])];
    var d = /.*@(.+):(\d+)$/.exec(a);
    return d ? [d[1], Number(d[2])] : void 0;
  }
  function i(a) {
    var b = [];
    if (!Ya(a))
      return b;
    Xa.nonEnumArgs && a.length && Za(a) && (a = bb.call(a));
    var c = Xa.enumPrototypes && "function" == typeof a,
        d = Xa.enumErrorProps && (a === Sa || a instanceof Error);
    for (var e in a)
      c && "prototype" == e || d && ("message" == e || "name" == e) || b.push(e);
    if (Xa.nonEnumShadows && a !== Ta) {
      var f = a.constructor,
          g = -1,
          h = Ea;
      if (a === (f && f.prototype))
        var i = a === Ua ? Oa : a === Sa ? Ja : Pa.call(a),
            j = Wa[i];
      for (; ++g < h; )
        e = Da[g], j && j[e] || !Qa.call(a, e) || b.push(e);
    }
    return b;
  }
  function j(a, b, c) {
    for (var d = -1,
        e = c(a),
        f = e.length; ++d < f; ) {
      var g = e[d];
      if (b(a[g], g, a) === !1)
        break;
    }
    return a;
  }
  function k(a, b) {
    return j(a, b, i);
  }
  function l(a) {
    return "function" != typeof a.toString && "string" == typeof(a + "");
  }
  function m(a, b, c, d) {
    if (a === b)
      return 0 !== a || 1 / a == 1 / b;
    var e = typeof a,
        f = typeof b;
    if (a === a && (null == a || null == b || "function" != e && "object" != e && "function" != f && "object" != f))
      return !1;
    var g = Pa.call(a),
        h = Pa.call(b);
    if (g == Fa && (g = Ma), h == Fa && (h = Ma), g != h)
      return !1;
    switch (g) {
      case Ha:
      case Ia:
        return +a == +b;
      case La:
        return a != +a ? b != +b : 0 == a ? 1 / a == 1 / b : a == +b;
      case Na:
      case Oa:
        return a == String(b);
    }
    var i = g == Ga;
    if (!i) {
      if (g != Ma || !Xa.nodeClass && (l(a) || l(b)))
        return !1;
      var j = !Xa.argsObject && Za(a) ? Object : a.constructor,
          n = !Xa.argsObject && Za(b) ? Object : b.constructor;
      if (!(j == n || Qa.call(a, "constructor") && Qa.call(b, "constructor") || ka(j) && j instanceof j && ka(n) && n instanceof n || !("constructor" in a && "constructor" in b)))
        return !1;
    }
    c || (c = []), d || (d = []);
    for (var o = c.length; o--; )
      if (c[o] == a)
        return d[o] == b;
    var p = 0,
        q = !0;
    if (c.push(a), d.push(b), i) {
      if (o = a.length, p = b.length, q = p == o)
        for (; p--; ) {
          var r = b[p];
          if (!(q = m(a[p], r, c, d)))
            break;
        }
    } else
      k(b, function(b, e, f) {
        return Qa.call(f, e) ? (p++, q = Qa.call(a, e) && m(a[e], b, c, d)) : void 0;
      }), q && k(a, function(a, b, c) {
        return Qa.call(c, b) ? q = --p > -1 : void 0;
      });
    return c.pop(), d.pop(), q;
  }
  function n() {
    try {
      return $a.apply(this, arguments);
    } catch (a) {
      return ab.e = a, ab;
    }
  }
  function o(a) {
    if (!ka(a))
      throw new TypeError("fn must be a function");
    return $a = a, n;
  }
  function p(a) {
    throw a;
  }
  function q(a, b) {
    for (var c = new Array(a),
        d = 0; a > d; d++)
      c[d] = b();
    return c;
  }
  function r(a, b) {
    this.id = a, this.value = b;
  }
  function t(a) {
    this.observer = a, this.a = [], this.isStopped = !1;
  }
  function u() {
    this._s = s;
  }
  function v() {
    this._s = s, this._l = s.length, this._i = 0;
  }
  function w(a) {
    this._a = a;
  }
  function x(a) {
    this._a = a, this._l = B(a), this._i = 0;
  }
  function y(a) {
    return "number" == typeof a && Z.isFinite(a);
  }
  function z(b) {
    var c,
        d = b[xa];
    if (!d && "string" == typeof b)
      return c = new u(b), c[xa]();
    if (!d && b.length !== a)
      return c = new w(b), c[xa]();
    if (!d)
      throw new TypeError("Object is not iterable");
    return b[xa]();
  }
  function A(a) {
    var b = +a;
    return 0 === b ? b : isNaN(b) ? b : 0 > b ? -1 : 1;
  }
  function B(a) {
    var b = +a.length;
    return isNaN(b) ? 0 : 0 !== b && y(b) ? (b = A(b) * Math.floor(Math.abs(b)), 0 >= b ? 0 : b > Xb ? Xb : b) : b;
  }
  function C(a, b) {
    this.observer = a, this.parent = b;
  }
  function D(a, b) {
    return sb(a) || (a = wb), new Zb(b, a);
  }
  function E(a, b) {
    this.observer = a, this.parent = b;
  }
  function F(a, b) {
    this.observer = a, this.parent = b;
  }
  function G(a, b) {
    return new Ac(function(c) {
      var d = new nb,
          e = new ob;
      return e.setDisposable(d), d.setDisposable(a.subscribe(function(a) {
        c.onNext(a);
      }, function(a) {
        try {
          var d = b(a);
        } catch (f) {
          return c.onError(f);
        }
        ja(d) && (d = tc(d));
        var g = new nb;
        e.setDisposable(g), g.setDisposable(d.subscribe(c));
      }, function(a) {
        c.onCompleted(a);
      })), e;
    }, a);
  }
  function H(a, b) {
    var c = this;
    return new Ac(function(d) {
      var e = 0,
          f = a.length;
      return c.subscribe(function(c) {
        if (f > e) {
          var g,
              h = a[e++];
          try {
            g = b(c, h);
          } catch (i) {
            return d.onError(i);
          }
          d.onNext(g);
        } else
          d.onCompleted();
      }, function(a) {
        d.onError(a);
      }, function() {
        d.onCompleted();
      });
    }, c);
  }
  function I() {
    return !1;
  }
  function J() {
    return [];
  }
  function K(a, b, c) {
    var d = Ca(b, c, 3);
    return a.map(function(b, c) {
      var e = d(b, c, a);
      return ja(e) && (e = tc(e)), (Aa(e) || za(e)) && (e = Yb(e)), e;
    }).concatAll();
  }
  function L(a, b, c) {
    this.observer = a, this.selector = b, this.source = c, this.i = 0, this.isStopped = !1;
  }
  function M(a, b, c) {
    var d = Ca(b, c, 3);
    return a.map(function(b, c) {
      var e = d(b, c, a);
      return ja(e) && (e = tc(e)), (Aa(e) || za(e)) && (e = Yb(e)), e;
    }).mergeAll();
  }
  function N(a, b, c) {
    this.observer = a, this.predicate = b, this.source = c, this.i = 0, this.isStopped = !1;
  }
  function O(a, b, c) {
    if (a.addEventListener)
      return a.addEventListener(b, c, !1), jb(function() {
        a.removeEventListener(b, c, !1);
      });
    throw new Error("No listener found");
  }
  function P(a, b, c) {
    var d = new gb;
    if ("[object NodeList]" === Object.prototype.toString.call(a))
      for (var e = 0,
          f = a.length; f > e; e++)
        d.add(P(a.item(e), b, c));
    else
      a && d.add(O(a, b, c));
    return d;
  }
  function Q(a, b) {
    return new Ac(function(c) {
      return b.scheduleWithAbsolute(a, function() {
        c.onNext(0), c.onCompleted();
      });
    });
  }
  function R(a, b, c) {
    return new Ac(function(d) {
      var e = a,
          f = rb(b);
      return c.scheduleRecursiveWithAbsoluteAndState(0, e, function(a, b) {
        if (f > 0) {
          var g = c.now();
          e += f, g >= e && (e = g + f);
        }
        d.onNext(a), b(a + 1, e);
      });
    });
  }
  function S(a, b) {
    return new Ac(function(c) {
      return b.scheduleWithRelative(rb(a), function() {
        c.onNext(0), c.onCompleted();
      });
    });
  }
  function T(a, b, c) {
    return a === b ? new Ac(function(a) {
      return c.schedulePeriodicWithState(0, b, function(b) {
        return a.onNext(b), b + 1;
      });
    }) : Sb(function() {
      return R(c.now() + a, b, c);
    });
  }
  function U(a, b, c) {
    return new Ac(function(d) {
      var e,
          f = !1,
          g = new ob,
          h = null,
          i = [],
          j = !1;
      return e = a.materialize().timestamp(c).subscribe(function(a) {
        var e,
            k;
        "E" === a.value.kind ? (i = [], i.push(a), h = a.value.exception, k = !j) : (i.push({
          value: a.value,
          timestamp: a.timestamp + b
        }), k = !f, f = !0), k && (null !== h ? d.onError(h) : (e = new nb, g.setDisposable(e), e.setDisposable(c.scheduleRecursiveWithRelative(b, function(a) {
          var b,
              e,
              g,
              k;
          if (null === h) {
            j = !0;
            do
              g = null, i.length > 0 && i[0].timestamp - c.now() <= 0 && (g = i.shift().value), null !== g && g.accept(d);
 while (null !== g);
            k = !1, e = 0, i.length > 0 ? (k = !0, e = Math.max(0, i[0].timestamp - c.now())) : f = !1, b = h, j = !1, null !== b ? d.onError(b) : k && a(e);
          }
        }))));
      }), new gb(e, g);
    }, a);
  }
  function V(a, b, c) {
    return Sb(function() {
      return U(a, b - c.now(), c);
    });
  }
  function W(a, b) {
    return new Ac(function(c) {
      function d() {
        g && (g = !1, c.onNext(f)), e && c.onCompleted();
      }
      var e,
          f,
          g;
      return new gb(a.subscribe(function(a) {
        g = !0, f = a;
      }, c.onError.bind(c), function() {
        e = !0;
      }), b.subscribe(d, c.onError.bind(c), d));
    }, a);
  }
  function X(a, b, c) {
    return new Ac(function(d) {
      function e(a, b) {
        j[b] = a;
        var e;
        if (g[b] = !0, h || (h = g.every(ea))) {
          if (f)
            return void d.onError(f);
          try {
            e = c.apply(null, j);
          } catch (k) {
            return void d.onError(k);
          }
          d.onNext(e);
        }
        i && j[1] && d.onCompleted();
      }
      var f,
          g = [!1, !1],
          h = !1,
          i = !1,
          j = new Array(2);
      return new gb(a.subscribe(function(a) {
        e(a, 0);
      }, function(a) {
        j[1] ? d.onError(a) : f = a;
      }, function() {
        i = !0, j[1] && d.onCompleted();
      }), b.subscribe(function(a) {
        e(a, 1);
      }, function(a) {
        d.onError(a);
      }, function() {
        i = !0, e(!0, 1);
      }));
    }, a);
  }
  var Y = {
    "boolean": !1,
    "function": !0,
    object: !0,
    number: !1,
    string: !1,
    undefined: !1
  },
      Z = Y[typeof window] && window || this,
      $ = Y[typeof exports] && exports && !exports.nodeType && exports,
      _ = Y[typeof module] && module && !module.nodeType && module,
      aa = _ && _.exports === $ && $,
      ba = Y[typeof global] && global;
  !ba || ba.global !== ba && ba.window !== ba || (Z = ba);
  var ca = {
    internals: {},
    config: {Promise: Z.Promise},
    helpers: {}
  },
      da = ca.helpers.noop = function() {},
      ea = (ca.helpers.notDefined = function(a) {
        return "undefined" == typeof a;
      }, ca.helpers.identity = function(a) {
        return a;
      }),
      fa = (ca.helpers.pluck = function(a) {
        return function(b) {
          return b[a];
        };
      }, ca.helpers.just = function(a) {
        return function() {
          return a;
        };
      }, ca.helpers.defaultNow = Date.now),
      ga = ca.helpers.defaultComparer = function(a, b) {
        return _a(a, b);
      },
      ha = ca.helpers.defaultSubComparer = function(a, b) {
        return a > b ? 1 : b > a ? -1 : 0;
      },
      ia = (ca.helpers.defaultKeySerializer = function(a) {
        return a.toString();
      }, ca.helpers.defaultError = function(a) {
        throw a;
      }),
      ja = ca.helpers.isPromise = function(a) {
        return !!a && "function" == typeof a.then;
      },
      ka = (ca.helpers.asArray = function() {
        return Array.prototype.slice.call(arguments);
      }, ca.helpers.not = function(a) {
        return !a;
      }, ca.helpers.isFunction = function() {
        var a = function(a) {
          return "function" == typeof a || !1;
        };
        return a(/x/) && (a = function(a) {
          return "function" == typeof a && "[object Function]" == Pa.call(a);
        }), a;
      }());
  ca.config.longStackSupport = !1;
  var la = !1;
  try {
    throw new Error;
  } catch (ma) {
    la = !!ma.stack;
  }
  var na,
      oa = g(),
      pa = "From previous event:",
      qa = ca.EmptyError = function() {
        this.message = "Sequence contains no elements.", Error.call(this);
      };
  qa.prototype = Error.prototype;
  var ra = ca.ObjectDisposedError = function() {
    this.message = "Object has been disposed", Error.call(this);
  };
  ra.prototype = Error.prototype;
  var sa = ca.ArgumentOutOfRangeError = function() {
    this.message = "Argument out of range", Error.call(this);
  };
  sa.prototype = Error.prototype;
  var ta = ca.NotSupportedError = function(a) {
    this.message = a || "This operation is not supported", Error.call(this);
  };
  ta.prototype = Error.prototype;
  var ua = ca.NotImplementedError = function(a) {
    this.message = a || "This operation is not implemented", Error.call(this);
  };
  ua.prototype = Error.prototype;
  var va = ca.helpers.notImplemented = function() {
    throw new ua;
  },
      wa = ca.helpers.notSupported = function() {
        throw new ta;
      },
      xa = "function" == typeof Symbol && Symbol.iterator || "_es6shim_iterator_";
  Z.Set && "function" == typeof(new Z.Set)["@@iterator"] && (xa = "@@iterator");
  var ya = ca.doneEnumerator = {
    done: !0,
    value: a
  },
      za = ca.helpers.isIterable = function(b) {
        return b[xa] !== a;
      },
      Aa = ca.helpers.isArrayLike = function(b) {
        return b && b.length !== a;
      };
  ca.helpers.iterator = xa;
  var Ba,
      Ca = ca.internals.bindCallback = function(a, b, c) {
        if ("undefined" == typeof b)
          return a;
        switch (c) {
          case 0:
            return function() {
              return a.call(b);
            };
          case 1:
            return function(c) {
              return a.call(b, c);
            };
          case 2:
            return function(c, d) {
              return a.call(b, c, d);
            };
          case 3:
            return function(c, d, e) {
              return a.call(b, c, d, e);
            };
        }
        return function() {
          return a.apply(b, arguments);
        };
      },
      Da = ["toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "constructor"],
      Ea = Da.length,
      Fa = "[object Arguments]",
      Ga = "[object Array]",
      Ha = "[object Boolean]",
      Ia = "[object Date]",
      Ja = "[object Error]",
      Ka = "[object Function]",
      La = "[object Number]",
      Ma = "[object Object]",
      Na = "[object RegExp]",
      Oa = "[object String]",
      Pa = Object.prototype.toString,
      Qa = Object.prototype.hasOwnProperty,
      Ra = Pa.call(arguments) == Fa,
      Sa = Error.prototype,
      Ta = Object.prototype,
      Ua = String.prototype,
      Va = Ta.propertyIsEnumerable;
  try {
    Ba = !(Pa.call(document) == Ma && !({toString: 0} + ""));
  } catch (ma) {
    Ba = !0;
  }
  var Wa = {};
  Wa[Ga] = Wa[Ia] = Wa[La] = {
    constructor: !0,
    toLocaleString: !0,
    toString: !0,
    valueOf: !0
  }, Wa[Ha] = Wa[Oa] = {
    constructor: !0,
    toString: !0,
    valueOf: !0
  }, Wa[Ja] = Wa[Ka] = Wa[Na] = {
    constructor: !0,
    toString: !0
  }, Wa[Ma] = {constructor: !0};
  var Xa = {};
  !function() {
    var a = function() {
      this.x = 1;
    },
        b = [];
    a.prototype = {
      valueOf: 1,
      y: 1
    };
    for (var c in new a)
      b.push(c);
    for (c in arguments)
      ;
    Xa.enumErrorProps = Va.call(Sa, "message") || Va.call(Sa, "name"), Xa.enumPrototypes = Va.call(a, "prototype"), Xa.nonEnumArgs = 0 != c, Xa.nonEnumShadows = !/valueOf/.test(b);
  }(1);
  var Ya = ca.internals.isObject = function(a) {
    var b = typeof a;
    return a && ("function" == b || "object" == b) || !1;
  },
      Za = function(a) {
        return a && "object" == typeof a ? Pa.call(a) == Fa : !1;
      };
  Ra || (Za = function(a) {
    return a && "object" == typeof a ? Qa.call(a, "callee") : !1;
  });
  {
    var $a,
        _a = ca.internals.isEqual = function(a, b) {
          return m(a, b, [], []);
        },
        ab = {e: {}},
        bb = ({}.hasOwnProperty, Array.prototype.slice),
        cb = this.inherits = ca.internals.inherits = function(a, b) {
          function c() {
            this.constructor = a;
          }
          c.prototype = b.prototype, a.prototype = new c;
        },
        db = ca.internals.addProperties = function(a) {
          for (var b = [],
              c = 1,
              d = arguments.length; d > c; c++)
            b.push(arguments[c]);
          for (var e = 0,
              f = b.length; f > e; e++) {
            var g = b[e];
            for (var h in g)
              a[h] = g[h];
          }
        };
    ca.internals.addRef = function(a, b) {
      return new Ac(function(c) {
        return new gb(b.getDisposable(), a.subscribe(c));
      });
    };
  }
  r.prototype.compareTo = function(a) {
    var b = this.value.compareTo(a.value);
    return 0 === b && (b = this.id - a.id), b;
  };
  var eb = ca.internals.PriorityQueue = function(a) {
    this.items = new Array(a), this.length = 0;
  },
      fb = eb.prototype;
  fb.isHigherPriority = function(a, b) {
    return this.items[a].compareTo(this.items[b]) < 0;
  }, fb.percolate = function(a) {
    if (!(a >= this.length || 0 > a)) {
      var b = a - 1 >> 1;
      if (!(0 > b || b === a) && this.isHigherPriority(a, b)) {
        var c = this.items[a];
        this.items[a] = this.items[b], this.items[b] = c, this.percolate(b);
      }
    }
  }, fb.heapify = function(a) {
    if (+a || (a = 0), !(a >= this.length || 0 > a)) {
      var b = 2 * a + 1,
          c = 2 * a + 2,
          d = a;
      if (b < this.length && this.isHigherPriority(b, d) && (d = b), c < this.length && this.isHigherPriority(c, d) && (d = c), d !== a) {
        var e = this.items[a];
        this.items[a] = this.items[d], this.items[d] = e, this.heapify(d);
      }
    }
  }, fb.peek = function() {
    return this.items[0].value;
  }, fb.removeAt = function(b) {
    this.items[b] = this.items[--this.length], this.items[this.length] = a, this.heapify();
  }, fb.dequeue = function() {
    var a = this.peek();
    return this.removeAt(0), a;
  }, fb.enqueue = function(a) {
    var b = this.length++;
    this.items[b] = new r(eb.count++, a), this.percolate(b);
  }, fb.remove = function(a) {
    for (var b = 0; b < this.length; b++)
      if (this.items[b].value === a)
        return this.removeAt(b), !0;
    return !1;
  }, eb.count = 0;
  var gb = ca.CompositeDisposable = function() {
    var a,
        b,
        c = [];
    if (Array.isArray(arguments[0]))
      c = arguments[0], b = c.length;
    else
      for (b = arguments.length, c = new Array(b), a = 0; b > a; a++)
        c[a] = arguments[a];
    for (a = 0; b > a; a++)
      if (!lb(c[a]))
        throw new TypeError("Not a disposable");
    this.disposables = c, this.isDisposed = !1, this.length = c.length;
  },
      hb = gb.prototype;
  hb.add = function(a) {
    this.isDisposed ? a.dispose() : (this.disposables.push(a), this.length++);
  }, hb.remove = function(a) {
    var b = !1;
    if (!this.isDisposed) {
      var c = this.disposables.indexOf(a);
      -1 !== c && (b = !0, this.disposables.splice(c, 1), this.length--, a.dispose());
    }
    return b;
  }, hb.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      for (var a = this.disposables.length,
          b = new Array(a),
          c = 0; a > c; c++)
        b[c] = this.disposables[c];
      for (this.disposables = [], this.length = 0, c = 0; a > c; c++)
        b[c].dispose();
    }
  };
  var ib = ca.Disposable = function(a) {
    this.isDisposed = !1, this.action = a || da;
  };
  ib.prototype.dispose = function() {
    this.isDisposed || (this.action(), this.isDisposed = !0);
  };
  var jb = ib.create = function(a) {
    return new ib(a);
  },
      kb = ib.empty = {dispose: da},
      lb = ib.isDisposable = function(a) {
        return a && ka(a.dispose);
      },
      mb = ib.checkDisposed = function(a) {
        if (a.isDisposed)
          throw new ra;
      },
      nb = ca.SingleAssignmentDisposable = function() {
        this.isDisposed = !1, this.current = null;
      };
  nb.prototype.getDisposable = function() {
    return this.current;
  }, nb.prototype.setDisposable = function(a) {
    if (this.current)
      throw new Error("Disposable has already been assigned");
    var b = this.isDisposed;
    !b && (this.current = a), b && a && a.dispose();
  }, nb.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      var a = this.current;
      this.current = null;
    }
    a && a.dispose();
  };
  var ob = ca.SerialDisposable = function() {
    this.isDisposed = !1, this.current = null;
  };
  ob.prototype.getDisposable = function() {
    return this.current;
  }, ob.prototype.setDisposable = function(a) {
    var b = this.isDisposed;
    if (!b) {
      var c = this.current;
      this.current = a;
    }
    c && c.dispose(), b && a && a.dispose();
  }, ob.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      var a = this.current;
      this.current = null;
    }
    a && a.dispose();
  };
  var pb = (ca.RefCountDisposable = function() {
    function a(a) {
      this.disposable = a, this.disposable.count++, this.isInnerDisposed = !1;
    }
    function b(a) {
      this.underlyingDisposable = a, this.isDisposed = !1, this.isPrimaryDisposed = !1, this.count = 0;
    }
    return a.prototype.dispose = function() {
      this.disposable.isDisposed || this.isInnerDisposed || (this.isInnerDisposed = !0, this.disposable.count--, 0 === this.disposable.count && this.disposable.isPrimaryDisposed && (this.disposable.isDisposed = !0, this.disposable.underlyingDisposable.dispose()));
    }, b.prototype.dispose = function() {
      this.isDisposed || this.isPrimaryDisposed || (this.isPrimaryDisposed = !0, 0 === this.count && (this.isDisposed = !0, this.underlyingDisposable.dispose()));
    }, b.prototype.getDisposable = function() {
      return this.isDisposed ? kb : new a(this);
    }, b;
  }(), ca.internals.ScheduledItem = function(a, b, c, d, e) {
    this.scheduler = a, this.state = b, this.action = c, this.dueTime = d, this.comparer = e || ha, this.disposable = new nb;
  });
  pb.prototype.invoke = function() {
    this.disposable.setDisposable(this.invokeCore());
  }, pb.prototype.compareTo = function(a) {
    return this.comparer(this.dueTime, a.dueTime);
  }, pb.prototype.isCancelled = function() {
    return this.disposable.isDisposed;
  }, pb.prototype.invokeCore = function() {
    return this.action(this.scheduler, this.state);
  };
  var qb = ca.Scheduler = function() {
    function a(a, b, c, d) {
      this.now = a, this._schedule = b, this._scheduleRelative = c, this._scheduleAbsolute = d;
    }
    function b(a, b) {
      return b(), kb;
    }
    a.isScheduler = function(b) {
      return b instanceof a;
    };
    var c = a.prototype;
    return c.schedule = function(a) {
      return this._schedule(a, b);
    }, c.scheduleWithState = function(a, b) {
      return this._schedule(a, b);
    }, c.scheduleWithRelative = function(a, c) {
      return this._scheduleRelative(c, a, b);
    }, c.scheduleWithRelativeAndState = function(a, b, c) {
      return this._scheduleRelative(a, b, c);
    }, c.scheduleWithAbsolute = function(a, c) {
      return this._scheduleAbsolute(c, a, b);
    }, c.scheduleWithAbsoluteAndState = function(a, b, c) {
      return this._scheduleAbsolute(a, b, c);
    }, a.now = fa, a.normalize = function(a) {
      return 0 > a && (a = 0), a;
    }, a;
  }(),
      rb = qb.normalize,
      sb = qb.isScheduler;
  !function(a) {
    function b(a, b) {
      function c(b) {
        e(b, function(b) {
          var d = !1,
              e = !1,
              g = a.scheduleWithState(b, function(a, b) {
                return d ? f.remove(g) : e = !0, c(b), kb;
              });
          e || (f.add(g), d = !0);
        });
      }
      var d = b[0],
          e = b[1],
          f = new gb;
      return c(d), f;
    }
    function c(a, b, c) {
      function d(b) {
        f(b, function(b, e) {
          var f = !1,
              h = !1,
              i = a[c](b, e, function(a, b) {
                return f ? g.remove(i) : h = !0, d(b), kb;
              });
          h || (g.add(i), f = !0);
        });
      }
      var e = b[0],
          f = b[1],
          g = new gb;
      return d(e), g;
    }
    function d(a, b) {
      a(function(c) {
        b(a, c);
      });
    }
    a.scheduleRecursive = function(a) {
      return this.scheduleRecursiveWithState(a, function(a, b) {
        a(function() {
          b(a);
        });
      });
    }, a.scheduleRecursiveWithState = function(a, c) {
      return this.scheduleWithState([a, c], b);
    }, a.scheduleRecursiveWithRelative = function(a, b) {
      return this.scheduleRecursiveWithRelativeAndState(b, a, d);
    }, a.scheduleRecursiveWithRelativeAndState = function(a, b, d) {
      return this._scheduleRelative([a, d], b, function(a, b) {
        return c(a, b, "scheduleWithRelativeAndState");
      });
    }, a.scheduleRecursiveWithAbsolute = function(a, b) {
      return this.scheduleRecursiveWithAbsoluteAndState(b, a, d);
    }, a.scheduleRecursiveWithAbsoluteAndState = function(a, b, d) {
      return this._scheduleAbsolute([a, d], b, function(a, b) {
        return c(a, b, "scheduleWithAbsoluteAndState");
      });
    };
  }(qb.prototype), function() {
    qb.prototype.schedulePeriodic = function(a, b) {
      return this.schedulePeriodicWithState(null, a, b);
    }, qb.prototype.schedulePeriodicWithState = function(a, b, c) {
      if ("undefined" == typeof Z.setInterval)
        throw new ta;
      b = rb(b);
      var d = a,
          e = Z.setInterval(function() {
            d = c(d);
          }, b);
      return jb(function() {
        Z.clearInterval(e);
      });
    };
  }(qb.prototype);
  var tb,
      ub,
      vb = qb.immediate = function() {
        function a(a, b) {
          return b(this, a);
        }
        return new qb(fa, a, wa, wa);
      }(),
      wb = qb.currentThread = function() {
        function a() {
          for (; c.length > 0; ) {
            var a = c.dequeue();
            !a.isCancelled() && a.invoke();
          }
        }
        function b(b, d) {
          var e = new pb(this, b, d, this.now());
          if (c)
            c.enqueue(e);
          else {
            c = new eb(4), c.enqueue(e);
            var f = o(a)();
            if (c = null, f === ab)
              return p(f.e);
          }
          return e.disposable;
        }
        var c,
            d = new qb(fa, b, wa, wa);
        return d.scheduleRequired = function() {
          return !c;
        }, d;
      }(),
      xb = (ca.internals.SchedulePeriodicRecursive = function() {
        function a(a, b) {
          b(0, this._period);
          try {
            this._state = this._action(this._state);
          } catch (c) {
            throw this._cancel.dispose(), c;
          }
        }
        function b(a, b, c, d) {
          this._scheduler = a, this._state = b, this._period = c, this._action = d;
        }
        return b.prototype.start = function() {
          var b = new nb;
          return this._cancel = b, b.setDisposable(this._scheduler.scheduleRecursiveWithRelativeAndState(0, this._period, a.bind(this))), b;
        }, b;
      }(), function() {
        var a,
            b = da;
        if (Z.setTimeout)
          a = Z.setTimeout, b = Z.clearTimeout;
        else {
          if (!Z.WScript)
            throw new ta;
          a = function(a, b) {
            Z.WScript.Sleep(b), a();
          };
        }
        return {
          setTimeout: a,
          clearTimeout: b
        };
      }()),
      yb = xb.setTimeout,
      zb = xb.clearTimeout;
  !function() {
    function a(b) {
      if (f)
        yb(function() {
          a(b);
        }, 0);
      else {
        var c = e[b];
        if (c) {
          f = !0;
          var d = o(c)();
          if (ub(b), f = !1, d === ab)
            return p(d.e);
        }
      }
    }
    function b() {
      if (!Z.postMessage || Z.importScripts)
        return !1;
      var a = !1,
          b = Z.onmessage;
      return Z.onmessage = function() {
        a = !0;
      }, Z.postMessage("", "*"), Z.onmessage = b, a;
    }
    function c(b) {
      "string" == typeof b.data && b.data.substring(0, i.length) === i && a(b.data.substring(i.length));
    }
    var d = 1,
        e = {},
        f = !1;
    ub = function(a) {
      delete e[a];
    };
    var g = RegExp("^" + String(Pa).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/toString| for [^\]]+/g, ".*?") + "$"),
        h = "function" == typeof(h = ba && aa && ba.setImmediate) && !g.test(h) && h;
    if (ka(h))
      tb = function(b) {
        var c = d++;
        return e[c] = b, h(function() {
          a(c);
        }), c;
      };
    else if ("undefined" != typeof process && "[object process]" === {}.toString.call(process))
      tb = function(b) {
        var c = d++;
        return e[c] = b, process.nextTick(function() {
          a(c);
        }), c;
      };
    else if (b()) {
      var i = "ms.rx.schedule" + Math.random();
      Z.addEventListener ? Z.addEventListener("message", c, !1) : Z.attachEvent ? Z.attachEvent("onmessage", c) : Z.onmessage = c, tb = function(a) {
        var b = d++;
        return e[b] = a, Z.postMessage(i + currentId, "*"), b;
      };
    } else if (Z.MessageChannel) {
      var j = new Z.MessageChannel;
      j.port1.onmessage = function(b) {
        a(b.data);
      }, tb = function(a) {
        var b = d++;
        return e[b] = a, j.port2.postMessage(b), b;
      };
    } else
      tb = "document" in Z && "onreadystatechange" in Z.document.createElement("script") ? function(b) {
        var c = Z.document.createElement("script"),
            f = d++;
        return e[f] = b, c.onreadystatechange = function() {
          a(f), c.onreadystatechange = null, c.parentNode.removeChild(c), c = null;
        }, Z.document.documentElement.appendChild(c), f;
      } : function(b) {
        var c = d++;
        return e[c] = b, yb(function() {
          a(c);
        }, 0), c;
      };
  }();
  var Ab = qb.timeout = qb["default"] = function() {
    function a(a, b) {
      var c = this,
          d = new nb,
          e = tb(function() {
            !d.isDisposed && d.setDisposable(b(c, a));
          });
      return new gb(d, jb(function() {
        ub(e);
      }));
    }
    function b(a, b, c) {
      var d = this,
          e = qb.normalize(b),
          f = new nb;
      if (0 === e)
        return d.scheduleWithState(a, c);
      var g = yb(function() {
        !f.isDisposed && f.setDisposable(c(d, a));
      }, e);
      return new gb(f, jb(function() {
        zb(g);
      }));
    }
    function c(a, b, c) {
      return this.scheduleWithRelativeAndState(a, b - this.now(), c);
    }
    return new qb(fa, a, b, c);
  }(),
      Bb = ca.Notification = function() {
        function a(a, b, c, d, e, f) {
          this.kind = a, this.value = b, this.exception = c, this._accept = d, this._acceptObservable = e, this.toString = f;
        }
        return a.prototype.accept = function(a, b, c) {
          return a && "object" == typeof a ? this._acceptObservable(a) : this._accept(a, b, c);
        }, a.prototype.toObservable = function(a) {
          var b = this;
          return sb(a) || (a = vb), new Ac(function(c) {
            return a.scheduleWithState(b, function(a, b) {
              b._acceptObservable(c), "N" === b.kind && c.onCompleted();
            });
          });
        }, a;
      }(),
      Cb = Bb.createOnNext = function() {
        function a(a) {
          return a(this.value);
        }
        function b(a) {
          return a.onNext(this.value);
        }
        function c() {
          return "OnNext(" + this.value + ")";
        }
        return function(d) {
          return new Bb("N", d, null, a, b, c);
        };
      }(),
      Db = Bb.createOnError = function() {
        function a(a, b) {
          return b(this.exception);
        }
        function b(a) {
          return a.onError(this.exception);
        }
        function c() {
          return "OnError(" + this.exception + ")";
        }
        return function(d) {
          return new Bb("E", null, d, a, b, c);
        };
      }(),
      Eb = Bb.createOnCompleted = function() {
        function a(a, b, c) {
          return c();
        }
        function b(a) {
          return a.onCompleted();
        }
        function c() {
          return "OnCompleted()";
        }
        return function() {
          return new Bb("C", null, null, a, b, c);
        };
      }(),
      Fb = ca.internals.Enumerator = function(a) {
        this._next = a;
      };
  Fb.prototype.next = function() {
    return this._next();
  }, Fb.prototype[xa] = function() {
    return this;
  };
  var Gb = ca.internals.Enumerable = function(a) {
    this._iterator = a;
  };
  Gb.prototype[xa] = function() {
    return this._iterator();
  }, Gb.prototype.concat = function() {
    var a = this;
    return new Ac(function(b) {
      var c,
          d = a[xa](),
          e = new ob,
          f = vb.scheduleRecursive(function(a) {
            if (!c) {
              try {
                var f = d.next();
              } catch (g) {
                return b.onError(g);
              }
              if (f.done)
                return b.onCompleted();
              var h = f.value;
              ja(h) && (h = tc(h));
              var i = new nb;
              e.setDisposable(i), i.setDisposable(h.subscribe(function(a) {
                b.onNext(a);
              }, function(a) {
                b.onError(a);
              }, a));
            }
          });
      return new gb(e, f, jb(function() {
        c = !0;
      }));
    });
  }, Gb.prototype.catchError = function() {
    var a = this;
    return new Ac(function(b) {
      var c,
          d = a[xa](),
          e = new ob,
          f = vb.scheduleRecursiveWithState(null, function(a, f) {
            if (!c) {
              try {
                var g = d.next();
              } catch (h) {
                return observer.onError(h);
              }
              if (g.done)
                return void(null !== a ? b.onError(a) : b.onCompleted());
              var i = g.value;
              ja(i) && (i = tc(i));
              var j = new nb;
              e.setDisposable(j), j.setDisposable(i.subscribe(function(a) {
                b.onNext(a);
              }, f, function() {
                b.onCompleted();
              }));
            }
          });
      return new gb(e, f, jb(function() {
        c = !0;
      }));
    });
  }, Gb.prototype.catchErrorWhen = function(a) {
    var b = this;
    return new Ac(function(c) {
      var d,
          e,
          f = new Dc,
          g = new Dc,
          h = a(f),
          i = h.subscribe(g),
          j = b[xa](),
          k = new ob,
          l = vb.scheduleRecursive(function(a) {
            if (!d) {
              try {
                var b = j.next();
              } catch (h) {
                return c.onError(h);
              }
              if (b.done)
                return void(e ? c.onError(e) : c.onCompleted());
              var i = b.value;
              ja(i) && (i = tc(i));
              var l = new nb,
                  m = new nb;
              k.setDisposable(new gb(m, l)), l.setDisposable(i.subscribe(function(a) {
                c.onNext(a);
              }, function(b) {
                m.setDisposable(g.subscribe(a, function(a) {
                  c.onError(a);
                }, function() {
                  c.onCompleted();
                })), f.onNext(b);
              }, function() {
                c.onCompleted();
              }));
            }
          });
      return new gb(i, k, l, jb(function() {
        d = !0;
      }));
    });
  };
  var Hb,
      Ib = Gb.repeat = function(a, b) {
        return null == b && (b = -1), new Gb(function() {
          var c = b;
          return new Fb(function() {
            return 0 === c ? ya : (c > 0 && c--, {
              done: !1,
              value: a
            });
          });
        });
      },
      Jb = Gb.of = function(a, b, c) {
        if (b)
          var d = Ca(b, c, 3);
        return new Gb(function() {
          var c = -1;
          return new Fb(function() {
            return ++c < a.length ? {
              done: !1,
              value: b ? d(a[c], c, a) : a[c]
            } : ya;
          });
        });
      },
      Kb = ca.Observer = function() {},
      Lb = Kb.create = function(a, b, c) {
        return a || (a = da), b || (b = ia), c || (c = da), new Nb(a, b, c);
      },
      Mb = ca.internals.AbstractObserver = function(a) {
        function b() {
          this.isStopped = !1, a.call(this);
        }
        return cb(b, a), b.prototype.next = va, b.prototype.error = va, b.prototype.completed = va, b.prototype.onNext = function(a) {
          this.isStopped || this.next(a);
        }, b.prototype.onError = function(a) {
          this.isStopped || (this.isStopped = !0, this.error(a));
        }, b.prototype.onCompleted = function() {
          this.isStopped || (this.isStopped = !0, this.completed());
        }, b.prototype.dispose = function() {
          this.isStopped = !0;
        }, b.prototype.fail = function(a) {
          return this.isStopped ? !1 : (this.isStopped = !0, this.error(a), !0);
        }, b;
      }(Kb),
      Nb = ca.AnonymousObserver = function(a) {
        function b(b, c, d) {
          a.call(this), this._onNext = b, this._onError = c, this._onCompleted = d;
        }
        return cb(b, a), b.prototype.next = function(a) {
          this._onNext(a);
        }, b.prototype.error = function(a) {
          this._onError(a);
        }, b.prototype.completed = function() {
          this._onCompleted();
        }, b;
      }(Mb),
      Ob = ca.Observable = function() {
        function a(a) {
          if (ca.config.longStackSupport && la) {
            try {
              throw new Error;
            } catch (b) {
              this.stack = b.stack.substring(b.stack.indexOf("\n") + 1);
            }
            var d = this;
            this._subscribe = function(b) {
              var e = b.onError.bind(b);
              return b.onError = function(a) {
                c(a, d), e(a);
              }, a.call(d, b);
            };
          } else
            this._subscribe = a;
        }
        return Hb = a.prototype, Hb.subscribe = Hb.forEach = function(a, b, c) {
          return this._subscribe("object" == typeof a ? a : Lb(a, b, c));
        }, Hb.subscribeOnNext = function(a, b) {
          return this._subscribe(Lb("undefined" != typeof b ? function(c) {
            a.call(b, c);
          } : a));
        }, Hb.subscribeOnError = function(a, b) {
          return this._subscribe(Lb(null, "undefined" != typeof b ? function(c) {
            a.call(b, c);
          } : a));
        }, Hb.subscribeOnCompleted = function(a, b) {
          return this._subscribe(Lb(null, null, "undefined" != typeof b ? function() {
            a.call(b);
          } : a));
        }, a;
      }(),
      Pb = ca.internals.ScheduledObserver = function(a) {
        function b(b, c) {
          a.call(this), this.scheduler = b, this.observer = c, this.isAcquired = !1, this.hasFaulted = !1, this.queue = [], this.disposable = new ob;
        }
        return cb(b, a), b.prototype.next = function(a) {
          var b = this;
          this.queue.push(function() {
            b.observer.onNext(a);
          });
        }, b.prototype.error = function(a) {
          var b = this;
          this.queue.push(function() {
            b.observer.onError(a);
          });
        }, b.prototype.completed = function() {
          var a = this;
          this.queue.push(function() {
            a.observer.onCompleted();
          });
        }, b.prototype.ensureActive = function() {
          var a = !1,
              b = this;
          !this.hasFaulted && this.queue.length > 0 && (a = !this.isAcquired, this.isAcquired = !0), a && this.disposable.setDisposable(this.scheduler.scheduleRecursive(function(a) {
            var c;
            if (!(b.queue.length > 0))
              return void(b.isAcquired = !1);
            c = b.queue.shift();
            try {
              c();
            } catch (d) {
              throw b.queue = [], b.hasFaulted = !0, d;
            }
            a();
          }));
        }, b.prototype.dispose = function() {
          a.prototype.dispose.call(this), this.disposable.dispose();
        }, b;
      }(Mb),
      Qb = ca.ObservableBase = function(a) {
        function b(a) {
          return a && ka(a.dispose) ? a : ka(a) ? jb(a) : kb;
        }
        function c(a, c) {
          var d = c[0],
              e = c[1],
              f = o(e.subscribeCore).call(e, d);
          return f !== ab || d.fail(ab.e) ? void d.setDisposable(b(f)) : p(ab.e);
        }
        function d(a) {
          var b = new Bc(a),
              d = [b, this];
          return wb.scheduleRequired() ? wb.scheduleWithState(d, c) : c(null, d), b;
        }
        function e() {
          a.call(this, d);
        }
        return cb(e, a), e.prototype.subscribeCore = va, e;
      }(Ob),
      Rb = function(a) {
        function b(b) {
          this.source = b, a.call(this);
        }
        return cb(b, a), b.prototype.subscribeCore = function(a) {
          return this.source.subscribe(new t(a));
        }, b;
      }(Qb);
  t.prototype.onNext = function(a) {
    this.isStopped || this.a.push(a);
  }, t.prototype.onError = function(a) {
    this.isStopped || (this.isStopped = !0, this.observer.onError(a));
  }, t.prototype.onCompleted = function() {
    this.isStopped || (this.isStopped = !0, this.observer.onNext(this.a), this.observer.onCompleted());
  }, t.prototype.dispose = function() {
    this.isStopped = !0;
  }, t.prototype.fail = function(a) {
    return this.isStopped ? !1 : (this.isStopped = !0, this.observer.onError(a), !0);
  }, Hb.toArray = function() {
    return new Rb(this);
  }, Ob.create = Ob.createWithDisposable = function(a, b) {
    return new Ac(a, b);
  };
  var Sb = Ob.defer = function(a) {
    return new Ac(function(b) {
      var c;
      try {
        c = a();
      } catch (d) {
        return gc(d).subscribe(b);
      }
      return ja(c) && (c = tc(c)), c.subscribe(b);
    });
  },
      Tb = function(a) {
        function b(b) {
          this.scheduler = b, a.call(this);
        }
        function c(a, b) {
          this.observer = a, this.parent = b;
        }
        function d(a, b) {
          b.onCompleted();
        }
        return cb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new c(a, this);
          return b.run();
        }, c.prototype.run = function() {
          return this.parent.scheduler.scheduleWithState(this.observer, d);
        }, b;
      }(Qb),
      Ub = Ob.empty = function(a) {
        return sb(a) || (a = vb), new Tb(a);
      },
      Vb = function(a) {
        function b(b, c, d) {
          this.iterable = b, this.mapper = c, this.scheduler = d, a.call(this);
        }
        return cb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new Wb(a, this);
          return b.run();
        }, b;
      }(Qb),
      Wb = function() {
        function a(a, b) {
          this.observer = a, this.parent = b;
        }
        return a.prototype.run = function() {
          function a(a, b) {
            try {
              var f = c.next();
            } catch (g) {
              return d.onError(g);
            }
            if (f.done)
              return d.onCompleted();
            var h = f.value;
            if (e)
              try {
                h = e(h, a);
              } catch (g) {
                return d.onError(g);
              }
            d.onNext(h), b(a + 1);
          }
          var b = Object(this.parent.iterable),
              c = z(b),
              d = this.observer,
              e = this.parent.mapper;
          return this.parent.scheduler.scheduleRecursiveWithState(0, a);
        }, a;
      }(),
      Xb = Math.pow(2, 53) - 1;
  u.prototype[xa] = function() {
    return new v(this._s);
  }, v.prototype[xa] = function() {
    return this;
  }, v.prototype.next = function() {
    return this._i < this._l ? {
      done: !1,
      value: this._s.charAt(this._i++)
    } : ya;
  }, w.prototype[xa] = function() {
    return new x(this._a);
  }, x.prototype[xa] = function() {
    return this;
  }, x.prototype.next = function() {
    return this._i < this._l ? {
      done: !1,
      value: this._a[this._i++]
    } : ya;
  };
  var Yb = Ob.from = function(a, b, c, d) {
    if (null == a)
      throw new Error("iterable cannot be null.");
    if (b && !ka(b))
      throw new Error("mapFn when provided must be a function");
    if (b)
      var e = Ca(b, c, 2);
    return sb(d) || (d = wb), new Vb(a, e, d);
  },
      Zb = function(a) {
        function b(b, c) {
          this.args = b, this.scheduler = c, a.call(this);
        }
        return cb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new C(a, this);
          return b.run();
        }, b;
      }(Qb);
  C.prototype.run = function() {
    function a(a, e) {
      d > a ? (b.onNext(c[a]), e(a + 1)) : b.onCompleted();
    }
    var b = this.observer,
        c = this.parent.args,
        d = c.length;
    return this.parent.scheduler.scheduleRecursiveWithState(0, a);
  };
  {
    var $b = Ob.fromArray = function(a, b) {
      return sb(b) || (b = wb), new Zb(a, b);
    },
        _b = function(a) {
          function b() {
            a.call(this);
          }
          return cb(b, a), b.prototype.subscribeCore = function() {
            return kb;
          }, b;
        }(Qb);
    Ob.never = function() {
      return new _b;
    };
  }
  Ob.of = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return new Zb(b, wb);
  }, Ob.ofWithScheduler = function(a) {
    for (var b = arguments.length,
        c = new Array(b - 1),
        d = 1; b > d; d++)
      c[d - 1] = arguments[d];
    return new Zb(c, a);
  };
  var ac = function(a) {
    function b(b, c) {
      this.obj = b, this.keys = Object.keys(b), this.scheduler = c, a.call(this);
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new E(a, this);
      return b.run();
    }, b;
  }(Qb);
  E.prototype.run = function() {
    function a(a, f) {
      if (e > a) {
        var g = d[a];
        b.onNext([g, c[g]]), f(a + 1);
      } else
        b.onCompleted();
    }
    var b = this.observer,
        c = this.parent.obj,
        d = this.parent.keys,
        e = d.length;
    return this.parent.scheduler.scheduleRecursiveWithState(0, a);
  }, Ob.pairs = function(a, b) {
    return b || (b = wb), new ac(a, b);
  };
  var bc = function(a) {
    function b(b, c, d) {
      this.start = b, this.count = c, this.scheduler = d, a.call(this);
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new cc(a, this);
      return b.run();
    }, b;
  }(Qb),
      cc = function() {
        function a(a, b) {
          this.observer = a, this.parent = b;
        }
        return a.prototype.run = function() {
          function a(a, e) {
            c > a ? (d.onNext(b + a), e(a + 1)) : d.onCompleted();
          }
          var b = this.parent.start,
              c = this.parent.count,
              d = this.observer;
          return this.parent.scheduler.scheduleRecursiveWithState(0, a);
        }, a;
      }();
  Ob.range = function(a, b, c) {
    return sb(c) || (c = wb), new bc(a, b, c);
  };
  var dc = function(a) {
    function b(b, c, d) {
      this.value = b, this.repeatCount = null == c ? -1 : c, this.scheduler = d, a.call(this);
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new F(a, this);
      return b.run();
    }, b;
  }(Qb);
  F.prototype.run = function() {
    function a(a, d) {
      return (-1 === a || a > 0) && (b.onNext(c), a > 0 && a--), 0 === a ? b.onCompleted() : void d(a);
    }
    var b = this.observer,
        c = this.parent.value;
    return this.parent.scheduler.scheduleRecursiveWithState(this.parent.repeatCount, a);
  }, Ob.repeat = function(a, b, c) {
    return sb(c) || (c = wb), new dc(a, b, c);
  };
  var ec = function(a) {
    function b(b, c) {
      this.value = b, this.scheduler = c, a.call(this);
    }
    function c(a, b) {
      this.observer = a, this.parent = b;
    }
    function d(a, b) {
      var c = b[0],
          d = b[1];
      d.onNext(c), d.onCompleted();
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new c(a, this);
      return b.run();
    }, c.prototype.run = function() {
      return this.parent.scheduler.scheduleWithState([this.parent.value, this.observer], d);
    }, b;
  }(Qb),
      fc = (Ob["return"] = Ob.just = Ob.returnValue = function(a, b) {
        return sb(b) || (b = vb), new ec(a, b);
      }, function(a) {
        function b(b, c) {
          this.error = b, this.scheduler = c, a.call(this);
        }
        function c(a, b) {
          this.observer = a, this.parent = b;
        }
        function d(a, b) {
          var c = b[0],
              d = b[1];
          d.onError(c);
        }
        return cb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new c(a, this);
          return b.run();
        }, c.prototype.run = function() {
          return this.parent.scheduler.scheduleWithState([this.parent.error, this.observer], d);
        }, b;
      }(Qb)),
      gc = Ob["throw"] = Ob.throwError = Ob.throwException = function(a, b) {
        return sb(b) || (b = vb), new fc(a, b);
      };
  Hb["catch"] = Hb.catchError = Hb.catchException = function(a) {
    return "function" == typeof a ? G(this, a) : hc([this, a]);
  };
  var hc = Ob.catchError = Ob["catch"] = Ob.catchException = function() {
    var a = [];
    if (Array.isArray(arguments[0]))
      a = arguments[0];
    else
      for (var b = 0,
          c = arguments.length; c > b; b++)
        a.push(arguments[b]);
    return Jb(a).catchError();
  };
  Hb.combineLatest = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return Array.isArray(b[0]) ? b[0].unshift(this) : b.unshift(this), ic.apply(this, b);
  };
  var ic = Ob.combineLatest = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = b.pop();
    return Array.isArray(b[0]) && (b = b[0]), new Ac(function(a) {
      function c(b) {
        if (h[b] = !0, i || (i = h.every(ea))) {
          try {
            var c = d.apply(null, k);
          } catch (e) {
            return a.onError(e);
          }
          a.onNext(c);
        } else
          j.filter(function(a, c) {
            return c !== b;
          }).every(ea) && a.onCompleted();
      }
      function e(b) {
        j[b] = !0, j.every(ea) && a.onCompleted();
      }
      for (var f = b.length,
          g = function() {
            return !1;
          },
          h = q(f, g),
          i = !1,
          j = q(f, g),
          k = new Array(f),
          l = new Array(f),
          m = 0; f > m; m++)
        !function(d) {
          var f = b[d],
              g = new nb;
          ja(f) && (f = tc(f)), g.setDisposable(f.subscribe(function(a) {
            k[d] = a, c(d);
          }, function(b) {
            a.onError(b);
          }, function() {
            e(d);
          })), l[d] = g;
        }(m);
      return new gb(l);
    }, this);
  };
  Hb.concat = function() {
    for (var a = [],
        b = 0,
        c = arguments.length; c > b; b++)
      a.push(arguments[b]);
    return a.unshift(this), jc.apply(null, a);
  };
  var jc = Ob.concat = function() {
    var a;
    if (Array.isArray(arguments[0]))
      a = arguments[0];
    else {
      a = new Array(arguments.length);
      for (var b = 0,
          c = arguments.length; c > b; b++)
        a[b] = arguments[b];
    }
    return Jb(a).concat();
  };
  Hb.concatAll = Hb.concatObservable = function() {
    return this.merge(1);
  };
  var kc = function(a) {
    function b(b, c) {
      this.source = b, this.maxConcurrent = c, a.call(this);
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new gb;
      return b.add(this.source.subscribe(new lc(a, this.maxConcurrent, b))), b;
    }, b;
  }(Qb),
      lc = function() {
        function a(a, b, c) {
          this.o = a, this.max = b, this.g = c, this.done = !1, this.q = [], this.activeCount = 0, this.isStopped = !1;
        }
        function b(a, b) {
          this.parent = a, this.sad = b, this.isStopped = !1;
        }
        return a.prototype.handleSubscribe = function(a) {
          var c = new nb;
          this.g.add(c), ja(a) && (a = tc(a)), c.setDisposable(a.subscribe(new b(this, c)));
        }, a.prototype.onNext = function(a) {
          this.isStopped || (this.activeCount < this.max ? (this.activeCount++, this.handleSubscribe(a)) : this.q.push(a));
        }, a.prototype.onError = function(a) {
          this.isStopped || (this.isStopped = !0, this.o.onError(a));
        }, a.prototype.onCompleted = function() {
          this.isStopped || (this.isStopped = !0, this.done = !0, 0 === this.activeCount && this.o.onCompleted());
        }, a.prototype.dispose = function() {
          this.isStopped = !0;
        }, a.prototype.fail = function(a) {
          return this.isStopped ? !1 : (this.isStopped = !0, this.o.onError(a), !0);
        }, b.prototype.onNext = function(a) {
          this.isStopped || this.parent.o.onNext(a);
        }, b.prototype.onError = function(a) {
          this.isStopped || (this.isStopped = !0, this.parent.o.onError(a));
        }, b.prototype.onCompleted = function() {
          if (!this.isStopped) {
            this.isStopped = !0;
            var a = this.parent;
            a.g.remove(this.sad), a.q.length > 0 ? a.handleSubscribe(a.q.shift()) : (a.activeCount--, a.done && 0 === a.activeCount && a.o.onCompleted());
          }
        }, b.prototype.dispose = function() {
          this.isStopped = !0;
        }, b.prototype.fail = function(a) {
          return this.isStopped ? !1 : (this.isStopped = !0, this.parent.o.onError(a), !0);
        }, a;
      }();
  Hb.merge = function(a) {
    return "number" != typeof a ? mc(this, a) : new kc(this, a);
  };
  var mc = Ob.merge = function() {
    var a,
        b,
        c = [],
        d = arguments.length;
    if (arguments[0])
      if (sb(arguments[0]))
        for (a = arguments[0], b = 1; d > b; b++)
          c.push(arguments[b]);
      else
        for (a = vb, b = 0; d > b; b++)
          c.push(arguments[b]);
    else
      for (a = vb, b = 1; d > b; b++)
        c.push(arguments[b]);
    return Array.isArray(c[0]) && (c = c[0]), D(a, c).mergeAll();
  },
      nc = ca.CompositeError = function(a) {
        this.name = "NotImplementedError", this.innerErrors = a, this.message = "This contains multiple errors. Check the innerErrors", Error.call(this);
      };
  nc.prototype = Error.prototype, Ob.mergeDelayError = function() {
    var a;
    if (Array.isArray(arguments[0]))
      a = arguments[0];
    else {
      var b = arguments.length;
      a = new Array(b);
      for (var c = 0; b > c; c++)
        a[c] = arguments[c];
    }
    var d = D(null, a);
    return new Ac(function(a) {
      function b() {
        0 === g.length ? a.onCompleted() : a.onError(1 === g.length ? g[0] : new nc(g));
      }
      var c = new gb,
          e = new nb,
          f = !1,
          g = [];
      return c.add(e), e.setDisposable(d.subscribe(function(d) {
        var e = new nb;
        c.add(e), ja(d) && (d = tc(d)), e.setDisposable(d.subscribe(function(b) {
          a.onNext(b);
        }, function(a) {
          g.push(a), c.remove(e), f && 1 === c.length && b();
        }, function() {
          c.remove(e), f && 1 === c.length && b();
        }));
      }, function(a) {
        g.push(a), f = !0, 1 === c.length && b();
      }, function() {
        f = !0, 1 === c.length && b();
      })), c;
    });
  };
  var oc = function(a) {
    function b(b) {
      this.source = b, a.call(this);
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new gb,
          c = new nb;
      return b.add(c), c.setDisposable(this.source.subscribe(new pc(a, b))), b;
    }, b;
  }(Qb),
      pc = function() {
        function a(a, b) {
          this.o = a, this.g = b, this.isStopped = !1, this.done = !1;
        }
        function b(a, b, c) {
          this.parent = a, this.g = b, this.sad = c, this.isStopped = !1;
        }
        return a.prototype.onNext = function(a) {
          if (!this.isStopped) {
            var c = new nb;
            this.g.add(c), ja(a) && (a = tc(a)), c.setDisposable(a.subscribe(new b(this, this.g, c)));
          }
        }, a.prototype.onError = function(a) {
          this.isStopped || (this.isStopped = !0, this.o.onError(a));
        }, a.prototype.onCompleted = function() {
          this.isStopped || (this.isStopped = !0, this.done = !0, 1 === this.g.length && this.o.onCompleted());
        }, a.prototype.dispose = function() {
          this.isStopped = !0;
        }, a.prototype.fail = function(a) {
          return this.isStopped ? !1 : (this.isStopped = !0, this.o.onError(a), !0);
        }, b.prototype.onNext = function(a) {
          this.isStopped || this.parent.o.onNext(a);
        }, b.prototype.onError = function(a) {
          this.isStopped || (this.isStopped = !0, this.parent.o.onError(a));
        }, b.prototype.onCompleted = function() {
          if (!this.isStopped) {
            var a = this.parent;
            this.isStopped = !0, a.g.remove(this.sad), a.done && 1 === a.g.length && a.o.onCompleted();
          }
        }, b.prototype.dispose = function() {
          this.isStopped = !0;
        }, b.prototype.fail = function(a) {
          return this.isStopped ? !1 : (this.isStopped = !0, this.parent.o.onError(a), !0);
        }, a;
      }();
  Hb.mergeAll = Hb.mergeObservable = function() {
    return new oc(this);
  }, Hb.skipUntil = function(a) {
    var b = this;
    return new Ac(function(c) {
      var d = !1,
          e = new gb(b.subscribe(function(a) {
            d && c.onNext(a);
          }, function(a) {
            c.onError(a);
          }, function() {
            d && c.onCompleted();
          }));
      ja(a) && (a = tc(a));
      var f = new nb;
      return e.add(f), f.setDisposable(a.subscribe(function() {
        d = !0, f.dispose();
      }, function(a) {
        c.onError(a);
      }, function() {
        f.dispose();
      })), e;
    }, b);
  }, Hb["switch"] = Hb.switchLatest = function() {
    var a = this;
    return new Ac(function(b) {
      var c = !1,
          d = new ob,
          e = !1,
          f = 0,
          g = a.subscribe(function(a) {
            var g = new nb,
                h = ++f;
            c = !0, d.setDisposable(g), ja(a) && (a = tc(a)), g.setDisposable(a.subscribe(function(a) {
              f === h && b.onNext(a);
            }, function(a) {
              f === h && b.onError(a);
            }, function() {
              f === h && (c = !1, e && b.onCompleted());
            }));
          }, function(a) {
            b.onError(a);
          }, function() {
            e = !0, !c && b.onCompleted();
          });
      return new gb(g, d);
    }, a);
  }, Hb.takeUntil = function(a) {
    var b = this;
    return new Ac(function(c) {
      return ja(a) && (a = tc(a)), new gb(b.subscribe(c), a.subscribe(function() {
        c.onCompleted();
      }, function(a) {
        c.onError(a);
      }, da));
    }, b);
  }, Hb.withLatestFrom = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = b.pop(),
        e = this;
    if ("undefined" == typeof e)
      throw new Error("Source observable not found for withLatestFrom().");
    if ("function" != typeof d)
      throw new Error("withLatestFrom() expects a resultSelector function.");
    return Array.isArray(b[0]) && (b = b[0]), new Ac(function(a) {
      for (var c = function() {
        return !1;
      },
          f = b.length,
          g = q(f, c),
          h = !1,
          i = new Array(f),
          j = new Array(f + 1),
          k = 0; f > k; k++)
        !function(c) {
          var d = b[c],
              e = new nb;
          ja(d) && (d = tc(d)), e.setDisposable(d.subscribe(function(a) {
            i[c] = a, g[c] = !0, h = g.every(ea);
          }, a.onError.bind(a), function() {})), j[c] = e;
        }(k);
      var l = new nb;
      return l.setDisposable(e.subscribe(function(b) {
        var c,
            e = [b].concat(i);
        if (h) {
          try {
            c = d.apply(null, e);
          } catch (f) {
            return void a.onError(f);
          }
          a.onNext(c);
        }
      }, a.onError.bind(a), function() {
        a.onCompleted();
      })), j[f] = l, new gb(j);
    }, this);
  }, Hb.zip = function() {
    if (Array.isArray(arguments[0]))
      return H.apply(this, arguments);
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = this,
        e = b.pop();
    return b.unshift(d), new Ac(function(a) {
      function c(b) {
        var c,
            f;
        if (h.every(function(a) {
          return a.length > 0;
        })) {
          try {
            f = h.map(function(a) {
              return a.shift();
            }), c = e.apply(d, f);
          } catch (g) {
            return void a.onError(g);
          }
          a.onNext(c);
        } else
          i.filter(function(a, c) {
            return c !== b;
          }).every(ea) && a.onCompleted();
      }
      function f(b) {
        i[b] = !0, i.every(function(a) {
          return a;
        }) && a.onCompleted();
      }
      for (var g = b.length,
          h = q(g, J),
          i = q(g, I),
          j = new Array(g),
          k = 0; g > k; k++)
        !function(d) {
          var e = b[d],
              g = new nb;
          ja(e) && (e = tc(e)), g.setDisposable(e.subscribe(function(a) {
            h[d].push(a), c(d);
          }, function(b) {
            a.onError(b);
          }, function() {
            f(d);
          })), j[d] = g;
        }(k);
      return new gb(j);
    }, d);
  }, Ob.zip = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = b.shift();
    return d.zip.apply(d, b);
  }, Ob.zipArray = function() {
    var a;
    if (Array.isArray(arguments[0]))
      a = arguments[0];
    else {
      var b = arguments.length;
      a = new Array(b);
      for (var c = 0; b > c; c++)
        a[c] = arguments[c];
    }
    return new Ac(function(b) {
      function c(a) {
        if (f.every(function(a) {
          return a.length > 0;
        })) {
          var c = f.map(function(a) {
            return a.shift();
          });
          b.onNext(c);
        } else if (g.filter(function(b, c) {
          return c !== a;
        }).every(ea))
          return void b.onCompleted();
      }
      function d(a) {
        return g[a] = !0, g.every(ea) ? void b.onCompleted() : void 0;
      }
      for (var e = a.length,
          f = q(e, function() {
            return [];
          }),
          g = q(e, function() {
            return !1;
          }),
          h = new Array(e),
          i = 0; e > i; i++)
        !function(e) {
          h[e] = new nb, h[e].setDisposable(a[e].subscribe(function(a) {
            f[e].push(a), c(e);
          }, function(a) {
            b.onError(a);
          }, function() {
            d(e);
          }));
        }(i);
      return new gb(h);
    });
  }, Hb.asObservable = function() {
    var a = this;
    return new Ac(function(b) {
      return a.subscribe(b);
    }, this);
  }, Hb.dematerialize = function() {
    var a = this;
    return new Ac(function(b) {
      return a.subscribe(function(a) {
        return a.accept(b);
      }, function(a) {
        b.onError(a);
      }, function() {
        b.onCompleted();
      });
    }, this);
  }, Hb.distinctUntilChanged = function(a, b) {
    var c = this;
    return b || (b = ga), new Ac(function(d) {
      var e,
          f = !1;
      return c.subscribe(function(c) {
        var g = c;
        if (a)
          try {
            g = a(c);
          } catch (h) {
            return void d.onError(h);
          }
        if (f)
          try {
            var i = b(e, g);
          } catch (h) {
            return void d.onError(h);
          }
        f && i || (f = !0, e = g, d.onNext(c));
      }, function(a) {
        d.onError(a);
      }, function() {
        d.onCompleted();
      });
    }, this);
  }, Hb["do"] = Hb.tap = Hb.doAction = function(a, b, c) {
    var d = this;
    return new Ac(function(e) {
      var f = !a || ka(a) ? Lb(a || da, b || da, c || da) : a;
      return d.subscribe(function(a) {
        try {
          f.onNext(a);
        } catch (b) {
          e.onError(b);
        }
        e.onNext(a);
      }, function(a) {
        try {
          f.onError(a);
        } catch (b) {
          e.onError(b);
        }
        e.onError(a);
      }, function() {
        try {
          f.onCompleted();
        } catch (a) {
          e.onError(a);
        }
        e.onCompleted();
      });
    }, this);
  }, Hb.doOnNext = Hb.tapOnNext = function(a, b) {
    return this.tap("undefined" != typeof b ? function(c) {
      a.call(b, c);
    } : a);
  }, Hb.doOnError = Hb.tapOnError = function(a, b) {
    return this.tap(da, "undefined" != typeof b ? function(c) {
      a.call(b, c);
    } : a);
  }, Hb.doOnCompleted = Hb.tapOnCompleted = function(a, b) {
    return this.tap(da, null, "undefined" != typeof b ? function() {
      a.call(b);
    } : a);
  }, Hb["finally"] = Hb.ensure = function(a) {
    var b = this;
    return new Ac(function(c) {
      var d;
      try {
        d = b.subscribe(c);
      } catch (e) {
        throw a(), e;
      }
      return jb(function() {
        try {
          d.dispose();
        } catch (b) {
          throw b;
        } finally {
          a();
        }
      });
    }, this);
  }, Hb.finallyAction = function(a) {
    return this.ensure(a);
  }, Hb.ignoreElements = function() {
    var a = this;
    return new Ac(function(b) {
      return a.subscribe(da, function(a) {
        b.onError(a);
      }, function() {
        b.onCompleted();
      });
    }, a);
  }, Hb.materialize = function() {
    var a = this;
    return new Ac(function(b) {
      return a.subscribe(function(a) {
        b.onNext(Cb(a));
      }, function(a) {
        b.onNext(Db(a)), b.onCompleted();
      }, function() {
        b.onNext(Eb()), b.onCompleted();
      });
    }, a);
  }, Hb.repeat = function(a) {
    return Ib(this, a).concat();
  }, Hb.retry = function(a) {
    return Ib(this, a).catchError();
  }, Hb.retryWhen = function(a) {
    return Ib(this).catchErrorWhen(a);
  }, Hb.scan = function() {
    var a,
        b,
        c = !1,
        d = this;
    return 2 === arguments.length ? (c = !0, a = arguments[0], b = arguments[1]) : b = arguments[0], new Ac(function(e) {
      var f,
          g,
          h;
      return d.subscribe(function(d) {
        !h && (h = !0);
        try {
          f ? g = b(g, d) : (g = c ? b(a, d) : d, f = !0);
        } catch (i) {
          return void e.onError(i);
        }
        e.onNext(g);
      }, function(a) {
        e.onError(a);
      }, function() {
        !h && c && e.onNext(a), e.onCompleted();
      });
    }, d);
  }, Hb.skipLast = function(a) {
    if (0 > a)
      throw new sa;
    var b = this;
    return new Ac(function(c) {
      var d = [];
      return b.subscribe(function(b) {
        d.push(b), d.length > a && c.onNext(d.shift());
      }, function(a) {
        c.onError(a);
      }, function() {
        c.onCompleted();
      });
    }, b);
  }, Hb.startWith = function() {
    var a,
        b = 0;
    arguments.length && sb(arguments[0]) ? (a = arguments[0], b = 1) : a = vb;
    for (var c = [],
        d = b,
        e = arguments.length; e > d; d++)
      c.push(arguments[d]);
    return Jb([$b(c, a), this]).concat();
  }, Hb.takeLast = function(a) {
    if (0 > a)
      throw new sa;
    var b = this;
    return new Ac(function(c) {
      var d = [];
      return b.subscribe(function(b) {
        d.push(b), d.length > a && d.shift();
      }, function(a) {
        c.onError(a);
      }, function() {
        for (; d.length > 0; )
          c.onNext(d.shift());
        c.onCompleted();
      });
    }, b);
  }, Hb.selectConcat = Hb.concatMap = function(a, b, c) {
    return ka(a) && ka(b) ? this.concatMap(function(c, d) {
      var e = a(c, d);
      return ja(e) && (e = tc(e)), (Aa(e) || za(e)) && (e = Yb(e)), e.map(function(a, e) {
        return b(c, a, d, e);
      });
    }) : ka(a) ? K(this, a, c) : K(this, function() {
      return a;
    });
  };
  var qc = function(a) {
    function b(b, c, d) {
      this.source = b, this.selector = Ca(c, d, 3), a.call(this);
    }
    return cb(b, a), b.prototype.internalMap = function(a, c) {
      var d = this;
      return new b(this.source, function(b, c, e) {
        return a.call(this, d.selector(b, c, e), c, e);
      }, c);
    }, b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new L(a, this.selector, this));
    }, b;
  }(Qb);
  L.prototype.onNext = function(a) {
    if (!this.isStopped) {
      var b = o(this.selector).call(this, a, this.i++, this.source);
      return b === ab ? this.observer.onError(b.e) : void this.observer.onNext(b);
    }
  }, L.prototype.onError = function(a) {
    this.isStopped || (this.isStopped = !0, this.observer.onError(a));
  }, L.prototype.onCompleted = function() {
    this.isStopped || (this.isStopped = !0, this.observer.onCompleted());
  }, L.prototype.dispose = function() {
    this.isStopped = !0;
  }, L.prototype.fail = function(a) {
    return this.isStopped ? !1 : (this.isStopped = !0, this.observer.onError(a), !0);
  }, Hb.map = Hb.select = function(a, b) {
    var c = "function" == typeof a ? a : function() {
      return a;
    };
    return this instanceof qc ? this.internalMap(c, b) : new qc(this, c, b);
  }, Hb.pluck = function() {
    var b = arguments,
        c = arguments.length;
    if (0 === c)
      throw new Error("List of properties cannot be empty.");
    return this.map(function(d) {
      for (var e = d,
          f = 0; c > f; f++) {
        var g = e[b[f]];
        if ("undefined" == typeof g)
          return a;
        e = g;
      }
      return e;
    });
  }, Hb.selectMany = Hb.flatMap = function(a, b, c) {
    return ka(a) && ka(b) ? this.flatMap(function(c, d) {
      var e = a(c, d);
      return ja(e) && (e = tc(e)), (Aa(e) || za(e)) && (e = Yb(e)), e.map(function(a, e) {
        return b(c, a, d, e);
      });
    }, c) : ka(a) ? M(this, a, c) : M(this, function() {
      return a;
    });
  }, Hb.selectSwitch = Hb.flatMapLatest = Hb.switchMap = function(a, b) {
    return this.select(a, b).switchLatest();
  }, Hb.skip = function(a) {
    if (0 > a)
      throw new sa;
    var b = this;
    return new Ac(function(c) {
      var d = a;
      return b.subscribe(function(a) {
        0 >= d ? c.onNext(a) : d--;
      }, function(a) {
        c.onError(a);
      }, function() {
        c.onCompleted();
      });
    }, b);
  }, Hb.skipWhile = function(a, b) {
    var c = this,
        d = Ca(a, b, 3);
    return new Ac(function(a) {
      var b = 0,
          e = !1;
      return c.subscribe(function(f) {
        if (!e)
          try {
            e = !d(f, b++, c);
          } catch (g) {
            return void a.onError(g);
          }
        e && a.onNext(f);
      }, function(b) {
        a.onError(b);
      }, function() {
        a.onCompleted();
      });
    }, c);
  }, Hb.take = function(a, b) {
    if (0 > a)
      throw new sa;
    if (0 === a)
      return Ub(b);
    var c = this;
    return new Ac(function(b) {
      var d = a;
      return c.subscribe(function(a) {
        d-- > 0 && (b.onNext(a), 0 === d && b.onCompleted());
      }, function(a) {
        b.onError(a);
      }, function() {
        b.onCompleted();
      });
    }, c);
  }, Hb.takeWhile = function(a, b) {
    var c = this,
        d = Ca(a, b, 3);
    return new Ac(function(a) {
      var b = 0,
          e = !0;
      return c.subscribe(function(f) {
        if (e) {
          try {
            e = d(f, b++, c);
          } catch (g) {
            return void a.onError(g);
          }
          e ? a.onNext(f) : a.onCompleted();
        }
      }, function(b) {
        a.onError(b);
      }, function() {
        a.onCompleted();
      });
    }, c);
  };
  var rc = function(a) {
    function b(b, c, d) {
      this.source = b, this.predicate = Ca(c, d, 3), a.call(this);
    }
    return cb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new N(a, this.predicate, this));
    }, b.prototype.internalFilter = function(a, c) {
      var d = this;
      return new b(this.source, function(b, c, e) {
        return d.predicate(b, c, e) && a.call(this, b, c, e);
      }, c);
    }, b;
  }(Qb);
  N.prototype.onNext = function(a) {
    if (!this.isStopped) {
      var b = o(this.predicate).call(this, a, this.i++, this.source);
      return b === ab ? this.observer.onError(b.e) : void(b && this.observer.onNext(a));
    }
  }, N.prototype.onError = function(a) {
    this.isStopped || (this.isStopped = !0, this.observer.onError(a));
  }, N.prototype.onCompleted = function() {
    this.isStopped || (this.isStopped = !0, this.observer.onCompleted());
  }, N.prototype.dispose = function() {
    this.isStopped = !0;
  }, N.prototype.fail = function(a) {
    return this.isStopped ? !1 : (this.isStopped = !0, this.observer.onError(a), !0);
  }, Hb.filter = Hb.where = function(a, b) {
    return this instanceof rc ? this.internalFilter(a, b) : new rc(this, a, b);
  }, Ob.fromCallback = function(a, b, c) {
    return function() {
      for (var d = arguments.length,
          e = new Array(d),
          f = 0; d > f; f++)
        e[f] = arguments[f];
      return new Ac(function(d) {
        function f() {
          for (var a = arguments.length,
              e = new Array(a),
              f = 0; a > f; f++)
            e[f] = arguments[f];
          if (c) {
            try {
              e = c.apply(b, e);
            } catch (g) {
              return d.onError(g);
            }
            d.onNext(e);
          } else
            e.length <= 1 ? d.onNext.apply(d, e) : d.onNext(e);
          d.onCompleted();
        }
        e.push(f), a.apply(b, e);
      }).publishLast().refCount();
    };
  }, Ob.fromNodeCallback = function(a, b, c) {
    return function() {
      for (var d = arguments.length,
          e = new Array(d),
          f = 0; d > f; f++)
        e[f] = arguments[f];
      return new Ac(function(d) {
        function f(a) {
          if (a)
            return void d.onError(a);
          for (var e = arguments.length,
              f = [],
              g = 1; e > g; g++)
            f[g - 1] = arguments[g];
          if (c) {
            try {
              f = c.apply(b, f);
            } catch (h) {
              return d.onError(h);
            }
            d.onNext(f);
          } else
            f.length <= 1 ? d.onNext.apply(d, f) : d.onNext(f);
          d.onCompleted();
        }
        e.push(f), a.apply(b, e);
      }).publishLast().refCount();
    };
  }, ca.config.useNativeEvents = !1, Ob.fromEvent = function(a, b, c) {
    return a.addListener ? sc(function(c) {
      a.addListener(b, c);
    }, function(c) {
      a.removeListener(b, c);
    }, c) : ca.config.useNativeEvents || "function" != typeof a.on || "function" != typeof a.off ? new Ac(function(d) {
      return P(a, b, function(a) {
        var b = a;
        if (c)
          try {
            b = c(arguments);
          } catch (e) {
            return d.onError(e);
          }
        d.onNext(b);
      });
    }).publish().refCount() : sc(function(c) {
      a.on(b, c);
    }, function(c) {
      a.off(b, c);
    }, c);
  };
  var sc = Ob.fromEventPattern = function(a, b, c) {
    return new Ac(function(d) {
      function e(a) {
        var b = a;
        if (c)
          try {
            b = c(arguments);
          } catch (e) {
            return d.onError(e);
          }
        d.onNext(b);
      }
      var f = a(e);
      return jb(function() {
        b && b(e, f);
      });
    }).publish().refCount();
  },
      tc = Ob.fromPromise = function(a) {
        return Sb(function() {
          var b = new ca.AsyncSubject;
          return a.then(function(a) {
            b.onNext(a), b.onCompleted();
          }, b.onError.bind(b)), b;
        });
      };
  Hb.toPromise = function(a) {
    if (a || (a = ca.config.Promise), !a)
      throw new ta("Promise type not provided nor in Rx.config.Promise");
    var b = this;
    return new a(function(a, c) {
      var d,
          e = !1;
      b.subscribe(function(a) {
        d = a, e = !0;
      }, c, function() {
        e && a(d);
      });
    });
  }, Ob.startAsync = function(a) {
    var b;
    try {
      b = a();
    } catch (c) {
      return gc(c);
    }
    return tc(b);
  }, Hb.multicast = function(a, b) {
    var c = this;
    return "function" == typeof a ? new Ac(function(d) {
      var e = c.multicast(a());
      return new gb(b(e).subscribe(d), e.connect());
    }, c) : new uc(c, a);
  }, Hb.publish = function(a) {
    return a && ka(a) ? this.multicast(function() {
      return new Dc;
    }, a) : this.multicast(new Dc);
  }, Hb.share = function() {
    return this.publish().refCount();
  }, Hb.publishLast = function(a) {
    return a && ka(a) ? this.multicast(function() {
      return new Ec;
    }, a) : this.multicast(new Ec);
  }, Hb.publishValue = function(a, b) {
    return 2 === arguments.length ? this.multicast(function() {
      return new Gc(b);
    }, a) : this.multicast(new Gc(a));
  }, Hb.shareValue = function(a) {
    return this.publishValue(a).refCount();
  }, Hb.replay = function(a, b, c, d) {
    return a && ka(a) ? this.multicast(function() {
      return new Hc(b, c, d);
    }, a) : this.multicast(new Hc(b, c, d));
  }, Hb.shareReplay = function(a, b, c) {
    return this.replay(null, a, b, c).refCount();
  };
  {
    var uc = ca.ConnectableObservable = function(a) {
      function b(b, c) {
        var d,
            e = !1,
            f = b.asObservable();
        this.connect = function() {
          return e || (e = !0, d = new gb(f.subscribe(c), jb(function() {
            e = !1;
          }))), d;
        }, a.call(this, function(a) {
          return c.subscribe(a);
        });
      }
      return cb(b, a), b.prototype.refCount = function() {
        var a,
            b = 0,
            c = this;
        return new Ac(function(d) {
          var e = 1 === ++b,
              f = c.subscribe(d);
          return e && (a = c.connect()), function() {
            f.dispose(), 0 === --b && a.dispose();
          };
        });
      }, b;
    }(Ob),
        vc = Ob.interval = function(a, b) {
          return T(a, a, sb(b) ? b : Ab);
        };
    Ob.timer = function(b, c, d) {
      var e;
      return sb(d) || (d = Ab), c !== a && "number" == typeof c ? e = c : sb(c) && (d = c), b instanceof Date && e === a ? Q(b.getTime(), d) : b instanceof Date && e !== a ? (e = c, R(b.getTime(), e, d)) : e === a ? S(b, d) : T(b, e, d);
    };
  }
  Hb.delay = function(a, b) {
    return sb(b) || (b = Ab), a instanceof Date ? V(this, a.getTime(), b) : U(this, a, b);
  }, Hb.debounce = Hb.throttleWithTimeout = function(a, b) {
    sb(b) || (b = Ab);
    var c = this;
    return new Ac(function(d) {
      var e,
          f = new ob,
          g = !1,
          h = 0,
          i = c.subscribe(function(c) {
            g = !0, e = c, h++;
            var i = h,
                j = new nb;
            f.setDisposable(j), j.setDisposable(b.scheduleWithRelative(a, function() {
              g && h === i && d.onNext(e), g = !1;
            }));
          }, function(a) {
            f.dispose(), d.onError(a), g = !1, h++;
          }, function() {
            f.dispose(), g && d.onNext(e), d.onCompleted(), g = !1, h++;
          });
      return new gb(i, f);
    }, this);
  }, Hb.throttle = function(a, b) {
    return this.debounce(a, b);
  }, Hb.timestamp = function(a) {
    return sb(a) || (a = Ab), this.map(function(b) {
      return {
        value: b,
        timestamp: a.now()
      };
    });
  }, Hb.sample = Hb.throttleLatest = function(a, b) {
    return sb(b) || (b = Ab), "number" == typeof a ? W(this, vc(a, b)) : W(this, a);
  }, Hb.timeout = function(a, b, c) {
    (null == b || "string" == typeof b) && (b = gc(new Error(b || "Timeout"))), sb(c) || (c = Ab);
    var d = this,
        e = a instanceof Date ? "scheduleWithAbsolute" : "scheduleWithRelative";
    return new Ac(function(f) {
      function g() {
        var d = h;
        l.setDisposable(c[e](a, function() {
          h === d && (ja(b) && (b = tc(b)), j.setDisposable(b.subscribe(f)));
        }));
      }
      var h = 0,
          i = new nb,
          j = new ob,
          k = !1,
          l = new ob;
      return j.setDisposable(i), g(), i.setDisposable(d.subscribe(function(a) {
        k || (h++, f.onNext(a), g());
      }, function(a) {
        k || (h++, f.onError(a));
      }, function() {
        k || (h++, f.onCompleted());
      })), new gb(j, l);
    }, d);
  }, Hb.throttleFirst = function(a, b) {
    sb(b) || (b = Ab);
    var c = +a || 0;
    if (0 >= c)
      throw new RangeError("windowDuration cannot be less or equal zero.");
    var d = this;
    return new Ac(function(a) {
      var e = 0;
      return d.subscribe(function(d) {
        var f = b.now();
        (0 === e || f - e >= c) && (e = f, a.onNext(d));
      }, function(b) {
        a.onError(b);
      }, function() {
        a.onCompleted();
      });
    }, d);
  };
  var wc = function(a) {
    function b(a) {
      var b = this.source.publish(),
          c = b.subscribe(a),
          d = kb,
          e = this.pauser.distinctUntilChanged().subscribe(function(a) {
            a ? d = b.connect() : (d.dispose(), d = kb);
          });
      return new gb(c, d, e);
    }
    function c(c, d) {
      this.source = c, this.controller = new Dc, this.pauser = d && d.subscribe ? this.controller.merge(d) : this.controller, a.call(this, b, c);
    }
    return cb(c, a), c.prototype.pause = function() {
      this.controller.onNext(!1);
    }, c.prototype.resume = function() {
      this.controller.onNext(!0);
    }, c;
  }(Ob);
  Hb.pausable = function(a) {
    return new wc(this, a);
  };
  var xc = function(b) {
    function c(b) {
      var c,
          d = [],
          e = X(this.source, this.pauser.distinctUntilChanged().startWith(!1), function(a, b) {
            return {
              data: a,
              shouldFire: b
            };
          }).subscribe(function(e) {
            if (c !== a && e.shouldFire != c) {
              if (c = e.shouldFire, e.shouldFire)
                for (; d.length > 0; )
                  b.onNext(d.shift());
            } else
              c = e.shouldFire, e.shouldFire ? b.onNext(e.data) : d.push(e.data);
          }, function(a) {
            for (; d.length > 0; )
              b.onNext(d.shift());
            b.onError(a);
          }, function() {
            for (; d.length > 0; )
              b.onNext(d.shift());
            b.onCompleted();
          });
      return e;
    }
    function d(a, d) {
      this.source = a, this.controller = new Dc, this.pauser = d && d.subscribe ? this.controller.merge(d) : this.controller, b.call(this, c, a);
    }
    return cb(d, b), d.prototype.pause = function() {
      this.controller.onNext(!1);
    }, d.prototype.resume = function() {
      this.controller.onNext(!0);
    }, d;
  }(Ob);
  Hb.pausableBuffered = function(a) {
    return new xc(this, a);
  };
  var yc = function(a) {
    function b(a) {
      return this.source.subscribe(a);
    }
    function c(c, d) {
      a.call(this, b, c), this.subject = new zc(d), this.source = c.multicast(this.subject).refCount();
    }
    return cb(c, a), c.prototype.request = function(a) {
      return null == a && (a = -1), this.subject.request(a);
    }, c;
  }(Ob),
      zc = function(a) {
        function b(a) {
          return this.subject.subscribe(a);
        }
        function c(c) {
          null == c && (c = !0), a.call(this, b), this.subject = new Dc, this.enableQueue = c, this.queue = c ? [] : null, this.requestedCount = 0, this.requestedDisposable = kb, this.error = null, this.hasFailed = !1, this.hasCompleted = !1;
        }
        return cb(c, a), db(c.prototype, Kb, {
          onCompleted: function() {
            this.hasCompleted = !0, this.enableQueue && 0 !== this.queue.length ? this.queue.push(ca.Notification.createOnCompleted()) : this.subject.onCompleted();
          },
          onError: function(a) {
            this.hasFailed = !0, this.error = a, this.enableQueue && 0 !== this.queue.length ? this.queue.push(ca.Notification.createOnError(a)) : this.subject.onError(a);
          },
          onNext: function(a) {
            var b = !1;
            0 === this.requestedCount ? this.enableQueue && this.queue.push(ca.Notification.createOnNext(a)) : (-1 !== this.requestedCount && 0 === this.requestedCount-- && this.disposeCurrentRequest(), b = !0), b && this.subject.onNext(a);
          },
          _processRequest: function(a) {
            if (this.enableQueue) {
              for (; this.queue.length >= a && a > 0 || this.queue.length > 0 && "N" !== this.queue[0].kind; ) {
                var b = this.queue.shift();
                b.accept(this.subject), "N" === b.kind ? a-- : (this.disposeCurrentRequest(), this.queue = []);
              }
              return {
                numberOfItems: a,
                returnValue: 0 !== this.queue.length
              };
            }
            return {
              numberOfItems: a,
              returnValue: !1
            };
          },
          request: function(a) {
            this.disposeCurrentRequest();
            var b = this,
                c = this._processRequest(a),
                a = c.numberOfItems;
            return c.returnValue ? kb : (this.requestedCount = a, this.requestedDisposable = jb(function() {
              b.requestedCount = 0;
            }), this.requestedDisposable);
          },
          disposeCurrentRequest: function() {
            this.requestedDisposable.dispose(), this.requestedDisposable = kb;
          }
        }), c;
      }(Ob);
  Hb.controlled = function(a) {
    return null == a && (a = !0), new yc(this, a);
  }, Hb.pipe = function(a) {
    function b() {
      c.resume();
    }
    var c = this.pausableBuffered();
    return a.addListener("drain", b), c.subscribe(function(b) {
      !a.write(String(b)) && c.pause();
    }, function(b) {
      a.emit("error", b);
    }, function() {
      !a._isStdio && a.end(), a.removeListener("drain", b);
    }), c.resume(), a;
  }, Hb.transduce = function(a) {
    function b(a) {
      return {
        "@@transducer/init": function() {
          return a;
        },
        "@@transducer/step": function(a, b) {
          return a.onNext(b);
        },
        "@@transducer/result": function(a) {
          return a.onCompleted();
        }
      };
    }
    var c = this;
    return new Ac(function(d) {
      var e = a(b(d));
      return c.subscribe(function(a) {
        try {
          e["@@transducer/step"](d, a);
        } catch (b) {
          d.onError(b);
        }
      }, function(a) {
        d.onError(a);
      }, function() {
        e["@@transducer/result"](d);
      });
    }, c);
  };
  var Ac = ca.AnonymousObservable = function(a) {
    function b(a) {
      return a && ka(a.dispose) ? a : ka(a) ? jb(a) : kb;
    }
    function c(a, c) {
      var d = c[0],
          e = c[1],
          f = o(e)(d);
      return f !== ab || d.fail(ab.e) ? void d.setDisposable(b(f)) : p(ab.e);
    }
    function d(b, d) {
      function e(a) {
        var d = new Bc(a),
            e = [d, b];
        return wb.scheduleRequired() ? wb.scheduleWithState(e, c) : c(null, e), d;
      }
      this.source = d, a.call(this, e);
    }
    return cb(d, a), d;
  }(Ob),
      Bc = function(a) {
        function b(b) {
          a.call(this), this.observer = b, this.m = new nb;
        }
        cb(b, a);
        var c = b.prototype;
        return c.next = function(a) {
          var b = o(this.observer.onNext).call(this.observer, a);
          b === ab && (this.dispose(), p(b.e));
        }, c.error = function(a) {
          var b = o(this.observer.onError).call(this.observer, a);
          this.dispose(), b === ab && p(b.e);
        }, c.completed = function() {
          var a = o(this.observer.onCompleted).call(this.observer);
          this.dispose(), a === ab && p(a.e);
        }, c.setDisposable = function(a) {
          this.m.setDisposable(a);
        }, c.getDisposable = function() {
          return this.m.getDisposable();
        }, c.dispose = function() {
          a.prototype.dispose.call(this), this.m.dispose();
        }, b;
      }(Mb),
      Cc = function(a, b) {
        this.subject = a, this.observer = b;
      };
  Cc.prototype.dispose = function() {
    if (!this.subject.isDisposed && null !== this.observer) {
      var a = this.subject.observers.indexOf(this.observer);
      this.subject.observers.splice(a, 1), this.observer = null;
    }
  };
  var Dc = ca.Subject = function(a) {
    function c(a) {
      return mb(this), this.isStopped ? this.hasError ? (a.onError(this.error), kb) : (a.onCompleted(), kb) : (this.observers.push(a), new Cc(this, a));
    }
    function d() {
      a.call(this, c), this.isDisposed = !1, this.isStopped = !1, this.observers = [], this.hasError = !1;
    }
    return cb(d, a), db(d.prototype, Kb.prototype, {
      hasObservers: function() {
        return this.observers.length > 0;
      },
      onCompleted: function() {
        if (mb(this), !this.isStopped) {
          this.isStopped = !0;
          for (var a = 0,
              c = b(this.observers),
              d = c.length; d > a; a++)
            c[a].onCompleted();
          this.observers.length = 0;
        }
      },
      onError: function(a) {
        if (mb(this), !this.isStopped) {
          this.isStopped = !0, this.error = a, this.hasError = !0;
          for (var c = 0,
              d = b(this.observers),
              e = d.length; e > c; c++)
            d[c].onError(a);
          this.observers.length = 0;
        }
      },
      onNext: function(a) {
        if (mb(this), !this.isStopped)
          for (var c = 0,
              d = b(this.observers),
              e = d.length; e > c; c++)
            d[c].onNext(a);
      },
      dispose: function() {
        this.isDisposed = !0, this.observers = null;
      }
    }), d.create = function(a, b) {
      return new Fc(a, b);
    }, d;
  }(Ob),
      Ec = ca.AsyncSubject = function(a) {
        function c(a) {
          return mb(this), this.isStopped ? (this.hasError ? a.onError(this.error) : this.hasValue ? (a.onNext(this.value), a.onCompleted()) : a.onCompleted(), kb) : (this.observers.push(a), new Cc(this, a));
        }
        function d() {
          a.call(this, c), this.isDisposed = !1, this.isStopped = !1, this.hasValue = !1, this.observers = [], this.hasError = !1;
        }
        return cb(d, a), db(d.prototype, Kb, {
          hasObservers: function() {
            return mb(this), this.observers.length > 0;
          },
          onCompleted: function() {
            var a,
                c;
            if (mb(this), !this.isStopped) {
              this.isStopped = !0;
              var d = b(this.observers),
                  c = d.length;
              if (this.hasValue)
                for (a = 0; c > a; a++) {
                  var e = d[a];
                  e.onNext(this.value), e.onCompleted();
                }
              else
                for (a = 0; c > a; a++)
                  d[a].onCompleted();
              this.observers.length = 0;
            }
          },
          onError: function(a) {
            if (mb(this), !this.isStopped) {
              this.isStopped = !0, this.hasError = !0, this.error = a;
              for (var c = 0,
                  d = b(this.observers),
                  e = d.length; e > c; c++)
                d[c].onError(a);
              this.observers.length = 0;
            }
          },
          onNext: function(a) {
            mb(this), this.isStopped || (this.value = a, this.hasValue = !0);
          },
          dispose: function() {
            this.isDisposed = !0, this.observers = null, this.exception = null, this.value = null;
          }
        }), d;
      }(Ob),
      Fc = ca.AnonymousSubject = function(a) {
        function b(a) {
          return this.observable.subscribe(a);
        }
        function c(c, d) {
          this.observer = c, this.observable = d, a.call(this, b);
        }
        return cb(c, a), db(c.prototype, Kb.prototype, {
          onCompleted: function() {
            this.observer.onCompleted();
          },
          onError: function(a) {
            this.observer.onError(a);
          },
          onNext: function(a) {
            this.observer.onNext(a);
          }
        }), c;
      }(Ob),
      Gc = ca.BehaviorSubject = function(a) {
        function c(a) {
          return mb(this), this.isStopped ? (this.hasError ? a.onError(this.error) : a.onCompleted(), kb) : (this.observers.push(a), a.onNext(this.value), new Cc(this, a));
        }
        function d(b) {
          a.call(this, c), this.value = b, this.observers = [], this.isDisposed = !1, this.isStopped = !1, this.hasError = !1;
        }
        return cb(d, a), db(d.prototype, Kb, {
          getValue: function() {
            if (mb(this), this.hasError)
              throw this.error;
            return this.value;
          },
          hasObservers: function() {
            return this.observers.length > 0;
          },
          onCompleted: function() {
            if (mb(this), !this.isStopped) {
              this.isStopped = !0;
              for (var a = 0,
                  c = b(this.observers),
                  d = c.length; d > a; a++)
                c[a].onCompleted();
              this.observers.length = 0;
            }
          },
          onError: function(a) {
            if (mb(this), !this.isStopped) {
              this.isStopped = !0, this.hasError = !0, this.error = a;
              for (var c = 0,
                  d = b(this.observers),
                  e = d.length; e > c; c++)
                d[c].onError(a);
              this.observers.length = 0;
            }
          },
          onNext: function(a) {
            if (mb(this), !this.isStopped) {
              this.value = a;
              for (var c = 0,
                  d = b(this.observers),
                  e = d.length; e > c; c++)
                d[c].onNext(a);
            }
          },
          dispose: function() {
            this.isDisposed = !0, this.observers = null, this.value = null, this.exception = null;
          }
        }), d;
      }(Ob),
      Hc = ca.ReplaySubject = function(a) {
        function c(a, b) {
          return jb(function() {
            b.dispose(), !a.isDisposed && a.observers.splice(a.observers.indexOf(b), 1);
          });
        }
        function d(a) {
          var b = new Pb(this.scheduler, a),
              d = c(this, b);
          mb(this), this._trim(this.scheduler.now()), this.observers.push(b);
          for (var e = 0,
              f = this.q.length; f > e; e++)
            b.onNext(this.q[e].value);
          return this.hasError ? b.onError(this.error) : this.isStopped && b.onCompleted(), b.ensureActive(), d;
        }
        function e(b, c, e) {
          this.bufferSize = null == b ? f : b, this.windowSize = null == c ? f : c, this.scheduler = e || wb, this.q = [], this.observers = [], this.isStopped = !1, this.isDisposed = !1, this.hasError = !1, this.error = null, a.call(this, d);
        }
        var f = Math.pow(2, 53) - 1;
        return cb(e, a), db(e.prototype, Kb.prototype, {
          hasObservers: function() {
            return this.observers.length > 0;
          },
          _trim: function(a) {
            for (; this.q.length > this.bufferSize; )
              this.q.shift();
            for (; this.q.length > 0 && a - this.q[0].interval > this.windowSize; )
              this.q.shift();
          },
          onNext: function(a) {
            if (mb(this), !this.isStopped) {
              var c = this.scheduler.now();
              this.q.push({
                interval: c,
                value: a
              }), this._trim(c);
              for (var d = 0,
                  e = b(this.observers),
                  f = e.length; f > d; d++) {
                var g = e[d];
                g.onNext(a), g.ensureActive();
              }
            }
          },
          onError: function(a) {
            if (mb(this), !this.isStopped) {
              this.isStopped = !0, this.error = a, this.hasError = !0;
              var c = this.scheduler.now();
              this._trim(c);
              for (var d = 0,
                  e = b(this.observers),
                  f = e.length; f > d; d++) {
                var g = e[d];
                g.onError(a), g.ensureActive();
              }
              this.observers.length = 0;
            }
          },
          onCompleted: function() {
            if (mb(this), !this.isStopped) {
              this.isStopped = !0;
              var a = this.scheduler.now();
              this._trim(a);
              for (var c = 0,
                  d = b(this.observers),
                  e = d.length; e > c; c++) {
                var f = d[c];
                f.onCompleted(), f.ensureActive();
              }
              this.observers.length = 0;
            }
          },
          dispose: function() {
            this.isDisposed = !0, this.observers = null;
          }
        }), e;
      }(Ob);
  ca.Pauser = function(a) {
    function b() {
      a.call(this);
    }
    return cb(b, a), b.prototype.pause = function() {
      this.onNext(!1);
    }, b.prototype.resume = function() {
      this.onNext(!0);
    }, b;
  }(Dc), "function" == typeof define && "object" == typeof define.amd && define.amd ? (Z.Rx = ca, System.register("src/libs/rx/rx.lite.min", [], false, function() {
    return ca;
  })) : $ && _ ? aa ? (_.exports = ca).Rx = ca : $.Rx = ca : Z.Rx = ca;
  var Ic = g();
}).call(this);
})();
System.register("test/spec/asynctask", ["src/asynctask"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var task = require("src/asynctask"),
      setAsyncTask = task.setAsyncTask,
      clearAsyncTask = task.clearAsyncTask;
  describe('asynctask', function() {
    var handler = {
      callback: function() {},
      callback2: function() {}
    };
    beforeEach(function() {
      spyOn(handler, 'callback');
      spyOn(handler, 'callback2');
    });
    it('asynchronously calls callbacks', function(done) {
      setAsyncTask(handler.callback);
      expect(handler.callback).not.toHaveBeenCalled();
      setTimeout(function() {
        expect(handler.callback).toHaveBeenCalled();
        done();
      }, 1);
    });
    it('cancells callback by ID', function(done) {
      var id1 = setAsyncTask(handler.callback),
          id2 = setAsyncTask(handler.callback2);
      clearAsyncTask(id1);
      setTimeout(function() {
        expect(handler.callback).not.toHaveBeenCalled();
        expect(handler.callback2).toHaveBeenCalled();
        done();
      }, 1);
    });
    it('calls all current tasks at a single event loop', function(done) {
      setAsyncTask(handler.callback);
      setTimeout(handler.callback2, 0);
      setAsyncTask(function() {
        expect(handler.callback).toHaveBeenCalled();
        expect(handler.callback2).not.toHaveBeenCalled();
        done();
      });
    });
  });
  global.define = __define;
  return module.exports;
});

System.register("test/spec/event", ["src/event"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var MediatorEvent = require("src/event");
  describe('event', function() {
    it('has correct values if argument is not passed', function() {
      var event = new MediatorEvent();
      expect(event.emitter).toBe('');
      expect(event.isCanceled).toBe(false);
      expect(event.type).toBe('*');
      expect(typeof event.timeStamp).toBe('number');
      expect(event.detail).toEqual({});
    });
    it('has correct values if Message event is passed as argument', function() {
      expect(true).toBe(true);
    });
    it('is cancelable', function() {
      var event = new MediatorEvent();
      event.cancel();
      expect(event.isCanceled).toBe(true);
    });
  });
  global.define = __define;
  return module.exports;
});

System.register("test/spec/promise", ["src/promise"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var PromiseHelper = require("src/promise");
  describe('promise helper', function() {
    var success1 = Promise.resolve(),
        success2 = Promise.resolve(),
        success3 = Promise.resolve(),
        error1 = Promise.reject(),
        error2 = Promise.reject(),
        error3 = Promise.reject(),
        some = PromiseHelper.somePromises,
        any = PromiseHelper.anyPromises;
    var handler = {
      success: function() {},
      error: function() {}
    };
    beforeEach(function() {
      spyOn(handler, 'success');
      spyOn(handler, 'error');
    });
    xit('resolved, when all promises are resolved, while looking for some', function(done) {
      some(success1, success2, success3).then(handler.success, handler.error).then(function(r) {
        console.log(r);
        expect(handler.success).toHavebeenCalled();
      }, function(err) {
        console.error(err);
      }).then(done, done);
    });
    xit('resolved, when some of promises are resolved, while looking for some', function(done) {
      some(success1, error2, success3).then(function() {}).then(done, done);
    });
    xit('rejected, when all promises are rejected while looking for some', function(done) {
      some(error1, error2, error3).then(function() {}).then(done, done);
    });
    xit('can resolve, when any promises are resolved', function(done) {
      any;
    });
    xit('not rejected, when all promises are rejected while looking for any', function(done) {
      any;
    });
  });
  global.define = __define;
  return module.exports;
});

System.register("src/stream", ["src/libs/rx/rx.lite.min"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var Rx = require("src/libs/rx/rx.lite.min");
  var EventStream = function(initialValue) {
    this.observable = new Rx.BehaviorSubject(initialValue);
    this.event = this.observable.publish();
    this.event.connect();
  };
  EventStream.prototype.emit = function(detail) {
    return this.observable.onNext(detail);
  };
  EventStream.prototype.listen = function(callback) {
    return this.event.subscribe(callback);
  };
  EventStream.prototype.observe = function(callback) {
    return this.observable.subscribe(callback);
  };
  EventStream.prototype.dispose = function() {
    this.observable.onCompleted();
    return this.observable.dispose();
  };
  module.exports = EventStream;
  global.define = __define;
  return module.exports;
});

System.register("test/spec/stream", ["src/stream"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var Stream = require("src/stream");
  describe('stream', function() {
    var stream,
        handler = {
          callback1: function() {},
          callback2: function() {},
          callback3: function() {}
        },
        data1 = {
          a: 1,
          b: 2
        },
        data2 = {
          c: 3,
          d: 4
        },
        data3 = {
          e: 5,
          f: 6
        },
        data4 = [7, 8, 9],
        data5 = undefined,
        data6 = null,
        data7 = true,
        data8 = false,
        WAIT_TIME = 1;
    function wait(callback) {
      return setTimeout(callback, WAIT_TIME);
    }
    beforeEach(function() {
      stream = new Stream();
      spyOn(handler, 'callback1');
      spyOn(handler, 'callback2');
      spyOn(handler, 'callback3');
      spyOn(stream, 'dispose').and.callThrough();
      spyOn(stream, 'emit').and.callThrough();
      spyOn(stream, 'observe').and.callThrough();
      spyOn(stream, 'listen').and.callThrough();
    });
    xit('created with correct initial value', function(done) {});
    it('can be listened', function(done) {
      stream.listen(handler.callback1);
      stream.emit(data1);
      stream.emit(data2);
      wait(function() {
        expect(handler.callback1).toHaveBeenCalled();
        expect(handler.callback1.calls.count()).toEqual(2);
        expect(handler.callback1.calls.argsFor(0)).toEqual([data1]);
        expect(handler.callback1.calls.argsFor(1)).toEqual([data2]);
        done();
      });
    });
    it('emits synchronously', function(done) {
      stream.emit(data1);
      stream.listen(handler.callback1);
      wait(function() {
        expect(handler.callback1).not.toHaveBeenCalled();
        done();
      });
    });
    it('can be observed', function(done) {
      stream.observe(handler.callback1);
      stream.emit(data1);
      stream.emit(data2);
      wait(function() {
        expect(handler.callback1).toHaveBeenCalled();
        expect(handler.callback1.calls.count()).toEqual(3);
        expect(handler.callback1.calls.argsFor(0)).toEqual([undefined]);
        expect(handler.callback1.calls.argsFor(1)).toEqual([data1]);
        expect(handler.callback1.calls.argsFor(2)).toEqual([data2]);
        done();
      });
    });
    it('observs synchronously', function(done) {
      stream.emit(data1);
      stream.observe(handler.callback1);
      expect(handler.callback1).toHaveBeenCalled();
      wait(function() {
        expect(handler.callback1.calls.count()).toEqual(1);
        done();
      });
    });
    describe('can be closed', function() {
      it('before first emitment', function(done) {
        stream.listen(handler.callback1);
        stream.observe(handler.callback2);
        stream.listen(handler.callback3);
        stream.dispose();
        wait(function() {
          expect(handler.callback1).not.toHaveBeenCalled();
          expect(handler.callback2).toHaveBeenCalled();
          expect(handler.callback3).not.toHaveBeenCalled();
          done();
        });
      });
      it('after first emitment', function(done) {
        stream.listen(handler.callback1);
        stream.observe(handler.callback2);
        stream.listen(handler.callback3);
        stream.emit(data1);
        stream.emit(data2);
        stream.dispose();
        wait(function() {
          expect(handler.callback1).toHaveBeenCalled();
          expect(handler.callback2).toHaveBeenCalled();
          expect(handler.callback3).toHaveBeenCalled();
          done();
        });
      });
      it('and throws error, if emit something after that', function(done) {
        stream.emit(data1);
        wait(function() {
          stream.dispose();
          expect(function() {
            stream.emit(data2);
          }).toThrowError();
          done();
        });
      });
      it('after some callback was called', function(done) {
        stream.listen(handler.callback1);
        stream.observe(handler.callback2);
        stream.listen(handler.callback3);
        stream.emit(data1);
        stream.emit(data2);
        wait(function() {
          stream.dispose();
          try {
            stream.emit(data3);
          } catch (err) {}
          wait(function() {
            expect(handler.callback1.calls.count()).toEqual(2);
            expect(handler.callback2.calls.count()).toEqual(3);
            expect(handler.callback3.calls.count()).toEqual(2);
            done();
          });
        });
      });
    });
    it('calls listeners first, and observers last', function(done) {
      var calls = [];
      handler.callback1.and.callFake(function() {
        calls.push('callback1');
      });
      handler.callback2.and.callFake(function() {
        calls.push('callback2');
      });
      handler.callback3.and.callFake(function() {
        calls.push('callback3');
      });
      stream.listen(handler.callback1);
      stream.observe(handler.callback2);
      stream.listen(handler.callback3);
      stream.emit();
      wait(function() {
        expect(calls).toEqual(['callback2', 'callback1', 'callback3', 'callback2']);
        done();
      });
    });
  });
  global.define = __define;
  return module.exports;
});

System.register("test/spec/spec", ["test/spec/asynctask", "test/spec/event", "test/spec/promise", "test/spec/stream"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  describe('Module', function() {
    require("test/spec/asynctask");
    require("test/spec/event");
    require("test/spec/promise");
    require("test/spec/stream");
  });
  global.define = __define;
  return module.exports;
});

});