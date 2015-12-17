"format amd";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

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

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

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
        depExports = depEntry.esModule;
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

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if ((typeof exports == 'object' || typeof exports == 'function') && exports !== global) {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
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
    if (!entry || entry.evaluated || !entry.declarative)
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

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

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

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1'], [], function($__System) {

(function(__global) {
  var loader = $__System;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var commentRegEx = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg;
  var cjsRequirePre = "(?:^|[^$_a-zA-Z\\xA0-\\uFFFF.])";
  var cjsRequirePost = "\\s*\\(\\s*(\"([^\"]+)\"|'([^']+)')\\s*\\)";
  var fnBracketRegEx = /\(([^\)]*)\)/;
  var wsRegEx = /^\s+|\s+$/g;
  
  var requireRegExs = {};

  function getCJSDeps(source, requireIndex) {

    // remove comments
    source = source.replace(commentRegEx, '');

    // determine the require alias
    var params = source.match(fnBracketRegEx);
    var requireAlias = (params[1].split(',')[requireIndex] || 'require').replace(wsRegEx, '');

    // find or generate the regex for this requireAlias
    var requireRegEx = requireRegExs[requireAlias] || (requireRegExs[requireAlias] = new RegExp(cjsRequirePre + requireAlias + cjsRequirePost, 'g'));

    requireRegEx.lastIndex = 0;

    var deps = [];

    var match;
    while (match = requireRegEx.exec(source))
      deps.push(match[2] || match[3]);

    return deps;
  }

  /*
    AMD-compatible require
    To copy RequireJS, set window.require = window.requirejs = loader.amdRequire
  */
  function require(names, callback, errback, referer) {
    // in amd, first arg can be a config object... we just ignore
    if (typeof names == 'object' && !(names instanceof Array))
      return require.apply(null, Array.prototype.splice.call(arguments, 1, arguments.length - 1));

    // amd require
    if (typeof names == 'string' && typeof callback == 'function')
      names = [names];
    if (names instanceof Array) {
      var dynamicRequires = [];
      for (var i = 0; i < names.length; i++)
        dynamicRequires.push(loader['import'](names[i], referer));
      Promise.all(dynamicRequires).then(function(modules) {
        if (callback)
          callback.apply(null, modules);
      }, errback);
    }

    // commonjs require
    else if (typeof names == 'string') {
      var module = loader.get(names);
      return module.__useDefault ? module['default'] : module;
    }

    else
      throw new TypeError('Invalid require');
  }

  function define(name, deps, factory) {
    if (typeof name != 'string') {
      factory = deps;
      deps = name;
      name = null;
    }
    if (!(deps instanceof Array)) {
      factory = deps;
      deps = ['require', 'exports', 'module'].splice(0, factory.length);
    }

    if (typeof factory != 'function')
      factory = (function(factory) {
        return function() { return factory; }
      })(factory);

    // in IE8, a trailing comma becomes a trailing undefined entry
    if (deps[deps.length - 1] === undefined)
      deps.pop();

    // remove system dependencies
    var requireIndex, exportsIndex, moduleIndex;
    
    if ((requireIndex = indexOf.call(deps, 'require')) != -1) {
      
      deps.splice(requireIndex, 1);

      // only trace cjs requires for non-named
      // named defines assume the trace has already been done
      if (!name)
        deps = deps.concat(getCJSDeps(factory.toString(), requireIndex));
    }

    if ((exportsIndex = indexOf.call(deps, 'exports')) != -1)
      deps.splice(exportsIndex, 1);
    
    if ((moduleIndex = indexOf.call(deps, 'module')) != -1)
      deps.splice(moduleIndex, 1);

    var define = {
      name: name,
      deps: deps,
      execute: function(req, exports, module) {

        var depValues = [];
        for (var i = 0; i < deps.length; i++)
          depValues.push(req(deps[i]));

        module.uri = module.id;

        module.config = function() {};

        // add back in system dependencies
        if (moduleIndex != -1)
          depValues.splice(moduleIndex, 0, module);
        
        if (exportsIndex != -1)
          depValues.splice(exportsIndex, 0, exports);
        
        if (requireIndex != -1) 
          depValues.splice(requireIndex, 0, function(names, callback, errback) {
            if (typeof names == 'string' && typeof callback != 'function')
              return req(names);
            return require.call(loader, names, callback, errback, module.id);
          });

        var output = factory.apply(exportsIndex == -1 ? __global : exports, depValues);

        if (typeof output == 'undefined' && module)
          output = module.exports;

        if (typeof output != 'undefined')
          return output;
      }
    };

    // anonymous define
    if (!name) {
      // already defined anonymously -> throw
      if (lastModule.anonDefine)
        throw new TypeError('Multiple defines for anonymous module');
      lastModule.anonDefine = define;
    }
    // named define
    else {
      // if we don't have any other defines,
      // then let this be an anonymous define
      // this is just to support single modules of the form:
      // define('jquery')
      // still loading anonymously
      // because it is done widely enough to be useful
      if (!lastModule.anonDefine && !lastModule.isBundle) {
        lastModule.anonDefine = define;
      }
      // otherwise its a bundle only
      else {
        // if there is an anonDefine already (we thought it could have had a single named define)
        // then we define it now
        // this is to avoid defining named defines when they are actually anonymous
        if (lastModule.anonDefine && lastModule.anonDefine.name)
          loader.registerDynamic(lastModule.anonDefine.name, lastModule.anonDefine.deps, false, lastModule.anonDefine.execute);

        lastModule.anonDefine = null;
      }

      // note this is now a bundle
      lastModule.isBundle = true;

      // define the module through the register registry
      loader.registerDynamic(name, define.deps, false, define.execute);
    }
  }
  define.amd = {};

  // adds define as a global (potentially just temporarily)
  function createDefine(loader) {
    lastModule.anonDefine = null;
    lastModule.isBundle = false;

    // ensure no NodeJS environment detection
    var oldModule = __global.module;
    var oldExports = __global.exports;
    var oldDefine = __global.define;

    __global.module = undefined;
    __global.exports = undefined;
    __global.define = define;

    return function() {
      __global.define = oldDefine;
      __global.module = oldModule;
      __global.exports = oldExports;
    };
  }

  var lastModule = {
    isBundle: false,
    anonDefine: null
  };

  loader.set('@@amd-helpers', loader.newModule({
    createDefine: createDefine,
    require: require,
    define: define,
    lastModule: lastModule
  }));
  loader.amdDefine = define;
  loader.amdRequire = require;
})(typeof self != 'undefined' ? self : global);

"bundle";
$__System.registerDynamic("2", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(exports) {
    'use strict';
    var i;
    var defineProperty = Object.defineProperty,
        is = function(a, b) {
          return isNaN(a) ? isNaN(b) : a === b;
        };
    if (typeof WeakMap == 'undefined') {
      exports.WeakMap = createCollection({
        'delete': sharedDelete,
        clear: sharedClear,
        get: sharedGet,
        has: mapHas,
        set: sharedSet
      }, true);
    }
    if (typeof Map == 'undefined') {
      exports.Map = createCollection({
        'delete': sharedDelete,
        has: mapHas,
        get: sharedGet,
        set: sharedSet,
        keys: sharedKeys,
        values: sharedValues,
        entries: mapEntries,
        forEach: sharedForEach,
        clear: sharedClear
      });
    }
    if (typeof Set == 'undefined') {
      exports.Set = createCollection({
        has: setHas,
        add: sharedAdd,
        'delete': sharedDelete,
        clear: sharedClear,
        keys: sharedValues,
        values: sharedValues,
        entries: setEntries,
        forEach: sharedForEach
      });
    }
    if (typeof WeakSet == 'undefined') {
      exports.WeakSet = createCollection({
        'delete': sharedDelete,
        add: sharedAdd,
        clear: sharedClear,
        has: setHas
      }, true);
    }
    function createCollection(proto, objectOnly) {
      function Collection(a) {
        if (!this || this.constructor !== Collection)
          return new Collection(a);
        this._keys = [];
        this._values = [];
        this._itp = [];
        this.objectOnly = objectOnly;
        if (a)
          init.call(this, a);
      }
      if (!objectOnly) {
        defineProperty(proto, 'size', {get: sharedSize});
      }
      proto.constructor = Collection;
      Collection.prototype = proto;
      return Collection;
    }
    function init(a) {
      var i;
      if (this.add)
        a.forEach(this.add, this);
      else
        a.forEach(function(a) {
          this.set(a[0], a[1]);
        }, this);
    }
    function sharedDelete(key) {
      if (this.has(key)) {
        this._keys.splice(i, 1);
        this._values.splice(i, 1);
        this._itp.forEach(function(p) {
          if (i < p[0])
            p[0]--;
        });
      }
      return -1 < i;
    }
    ;
    function sharedGet(key) {
      return this.has(key) ? this._values[i] : undefined;
    }
    function has(list, key) {
      if (this.objectOnly && key !== Object(key))
        throw new TypeError("Invalid value used as weak collection key");
      if (key != key || key === 0)
        for (i = list.length; i-- && !is(list[i], key); ) {}
      else
        i = list.indexOf(key);
      return -1 < i;
    }
    function setHas(value) {
      return has.call(this, this._values, value);
    }
    function mapHas(value) {
      return has.call(this, this._keys, value);
    }
    function sharedSet(key, value) {
      this.has(key) ? this._values[i] = value : this._values[this._keys.push(key) - 1] = value;
      ;
      return this;
    }
    function sharedAdd(value) {
      if (!this.has(value))
        this._values.push(value);
      return this;
    }
    function sharedClear() {
      this._values.length = 0;
    }
    function sharedKeys() {
      return sharedIterator(this._itp, this._keys);
    }
    function sharedValues() {
      return sharedIterator(this._itp, this._values);
    }
    function mapEntries() {
      return sharedIterator(this._itp, this._keys, this._values);
    }
    function setEntries() {
      return sharedIterator(this._itp, this._values, this._values);
    }
    function sharedIterator(itp, array, array2) {
      var p = [0],
          done = false;
      itp.push(p);
      return {next: function() {
          var v,
              k = p[0];
          if (!done && k < array.length) {
            v = array2 ? [array[k], array2[k]] : array[k];
            p[0]++;
          } else {
            done = true;
            itp.splice(itp.indexOf(p), 1);
          }
          return {
            done: done,
            value: v
          };
        }};
    }
    function sharedSize() {
      return this._values.length;
    }
    function sharedForEach(callback, context) {
      var it = this.entries();
      for (; ; ) {
        var r = it.next();
        if (r.done)
          break;
        callback.call(context, r.value[1], r.value[0], this);
      }
    }
  })(typeof exports != 'undefined' && typeof global != 'undefined' ? global : window);
  global.define = __define;
  return module.exports;
});

(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
(function(a) {
  function b(a) {
    return a && a.Object === Object ? a : null;
  }
  function c(a) {
    for (var b = a.length,
        c = new Array(b),
        d = 0; b > d; d++)
      c[d] = a[d];
    return c;
  }
  function d(a) {
    return function() {
      try {
        return a.apply(this, arguments);
      } catch (b) {
        return ua.e = b, ua;
      }
    };
  }
  function e(a) {
    throw a;
  }
  function f(a, b) {
    if (wa && b.stack && "object" == typeof a && null !== a && a.stack && -1 === a.stack.indexOf(Aa)) {
      for (var c = [],
          d = b; d; d = d.source)
        d.stack && c.unshift(d.stack);
      c.unshift(a.stack);
      var e = c.join("\n" + Aa + "\n");
      a.stack = g(e);
    }
  }
  function g(a) {
    for (var b = a.split("\n"),
        c = [],
        d = 0,
        e = b.length; e > d; d++) {
      var f = b[d];
      h(f) || i(f) || !f || c.push(f);
    }
    return c.join("\n");
  }
  function h(a) {
    var b = k(a);
    if (!b)
      return !1;
    var c = b[0],
        d = b[1];
    return c === ya && d >= za && $d >= d;
  }
  function i(a) {
    return -1 !== a.indexOf("(module.js:") || -1 !== a.indexOf("(node.js:");
  }
  function j() {
    if (wa)
      try {
        throw new Error;
      } catch (a) {
        var b = a.stack.split("\n"),
            c = b[0].indexOf("@") > 0 ? b[1] : b[2],
            d = k(c);
        if (!d)
          return;
        return ya = d[0], d[1];
      }
  }
  function k(a) {
    var b = /at .+ \((.+):(\d+):(?:\d+)\)$/.exec(a);
    if (b)
      return [b[1], Number(b[2])];
    var c = /at ([^ ]+):(\d+):(?:\d+)$/.exec(a);
    if (c)
      return [c[1], Number(c[2])];
    var d = /.*@(.+):(\d+)$/.exec(a);
    return d ? [d[1], Number(d[2])] : void 0;
  }
  function l(a) {
    var b = [];
    if (!hb(a))
      return b;
    gb.nonEnumArgs && a.length && ib(a) && (a = kb.call(a));
    var c = gb.enumPrototypes && "function" == typeof a,
        d = gb.enumErrorProps && (a === ab || a instanceof Error);
    for (var e in a)
      c && "prototype" == e || d && ("message" == e || "name" == e) || b.push(e);
    if (gb.nonEnumShadows && a !== bb) {
      var f = a.constructor,
          g = -1,
          h = Oa;
      if (a === (f && f.prototype))
        var i = a === cb ? Ya : a === ab ? Ta : Za.call(a),
            j = fb[i];
      for (; ++g < h; )
        e = Na[g], j && j[e] || !$a.call(a, e) || b.push(e);
    }
    return b;
  }
  function m(a, b, c) {
    for (var d = -1,
        e = c(a),
        f = e.length; ++d < f; ) {
      var g = e[d];
      if (b(a[g], g, a) === !1)
        break;
    }
    return a;
  }
  function n(a, b) {
    return m(a, b, l);
  }
  function o(a) {
    return "function" != typeof a.toString && "string" == typeof(a + "");
  }
  function p(a, b, c, d) {
    if (a === b)
      return 0 !== a || 1 / a == 1 / b;
    var e = typeof a,
        f = typeof b;
    if (a === a && (null == a || null == b || "function" != e && "object" != e && "function" != f && "object" != f))
      return !1;
    var g = Za.call(a),
        h = Za.call(b);
    if (g == Pa && (g = Wa), h == Pa && (h = Wa), g != h)
      return !1;
    switch (g) {
      case Ra:
      case Sa:
        return +a == +b;
      case Va:
        return a != +a ? b != +b : 0 == a ? 1 / a == 1 / b : a == +b;
      case Xa:
      case Ya:
        return a == String(b);
    }
    var i = g == Qa;
    if (!i) {
      if (g != Wa || !gb.nodeClass && (o(a) || o(b)))
        return !1;
      var j = !gb.argsObject && ib(a) ? Object : a.constructor,
          k = !gb.argsObject && ib(b) ? Object : b.constructor;
      if (!(j == k || $a.call(a, "constructor") && $a.call(b, "constructor") || ta(j) && j instanceof j && ta(k) && k instanceof k || !("constructor" in a && "constructor" in b)))
        return !1;
    }
    c || (c = []), d || (d = []);
    for (var l = c.length; l--; )
      if (c[l] == a)
        return d[l] == b;
    var m = 0,
        q = !0;
    if (c.push(a), d.push(b), i) {
      if (l = a.length, m = b.length, q = m == l)
        for (; m--; ) {
          var r = b[m];
          if (!(q = p(a[m], r, c, d)))
            break;
        }
    } else
      n(b, function(b, e, f) {
        return $a.call(f, e) ? (m++, q = $a.call(a, e) && p(a[e], b, c, d)) : void 0;
      }), q && n(a, function(a, b, c) {
        return $a.call(c, b) ? q = --m > -1 : void 0;
      });
    return c.pop(), d.pop(), q;
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
  function s(a) {
    this._s = a, this.isDisposed = !1;
  }
  function t(a) {
    this._s = a;
  }
  function u(a) {
    this._s = a, this._l = a.length, this._i = 0;
  }
  function v(a) {
    this._a = a;
  }
  function w(a) {
    this._a = a, this._l = A(a), this._i = 0;
  }
  function x(a) {
    return "number" == typeof a && ka.isFinite(a);
  }
  function y(b) {
    var c,
        d = b[Ha];
    if (!d && "string" == typeof b)
      return c = new t(b), c[Ha]();
    if (!d && b.length !== a)
      return c = new v(b), c[Ha]();
    if (!d)
      throw new TypeError("Object is not iterable");
    return b[Ha]();
  }
  function z(a) {
    var b = +a;
    return 0 === b ? b : isNaN(b) ? b : 0 > b ? -1 : 1;
  }
  function A(a) {
    var b = +a.length;
    return isNaN(b) ? 0 : 0 !== b && x(b) ? (b = z(b) * Math.floor(Math.abs(b)), 0 >= b ? 0 : b > tc ? tc : b) : b;
  }
  function B(a, b) {
    this.observer = a, this.parent = b;
  }
  function C(a, b) {
    var c = a.length;
    return function(d, e) {
      c > d ? (b.onNext(a[d]), e(d + 1)) : b.onCompleted();
    };
  }
  function D(a, b) {
    return Cb(a) || (a = Ib), new vc(b, a);
  }
  function E(a, b) {
    this.observer = a, this.parent = b;
  }
  function F(a, b) {
    this.observer = a, this.parent = b;
  }
  function G() {
    return !1;
  }
  function H() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return b;
  }
  function G() {
    return !1;
  }
  function H() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return b;
  }
  function G() {
    return !1;
  }
  function I() {
    return [];
  }
  function G() {
    return !1;
  }
  function I() {
    return [];
  }
  function H() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return b;
  }
  function J(a) {
    return function(b) {
      return a.subscribe(b);
    };
  }
  function K(b, c) {
    return function(d) {
      for (var e = d,
          f = 0; c > f; f++) {
        var g = e[b[f]];
        if ("undefined" == typeof g)
          return a;
        e = g;
      }
      return e;
    };
  }
  function L(a, b, c, d) {
    var e = new Wd;
    return d.push(M(e, b, c)), a.apply(b, d), e.asObservable();
  }
  function M(a, b, c) {
    return function() {
      for (var d = arguments.length,
          e = new Array(d),
          f = 0; d > f; f++)
        e[f] = arguments[f];
      if (ta(c)) {
        if (e = va(c).apply(b, e), e === ua)
          return a.onError(e.e);
        a.onNext(e);
      } else
        e.length <= 1 ? a.onNext(e[0]) : a.onNext(e);
      a.onCompleted();
    };
  }
  function N(a, b, c, d) {
    var e = new Wd;
    return d.push(O(e, b, c)), a.apply(b, d), e.asObservable();
  }
  function O(a, b, c) {
    return function() {
      var d = arguments[0];
      if (d)
        return a.onError(d);
      for (var e = arguments.length,
          f = [],
          g = 1; e > g; g++)
        f[g - 1] = arguments[g];
      if (ta(c)) {
        var f = va(c).apply(b, f);
        if (f === ua)
          return a.onError(f.e);
        a.onNext(f);
      } else
        f.length <= 1 ? a.onNext(f[0]) : a.onNext(f);
      a.onCompleted();
    };
  }
  function P(a) {
    return ka.StaticNodeList ? a instanceof ka.StaticNodeList || a instanceof ka.NodeList : "[object NodeList]" === Object.prototype.toString.call(a);
  }
  function Q(a, b, c) {
    this._e = a, this._n = b, this._fn = c, this._e.addEventListener(this._n, this._fn, !1), this.isDisposed = !1;
  }
  function R(a, b, c) {
    var d = new nb,
        e = Object.prototype.toString.call(a);
    if (P(a) || "[object HTMLCollection]" === e)
      for (var f = 0,
          g = a.length; g > f; f++)
        d.add(R(a.item(f), b, c));
    else
      a && d.add(new Q(a, b, c));
    return d;
  }
  function S(a, b) {
    return new Gd(a, b);
  }
  function T(a, b, c) {
    return new Sd(function(d) {
      var e = a,
          f = Bb(b);
      return c.scheduleRecursiveFuture(0, e, function(a, b) {
        if (f > 0) {
          var g = c.now();
          e = new Date(e.getTime() + f), e.getTime() <= g && (e = new Date(g + f));
        }
        d.onNext(a), b(a + 1, new Date(e));
      });
    });
  }
  function U(a, b, c) {
    return a === b ? new Sd(function(a) {
      return c.schedulePeriodic(0, b, function(b) {
        return a.onNext(b), b + 1;
      });
    }) : nc(function() {
      return T(new Date(c.now() + a), b, c);
    });
  }
  function V(a, b, c) {
    return new Sd(function(d) {
      var e,
          f = !1,
          g = new wb,
          h = null,
          i = [],
          j = !1;
      return e = a.materialize().timestamp(c).subscribe(function(a) {
        var e,
            k;
        "E" === a.value.kind ? (i = [], i.push(a), h = a.value.error, k = !j) : (i.push({
          value: a.value,
          timestamp: a.timestamp + b
        }), k = !f, f = !0), k && (null !== h ? d.onError(h) : (e = new vb, g.setDisposable(e), e.setDisposable(c.scheduleRecursiveFuture(null, b, function(a, b) {
          var e,
              g,
              k,
              l;
          if (null === h) {
            j = !0;
            do
              k = null, i.length > 0 && i[0].timestamp - c.now() <= 0 && (k = i.shift().value), null !== k && k.accept(d);
 while (null !== k);
            l = !1, g = 0, i.length > 0 ? (l = !0, g = Math.max(0, i[0].timestamp - c.now())) : f = !1, e = h, j = !1, null !== e ? d.onError(e) : l && b(null, g);
          }
        }))));
      }), new xb(e, g);
    }, a);
  }
  function W(a, b, c) {
    return nc(function() {
      return V(a, b - c.now(), c);
    });
  }
  function X(a, b, c) {
    var d,
        e;
    return ta(b) ? e = b : (d = b, e = c), new Sd(function(b) {
      function c() {
        i.setDisposable(a.subscribe(function(a) {
          var c = va(e)(a);
          if (c === ua)
            return b.onError(c.e);
          var d = new vb;
          g.add(d), d.setDisposable(c.subscribe(function() {
            b.onNext(a), g.remove(d), f();
          }, function(a) {
            b.onError(a);
          }, function() {
            b.onNext(a), g.remove(d), f();
          }));
        }, function(a) {
          b.onError(a);
        }, function() {
          h = !0, i.dispose(), f();
        }));
      }
      function f() {
        h && 0 === g.length && b.onCompleted();
      }
      var g = new nb,
          h = !1,
          i = new wb;
      return d ? i.setDisposable(d.subscribe(c, function(a) {
        b.onError(a);
      }, c)) : c(), new xb(i, g);
    }, this);
  }
  function Y(a, b) {
    return new Sd(function(c) {
      var d,
          e = !1,
          f = new wb,
          g = 0,
          h = a.subscribe(function(a) {
            var h = va(b)(a);
            if (h === ua)
              return c.onError(h.e);
            sa(h) && (h = Cd(h)), e = !0, d = a, g++;
            var i = g,
                j = new vb;
            f.setDisposable(j), j.setDisposable(h.subscribe(function() {
              e && g === i && c.onNext(d), e = !1, j.dispose();
            }, function(a) {
              c.onError(a);
            }, function() {
              e && g === i && c.onNext(d), e = !1, j.dispose();
            }));
          }, function(a) {
            f.dispose(), c.onError(a), e = !1, g++;
          }, function() {
            f.dispose(), e && c.onNext(d), c.onCompleted(), e = !1, g++;
          });
      return new xb(h, f);
    }, a);
  }
  function Z(a, b) {
    return new Sd(function(c) {
      function d() {
        g && (g = !1, c.onNext(e)), f && c.onCompleted();
      }
      var e,
          f = !1,
          g = !1,
          h = new vb;
      return h.setDisposable(a.subscribe(function(a) {
        g = !0, e = a;
      }, function(a) {
        c.onError(a);
      }, function() {
        f = !0, h.dispose();
      })), new xb(h, b.subscribe(d, function(a) {
        c.onError(a);
      }, d));
    }, a);
  }
  function $(a, b, c, d) {
    return ta(b) && (d = c, c = b, b = zc()), d || (d = Gc(new Md)), new Sd(function(e) {
      function f(a) {
        function b() {
          return l = c === k;
        }
        var c = k,
            f = new vb;
        i.setDisposable(f), f.setDisposable(a.subscribe(function() {
          b() && h.setDisposable(d.subscribe(e)), f.dispose();
        }, function(a) {
          b() && e.onError(a);
        }, function() {
          b() && h.setDisposable(d.subscribe(e));
        }));
      }
      function g() {
        var a = !l;
        return a && k++, a;
      }
      var h = new wb,
          i = new wb,
          j = new vb;
      h.setDisposable(j);
      var k = 0,
          l = !1;
      return f(b), j.setDisposable(a.subscribe(function(a) {
        if (g()) {
          e.onNext(a);
          var b = va(c)(a);
          if (b === ua)
            return e.onError(b.e);
          f(sa(b) ? Cd(b) : b);
        }
      }, function(a) {
        g() && e.onError(a);
      }, function() {
        g() && e.onCompleted();
      })), new xb(h, i);
    }, a);
  }
  function _(a, b, c, d) {
    return Cb(c) && (d = c, c = Gc(new Md)), c instanceof Error && (c = Gc(c)), Cb(d) || (d = Nb), new Sd(function(e) {
      function f() {
        var a = g;
        k.setDisposable(d.scheduleFuture(null, b, function() {
          j = g === a, j && (sa(c) && (c = Cd(c)), i.setDisposable(c.subscribe(e)));
        }));
      }
      var g = 0,
          h = new vb,
          i = new wb,
          j = !1,
          k = new wb;
      return i.setDisposable(h), f(), h.setDisposable(a.subscribe(function(a) {
        j || (g++, e.onNext(a), f());
      }, function(a) {
        j || (g++, e.onError(a));
      }, function() {
        j || (g++, e.onCompleted());
      })), new xb(i, k);
    }, a);
  }
  function aa(a, b, c) {
    return new Sd(function(d) {
      function e(a, b) {
        if (j[b] = a, g[b] = !0, h || (h = g.every(na))) {
          if (f)
            return d.onError(f);
          var e = va(c).apply(null, j);
          if (e === ua)
            return d.onError(e.e);
          d.onNext(e);
        }
        i && j[1] && d.onCompleted();
      }
      var f,
          g = [!1, !1],
          h = !1,
          i = !1,
          j = new Array(2);
      return new xb(a.subscribe(function(a) {
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
  function ba(a) {
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
  var ca = {
    "function": !0,
    object: !0
  },
      da = ca[typeof exports] && exports && !exports.nodeType ? exports : null,
      ea = ca[typeof module] && module && !module.nodeType ? module : null,
      fa = b(da && ea && "object" == typeof global && global),
      ga = b(ca[typeof self] && self),
      ha = b(ca[typeof window] && window),
      ia = ea && ea.exports === da ? da : null,
      ja = b(ca[typeof this] && this),
      ka = fa || ha !== (ja && ja.window) && ha || ga || ja || Function("return this")(),
      la = {
        internals: {},
        config: {Promise: ka.Promise},
        helpers: {}
      },
      ma = la.helpers.noop = function() {},
      na = la.helpers.identity = function(a) {
        return a;
      },
      oa = la.helpers.defaultNow = Date.now,
      pa = la.helpers.defaultComparer = function(a, b) {
        return jb(a, b);
      },
      qa = la.helpers.defaultSubComparer = function(a, b) {
        return a > b ? 1 : b > a ? -1 : 0;
      },
      ra = (la.helpers.defaultKeySerializer = function(a) {
        return a.toString();
      }, la.helpers.defaultError = function(a) {
        throw a;
      }),
      sa = la.helpers.isPromise = function(a) {
        return !!a && "function" != typeof a.subscribe && "function" == typeof a.then;
      },
      ta = la.helpers.isFunction = function() {
        var a = function(a) {
          return "function" == typeof a || !1;
        };
        return a(/x/) && (a = function(a) {
          return "function" == typeof a && "[object Function]" == Za.call(a);
        }), a;
      }(),
      ua = {e: {}},
      va = la.internals.tryCatch = function(a) {
        if (!ta(a))
          throw new TypeError("fn must be a function");
        return d(a);
      };
  la.config.longStackSupport = !1;
  var wa = !1,
      xa = va(function() {
        throw new Error;
      })();
  wa = !!xa.e && !!xa.e.stack;
  var ya,
      za = j(),
      Aa = "From previous event:",
      Ba = la.EmptyError = function() {
        this.message = "Sequence contains no elements.", Error.call(this);
      };
  Ba.prototype = Object.create(Error.prototype), Ba.prototype.name = "EmptyError";
  var Ca = la.ObjectDisposedError = function() {
    this.message = "Object has been disposed", Error.call(this);
  };
  Ca.prototype = Object.create(Error.prototype), Ca.prototype.name = "ObjectDisposedError";
  var Da = la.ArgumentOutOfRangeError = function() {
    this.message = "Argument out of range", Error.call(this);
  };
  Da.prototype = Object.create(Error.prototype), Da.prototype.name = "ArgumentOutOfRangeError";
  var Ea = la.NotSupportedError = function(a) {
    this.message = a || "This operation is not supported", Error.call(this);
  };
  Ea.prototype = Object.create(Error.prototype), Ea.prototype.name = "NotSupportedError";
  var Fa = la.NotImplementedError = function(a) {
    this.message = a || "This operation is not implemented", Error.call(this);
  };
  Fa.prototype = Object.create(Error.prototype), Fa.prototype.name = "NotImplementedError";
  var Ga = la.helpers.notImplemented = function() {
    throw new Fa;
  },
      Ha = (la.helpers.notSupported = function() {
        throw new Ea;
      }, "function" == typeof Symbol && Symbol.iterator || "_es6shim_iterator_");
  ka.Set && "function" == typeof(new ka.Set)["@@iterator"] && (Ha = "@@iterator");
  var Ia = la.doneEnumerator = {
    done: !0,
    value: a
  },
      Ja = la.helpers.isIterable = function(b) {
        return b[Ha] !== a;
      },
      Ka = la.helpers.isArrayLike = function(b) {
        return b && b.length !== a;
      };
  la.helpers.iterator = Ha;
  var La,
      Ma = la.internals.bindCallback = function(a, b, c) {
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
      Na = ["toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "constructor"],
      Oa = Na.length,
      Pa = "[object Arguments]",
      Qa = "[object Array]",
      Ra = "[object Boolean]",
      Sa = "[object Date]",
      Ta = "[object Error]",
      Ua = "[object Function]",
      Va = "[object Number]",
      Wa = "[object Object]",
      Xa = "[object RegExp]",
      Ya = "[object String]",
      Za = Object.prototype.toString,
      $a = Object.prototype.hasOwnProperty,
      _a = Za.call(arguments) == Pa,
      ab = Error.prototype,
      bb = Object.prototype,
      cb = String.prototype,
      db = bb.propertyIsEnumerable;
  try {
    La = !(Za.call(document) == Wa && !({toString: 0} + ""));
  } catch (eb) {
    La = !0;
  }
  var fb = {};
  fb[Qa] = fb[Sa] = fb[Va] = {
    constructor: !0,
    toLocaleString: !0,
    toString: !0,
    valueOf: !0
  }, fb[Ra] = fb[Ya] = {
    constructor: !0,
    toString: !0,
    valueOf: !0
  }, fb[Ta] = fb[Ua] = fb[Xa] = {
    constructor: !0,
    toString: !0
  }, fb[Wa] = {constructor: !0};
  var gb = {};
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
    gb.enumErrorProps = db.call(ab, "message") || db.call(ab, "name"), gb.enumPrototypes = db.call(a, "prototype"), gb.nonEnumArgs = 0 != c, gb.nonEnumShadows = !/valueOf/.test(b);
  }(1);
  var hb = la.internals.isObject = function(a) {
    var b = typeof a;
    return a && ("function" == b || "object" == b) || !1;
  },
      ib = function(a) {
        return a && "object" == typeof a ? Za.call(a) == Pa : !1;
      };
  _a || (ib = function(a) {
    return a && "object" == typeof a ? $a.call(a, "callee") : !1;
  });
  var jb = la.internals.isEqual = function(a, b) {
    return p(a, b, [], []);
  },
      kb = ({}.hasOwnProperty, Array.prototype.slice),
      lb = la.internals.inherits = function(a, b) {
        function c() {
          this.constructor = a;
        }
        c.prototype = b.prototype, a.prototype = new c;
      },
      mb = la.internals.addProperties = function(a) {
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
      },
      nb = (la.internals.addRef = function(a, b) {
        return new Sd(function(c) {
          return new xb(b.getDisposable(), a.subscribe(c));
        });
      }, la.CompositeDisposable = function() {
        var a,
            b,
            c = [];
        if (Array.isArray(arguments[0]))
          c = arguments[0], b = c.length;
        else
          for (b = arguments.length, c = new Array(b), a = 0; b > a; a++)
            c[a] = arguments[a];
        this.disposables = c, this.isDisposed = !1, this.length = c.length;
      }),
      ob = nb.prototype;
  ob.add = function(a) {
    this.isDisposed ? a.dispose() : (this.disposables.push(a), this.length++);
  }, ob.remove = function(a) {
    var b = !1;
    if (!this.isDisposed) {
      var c = this.disposables.indexOf(a);
      -1 !== c && (b = !0, this.disposables.splice(c, 1), this.length--, a.dispose());
    }
    return b;
  }, ob.dispose = function() {
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
  var pb = la.Disposable = function(a) {
    this.isDisposed = !1, this.action = a || ma;
  };
  pb.prototype.dispose = function() {
    this.isDisposed || (this.action(), this.isDisposed = !0);
  };
  var qb = pb.create = function(a) {
    return new pb(a);
  },
      rb = pb.empty = {dispose: ma},
      sb = pb.isDisposable = function(a) {
        return a && ta(a.dispose);
      },
      tb = pb.checkDisposed = function(a) {
        if (a.isDisposed)
          throw new Ca;
      },
      ub = pb._fixup = function(a) {
        return sb(a) ? a : rb;
      },
      vb = la.SingleAssignmentDisposable = function() {
        this.isDisposed = !1, this.current = null;
      };
  vb.prototype.getDisposable = function() {
    return this.current;
  }, vb.prototype.setDisposable = function(a) {
    if (this.current)
      throw new Error("Disposable has already been assigned");
    var b = this.isDisposed;
    !b && (this.current = a), b && a && a.dispose();
  }, vb.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      var a = this.current;
      this.current = null, a && a.dispose();
    }
  };
  var wb = la.SerialDisposable = function() {
    this.isDisposed = !1, this.current = null;
  };
  wb.prototype.getDisposable = function() {
    return this.current;
  }, wb.prototype.setDisposable = function(a) {
    var b = this.isDisposed;
    if (!b) {
      var c = this.current;
      this.current = a;
    }
    c && c.dispose(), b && a && a.dispose();
  }, wb.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      var a = this.current;
      this.current = null;
    }
    a && a.dispose();
  };
  var xb = la.BinaryDisposable = function(a, b) {
    this._first = a, this._second = b, this.isDisposed = !1;
  };
  xb.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      var a = this._first;
      this._first = null, a && a.dispose();
      var b = this._second;
      this._second = null, b && b.dispose();
    }
  };
  var yb = la.NAryDisposable = function(a) {
    this._disposables = a, this.isDisposed = !1;
  };
  yb.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = !0;
      for (var a = 0,
          b = this._disposables.length; b > a; a++)
        this._disposables[a].dispose();
      this._disposables.length = 0;
    }
  };
  var zb = (la.RefCountDisposable = function() {
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
      return this.isDisposed ? rb : new a(this);
    }, b;
  }(), la.internals.ScheduledItem = function(a, b, c, d, e) {
    this.scheduler = a, this.state = b, this.action = c, this.dueTime = d, this.comparer = e || qa, this.disposable = new vb;
  });
  zb.prototype.invoke = function() {
    this.disposable.setDisposable(this.invokeCore());
  }, zb.prototype.compareTo = function(a) {
    return this.comparer(this.dueTime, a.dueTime);
  }, zb.prototype.isCancelled = function() {
    return this.disposable.isDisposed;
  }, zb.prototype.invokeCore = function() {
    return ub(this.action(this.scheduler, this.state));
  };
  var Ab = la.Scheduler = function() {
    function a() {}
    a.isScheduler = function(b) {
      return b instanceof a;
    };
    var b = a.prototype;
    return b.schedule = function(a, b) {
      throw new Fa;
    }, b.scheduleFuture = function(b, c, d) {
      var e = c;
      return e instanceof Date && (e -= this.now()), e = a.normalize(e), 0 === e ? this.schedule(b, d) : this._scheduleFuture(b, e, d);
    }, b._scheduleFuture = function(a, b, c) {
      throw new Fa;
    }, a.now = oa, a.prototype.now = oa, a.normalize = function(a) {
      return 0 > a && (a = 0), a;
    }, a;
  }(),
      Bb = Ab.normalize,
      Cb = Ab.isScheduler;
  !function(a) {
    function b(a, b) {
      function c(b) {
        function d(a, b) {
          return g ? f.remove(i) : h = !0, e(b, c), rb;
        }
        var g = !1,
            h = !1,
            i = a.schedule(b, d);
        h || (f.add(i), g = !0);
      }
      var d = b[0],
          e = b[1],
          f = new nb;
      return e(d, c), f;
    }
    function c(a, b) {
      function c(b, d) {
        function g(a, b) {
          return h ? f.remove(j) : i = !0, e(b, c), rb;
        }
        var h = !1,
            i = !1,
            j = a.scheduleFuture(b, d, g);
        i || (f.add(j), h = !0);
      }
      var d = b[0],
          e = b[1],
          f = new nb;
      return e(d, c), f;
    }
    a.scheduleRecursive = function(a, c) {
      return this.schedule([a, c], b);
    }, a.scheduleRecursiveFuture = function(a, b, d) {
      return this.scheduleFuture([a, d], b, c);
    };
  }(Ab.prototype), function(a) {
    Ab.prototype.schedulePeriodic = function(a, b, c) {
      if ("undefined" == typeof ka.setInterval)
        throw new Ea;
      b = Bb(b);
      var d = a,
          e = ka.setInterval(function() {
            d = c(d);
          }, b);
      return qb(function() {
        ka.clearInterval(e);
      });
    };
  }(Ab.prototype);
  var Db,
      Eb,
      Fb = function(a) {
        function b() {
          a.call(this);
        }
        return lb(b, a), b.prototype.schedule = function(a, b) {
          return ub(b(this, a));
        }, b;
      }(Ab),
      Gb = Ab.immediate = new Fb,
      Hb = function(a) {
        function b() {
          for (; d.length > 0; ) {
            var a = d.dequeue();
            !a.isCancelled() && a.invoke();
          }
        }
        function c() {
          a.call(this);
        }
        var d;
        return lb(c, a), c.prototype.schedule = function(a, c) {
          var f = new zb(this, a, c, this.now());
          if (d)
            d.enqueue(f);
          else {
            d = new Ob(4), d.enqueue(f);
            var g = va(b)();
            d = null, g === ua && e(g.e);
          }
          return f.disposable;
        }, c.prototype.scheduleRequired = function() {
          return !d;
        }, c;
      }(Ab),
      Ib = Ab.currentThread = new Hb,
      Jb = (la.internals.SchedulePeriodicRecursive = function() {
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
          var b = new vb;
          return this._cancel = b, b.setDisposable(this._scheduler.scheduleRecursiveFuture(0, this._period, a.bind(this))), b;
        }, b;
      }(), function() {
        var a,
            b = ma;
        if (ka.setTimeout)
          a = ka.setTimeout, b = ka.clearTimeout;
        else {
          if (!ka.WScript)
            throw new Ea;
          a = function(a, b) {
            ka.WScript.Sleep(b), a();
          };
        }
        return {
          setTimeout: a,
          clearTimeout: b
        };
      }()),
      Kb = Jb.setTimeout,
      Lb = Jb.clearTimeout;
  !function() {
    function a(b) {
      if (f)
        Kb(function() {
          a(b);
        }, 0);
      else {
        var c = d[b];
        if (c) {
          f = !0;
          var g = va(c)();
          Eb(b), f = !1, g === ua && e(g.e);
        }
      }
    }
    function b() {
      if (!ka.postMessage || ka.importScripts)
        return !1;
      var a = !1,
          b = ka.onmessage;
      return ka.onmessage = function() {
        a = !0;
      }, ka.postMessage("", "*"), ka.onmessage = b, a;
    }
    var c = 1,
        d = {},
        f = !1;
    Eb = function(a) {
      delete d[a];
    };
    var g = new RegExp("^" + String(Za).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/toString| for [^\]]+/g, ".*?") + "$"),
        h = "function" == typeof(h = fa && ia && fa.setImmediate) && !g.test(h) && h;
    if (ta(h))
      Db = function(b) {
        var e = c++;
        return d[e] = b, h(function() {
          a(e);
        }), e;
      };
    else if ("undefined" != typeof process && "[object process]" === {}.toString.call(process))
      Db = function(b) {
        var e = c++;
        return d[e] = b, process.nextTick(function() {
          a(e);
        }), e;
      };
    else if (b()) {
      var i = "ms.rx.schedule" + Math.random(),
          j = function(b) {
            "string" == typeof b.data && b.data.substring(0, i.length) === i && a(b.data.substring(i.length));
          };
      ka.addEventListener("message", j, !1), Db = function(a) {
        var b = c++;
        return d[b] = a, ka.postMessage(i + currentId, "*"), b;
      };
    } else if (ka.MessageChannel) {
      var k = new ka.MessageChannel;
      k.port1.onmessage = function(b) {
        a(b.data);
      }, Db = function(a) {
        var b = c++;
        return d[b] = a, k.port2.postMessage(b), b;
      };
    } else
      Db = "document" in ka && "onreadystatechange" in ka.document.createElement("script") ? function(b) {
        var e = ka.document.createElement("script"),
            f = c++;
        return d[f] = b, e.onreadystatechange = function() {
          a(f), e.onreadystatechange = null, e.parentNode.removeChild(e), e = null;
        }, ka.document.documentElement.appendChild(e), f;
      } : function(b) {
        var e = c++;
        return d[e] = b, Kb(function() {
          a(e);
        }, 0), e;
      };
  }();
  var Mb = function(a) {
    function b() {
      a.call(this);
    }
    function c(a, b, c, d) {
      return function() {
        !a.isDisposed && a.setDisposable(pb._fixup(b(c, d)));
      };
    }
    function d(a, b) {
      this._id = b, this._method = a, this.isDisposed = !1;
    }
    return lb(b, a), d.prototype.dispose = function() {
      this.isDisposed || (this.isDisposed = !0, this._method.call(null, this._id));
    }, b.prototype.schedule = function(a, b) {
      var e = new vb,
          f = Db(c(e, b, this, a));
      return new xb(e, new d(Eb, f));
    }, b.prototype._scheduleFuture = function(a, b, e) {
      if (0 === b)
        return this.schedule(a, e);
      var f = new vb,
          g = Kb(c(f, e, this, a), b);
      return new xb(f, new d(Lb, g));
    }, b;
  }(Ab),
      Nb = Ab["default"] = Ab.async = new Mb;
  r.prototype.compareTo = function(a) {
    var b = this.value.compareTo(a.value);
    return 0 === b && (b = this.id - a.id), b;
  };
  var Ob = la.internals.PriorityQueue = function(a) {
    this.items = new Array(a), this.length = 0;
  },
      Pb = Ob.prototype;
  Pb.isHigherPriority = function(a, b) {
    return this.items[a].compareTo(this.items[b]) < 0;
  }, Pb.percolate = function(a) {
    if (!(a >= this.length || 0 > a)) {
      var b = a - 1 >> 1;
      if (!(0 > b || b === a) && this.isHigherPriority(a, b)) {
        var c = this.items[a];
        this.items[a] = this.items[b], this.items[b] = c, this.percolate(b);
      }
    }
  }, Pb.heapify = function(a) {
    if (+a || (a = 0), !(a >= this.length || 0 > a)) {
      var b = 2 * a + 1,
          c = 2 * a + 2,
          d = a;
      if (b < this.length && this.isHigherPriority(b, d) && (d = b), c < this.length && this.isHigherPriority(c, d) && (d = c), d !== a) {
        var e = this.items[a];
        this.items[a] = this.items[d], this.items[d] = e, this.heapify(d);
      }
    }
  }, Pb.peek = function() {
    return this.items[0].value;
  }, Pb.removeAt = function(b) {
    this.items[b] = this.items[--this.length], this.items[this.length] = a, this.heapify();
  }, Pb.dequeue = function() {
    var a = this.peek();
    return this.removeAt(0), a;
  }, Pb.enqueue = function(a) {
    var b = this.length++;
    this.items[b] = new r(Ob.count++, a), this.percolate(b);
  }, Pb.remove = function(a) {
    for (var b = 0; b < this.length; b++)
      if (this.items[b].value === a)
        return this.removeAt(b), !0;
    return !1;
  }, Ob.count = 0;
  var Qb,
      Rb = la.Notification = function() {
        function a() {}
        return a.prototype._accept = function(a, b, c) {
          throw new Fa;
        }, a.prototype._acceptObservable = function(a, b, c) {
          throw new Fa;
        }, a.prototype.accept = function(a, b, c) {
          return a && "object" == typeof a ? this._acceptObservable(a) : this._accept(a, b, c);
        }, a.prototype.toObservable = function(a) {
          var b = this;
          return Cb(a) || (a = Gb), new Sd(function(c) {
            return a.schedule(b, function(a, b) {
              b._acceptObservable(c), "N" === b.kind && c.onCompleted();
            });
          });
        }, a;
      }(),
      Sb = function(a) {
        function b(a) {
          this.value = a, this.kind = "N";
        }
        return lb(b, a), b.prototype._accept = function(a) {
          return a(this.value);
        }, b.prototype._acceptObservable = function(a) {
          return a.onNext(this.value);
        }, b.prototype.toString = function() {
          return "OnNext(" + this.value + ")";
        }, b;
      }(Rb),
      Tb = function(a) {
        function b(a) {
          this.error = a, this.kind = "E";
        }
        return lb(b, a), b.prototype._accept = function(a, b) {
          return b(this.error);
        }, b.prototype._acceptObservable = function(a) {
          return a.onError(this.error);
        }, b.prototype.toString = function() {
          return "OnError(" + this.error + ")";
        }, b;
      }(Rb),
      Ub = function(a) {
        function b() {
          this.kind = "C";
        }
        return lb(b, a), b.prototype._accept = function(a, b, c) {
          return c();
        }, b.prototype._acceptObservable = function(a) {
          return a.onCompleted();
        }, b.prototype.toString = function() {
          return "OnCompleted()";
        }, b;
      }(Rb),
      Vb = Rb.createOnNext = function(a) {
        return new Sb(a);
      },
      Wb = Rb.createOnError = function(a) {
        return new Tb(a);
      },
      Xb = Rb.createOnCompleted = function() {
        return new Ub;
      },
      Yb = la.Observer = function() {},
      Zb = Yb.create = function(a, b, c) {
        return a || (a = ma), b || (b = ra), c || (c = ma), new _b(a, b, c);
      },
      $b = la.internals.AbstractObserver = function(a) {
        function b() {
          this.isStopped = !1;
        }
        return lb(b, a), b.prototype.next = Ga, b.prototype.error = Ga, b.prototype.completed = Ga, b.prototype.onNext = function(a) {
          !this.isStopped && this.next(a);
        }, b.prototype.onError = function(a) {
          this.isStopped || (this.isStopped = !0, this.error(a));
        }, b.prototype.onCompleted = function() {
          this.isStopped || (this.isStopped = !0, this.completed());
        }, b.prototype.dispose = function() {
          this.isStopped = !0;
        }, b.prototype.fail = function(a) {
          return this.isStopped ? !1 : (this.isStopped = !0, this.error(a), !0);
        }, b;
      }(Yb),
      _b = la.AnonymousObserver = function(a) {
        function b(b, c, d) {
          a.call(this), this._onNext = b, this._onError = c, this._onCompleted = d;
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._onNext(a);
        }, b.prototype.error = function(a) {
          this._onError(a);
        }, b.prototype.completed = function() {
          this._onCompleted();
        }, b;
      }($b),
      ac = la.Observable = function() {
        function a(a, b) {
          return function(c) {
            var d = c.onError;
            return c.onError = function(b) {
              f(b, a), d.call(c, b);
            }, b.call(a, c);
          };
        }
        function b() {
          if (la.config.longStackSupport && wa) {
            var b = this._subscribe,
                c = va(e)(new Error).e;
            this.stack = c.stack.substring(c.stack.indexOf("\n") + 1), this._subscribe = a(this, b);
          }
        }
        return Qb = b.prototype, b.isObservable = function(a) {
          return a && ta(a.subscribe);
        }, Qb.subscribe = Qb.forEach = function(a, b, c) {
          return this._subscribe("object" == typeof a ? a : Zb(a, b, c));
        }, Qb.subscribeOnNext = function(a, b) {
          return this._subscribe(Zb("undefined" != typeof b ? function(c) {
            a.call(b, c);
          } : a));
        }, Qb.subscribeOnError = function(a, b) {
          return this._subscribe(Zb(null, "undefined" != typeof b ? function(c) {
            a.call(b, c);
          } : a));
        }, Qb.subscribeOnCompleted = function(a, b) {
          return this._subscribe(Zb(null, null, "undefined" != typeof b ? function() {
            a.call(b);
          } : a));
        }, b;
      }(),
      bc = la.internals.ScheduledObserver = function(a) {
        function b(b, c) {
          a.call(this), this.scheduler = b, this.observer = c, this.isAcquired = !1, this.hasFaulted = !1, this.queue = [], this.disposable = new wb;
        }
        return lb(b, a), b.prototype.next = function(a) {
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
          var a = !1;
          !this.hasFaulted && this.queue.length > 0 && (a = !this.isAcquired, this.isAcquired = !0), a && this.disposable.setDisposable(this.scheduler.scheduleRecursive(this, function(a, b) {
            var c;
            if (!(a.queue.length > 0))
              return void(a.isAcquired = !1);
            c = a.queue.shift();
            var d = va(c)();
            return d === ua ? (a.queue = [], a.hasFaulted = !0, e(d.e)) : void b(a);
          }));
        }, b.prototype.dispose = function() {
          a.prototype.dispose.call(this), this.disposable.dispose();
        }, b;
      }($b),
      cc = la.ObservableBase = function(a) {
        function b(a) {
          return a && ta(a.dispose) ? a : ta(a) ? qb(a) : rb;
        }
        function c(a, c) {
          var d = c[0],
              f = c[1],
              g = va(f.subscribeCore).call(f, d);
          g !== ua || d.fail(ua.e) || e(ua.e), d.setDisposable(b(g));
        }
        function d() {
          a.call(this);
        }
        return lb(d, a), d.prototype._subscribe = function(a) {
          var b = new Td(a),
              d = [b, this];
          return Ib.scheduleRequired() ? Ib.schedule(d, c) : c(null, d), b;
        }, d.prototype.subscribeCore = Ga, d;
      }(ac),
      dc = la.FlatMapObservable = function(a) {
        function b(b, c, d, e) {
          this.resultSelector = ta(d) ? d : null, this.selector = Ma(ta(c) ? c : function() {
            return c;
          }, e, 3), this.source = b, a.call(this);
        }
        function c(a, b, c, d) {
          this.i = 0, this.selector = b, this.resultSelector = c, this.source = d, this.o = a, $b.call(this);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          return this.source.subscribe(new c(a, this.selector, this.resultSelector, this));
        }, lb(c, $b), c.prototype._wrapResult = function(a, b, c) {
          return this.resultSelector ? a.map(function(a, d) {
            return this.resultSelector(b, a, c, d);
          }, this) : a;
        }, c.prototype.next = function(a) {
          var b = this.i++,
              c = va(this.selector)(a, b, this.source);
          return c === ua ? this.o.onError(c.e) : (sa(c) && (c = Cd(c)), (Ka(c) || Ja(c)) && (c = ac.from(c)), void this.o.onNext(this._wrapResult(c, a, b)));
        }, c.prototype.error = function(a) {
          this.o.onError(a);
        }, c.prototype.onCompleted = function() {
          this.o.onCompleted();
        }, b;
      }(cc),
      ec = la.internals.Enumerable = function() {};
  s.prototype.dispose = function() {
    this.isDisposed || (this.isDisposed = !0, this._s.isDisposed = !0);
  };
  var fc = function(a) {
    function b(b) {
      this.sources = b, a.call(this);
    }
    function c(a, b, c) {
      this._o = a, this._s = b, this._e = c, $b.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = {isDisposed: !1},
          d = new wb,
          e = Ib.scheduleRecursive(this.sources[Ha](), function(e, f) {
            if (!b.isDisposed) {
              var g = va(e.next).call(e);
              if (g === ua)
                return a.onError(g.e);
              if (g.done)
                return a.onCompleted();
              var h = g.value;
              sa(h) && (h = Cd(h));
              var i = new vb;
              d.setDisposable(i), i.setDisposable(h.subscribe(new c(a, f, e)));
            }
          });
      return new yb([d, e, new s(b)]);
    }, lb(c, $b), c.prototype.onNext = function(a) {
      this._o.onNext(a);
    }, c.prototype.onError = function(a) {
      this._o.onError(a);
    }, c.prototype.onCompleted = function() {
      this._s(this._e);
    }, b;
  }(cc);
  ec.prototype.concat = function() {
    return new fc(this);
  };
  var gc = function(a) {
    function b(b) {
      this.sources = b, a.call(this);
    }
    function c(a, b) {
      this._o = a, this._recurse = b, $b.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = this.sources[Ha](),
          d = {isDisposed: !1},
          e = new wb,
          f = Ib.scheduleRecursive(null, function(f, g) {
            if (!d.isDisposed) {
              var h = va(b.next).call(b);
              if (h === ua)
                return a.onError(h.e);
              if (h.done)
                return null !== f ? a.onError(f) : a.onCompleted();
              var i = h.value;
              sa(i) && (i = Cd(i));
              var j = new vb;
              e.setDisposable(j), j.setDisposable(i.subscribe(new c(a, g)));
            }
          });
      return new yb([e, f, new s(d)]);
    }, lb(c, $b), c.prototype.next = function(a) {
      this._o.onNext(a);
    }, c.prototype.error = function(a) {
      this._recurse(a);
    }, c.prototype.completed = function() {
      this._o.onCompleted();
    }, b;
  }(cc);
  ec.prototype.catchError = function() {
    return new gc(this);
  }, ec.prototype.catchErrorWhen = function(a) {
    var b = this;
    return new Sd(function(c) {
      var d,
          e = new Vd,
          f = new Vd,
          g = a(e),
          h = g.subscribe(f),
          i = b[Ha](),
          j = {isDisposed: !1},
          k = new wb,
          l = Ib.scheduleRecursive(null, function(a, b) {
            if (!j.isDisposed) {
              var g = va(i.next).call(i);
              if (g === ua)
                return c.onError(g.e);
              if (g.done)
                return void(d ? c.onError(d) : c.onCompleted());
              var h = g.value;
              sa(h) && (h = Cd(h));
              var l = new vb,
                  m = new vb;
              k.setDisposable(new xb(m, l)), l.setDisposable(h.subscribe(function(a) {
                c.onNext(a);
              }, function(a) {
                m.setDisposable(f.subscribe(b, function(a) {
                  c.onError(a);
                }, function() {
                  c.onCompleted();
                })), e.onNext(a);
              }, function() {
                c.onCompleted();
              }));
            }
          });
      return new yb([h, k, l, new s(j)]);
    });
  };
  var hc = function(a) {
    function b(a, b) {
      this.v = a, this.c = null == b ? -1 : b;
    }
    function c(a) {
      this.v = a.v, this.l = a.c;
    }
    return lb(b, a), b.prototype[Ha] = function() {
      return new c(this);
    }, c.prototype.next = function() {
      return 0 === this.l ? Ia : (this.l > 0 && this.l--, {
        done: !1,
        value: this.v
      });
    }, b;
  }(ec),
      ic = ec.repeat = function(a, b) {
        return new hc(a, b);
      },
      jc = function(a) {
        function b(a, b, c) {
          this.s = a, this.fn = b ? Ma(b, c, 3) : null;
        }
        function c(a) {
          this.i = -1, this.s = a.s, this.l = this.s.length, this.fn = a.fn;
        }
        return lb(b, a), b.prototype[Ha] = function() {
          return new c(this);
        }, c.prototype.next = function() {
          return ++this.i < this.l ? {
            done: !1,
            value: this.fn ? this.fn(this.s[this.i], this.i, this.s) : this.s[this.i]
          } : Ia;
        }, b;
      }(ec),
      kc = ec.of = function(a, b, c) {
        return new jc(a, b, c);
      },
      lc = function(a) {
        function b(b) {
          this.source = b, a.call(this);
        }
        function c(a) {
          this.o = a, this.a = [], $b.call(this);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          return this.source.subscribe(new c(a));
        }, lb(c, $b), c.prototype.next = function(a) {
          this.a.push(a);
        }, c.prototype.error = function(a) {
          this.o.onError(a);
        }, c.prototype.completed = function() {
          this.o.onNext(this.a), this.o.onCompleted();
        }, b;
      }(cc);
  Qb.toArray = function() {
    return new lc(this);
  }, ac.create = function(a, b) {
    return new Sd(a, b);
  };
  var mc = function(a) {
    function b(b) {
      this._f = b, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = va(this._f)();
      return b === ua ? Gc(b.e).subscribe(a) : (sa(b) && (b = Cd(b)), b.subscribe(a));
    }, b;
  }(cc),
      nc = ac.defer = function(a) {
        return new mc(a);
      },
      oc = function(a) {
        function b(b) {
          this.scheduler = b, a.call(this);
        }
        function c(a, b) {
          this.observer = a, this.scheduler = b;
        }
        function d(a, b) {
          return b.onCompleted(), rb;
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new c(a, this.scheduler);
          return b.run();
        }, c.prototype.run = function() {
          var a = this.observer;
          return this.scheduler === Gb ? d(null, a) : this.scheduler.schedule(a, d);
        }, b;
      }(cc),
      pc = new oc(Gb),
      qc = ac.empty = function(a) {
        return Cb(a) || (a = Gb), a === Gb ? pc : new oc(a);
      },
      rc = function(a) {
        function b(b, c, d) {
          this.iterable = b, this.mapper = c, this.scheduler = d, a.call(this);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new sc(a, this);
          return b.run();
        }, b;
      }(cc),
      sc = function() {
        function a(a, b) {
          this.o = a, this.parent = b;
        }
        return a.prototype.run = function() {
          function a(a, b) {
            var f = va(c.next).call(c);
            if (f === ua)
              return d.onError(f.e);
            if (f.done)
              return d.onCompleted();
            var g = f.value;
            return ta(e) && (g = va(e)(g, a), g === ua) ? d.onError(g.e) : (d.onNext(g), void b(a + 1));
          }
          var b = Object(this.parent.iterable),
              c = y(b),
              d = this.o,
              e = this.parent.mapper;
          return this.parent.scheduler.scheduleRecursive(0, a);
        }, a;
      }(),
      tc = Math.pow(2, 53) - 1;
  t.prototype[Ha] = function() {
    return new u(this._s);
  }, u.prototype[Ha] = function() {
    return this;
  }, u.prototype.next = function() {
    return this._i < this._l ? {
      done: !1,
      value: this._s.charAt(this._i++)
    } : Ia;
  }, v.prototype[Ha] = function() {
    return new w(this._a);
  }, w.prototype[Ha] = function() {
    return this;
  }, w.prototype.next = function() {
    return this._i < this._l ? {
      done: !1,
      value: this._a[this._i++]
    } : Ia;
  };
  var uc = ac.from = function(a, b, c, d) {
    if (null == a)
      throw new Error("iterable cannot be null.");
    if (b && !ta(b))
      throw new Error("mapFn when provided must be a function");
    if (b)
      var e = Ma(b, c, 2);
    return Cb(d) || (d = Ib), new rc(a, e, d);
  },
      vc = function(a) {
        function b(b, c) {
          this.args = b, this.scheduler = c, a.call(this);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new B(a, this);
          return b.run();
        }, b;
      }(cc);
  B.prototype.run = function() {
    return this.parent.scheduler.scheduleRecursive(0, C(this.parent.args, this.observer));
  };
  var wc = ac.fromArray = function(a, b) {
    return Cb(b) || (b = Ib), new vc(a, b);
  },
      xc = function(a) {
        function b() {
          a.call(this);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          return rb;
        }, b;
      }(cc),
      yc = new xc,
      zc = ac.never = function() {
        return yc;
      };
  ac.of = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return new vc(b, Ib);
  }, ac.ofWithScheduler = function(a) {
    for (var b = arguments.length,
        c = new Array(b - 1),
        d = 1; b > d; d++)
      c[d - 1] = arguments[d];
    return new vc(c, a);
  };
  var Ac = function(a) {
    function b(b, c) {
      this.obj = b, this.keys = Object.keys(b), this.scheduler = c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new E(a, this);
      return b.run();
    }, b;
  }(cc);
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
    return this.parent.scheduler.scheduleRecursive(0, a);
  }, ac.pairs = function(a, b) {
    return b || (b = Ib), new Ac(a, b);
  };
  var Bc = function(a) {
    function b(b, c, d) {
      this.start = b, this.rangeCount = c, this.scheduler = d, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new Cc(a, this);
      return b.run();
    }, b;
  }(cc),
      Cc = function() {
        function a(a, b) {
          this.observer = a, this.parent = b;
        }
        function b(a, b, c) {
          return function(d, e) {
            b > d ? (c.onNext(a + d), e(d + 1)) : c.onCompleted();
          };
        }
        return a.prototype.run = function() {
          return this.parent.scheduler.scheduleRecursive(0, b(this.parent.start, this.parent.rangeCount, this.observer));
        }, a;
      }();
  ac.range = function(a, b, c) {
    return Cb(c) || (c = Ib), new Bc(a, b, c);
  };
  var Dc = function(a) {
    function b(b, c, d) {
      this.value = b, this.repeatCount = null == c ? -1 : c, this.scheduler = d, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new F(a, this);
      return b.run();
    }, b;
  }(cc);
  F.prototype.run = function() {
    function a(a, d) {
      return (-1 === a || a > 0) && (b.onNext(c), a > 0 && a--), 0 === a ? b.onCompleted() : void d(a);
    }
    var b = this.observer,
        c = this.parent.value;
    return this.parent.scheduler.scheduleRecursive(this.parent.repeatCount, a);
  }, ac.repeat = function(a, b, c) {
    return Cb(c) || (c = Ib), new Dc(a, b, c);
  };
  var Ec = function(a) {
    function b(b, c) {
      this.value = b, this.scheduler = c, a.call(this);
    }
    function c(a, b, c) {
      this.observer = a, this.value = b, this.scheduler = c;
    }
    function d(a, b) {
      var c = b[0],
          d = b[1];
      return d.onNext(c), d.onCompleted(), rb;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new c(a, this.value, this.scheduler);
      return b.run();
    }, c.prototype.run = function() {
      var a = [this.value, this.observer];
      return this.scheduler === Gb ? d(null, a) : this.scheduler.schedule(a, d);
    }, b;
  }(cc),
      Fc = (ac["return"] = ac.just = function(a, b) {
        return Cb(b) || (b = Gb), new Ec(a, b);
      }, function(a) {
        function b(b, c) {
          this.error = b, this.scheduler = c, a.call(this);
        }
        function c(a, b) {
          this.o = a, this.p = b;
        }
        function d(a, b) {
          var c = b[0],
              d = b[1];
          d.onError(c);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new c(a, this);
          return b.run();
        }, c.prototype.run = function() {
          return this.p.scheduler.schedule([this.p.error, this.o], d);
        }, b;
      }(cc)),
      Gc = ac["throw"] = function(a, b) {
        return Cb(b) || (b = Gb), new Fc(a, b);
      },
      Hc = function(a) {
        function b(b, c) {
          this.source = b, this._fn = c, a.call(this);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new vb,
              c = new wb;
          return c.setDisposable(b), b.setDisposable(this.source.subscribe(new Ic(a, c, this._fn))), c;
        }, b;
      }(cc),
      Ic = function(a) {
        function b(b, c, d) {
          this._o = b, this._s = c, this._fn = d, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._o.onNext(a);
        }, b.prototype.completed = function() {
          return this._o.onCompleted();
        }, b.prototype.error = function(a) {
          var b = va(this._fn)(a);
          if (b === ua)
            return this._o.onError(b.e);
          sa(b) && (b = Cd(b));
          var c = new vb;
          this._s.setDisposable(c), c.setDisposable(b.subscribe(this._o));
        }, b;
      }($b);
  Qb["catch"] = function(a) {
    return ta(a) ? new Hc(this, a) : Jc([this, a]);
  };
  var Jc = ac["catch"] = function() {
    var a;
    if (Array.isArray(arguments[0]))
      a = arguments[0];
    else {
      var b = arguments.length;
      a = new Array(b);
      for (var c = 0; b > c; c++)
        a[c] = arguments[c];
    }
    return kc(a).catchError();
  };
  Qb.combineLatest = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    return Array.isArray(b[0]) ? b[0].unshift(this) : b.unshift(this), Mc.apply(this, b);
  };
  var Kc = function(a) {
    function b(b, c) {
      var d = b.length;
      this._params = b, this._cb = c, this._hv = q(d, G), this._hvAll = !1, this._done = q(d, G), this._v = new Array(d), a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      for (var b = this._params.length,
          c = new Array(b),
          d = 0; b > d; d++) {
        var e = this._params[d],
            f = new vb;
        c[d] = f, sa(e) && (e = Cd(e)), f.setDisposable(e.subscribe(new Lc(a, d, this)));
      }
      return new yb(c);
    }, b;
  }(cc),
      Lc = function(a) {
        function b(b, c, d) {
          this._o = b, this._i = c, this._p = d, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          if (this._p._v[this._i] = a, this._p._hv[this._i] = !0, this._p._hvAll || (this._p._hvAll = this._p._hv.every(na))) {
            var b = va(this._p._cb).apply(null, this._p._v);
            if (b === ua)
              return this._o.onError(b.e);
            this._o.onNext(b);
          } else
            this._p._done.filter(function(a, b) {
              return b !== this._i;
            }, this).every(na) && this._o.onCompleted();
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._p._done[this._i] = !0, this._p._done.every(na) && this._o.onCompleted();
        }, b;
      }($b),
      Mc = ac.combineLatest = function() {
        for (var a = arguments.length,
            b = new Array(a),
            c = 0; a > c; c++)
          b[c] = arguments[c];
        var d = ta(b[a - 1]) ? b.pop() : H;
        return Array.isArray(b[0]) && (b = b[0]), new Kc(b, d);
      };
  Qb.concat = function() {
    for (var a = [],
        b = 0,
        c = arguments.length; c > b; b++)
      a.push(arguments[b]);
    return a.unshift(this), Oc.apply(null, a);
  };
  var Nc = function(a) {
    function b(b) {
      this.sources = b, a.call(this);
    }
    function c(a, b) {
      this.sources = a, this.o = b;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new c(this.sources, a);
      return b.run();
    }, c.prototype.run = function() {
      var a,
          b = new wb,
          c = this.sources,
          d = c.length,
          e = this.o,
          f = Gb.scheduleRecursive(0, function(f, g) {
            if (!a) {
              if (f === d)
                return e.onCompleted();
              var h = c[f];
              sa(h) && (h = Cd(h));
              var i = new vb;
              b.setDisposable(i), i.setDisposable(h.subscribe(function(a) {
                e.onNext(a);
              }, function(a) {
                e.onError(a);
              }, function() {
                g(f + 1);
              }));
            }
          });
      return new nb(b, f, qb(function() {
        a = !0;
      }));
    }, b;
  }(cc),
      Oc = ac.concat = function() {
        var a;
        if (Array.isArray(arguments[0]))
          a = arguments[0];
        else {
          a = new Array(arguments.length);
          for (var b = 0,
              c = arguments.length; c > b; b++)
            a[b] = arguments[b];
        }
        return new Nc(a);
      };
  Qb.concatAll = function() {
    return this.merge(1);
  };
  var Pc = function(a) {
    function b(b, c) {
      this.source = b, this.maxConcurrent = c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new nb;
      return b.add(this.source.subscribe(new Qc(a, this.maxConcurrent, b))), b;
    }, b;
  }(cc),
      Qc = function() {
        function a(a, b, c) {
          this.o = a, this.max = b, this.g = c, this.done = !1, this.q = [], this.activeCount = 0, this.isStopped = !1;
        }
        function b(a, b) {
          this.parent = a, this.sad = b, this.isStopped = !1;
        }
        return a.prototype.handleSubscribe = function(a) {
          var c = new vb;
          this.g.add(c), sa(a) && (a = Cd(a)), c.setDisposable(a.subscribe(new b(this, c)));
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
  Qb.merge = function(a) {
    return "number" != typeof a ? Rc(this, a) : new Pc(this, a);
  };
  var Rc = ac.merge = function() {
    var a,
        b,
        c = [],
        d = arguments.length;
    if (arguments[0])
      if (Cb(arguments[0]))
        for (a = arguments[0], b = 1; d > b; b++)
          c.push(arguments[b]);
      else
        for (a = Gb, b = 0; d > b; b++)
          c.push(arguments[b]);
    else
      for (a = Gb, b = 1; d > b; b++)
        c.push(arguments[b]);
    return Array.isArray(c[0]) && (c = c[0]), D(a, c).mergeAll();
  },
      Sc = la.CompositeError = function(a) {
        this.innerErrors = a, this.message = "This contains multiple errors. Check the innerErrors", Error.call(this);
      };
  Sc.prototype = Error.prototype, Sc.prototype.name = "NotImplementedError", ac.mergeDelayError = function() {
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
    return new Sd(function(a) {
      function b() {
        0 === g.length ? a.onCompleted() : 1 === g.length ? a.onError(g[0]) : a.onError(new Sc(g));
      }
      var c = new nb,
          e = new vb,
          f = !1,
          g = [];
      return c.add(e), e.setDisposable(d.subscribe(function(d) {
        var e = new vb;
        c.add(e), sa(d) && (d = Cd(d)), e.setDisposable(d.subscribe(function(b) {
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
  var Tc = function(a) {
    function b(b) {
      this.source = b, a.call(this);
    }
    function c(a, b) {
      this.o = a, this.g = b, this.isStopped = !1, this.done = !1;
    }
    function d(a, b) {
      this.parent = a, this.sad = b, this.isStopped = !1;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new nb,
          d = new vb;
      return b.add(d), d.setDisposable(this.source.subscribe(new c(a, b))), b;
    }, c.prototype.onNext = function(a) {
      if (!this.isStopped) {
        var b = new vb;
        this.g.add(b), sa(a) && (a = Cd(a)), b.setDisposable(a.subscribe(new d(this, b)));
      }
    }, c.prototype.onError = function(a) {
      this.isStopped || (this.isStopped = !0, this.o.onError(a));
    }, c.prototype.onCompleted = function() {
      this.isStopped || (this.isStopped = !0, this.done = !0, 1 === this.g.length && this.o.onCompleted());
    }, c.prototype.dispose = function() {
      this.isStopped = !0;
    }, c.prototype.fail = function(a) {
      return this.isStopped ? !1 : (this.isStopped = !0, this.o.onError(a), !0);
    }, d.prototype.onNext = function(a) {
      this.isStopped || this.parent.o.onNext(a);
    }, d.prototype.onError = function(a) {
      this.isStopped || (this.isStopped = !0, this.parent.o.onError(a));
    }, d.prototype.onCompleted = function() {
      if (!this.isStopped) {
        var a = this.parent;
        this.isStopped = !0, a.g.remove(this.sad), a.done && 1 === a.g.length && a.o.onCompleted();
      }
    }, d.prototype.dispose = function() {
      this.isStopped = !0;
    }, d.prototype.fail = function(a) {
      return this.isStopped ? !1 : (this.isStopped = !0, this.parent.o.onError(a), !0);
    }, b;
  }(cc);
  Qb.mergeAll = function() {
    return new Tc(this);
  };
  var Uc = function(a) {
    function b(b, c) {
      this._s = b, this._o = sa(c) ? Cd(c) : c, this._open = !1, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new vb;
      b.setDisposable(this._s.subscribe(new Vc(a, this))), sa(this._o) && (this._o = Cd(this._o));
      var c = new vb;
      return c.setDisposable(this._o.subscribe(new Wc(a, this, c))), new xb(b, c);
    }, b;
  }(cc),
      Vc = function(a) {
        function b(b, c) {
          this._o = b, this._p = c, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._p._open && this._o.onNext(a);
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.onCompleted = function() {
          this._p._open && this._o.onCompleted();
        }, b;
      }($b),
      Wc = function(a) {
        function b(b, c, d) {
          this._o = b, this._p = c, this._r = d, a.call(this);
        }
        return lb(b, a), b.prototype.next = function() {
          this._p._open = !0, this._r.dispose();
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.onCompleted = function() {
          this._r.dispose();
        }, b;
      }($b);
  Qb.skipUntil = function(a) {
    return new Uc(this, a);
  };
  var Xc = function(a) {
    function b(b) {
      this.source = b, a.call(this);
    }
    function c(a, b) {
      this.o = a, this.inner = b, this.stopped = !1, this.latest = 0, this.hasLatest = !1, $b.call(this);
    }
    function d(a, b) {
      this.parent = a, this.id = b, $b.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new wb,
          d = this.source.subscribe(new c(a, b));
      return new xb(d, b);
    }, lb(c, $b), c.prototype.next = function(a) {
      var b = new vb,
          c = ++this.latest;
      this.hasLatest = !0, this.inner.setDisposable(b), sa(a) && (a = Cd(a)), b.setDisposable(a.subscribe(new d(this, c)));
    }, c.prototype.error = function(a) {
      this.o.onError(a);
    }, c.prototype.completed = function() {
      this.stopped = !0, !this.hasLatest && this.o.onCompleted();
    }, lb(d, $b), d.prototype.next = function(a) {
      this.parent.latest === this.id && this.parent.o.onNext(a);
    }, d.prototype.error = function(a) {
      this.parent.latest === this.id && this.parent.o.onError(a);
    }, d.prototype.completed = function() {
      this.parent.latest === this.id && (this.parent.hasLatest = !1, this.parent.isStopped && this.parent.o.onCompleted());
    }, b;
  }(cc);
  Qb["switch"] = Qb.switchLatest = function() {
    return new Xc(this);
  };
  var Yc = function(a) {
    function b(b, c) {
      this.source = b, this.other = sa(c) ? Cd(c) : c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return new xb(this.source.subscribe(a), this.other.subscribe(new Zc(a)));
    }, b;
  }(cc),
      Zc = function(a) {
        function b(b) {
          this._o = b, a.call(this);
        }
        return lb(b, a), b.prototype.next = function() {
          this._o.onCompleted();
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.onCompleted = ma, b;
      }($b);
  Qb.takeUntil = function(a) {
    return new Yc(this, a);
  };
  var $c = function(a) {
    function b(b, c, d) {
      var e = c.length;
      this._s = b, this._ss = c, this._cb = d, this._hv = q(e, G), this._hvAll = !1, this._v = new Array(e), a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      for (var b = this._ss.length,
          c = new Array(b + 1),
          d = 0; b > d; d++) {
        var e = this._ss[d],
            f = new vb;
        sa(e) && (e = Cd(e)), f.setDisposable(e.subscribe(new _c(a, d, this))), c[d] = f;
      }
      var f = new vb;
      return f.setDisposable(this._s.subscribe(new ad(a, this))), c[b] = f, new yb(c);
    }, b;
  }(cc),
      _c = function(a) {
        function b(b, c, d) {
          this._o = b, this._i = c, this._p = d, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._p._v[this._i] = a, this._p._hv[this._i] = !0, this._p._hvAll = this._p._hv.every(na);
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = ma, b;
      }($b),
      ad = function(a) {
        function b(b, c) {
          this._o = b, this._p = c, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          var b = [a].concat(this._p._v);
          if (this._p._hvAll) {
            var c = va(this._p._cb).apply(null, b);
            return c === ua ? this._o.onError(c.e) : void this._o.onNext(c);
          }
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._o.onCompleted();
        }, b;
      }($b);
  Qb.withLatestFrom = function() {
    if (0 === arguments.length)
      throw new Error("invalid arguments");
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = ta(b[a - 1]) ? b.pop() : H;
    return Array.isArray(b[0]) && (b = b[0]), new $c(this, b, d);
  };
  var bd = function(a) {
    function b(b, c) {
      var d = b.length;
      this._s = b, this._cb = c, this._done = q(d, G), this._q = q(d, I), a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      for (var b = this._s.length,
          c = new Array(b),
          d = 0; b > d; d++) {
        var e = this._s[d],
            f = new vb;
        c[d] = f, sa(e) && (e = Cd(e)), f.setDisposable(e.subscribe(new cd(a, d, this)));
      }
      return new yb(c);
    }, b;
  }(cc),
      cd = function(a) {
        function b(b, c, d) {
          this._o = b, this._i = c, this._p = d, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          if (this._p._q[this._i].push(a), this._p._q.every(function(a) {
            return a.length > 0;
          })) {
            var b = this._p._q.map(function(a) {
              return a.shift();
            }),
                c = va(this._p._cb).apply(null, b);
            if (c === ua)
              return this._o.onError(c.e);
            this._o.onNext(c);
          } else
            this._p._done.filter(function(a, b) {
              return b !== this._i;
            }, this).every(na) && this._o.onCompleted();
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._p._done[this._i] = !0, this._p._done.every(na) && this._o.onCompleted();
        }, b;
      }($b);
  Qb.zip = function() {
    if (0 === arguments.length)
      throw new Error("invalid arguments");
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = ta(b[a - 1]) ? b.pop() : H;
    Array.isArray(b[0]) && (b = b[0]);
    var e = this;
    return b.unshift(e), new bd(b, d);
  }, ac.zip = function() {
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    Array.isArray(b[0]) && (b = ta(b[1]) ? b[0].concat(b[1]) : b[0]);
    var d = b.shift();
    return d.zip.apply(d, b);
  }, Qb.zipIterable = function() {
    if (0 === arguments.length)
      throw new Error("invalid arguments");
    for (var a = arguments.length,
        b = new Array(a),
        c = 0; a > c; c++)
      b[c] = arguments[c];
    var d = ta(b[a - 1]) ? b.pop() : H,
        e = this;
    return b.unshift(e), new Sd(function(a) {
      for (var c = b.length,
          f = q(c, I),
          g = q(c, G),
          h = new Array(c),
          i = 0; c > i; i++)
        !function(c) {
          var i = b[c],
              j = new vb;
          (Ka(i) || Ja(i)) && (i = uc(i)), j.setDisposable(i.subscribe(function(b) {
            if (f[c].push(b), f.every(function(a) {
              return a.length > 0;
            })) {
              var h = f.map(function(a) {
                return a.shift();
              }),
                  i = va(d).apply(e, h);
              if (i === ua)
                return a.onError(i.e);
              a.onNext(i);
            } else
              g.filter(function(a, b) {
                return b !== c;
              }).every(na) && a.onCompleted();
          }, function(b) {
            a.onError(b);
          }, function() {
            g[c] = !0, g.every(na) && a.onCompleted();
          })), h[c] = j;
        }(i);
      return new nb(h);
    }, e);
  }, Qb.asObservable = function() {
    return new Sd(J(this), this);
  };
  var dd = function(a) {
    function b(b) {
      this.source = b, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new ed(a));
    }, b;
  }(cc),
      ed = function(a) {
        function b(b) {
          this._o = b, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          a.accept(this._o);
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._o.onCompleted();
        }, b;
      }($b);
  Qb.dematerialize = function() {
    return new dd(this);
  };
  var fd = function(a) {
    function b(b, c, d) {
      this.source = b, this.keyFn = c, this.comparer = d, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new gd(a, this.keyFn, this.comparer));
    }, b;
  }(cc),
      gd = function(a) {
        function b(b, c, d) {
          this.o = b, this.keyFn = c, this.comparer = d, this.hasCurrentKey = !1, this.currentKey = null, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          var b,
              c = a;
          return ta(this.keyFn) && (c = va(this.keyFn)(a), c === ua) ? this.o.onError(c.e) : this.hasCurrentKey && (b = va(this.comparer)(this.currentKey, c), b === ua) ? this.o.onError(b.e) : void(this.hasCurrentKey && b || (this.hasCurrentKey = !0, this.currentKey = c, this.o.onNext(a)));
        }, b.prototype.error = function(a) {
          this.o.onError(a);
        }, b.prototype.completed = function() {
          this.o.onCompleted();
        }, b;
      }($b);
  Qb.distinctUntilChanged = function(a, b) {
    return b || (b = pa), new fd(this, a, b);
  };
  var hd = function(a) {
    function b(b, c, d, e) {
      this.source = b, this._oN = c, this._oE = d, this._oC = e, a.call(this);
    }
    function c(a, b) {
      this.o = a, this.t = !b._oN || ta(b._oN) ? Zb(b._oN || ma, b._oE || ma, b._oC || ma) : b._oN, this.isStopped = !1, $b.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new c(a, this));
    }, lb(c, $b), c.prototype.next = function(a) {
      var b = va(this.t.onNext).call(this.t, a);
      b === ua && this.o.onError(b.e), this.o.onNext(a);
    }, c.prototype.error = function(a) {
      var b = va(this.t.onError).call(this.t, a);
      return b === ua ? this.o.onError(b.e) : void this.o.onError(a);
    }, c.prototype.completed = function() {
      var a = va(this.t.onCompleted).call(this.t);
      return a === ua ? this.o.onError(a.e) : void this.o.onCompleted();
    }, b;
  }(cc);
  Qb["do"] = Qb.tap = Qb.doAction = function(a, b, c) {
    return new hd(this, a, b, c);
  }, Qb.doOnNext = Qb.tapOnNext = function(a, b) {
    return this.tap("undefined" != typeof b ? function(c) {
      a.call(b, c);
    } : a);
  }, Qb.doOnError = Qb.tapOnError = function(a, b) {
    return this.tap(ma, "undefined" != typeof b ? function(c) {
      a.call(b, c);
    } : a);
  }, Qb.doOnCompleted = Qb.tapOnCompleted = function(a, b) {
    return this.tap(ma, null, "undefined" != typeof b ? function() {
      a.call(b);
    } : a);
  }, Qb["finally"] = function(a) {
    var b = this;
    return new Sd(function(c) {
      var d = va(b.subscribe).call(b, c);
      return d === ua ? (a(), e(d.e)) : qb(function() {
        var b = va(d.dispose).call(d);
        a(), b === ua && e(b.e);
      });
    }, this);
  };
  var id = function(a) {
    function b(b) {
      this.source = b, a.call(this);
    }
    function c(a) {
      this.o = a, this.isStopped = !1;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new c(a));
    }, c.prototype.onNext = ma, c.prototype.onError = function(a) {
      this.isStopped || (this.isStopped = !0, this.o.onError(a));
    }, c.prototype.onCompleted = function() {
      this.isStopped || (this.isStopped = !0, this.o.onCompleted());
    }, c.prototype.dispose = function() {
      this.isStopped = !0;
    }, c.prototype.fail = function(a) {
      return this.isStopped ? !1 : (this.isStopped = !0, this.observer.onError(a), !0);
    }, b;
  }(cc);
  Qb.ignoreElements = function() {
    return new id(this);
  };
  var jd = function(a) {
    function b(b, c) {
      this.source = b, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new kd(a));
    }, b;
  }(cc),
      kd = function(a) {
        function b(b) {
          this._o = b, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._o.onNext(Vb(a));
        }, b.prototype.error = function(a) {
          this._o.onNext(Wb(a)), this._o.onCompleted();
        }, b.prototype.completed = function() {
          this._o.onNext(Xb()), this._o.onCompleted();
        }, b;
      }($b);
  Qb.materialize = function() {
    return new jd(this);
  }, Qb.repeat = function(a) {
    return ic(this, a).concat();
  }, Qb.retry = function(a) {
    return ic(this, a).catchError();
  }, Qb.retryWhen = function(a) {
    return ic(this).catchErrorWhen(a);
  };
  var ld = function(a) {
    function b(b, c, d, e) {
      this.source = b, this.accumulator = c, this.hasSeed = d, this.seed = e, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new md(a, this));
    }, b;
  }(cc),
      md = function(a) {
        function b(b, c) {
          this._o = b, this._p = c, this._fn = c.accumulator, this._hs = c.hasSeed, this._s = c.seed, this._ha = !1, this._a = null, this._hv = !1, this._i = 0, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          return !this._hv && (this._hv = !0), this._ha ? this._a = va(this._fn)(this._a, a, this._i, this._p) : (this._a = this._hs ? va(this._fn)(this._s, a, this._i, this._p) : a, this._ha = !0), this._a === ua ? this._o.onError(this._a.e) : (this._o.onNext(this._a), void this._i++);
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          !this._hv && this._hs && this._o.onNext(this._s), this._o.onCompleted();
        }, b;
      }($b);
  Qb.scan = function() {
    var a,
        b = !1,
        c = arguments[0];
    return 2 === arguments.length && (b = !0, a = arguments[1]), new ld(this, c, b, a);
  };
  var nd = function(a) {
    function b(b, c) {
      this.source = b, this._c = c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new od(a, this._c));
    }, b;
  }(cc),
      od = function(a) {
        function b(b, c) {
          this._o = b, this._c = c, this._q = [], a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._q.push(a), this._q.length > this._c && this._o.onNext(this._q.shift());
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._o.onCompleted();
        }, b;
      }($b);
  Qb.skipLast = function(a) {
    if (0 > a)
      throw new Da;
    return new nd(this, a);
  }, Qb.startWith = function() {
    var a,
        b = 0;
    arguments.length && Cb(arguments[0]) ? (a = arguments[0], b = 1) : a = Gb;
    for (var c = [],
        d = b,
        e = arguments.length; e > d; d++)
      c.push(arguments[d]);
    return kc([wc(c, a), this]).concat();
  };
  var pd = function(a) {
    function b(b, c) {
      this._o = b, this._c = c, this._q = [], a.call(this);
    }
    return lb(b, a), b.prototype.next = function(a) {
      this._q.push(a), this._q.length > this._c && this._q.shift();
    }, b.prototype.error = function(a) {
      this._o.onError(a);
    }, b.prototype.completed = function() {
      for (; this._q.length > 0; )
        this._o.onNext(this._q.shift());
      this._o.onCompleted();
    }, b;
  }($b);
  Qb.takeLast = function(a) {
    if (0 > a)
      throw new Da;
    var b = this;
    return new Sd(function(c) {
      return b.subscribe(new pd(c, a));
    }, b);
  }, Qb.flatMapConcat = Qb.concatMap = function(a, b, c) {
    return new dc(this, a, b, c).merge(1);
  };
  var qd = function(a) {
    function b(b, c, d) {
      this.source = b, this.selector = Ma(c, d, 3), a.call(this);
    }
    function c(a, b) {
      return function(c, d, e) {
        return a.call(this, b.selector(c, d, e), d, e);
      };
    }
    function d(a, b, c) {
      this.o = a, this.selector = b, this.source = c, this.i = 0, $b.call(this);
    }
    return lb(b, a), b.prototype.internalMap = function(a, d) {
      return new b(this.source, c(a, this), d);
    }, b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new d(a, this.selector, this));
    }, lb(d, $b), d.prototype.next = function(a) {
      var b = va(this.selector)(a, this.i++, this.source);
      return b === ua ? this.o.onError(b.e) : void this.o.onNext(b);
    }, d.prototype.error = function(a) {
      this.o.onError(a);
    }, d.prototype.completed = function() {
      this.o.onCompleted();
    }, b;
  }(cc);
  Qb.map = Qb.select = function(a, b) {
    var c = "function" == typeof a ? a : function() {
      return a;
    };
    return this instanceof qd ? this.internalMap(c, b) : new qd(this, c, b);
  }, Qb.pluck = function() {
    var a = arguments.length,
        b = new Array(a);
    if (0 === a)
      throw new Error("List of properties cannot be empty.");
    for (var c = 0; a > c; c++)
      b[c] = arguments[c];
    return this.map(K(b, a));
  }, Qb.flatMap = Qb.selectMany = function(a, b, c) {
    return new dc(this, a, b, c).mergeAll();
  }, la.Observable.prototype.flatMapLatest = function(a, b, c) {
    return new dc(this, a, b, c).switchLatest();
  };
  var rd = function(a) {
    function b(b, c) {
      this.source = b, this.skipCount = c, a.call(this);
    }
    function c(a, b) {
      this.c = b, this.r = b, this.o = a, this.isStopped = !1;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new c(a, this.skipCount));
    }, c.prototype.onNext = function(a) {
      this.isStopped || (this.r <= 0 ? this.o.onNext(a) : this.r--);
    }, c.prototype.onError = function(a) {
      this.isStopped || (this.isStopped = !0, this.o.onError(a));
    }, c.prototype.onCompleted = function() {
      this.isStopped || (this.isStopped = !0, this.o.onCompleted());
    }, c.prototype.dispose = function() {
      this.isStopped = !0;
    }, c.prototype.fail = function(a) {
      return this.isStopped ? !1 : (this.isStopped = !0, this.o.onError(a), !0);
    }, b;
  }(cc);
  Qb.skip = function(a) {
    if (0 > a)
      throw new Da;
    return new rd(this, a);
  };
  var sd = function(a) {
    function b(b, c) {
      this.source = b, this._fn = c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new td(a, this));
    }, b;
  }(cc),
      td = function(a) {
        function b(b, c) {
          this._o = b, this._p = c, this._i = 0, this._r = !1, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          if (!this._r) {
            var b = va(this._p._fn)(a, this._i++, this._p);
            if (b === ua)
              return this._o.onError(b.e);
            this._r = !b;
          }
          this._r && this._o.onNext(a);
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._o.onCompleted();
        }, b;
      }($b);
  Qb.skipWhile = function(a, b) {
    var c = Ma(a, b, 3);
    return new sd(this, c);
  };
  var ud = function(a) {
    function b(b, c) {
      this.source = b, this.takeCount = c, a.call(this);
    }
    function c(a, b) {
      this.o = a, this.c = b, this.r = b, this.isStopped = !1;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new c(a, this.takeCount));
    }, c.prototype = {
      onNext: function(a) {
        this.isStopped || this.r-- > 0 && (this.o.onNext(a), this.r <= 0 && this.o.onCompleted());
      },
      onError: function(a) {
        this.isStopped || (this.isStopped = !0, this.o.onError(a));
      },
      onCompleted: function() {
        this.isStopped || (this.isStopped = !0, this.o.onCompleted());
      },
      dispose: function() {
        this.isStopped = !0;
      },
      fail: function(a) {
        return this.isStopped ? !1 : (this.isStopped = !0, this.o.onError(a), !0);
      }
    }, b;
  }(cc);
  Qb.take = function(a, b) {
    if (0 > a)
      throw new Da;
    return 0 === a ? qc(b) : new ud(this, a);
  };
  var vd = function(a) {
    function b(b, c) {
      this.source = b, this._fn = c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new wd(a, this));
    }, b;
  }(cc),
      wd = function(a) {
        function b(b, c) {
          this._o = b, this._p = c, this._i = 0, this._r = !0, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          return this._r && (this._r = va(this._p._fn)(a, this._i++, this._p), this._r === ua) ? this._o.onError(this._r.e) : void(this._r ? this._o.onNext(a) : this._o.onCompleted());
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._o.onCompleted();
        }, b;
      }($b);
  Qb.takeWhile = function(a, b) {
    var c = Ma(a, b, 3);
    return new vd(this, c);
  };
  var xd = function(a) {
    function b(b, c, d) {
      this.source = b, this.predicate = Ma(c, d, 3), a.call(this);
    }
    function c(a, b) {
      return function(c, d, e) {
        return b.predicate(c, d, e) && a.call(this, c, d, e);
      };
    }
    function d(a, b, c) {
      this.o = a, this.predicate = b, this.source = c, this.i = 0, $b.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new d(a, this.predicate, this));
    }, b.prototype.internalFilter = function(a, d) {
      return new b(this.source, c(a, this), d);
    }, lb(d, $b), d.prototype.next = function(a) {
      var b = va(this.predicate)(a, this.i++, this.source);
      return b === ua ? this.o.onError(b.e) : void(b && this.o.onNext(a));
    }, d.prototype.error = function(a) {
      this.o.onError(a);
    }, d.prototype.completed = function() {
      this.o.onCompleted();
    }, b;
  }(cc);
  Qb.filter = Qb.where = function(a, b) {
    return this instanceof xd ? this.internalFilter(a, b) : new xd(this, a, b);
  }, ac.fromCallback = function(a, b, c) {
    return function() {
      "undefined" == typeof b && (b = this);
      for (var d = arguments.length,
          e = new Array(d),
          f = 0; d > f; f++)
        e[f] = arguments[f];
      return L(a, b, c, e);
    };
  }, ac.fromNodeCallback = function(a, b, c) {
    return function() {
      "undefined" == typeof b && (b = this);
      for (var d = arguments.length,
          e = new Array(d),
          f = 0; d > f; f++)
        e[f] = arguments[f];
      return N(a, b, c, e);
    };
  }, Q.prototype.dispose = function() {
    this.isDisposed || (this._e.removeEventListener(this._n, this._fn, !1), this.isDisposed = !0);
  }, la.config.useNativeEvents = !1;
  var yd = function(a) {
    function b(b, c, d) {
      this._el = b, this._name = c, this._fn = d, a.call(this);
    }
    function c(a, b) {
      return function() {
        var c = arguments[0];
        return ta(b) && (c = va(b).apply(null, arguments), c === ua) ? a.onError(c.e) : void a.onNext(c);
      };
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return R(this._el, this._n, c(a, this._fn));
    }, b;
  }(cc);
  ac.fromEvent = function(a, b, c) {
    return a.addListener ? Ad(function(c) {
      a.addListener(b, c);
    }, function(c) {
      a.removeListener(b, c);
    }, c) : la.config.useNativeEvents || "function" != typeof a.on || "function" != typeof a.off ? new yd(a, b, c).publish().refCount() : Ad(function(c) {
      a.on(b, c);
    }, function(c) {
      a.off(b, c);
    }, c);
  };
  var zd = function(a) {
    function b(b, c, d) {
      this._add = b, this._del = c, this._fn = d, a.call(this);
    }
    function c(a, b) {
      return function() {
        var c = arguments[0];
        return ta(b) && (c = va(b).apply(null, arguments), c === ua) ? a.onError(c.e) : void a.onNext(c);
      };
    }
    function d(a, b, c) {
      this._del = a, this._fn = b, this._ret = c, this.isDisposed = !1;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = c(a, this._fn),
          e = this._add(b);
      return new d(this._del, b, e);
    }, d.prototype.dispose = function() {
      this.isDisposed || ta(this._del) && this._del(this._fn, this._ret);
    }, b;
  }(cc),
      Ad = ac.fromEventPattern = function(a, b, c) {
        return new zd(a, b, c).publish().refCount();
      },
      Bd = function(a) {
        function b(b, c) {
          this._p = b, this._s = c, a.call(this);
        }
        function c(a, b) {
          var c = b[0],
              d = b[1];
          c.onNext(d), c.onCompleted();
        }
        function d(a, b) {
          var c = b[0],
              d = b[1];
          c.onError(d);
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          var b = new vb,
              e = this;
          return this._p.then(function(d) {
            b.setDisposable(e._s.schedule([a, d], c));
          }, function(c) {
            b.setDisposable(e._s.schedule([a, c], d));
          }), b;
        }, b;
      }(cc),
      Cd = ac.fromPromise = function(a, b) {
        return b || (b = Nb), new Bd(a, b);
      };
  Qb.toPromise = function(a) {
    if (a || (a = la.config.Promise), !a)
      throw new Ea("Promise type not provided nor in Rx.config.Promise");
    var b = this;
    return new a(function(a, c) {
      var d;
      b.subscribe(function(a) {
        d = a;
      }, c, function() {
        a(d);
      });
    });
  }, ac.startAsync = function(a) {
    var b = va(a)();
    return b === ua ? Gc(b.e) : Cd(b);
  };
  var Dd = function(a) {
    function b(b, c, d) {
      this.source = b, this._fn1 = c, this._fn2 = d, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = this.source.multicast(this._fn1());
      return new xb(this._fn2(b).subscribe(a), b.connect());
    }, b;
  }(cc);
  Qb.multicast = function(a, b) {
    return ta(a) ? new Dd(this, a, b) : new Fd(this, a);
  }, Qb.publish = function(a) {
    return a && ta(a) ? this.multicast(function() {
      return new Vd;
    }, a) : this.multicast(new Vd);
  }, Qb.share = function() {
    return this.publish().refCount();
  }, Qb.publishLast = function(a) {
    return a && ta(a) ? this.multicast(function() {
      return new Wd;
    }, a) : this.multicast(new Wd);
  }, Qb.publishValue = function(a, b) {
    return 2 === arguments.length ? this.multicast(function() {
      return new Yd(b);
    }, a) : this.multicast(new Yd(a));
  }, Qb.shareValue = function(a) {
    return this.publishValue(a).refCount();
  }, Qb.replay = function(a, b, c, d) {
    return a && ta(a) ? this.multicast(function() {
      return new Zd(b, c, d);
    }, a) : this.multicast(new Zd(b, c, d));
  }, Qb.shareReplay = function(a, b, c) {
    return this.replay(null, a, b, c).refCount();
  };
  var Ed = function(a) {
    function b(b) {
      this.source = b, this._count = 0, this._connectableSubscription = null, a.call(this);
    }
    function c(a, b) {
      this._p = a, this._s = b, this.isDisposed = !1;
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = 1 === ++this._count,
          d = this.source.subscribe(a);
      return b && (this._connectableSubscription = this.source.connect()), new c(this, d);
    }, c.prototype.dispose = function() {
      this.isDisposed || (this.isDisposed = !0, this._s.dispose(), 0 === --this._p._count && this._p._connectableSubscription.dispose());
    }, b;
  }(cc),
      Fd = la.ConnectableObservable = function(a) {
        function b(b, c) {
          this.source = b, this._hasSubscription = !1, this._subscription = null, this._sourceObservable = b.asObservable(), this._subject = c, a.call(this);
        }
        function c(a) {
          this._p = a, this.isDisposed = !1;
        }
        return lb(b, a), c.prototype.dispose = function() {
          this.isDisposed || (this.isDisposed = !0, this._p._hasSubscription = !1);
        }, b.prototype.connect = function() {
          return this._hasSubscription || (this._hasSubscription = !0, this._subscription = new xb(this._sourceObservable.subscribe(this._subject), new c(this))), this._subscription;
        }, b.prototype._subscribe = function(a) {
          return this._subject.subscribe(a);
        }, b.prototype.refCount = function() {
          return new Ed(this);
        }, b;
      }(ac),
      Gd = function(a) {
        function b(b, c) {
          this._dt = b, this._s = c, a.call(this);
        }
        function c(a, b) {
          b.onNext(0), b.onCompleted();
        }
        return lb(b, a), b.prototype.subscribeCore = function(a) {
          return this._s.scheduleFuture(a, this._dt, c);
        }, b;
      }(cc),
      Hd = ac.interval = function(a, b) {
        return U(a, a, Cb(b) ? b : Nb);
      };
  ac.timer = function(b, c, d) {
    var e;
    return Cb(d) || (d = Nb), null != c && "number" == typeof c ? e = c : Cb(c) && (d = c), (b instanceof Date || "number" == typeof b) && e === a ? S(b, d) : b instanceof Date && e !== a ? T(b.getTime(), c, d) : U(b, e, d);
  };
  Qb.delay = function() {
    var a = arguments[0];
    if ("number" == typeof a || a instanceof Date) {
      var b = a,
          c = arguments[1];
      return Cb(c) || (c = Nb), b instanceof Date ? W(this, b, c) : V(this, b, c);
    }
    if (ac.isObservable(a) || ta(a))
      return X(this, a, arguments[1]);
    throw new Error("Invalid arguments");
  };
  var Id = function(a) {
    function b(b, c, d) {
      Cb(d) || (d = Nb), this.source = b, this._dt = c, this._s = d, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      var b = new wb;
      return new xb(this.source.subscribe(new Jd(a, this.source, this._dt, this._s, b)), b);
    }, b;
  }(cc),
      Jd = function(a) {
        function b(b, c, d, e, f) {
          this._o = b, this._s = c, this._d = d, this._scheduler = e, this._c = f, this._v = null, this._hv = !1, this._id = 0, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._hv = !0, this._v = a;
          var b = ++this._id,
              c = new vb;
          this._c.setDisposable(c), c.setDisposable(this._scheduler.scheduleFuture(this, this._d, function(c, d) {
            d._hv && d._id === b && d._o.onNext(a), d._hv = !1;
          }));
        }, b.prototype.error = function(a) {
          this._c.dispose(), this._o.onError(a), this._hv = !1, this._id++;
        }, b.prototype.completed = function() {
          this._c.dispose(), this._hv && this._o.onNext(this._v), this._o.onCompleted(), this._hv = !1, this._id++;
        }, b;
      }($b);
  Qb.debounce = function() {
    if (ta(arguments[0]))
      return Y(this, arguments[0]);
    if ("number" == typeof arguments[0])
      return new Id(this, arguments[0], arguments[1]);
    throw new Error("Invalid arguments");
  };
  var Kd = function(a) {
    function b(b, c) {
      this.source = b, this._s = c, a.call(this);
    }
    return lb(b, a), b.prototype.subscribeCore = function(a) {
      return this.source.subscribe(new Ld(a, this._s));
    }, b;
  }(cc),
      Ld = function(a) {
        function b(b, c) {
          this._o = b, this._s = c, a.call(this);
        }
        return lb(b, a), b.prototype.next = function(a) {
          this._o.onNext({
            value: a,
            timestamp: this._s.now()
          });
        }, b.prototype.error = function(a) {
          this._o.onError(a);
        }, b.prototype.completed = function() {
          this._o.onCompleted();
        }, b;
      }($b);
  Qb.timestamp = function(a) {
    return Cb(a) || (a = Nb), new Kd(this, a);
  }, Qb.sample = Qb.throttleLatest = function(a, b) {
    return Cb(b) || (b = Nb), "number" == typeof a ? Z(this, Hd(a, b)) : Z(this, a);
  };
  var Md = la.TimeoutError = function(a) {
    this.message = a || "Timeout has occurred", this.name = "TimeoutError", Error.call(this);
  };
  Md.prototype = Object.create(Error.prototype), Qb.timeout = function() {
    var a = arguments[0];
    if (a instanceof Date || "number" == typeof a)
      return _(this, a, arguments[1], arguments[2]);
    if (ac.isObservable(a) || ta(a))
      return $(this, a, arguments[1], arguments[2]);
    throw new Error("Invalid arguments");
  }, Qb.throttle = function(a, b) {
    Cb(b) || (b = Nb);
    var c = +a || 0;
    if (0 >= c)
      throw new RangeError("windowDuration cannot be less or equal zero.");
    var d = this;
    return new Sd(function(a) {
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
  var Nd = function(a) {
    function b(b, c) {
      this.source = b, this.controller = new Vd, c && c.subscribe ? this.pauser = this.controller.merge(c) : this.pauser = this.controller, a.call(this);
    }
    return lb(b, a), b.prototype._subscribe = function(a) {
      var b = this.source.publish(),
          c = b.subscribe(a),
          d = rb,
          e = this.pauser.distinctUntilChanged().subscribe(function(a) {
            a ? d = b.connect() : (d.dispose(), d = rb);
          });
      return new yb([c, d, e]);
    }, b.prototype.pause = function() {
      this.controller.onNext(!1);
    }, b.prototype.resume = function() {
      this.controller.onNext(!0);
    }, b;
  }(ac);
  Qb.pausable = function(a) {
    return new Nd(this, a);
  };
  var Od = function(b) {
    function c(a, c) {
      this.source = a, this.controller = new Vd, c && c.subscribe ? this.pauser = this.controller.merge(c) : this.pauser = this.controller, b.call(this);
    }
    return lb(c, b), c.prototype._subscribe = function(b) {
      function c() {
        for (; e.length > 0; )
          b.onNext(e.shift());
      }
      var d,
          e = [],
          f = aa(this.source, this.pauser.startWith(!1).distinctUntilChanged(), function(a, b) {
            return {
              data: a,
              shouldFire: b
            };
          }).subscribe(function(f) {
            d !== a && f.shouldFire !== d ? (d = f.shouldFire, f.shouldFire && c()) : (d = f.shouldFire, f.shouldFire ? b.onNext(f.data) : e.push(f.data));
          }, function(a) {
            c(), b.onError(a);
          }, function() {
            c(), b.onCompleted();
          });
      return f;
    }, c.prototype.pause = function() {
      this.controller.onNext(!1);
    }, c.prototype.resume = function() {
      this.controller.onNext(!0);
    }, c;
  }(ac);
  Qb.pausableBuffered = function(a) {
    return new Od(this, a);
  };
  var Pd = function(a) {
    function b(b, c, d) {
      a.call(this), this.subject = new Qd(c, d), this.source = b.multicast(this.subject).refCount();
    }
    return lb(b, a), b.prototype._subscribe = function(a) {
      return this.source.subscribe(a);
    }, b.prototype.request = function(a) {
      return this.subject.request(null == a ? -1 : a);
    }, b;
  }(ac),
      Qd = function(a) {
        function b(b, c) {
          null == b && (b = !0), a.call(this), this.subject = new Vd, this.enableQueue = b, this.queue = b ? [] : null, this.requestedCount = 0, this.requestedDisposable = null, this.error = null, this.hasFailed = !1, this.hasCompleted = !1, this.scheduler = c || Ib;
        }
        return lb(b, a), mb(b.prototype, Yb, {
          _subscribe: function(a) {
            return this.subject.subscribe(a);
          },
          onCompleted: function() {
            this.hasCompleted = !0, this.enableQueue && 0 !== this.queue.length ? this.queue.push(Rb.createOnCompleted()) : (this.subject.onCompleted(), this.disposeCurrentRequest());
          },
          onError: function(a) {
            this.hasFailed = !0, this.error = a, this.enableQueue && 0 !== this.queue.length ? this.queue.push(Rb.createOnError(a)) : (this.subject.onError(a), this.disposeCurrentRequest());
          },
          onNext: function(a) {
            this.requestedCount <= 0 ? this.enableQueue && this.queue.push(Rb.createOnNext(a)) : (0 === this.requestedCount-- && this.disposeCurrentRequest(), this.subject.onNext(a));
          },
          _processRequest: function(a) {
            if (this.enableQueue)
              for (; this.queue.length > 0 && (a > 0 || "N" !== this.queue[0].kind); ) {
                var b = this.queue.shift();
                b.accept(this.subject), "N" === b.kind ? a-- : (this.disposeCurrentRequest(), this.queue = []);
              }
            return a;
          },
          request: function(a) {
            this.disposeCurrentRequest();
            var b = this;
            return this.requestedDisposable = this.scheduler.schedule(a, function(a, c) {
              var d = b._processRequest(c),
                  e = b.hasCompleted || b.hasFailed;
              return !e && d > 0 ? (b.requestedCount = d, qb(function() {
                b.requestedCount = 0;
              })) : void 0;
            }), this.requestedDisposable;
          },
          disposeCurrentRequest: function() {
            this.requestedDisposable && (this.requestedDisposable.dispose(), this.requestedDisposable = null);
          }
        }), b;
      }(ac);
  Qb.controlled = function(a, b) {
    return a && Cb(a) && (b = a, a = !0), null == a && (a = !0), new Pd(this, a, b);
  }, Qb.pipe = function(a) {
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
  };
  var Rd = function(a) {
    function b(b, c) {
      this._o = b, this._xform = c, a.call(this);
    }
    return lb(b, a), b.prototype.next = function(a) {
      var b = va(this._xform["@@transducer/step"]).call(this._xform, this._o, a);
      b === ua && this._o.onError(b.e);
    }, b.prototype.error = function(a) {
      this._o.onError(a);
    }, b.prototype.completed = function() {
      this._xform["@@transducer/result"](this._o);
    }, b;
  }($b);
  Qb.transduce = function(a) {
    var b = this;
    return new Sd(function(c) {
      var d = a(ba(c));
      return b.subscribe(new Rd(c, d));
    }, b);
  };
  var Sd = la.AnonymousObservable = function(a) {
    function b(a) {
      return a && ta(a.dispose) ? a : ta(a) ? qb(a) : rb;
    }
    function c(a, c) {
      var d = c[0],
          f = c[1],
          g = va(f.__subscribe).call(f, d);
      g !== ua || d.fail(ua.e) || e(ua.e), d.setDisposable(b(g));
    }
    function d(b, c) {
      this.source = c, this.__subscribe = b, a.call(this);
    }
    return lb(d, a), d.prototype._subscribe = function(a) {
      var b = new Td(a),
          d = [b, this];
      return Ib.scheduleRequired() ? Ib.schedule(d, c) : c(null, d), b;
    }, d;
  }(ac),
      Td = function(a) {
        function b(b) {
          a.call(this), this.observer = b, this.m = new vb;
        }
        lb(b, a);
        var c = b.prototype;
        return c.next = function(a) {
          var b = va(this.observer.onNext).call(this.observer, a);
          b === ua && (this.dispose(), e(b.e));
        }, c.error = function(a) {
          var b = va(this.observer.onError).call(this.observer, a);
          this.dispose(), b === ua && e(b.e);
        }, c.completed = function() {
          var a = va(this.observer.onCompleted).call(this.observer);
          this.dispose(), a === ua && e(a.e);
        }, c.setDisposable = function(a) {
          this.m.setDisposable(a);
        }, c.getDisposable = function() {
          return this.m.getDisposable();
        }, c.dispose = function() {
          a.prototype.dispose.call(this), this.m.dispose();
        }, b;
      }($b),
      Ud = function(a, b) {
        this._s = a, this._o = b;
      };
  Ud.prototype.dispose = function() {
    if (!this._s.isDisposed && null !== this._o) {
      var a = this._s.observers.indexOf(this._o);
      this._s.observers.splice(a, 1), this._o = null;
    }
  };
  var Vd = la.Subject = function(a) {
    function b() {
      a.call(this), this.isDisposed = !1, this.isStopped = !1, this.observers = [], this.hasError = !1;
    }
    return lb(b, a), mb(b.prototype, Yb.prototype, {
      _subscribe: function(a) {
        return tb(this), this.isStopped ? this.hasError ? (a.onError(this.error), rb) : (a.onCompleted(), rb) : (this.observers.push(a), new Ud(this, a));
      },
      hasObservers: function() {
        return this.observers.length > 0;
      },
      onCompleted: function() {
        if (tb(this), !this.isStopped) {
          this.isStopped = !0;
          for (var a = 0,
              b = c(this.observers),
              d = b.length; d > a; a++)
            b[a].onCompleted();
          this.observers.length = 0;
        }
      },
      onError: function(a) {
        if (tb(this), !this.isStopped) {
          this.isStopped = !0, this.error = a, this.hasError = !0;
          for (var b = 0,
              d = c(this.observers),
              e = d.length; e > b; b++)
            d[b].onError(a);
          this.observers.length = 0;
        }
      },
      onNext: function(a) {
        if (tb(this), !this.isStopped)
          for (var b = 0,
              d = c(this.observers),
              e = d.length; e > b; b++)
            d[b].onNext(a);
      },
      dispose: function() {
        this.isDisposed = !0, this.observers = null;
      }
    }), b.create = function(a, b) {
      return new Xd(a, b);
    }, b;
  }(ac),
      Wd = la.AsyncSubject = function(a) {
        function b() {
          a.call(this), this.isDisposed = !1, this.isStopped = !1, this.hasValue = !1, this.observers = [], this.hasError = !1;
        }
        return lb(b, a), mb(b.prototype, Yb.prototype, {
          _subscribe: function(a) {
            return tb(this), this.isStopped ? (this.hasError ? a.onError(this.error) : this.hasValue ? (a.onNext(this.value), a.onCompleted()) : a.onCompleted(), rb) : (this.observers.push(a), new Ud(this, a));
          },
          hasObservers: function() {
            return tb(this), this.observers.length > 0;
          },
          onCompleted: function() {
            var a,
                b;
            if (tb(this), !this.isStopped) {
              this.isStopped = !0;
              var d = c(this.observers),
                  b = d.length;
              if (this.hasValue)
                for (a = 0; b > a; a++) {
                  var e = d[a];
                  e.onNext(this.value), e.onCompleted();
                }
              else
                for (a = 0; b > a; a++)
                  d[a].onCompleted();
              this.observers.length = 0;
            }
          },
          onError: function(a) {
            if (tb(this), !this.isStopped) {
              this.isStopped = !0, this.hasError = !0, this.error = a;
              for (var b = 0,
                  d = c(this.observers),
                  e = d.length; e > b; b++)
                d[b].onError(a);
              this.observers.length = 0;
            }
          },
          onNext: function(a) {
            tb(this), this.isStopped || (this.value = a, this.hasValue = !0);
          },
          dispose: function() {
            this.isDisposed = !0, this.observers = null, this.error = null, this.value = null;
          }
        }), b;
      }(ac),
      Xd = la.AnonymousSubject = function(a) {
        function b(b, c) {
          this.observer = b, this.observable = c, a.call(this);
        }
        return lb(b, a), mb(b.prototype, Yb.prototype, {
          _subscribe: function(a) {
            return this.observable.subscribe(a);
          },
          onCompleted: function() {
            this.observer.onCompleted();
          },
          onError: function(a) {
            this.observer.onError(a);
          },
          onNext: function(a) {
            this.observer.onNext(a);
          }
        }), b;
      }(ac),
      Yd = la.BehaviorSubject = function(a) {
        function b(b) {
          a.call(this), this.value = b, this.observers = [], this.isDisposed = !1, this.isStopped = !1, this.hasError = !1;
        }
        return lb(b, a), mb(b.prototype, Yb.prototype, {
          _subscribe: function(a) {
            return tb(this), this.isStopped ? (this.hasError ? a.onError(this.error) : a.onCompleted(), rb) : (this.observers.push(a), a.onNext(this.value), new Ud(this, a));
          },
          getValue: function() {
            if (tb(this), this.hasError)
              throw this.error;
            return this.value;
          },
          hasObservers: function() {
            return this.observers.length > 0;
          },
          onCompleted: function() {
            if (tb(this), !this.isStopped) {
              this.isStopped = !0;
              for (var a = 0,
                  b = c(this.observers),
                  d = b.length; d > a; a++)
                b[a].onCompleted();
              this.observers.length = 0;
            }
          },
          onError: function(a) {
            if (tb(this), !this.isStopped) {
              this.isStopped = !0, this.hasError = !0, this.error = a;
              for (var b = 0,
                  d = c(this.observers),
                  e = d.length; e > b; b++)
                d[b].onError(a);
              this.observers.length = 0;
            }
          },
          onNext: function(a) {
            if (tb(this), !this.isStopped) {
              this.value = a;
              for (var b = 0,
                  d = c(this.observers),
                  e = d.length; e > b; b++)
                d[b].onNext(a);
            }
          },
          dispose: function() {
            this.isDisposed = !0, this.observers = null, this.value = null, this.error = null;
          }
        }), b;
      }(ac),
      Zd = la.ReplaySubject = function(a) {
        function b(a, b) {
          return qb(function() {
            b.dispose(), !a.isDisposed && a.observers.splice(a.observers.indexOf(b), 1);
          });
        }
        function d(b, c, d) {
          this.bufferSize = null == b ? e : b, this.windowSize = null == c ? e : c, this.scheduler = d || Ib, this.q = [], this.observers = [], this.isStopped = !1, this.isDisposed = !1, this.hasError = !1, this.error = null, a.call(this);
        }
        var e = Math.pow(2, 53) - 1;
        return lb(d, a), mb(d.prototype, Yb.prototype, {
          _subscribe: function(a) {
            tb(this);
            var c = new bc(this.scheduler, a),
                d = b(this, c);
            this._trim(this.scheduler.now()), this.observers.push(c);
            for (var e = 0,
                f = this.q.length; f > e; e++)
              c.onNext(this.q[e].value);
            return this.hasError ? c.onError(this.error) : this.isStopped && c.onCompleted(), c.ensureActive(), d;
          },
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
            if (tb(this), !this.isStopped) {
              var b = this.scheduler.now();
              this.q.push({
                interval: b,
                value: a
              }), this._trim(b);
              for (var d = 0,
                  e = c(this.observers),
                  f = e.length; f > d; d++) {
                var g = e[d];
                g.onNext(a), g.ensureActive();
              }
            }
          },
          onError: function(a) {
            if (tb(this), !this.isStopped) {
              this.isStopped = !0, this.error = a, this.hasError = !0;
              var b = this.scheduler.now();
              this._trim(b);
              for (var d = 0,
                  e = c(this.observers),
                  f = e.length; f > d; d++) {
                var g = e[d];
                g.onError(a), g.ensureActive();
              }
              this.observers.length = 0;
            }
          },
          onCompleted: function() {
            if (tb(this), !this.isStopped) {
              this.isStopped = !0;
              var a = this.scheduler.now();
              this._trim(a);
              for (var b = 0,
                  d = c(this.observers),
                  e = d.length; e > b; b++) {
                var f = d[b];
                f.onCompleted(), f.ensureActive();
              }
              this.observers.length = 0;
            }
          },
          dispose: function() {
            this.isDisposed = !0, this.observers = null;
          }
        }), d;
      }(ac);
  la.Pauser = function(a) {
    function b() {
      a.call(this);
    }
    return lb(b, a), b.prototype.pause = function() {
      this.onNext(!1);
    }, b.prototype.resume = function() {
      this.onNext(!0);
    }, b;
  }(Vd), "function" == typeof define && "object" == typeof define.amd && define.amd ? (ka.Rx = la, define("3", [], function() {
    return la;
  })) : da && ea ? ia ? (ea.exports = la).Rx = la : da.Rx = la : ka.Rx = la;
  var $d = j();
}).call(this);

_removeDefine();
})();
$__System.registerDynamic("4", ["3"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var Rx = req('3');
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

$__System.registerDynamic("5", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ConnexionEvent = function(origin) {
    this.emitter = origin && origin.emitter || '';
    this.scope = origin && origin.scope || '';
    this.isCanceled = false;
    this.type = (origin && origin.type) || '*';
    this.timeStamp = (origin && ('timeStamp' in origin)) ? origin.timeStamp : new Date().getTime();
    this.detail = origin && origin.detail;
    this.detail = (this.detail && typeof this.detail === 'object') ? this.detail : {};
    this.key = ConnexionEvent.key;
  };
  ConnexionEvent.prototype.cancel = function() {
    this.isCanceled = true;
  };
  ConnexionEvent.key = Math.round(Math.random() * Math.pow(10, 15));
  module.exports = ConnexionEvent;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", [], true, function(req, exports, module) {
  ;
  var global = this,
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
      return;
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
      return;
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

$__System.registerDynamic("7", ["6", "5", "8", "4", "2"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var setAsyncTask = req('6').setAsyncTask,
      ConnexionEvent = req('5'),
      environment = req('8'),
      EventStream = req('4'),
      es6collections = req('2'),
      WeakMap = es6collections.WeakMap || environment.global.WeakMap,
      isNodeJs = environment.isNodeJs;
  function createObserver(callback, context) {
    var observer;
    if (typeof context === 'object' && context) {
      observer = function(event) {
        if (event.isCanceled) {
          return;
        }
        context.__handler__ = callback;
        context.__handler__(event.detail, event);
        context.__handler__ = undefined;
      };
    } else {
      observer = function(event) {
        if (event.isCanceled) {
          return;
        }
        callback(event.detail, event);
      };
    }
    return observer;
  }
  function createAsyncObserver(callback, context) {
    var observer;
    if (typeof context === 'object' && context) {
      observer = function(event) {
        if (event.isCanceled) {
          return;
        }
        setAsyncTask(function() {
          context.__handler__ = callback;
          context.__handler__(event.detail, event);
          context.__handler__ = undefined;
        });
      };
    } else {
      observer = function(event) {
        if (event.isCanceled) {
          return;
        }
        setAsyncTask(function() {
          callback(event.detail, event);
        });
      };
    }
    return observer;
  }
  function ensureStreamExists(emitter, name) {
    var stream = emitter.subjects[name];
    if (!stream) {
      stream = new EventStream(new ConnexionEvent({
        type: name,
        timeStamp: 0
      }));
      emitter.subscriptions[name] = new WeakMap();
      emitter.subjects[name] = stream;
    }
    return stream;
  }
  function ensureStreamDestroyed(emitter, name) {
    var stream = emitter.subjects[name];
    if (stream) {
      emitter.subscriptions[name] = null;
      emitter.subjects[name] = null;
    }
    return stream;
  }
  var Emitter = function() {
    this.subjects = Object.create(null);
    this.subscriptions = Object.create(null);
  };
  Emitter.prototype.emit = function(eventType, detail) {
    var stream,
        commonStream,
        eventData = eventType,
        event;
    if ((typeof eventType === 'string') || (eventType instanceof String)) {
      event = new ConnexionEvent({
        type: eventType,
        detail: detail,
        scope: isNodeJs ? 'nodejs' : 'window',
        emitter: isNodeJs ? 'nodejs' : (environment.global.name || '')
      });
    } else if ((typeof eventData === 'object') && !(eventData instanceof Array)) {
      event = new ConnexionEvent(eventData);
      eventType = event.type;
    }
    stream = ensureStreamExists(this, eventType);
    commonStream = ensureStreamExists(this, '*');
    setAsyncTask(stream.emit.bind(stream, event));
    if (eventType !== '*') {
      setAsyncTask(commonStream.emit.bind(commonStream, event));
    }
    return event;
  };
  Emitter.prototype.listen = function(eventType, handler, context) {
    var listeners,
        stream,
        observer,
        subscription;
    if (typeof eventType === 'object' && eventType) {
      listeners = eventType;
      for (eventType in listeners) {
        this.listen(eventType, listeners[eventType]);
      }
    } else if (eventType && handler) {
      stream = ensureStreamExists(this, eventType);
      observer = createObserver(handler, context);
      subscription = context ? stream.listenAfter(observer) : stream.listen(observer);
      listeners = this.subscriptions[eventType].get(handler) || [];
      listeners.push(subscription);
      this.subscriptions[eventType].set(handler, listeners);
      subscription.callback = handler;
    }
    return subscription;
  };
  Emitter.prototype.observe = function(eventType, handler, context) {
    var listeners,
        stream,
        observer,
        subscription;
    if (typeof eventType === 'object' && eventType) {
      listeners = eventType;
      for (eventType in listeners) {
        this.listen(eventType, listeners[eventType]);
      }
    } else if (eventType && handler) {
      stream = ensureStreamExists(this, eventType);
      observer = createAsyncObserver(handler, context);
      subscription = stream.observe(observer);
      listeners = this.subscriptions[eventType].get(handler) || [];
      listeners.push(subscription);
      this.subscriptions[eventType].set(handler, listeners);
      subscription.callback = handler;
    }
    return subscription;
  };
  Emitter.prototype.unsubscribe = function(eventType, handler) {
    var listeners,
        stream,
        streams,
        subscription,
        subscriptions,
        i;
    if (!eventType && !handler) {
      streams = this.subjects;
      for (eventType in streams) {
        this.unsubscribe(eventType);
      }
    } else if (typeof eventType === 'object' && eventType) {
      listeners = eventType;
      for (eventType in listeners) {
        this.unsubscribe(eventType, listeners[eventType]);
      }
    } else if (eventType && !handler) {
      stream = this.subjects[eventType];
      if (stream) {
        stream.dispose();
        ensureStreamDestroyed(this, eventType);
      }
    } else if (eventType && handler) {
      subscriptions = this.subscriptions[eventType];
      if (subscriptions) {
        if ('dispose' in handler) {
          subscription = handler;
          handler = subscription.callback;
          subscription.dispose();
          subscription.callback = undefined;
          listeners = subscriptions.get(handler);
          if (listeners) {
            i = -1;
            while (++i in listeners) {
              if (subscription === listeners[i]) {
                listeners.splice(i, 1);
                break;
              }
            }
          }
        } else {
          listeners = subscriptions.get(handler);
          if (listeners) {
            i = -1;
            while (++i in listeners) {
              subscription = listeners[i];
              subscription.dispose();
              subscription.callback = undefined;
            }
            subscriptions.delete(handler);
          }
        }
      }
    }
    return this;
  };
  module.exports = new Emitter();
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8", [], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var __filename = module.id,
      __dirname = module.id.split('/').splice(0, module.id.split('/').length - 1).join('/');
  (function(self, nodeGlobal, browserWindow, undefined) {
    'use strict';
    var window = self.window || browserWindow || {},
        document = window.document || {},
        location = window.location || {},
        global = nodeGlobal || (('top' in window) ? (window.top.global || {}) : {}),
        isNodeJs = ('require' in global) && ('process' in global) && (typeof __dirname !== 'undefined') && (global.global === global);
    if (!('head' in document)) {
      document.head = (document.getElementsByTagName && document.getElementsByTagName('head')[0]) || document.documentElement;
    }
    if ('createElement' in document) {
      document.createElement('template');
      document.createElement('content');
    }
    exports.window = window;
    exports.global = global;
    exports.location = location;
    exports.isNodeJs = isNodeJs;
    exports.undefined = undefined;
  }(this, (typeof global !== 'undefined') ? global : null, (typeof window !== 'undefined') ? window : null));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", ["8", "7", "5"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var environment = req('8'),
      emitter = req('7'),
      event = req('5');
  var channel = exports,
      eventKey = event.key,
      emitterEmit = emitter.emit,
      globalScope = environment.global,
      isNodeJs = environment.isNodeJs;
  channel.getAllChildWindows = function(topWin) {
    var wins = [],
        frames = topWin.frames,
        win,
        i = frames.length;
    while (i--) {
      win = frames[i];
      wins.push(win);
      wins = wins.concat(channel.getAllChildWindows(win));
    }
    return wins;
  };
  channel.getCurrentNWWindow = function() {
    return new Promise(function(resolve, reject) {
      if (globalScope.process) {
        var uiTimeoutId = setInterval(function() {
          if (globalScope.window) {
            clearInterval(uiTimeoutId);
            var gui = globalScope.window.require('nw.gui');
            var win = gui.Window.get();
            resolve(win);
          }
        }, 10);
      } else {
        reject(new Error('Not a Node-Webkit environment'));
      }
    });
  };
  channel.sendMessage = function(connexionMessage) {
    var browserWindow = globalScope.window || {},
        location = browserWindow.location,
        origin = location && (location.origin || (location.protocol + '//' + location.host)) || '*',
        browserFrames = browserWindow.top && [browserWindow.top].concat(channel.getAllChildWindows(browserWindow.top)) || [];
    origin = '*';
    browserFrames.forEach(function(win) {
      try {
        win.postMessage(connexionMessage, origin);
      } catch (err) {
        console.error(err, connexionMessage);
      }
    });
  };
  channel.sendEvent = function(event) {
    var connexionMessage = channel._createEvent(event);
    channel.sendMessage(connexionMessage);
  };
  channel.sendSetup = function(setup) {
    var connexionMessage = channel._createSetup(setup);
    channel.sendMessage(connexionMessage);
  };
  channel.sendSetupResponse = function(setup) {
    var connexionMessage = channel._createSetupResponse(setup);
    channel.sendMessage(connexionMessage);
  };
  channel.onMessage = function(handler, messageCriteria, once) {
    var browserWindow = globalScope.window;
    if (browserWindow && browserWindow.addEventListener && typeof handler === 'function') {
      browserWindow.addEventListener('message', function onmessage(e) {
        var message = e.data,
            data,
            setup,
            setupResponse;
        if (!message) {
          return;
        }
        if (typeof message === 'string') {
          message = JSON.parse(message);
        }
        if (messageCriteria in message) {
          data = message[messageCriteria];
          if (data && ((('key' in data) && data.key !== eventKey) || (data.length && data[0].event.key !== eventKey))) {
            handler(data);
            if (once) {
              browserWindow.removeEventListener('message', onmessage, false);
            }
          }
        }
      }, false);
    }
  };
  channel.onEvent = function(handler) {
    return channel.onMessage(function(event) {
      if (event && event.key !== eventKey) {
        handler(event);
      }
    }, '__connexionEvent__');
  };
  channel.onSetup = function(handler) {
    return channel.onMessage(handler, '__connexionSetup__');
  };
  channel.onceSetupResponse = function(handler) {
    return channel.onMessage(handler, '__connexionSetupResponse__', true);
  };
  channel.invokeEvent = function(event) {
    return emitterEmit.call(emitter, event);
  };
  channel._createEvent = function(event) {
    var data = {__connexionEvent__: event};
    return JSON.stringify(data);
  };
  channel._createSetup = function(setupData) {
    var data = {__connexionSetup__: [{event: {key: eventKey}}]};
    return JSON.stringify(data);
  };
  channel._createSetupResponse = function(setupData) {
    var data = {__connexionSetupResponse__: setupData};
    return JSON.stringify(data);
  };
  channel.getStreamsData = function() {
    var eventStreams = emitter.subjects,
        eventTypes = Object.keys(emitter.subjects);
    return eventTypes.map(function(eventType) {
      var stream = eventStreams[eventType];
      return {
        name: eventType,
        event: stream.observable.value
      };
    });
  };
  channel.setStreamsData = function(streamsData) {
    var eventStreams = emitter.subjects,
        eventTypes = Object.keys(emitter.subjects);
    streamsData.forEach(function(data) {
      var name = data.name,
          event = data.event,
          stream,
          streamValue;
      if (!name || name === '*') {
        return;
      }
      if (!event.timeStamp) {
        return;
      }
      if (!(name in eventStreams)) {
        channel.invokeEvent(event);
      } else {
        stream = eventStreams[name];
        streamValue = stream.observable.value;
        if (event.timeStamp > streamValue.timeStamp) {
          channel.invokeEvent(event);
        }
      }
    });
  };
  channel.attachMessageHandlers = function() {
    channel.onEvent(channel.invokeEvent);
    channel.onSetup(function(setup) {
      channel.sendSetupResponse(channel.getStreamsData());
      channel.setStreamsData(setup);
    });
    channel.onceSetupResponse(channel.setStreamsData);
  };
  channel.sendSetup(channel.getStreamsData());
  emitter.emit = function(type, detail) {
    var event = emitterEmit.call(emitter, type, detail);
    channel.sendEvent(event);
  };
  if (isNodeJs) {
    channel.getCurrentNWWindow().then(function(win) {
      win.on('loaded', function(e) {
        var browserWindow = globalScope.window;
        if (!browserWindow.__ConnexionNodeChannel__) {
          browserWindow.__ConnexionNodeChannel__ = true;
          channel.attachMessageHandlers();
        }
      });
    });
  } else {
    channel.attachMessageHandlers();
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1", ["9", "8", "7"], true, function(req, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'format cjs';
  'use strict';
  var connexion = exports;
  connexion.version = '0.2.2';
  connexion.chanel = req('9');
  var DOMWindow = req('8').window,
      emitter = req('7');
  connexion.listen = function(type, handler) {
    emitter.listen(type, handler);
    return this;
  };
  connexion.observe = function(type, handler) {
    emitter.observe(type, handler);
    return this;
  };
  connexion.unsubscribe = function(type, handler) {
    emitter.unsubscribe(type, handler);
    return this;
  };
  connexion.emit = function(type, detail) {
    emitter.emit(type, detail);
    return this;
  };
  DOMWindow.connexion = connexion;
  global.define = __define;
  return module.exports;
});

})
(function(factory) {
  if (typeof define == 'function' && define.amd)
    define([], factory);
  else
    factory();
});
//# sourceMappingURL=connexion.js.map