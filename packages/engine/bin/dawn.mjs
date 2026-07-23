#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "node_modules/graceful-fs/polyfills.js"(exports, module) {
    var constants3 = __require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module.exports = patch;
    function patch(fs) {
      if (constants3.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs);
      }
      if (!fs.lutimes) {
        patchLutimes(fs);
      }
      fs.chown = chownFix(fs.chown);
      fs.fchown = chownFix(fs.fchown);
      fs.lchown = chownFix(fs.lchown);
      fs.chmod = chmodFix(fs.chmod);
      fs.fchmod = chmodFix(fs.fchmod);
      fs.lchmod = chmodFix(fs.lchmod);
      fs.chownSync = chownFixSync(fs.chownSync);
      fs.fchownSync = chownFixSync(fs.fchownSync);
      fs.lchownSync = chownFixSync(fs.lchownSync);
      fs.chmodSync = chmodFixSync(fs.chmodSync);
      fs.fchmodSync = chmodFixSync(fs.fchmodSync);
      fs.lchmodSync = chmodFixSync(fs.lchmodSync);
      fs.stat = statFix(fs.stat);
      fs.fstat = statFix(fs.fstat);
      fs.lstat = statFix(fs.lstat);
      fs.statSync = statFixSync(fs.statSync);
      fs.fstatSync = statFixSync(fs.fstatSync);
      fs.lstatSync = statFixSync(fs.lstatSync);
      if (fs.chmod && !fs.lchmod) {
        fs.lchmod = function(path, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchmodSync = function() {
        };
      }
      if (fs.chown && !fs.lchown) {
        fs.lchown = function(path, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs.rename = typeof fs.rename !== "function" ? fs.rename : function(fs$rename) {
          function rename(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename, fs$rename);
          return rename;
        }(fs.rename);
      }
      fs.read = typeof fs.read !== "function" ? fs.read : function(fs$read) {
        function read(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
        return read;
      }(fs.read);
      fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : /* @__PURE__ */ function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      }(fs.readSync);
      function patchLchmod(fs2) {
        fs2.lchmod = function(path, mode, callback) {
          fs2.open(
            path,
            constants3.O_WRONLY | constants3.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs2.fchmod(fd, mode, function(err2) {
                fs2.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs2.lchmodSync = function(path, mode) {
          var fd = fs2.openSync(path, constants3.O_WRONLY | constants3.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs2.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs2) {
        if (constants3.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
          fs2.lutimes = function(path, at, mt, cb) {
            fs2.open(path, constants3.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path, at, mt) {
            var fd = fs2.openSync(path, constants3.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs2.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs2.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs2.futimes) {
          fs2.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs2.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "node_modules/graceful-fs/legacy-streams.js"(exports, module) {
    var Stream = __require("stream").Stream;
    module.exports = legacy;
    function legacy(fs) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path, options);
        Stream.call(this);
        var self = this;
        this.path = path;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self._read();
          });
          return;
        }
        fs.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self.emit("error", err);
            self.readable = false;
            return;
          }
          self.fd = fd;
          self.emit("open", fd);
          self._read();
        });
      }
      function WriteStream(path, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path, options);
        Stream.call(this);
        this.path = path;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "node_modules/graceful-fs/clone.js"(exports, module) {
    "use strict";
    module.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "node_modules/graceful-fs/graceful-fs.js"(exports, module) {
    var fs = __require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util = __require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = Symbol.for("graceful-fs.queue");
      previousSymbol = Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util.debuglog)
      debug = util.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util.format.apply(util, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs, queue);
      fs.close = function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      }(fs.close);
      fs.closeSync = function(fs$closeSync) {
        function closeSync3(fd) {
          fs$closeSync.apply(fs, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync3, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync3;
      }(fs.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs[gracefulQueue]);
          __require("assert").equal(fs[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs[gracefulQueue]);
    }
    module.exports = patch(clone(fs));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
      module.exports = patch(fs);
      fs.__patched = true;
    }
    function patch(fs2) {
      polyfills(fs2);
      fs2.gracefulify = patch;
      fs2.createReadStream = createReadStream;
      fs2.createWriteStream = createWriteStream;
      var fs$readFile = fs2.readFile;
      fs2.readFile = readFile;
      function readFile(path, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path, options, cb);
        function go$readFile(path2, options2, cb2, startTime) {
          return fs$readFile(path2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs2.writeFile;
      fs2.writeFile = writeFile;
      function writeFile(path, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path, data, options, cb);
        function go$writeFile(path2, data2, options2, cb2, startTime) {
          return fs$writeFile(path2, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs2.appendFile;
      if (fs$appendFile)
        fs2.appendFile = appendFile;
      function appendFile(path, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path, data, options, cb);
        function go$appendFile(path2, data2, options2, cb2, startTime) {
          return fs$appendFile(path2, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs2.copyFile;
      if (fs$copyFile)
        fs2.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs2.readdir;
      fs2.readdir = readdir;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir(path, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path2, options2, cb2, startTime) {
          return fs$readdir(path2, fs$readdirCallback(
            path2,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path2, options2, cb2, startTime) {
          return fs$readdir(path2, options2, fs$readdirCallback(
            path2,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path, options, cb);
        function fs$readdirCallback(path2, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path2, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs2);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs2.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs2.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs2, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs2, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs2, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs2, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path, options) {
        return new fs2.ReadStream(path, options);
      }
      function createWriteStream(path, options) {
        return new fs2.WriteStream(path, options);
      }
      var fs$open = fs2.open;
      fs2.open = open;
      function open(path, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path, flags, mode, cb);
        function go$open(path2, flags2, mode2, cb2, startTime) {
          return fs$open(path2, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path2, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs2;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs[gracefulQueue].length; ++i) {
        if (fs[gracefulQueue][i].length > 2) {
          fs[gracefulQueue][i][3] = now;
          fs[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs[gracefulQueue].length === 0)
        return;
      var elem = fs[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/retry/lib/retry_operation.js"(exports, module) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts;
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(this._errors.length - 1, this._errors.length);
          this._timeouts = this._cachedTimeouts.slice(0);
          timeout = this._timeouts.shift();
        } else {
          return false;
        }
      }
      var self = this;
      var timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/retry/lib/retry.js"(exports) {
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && options.forever,
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper(original2) {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }.bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "node_modules/signal-exit/signals.js"(exports, module) {
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "node_modules/signal-exit/index.js"(exports, module) {
    var process2 = global.process;
    var processOk = function(process3) {
      return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
    };
    if (!processOk(process2)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals();
      isWin = /^win/i.test(process2.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process2.__signal_exit_emitter__) {
        emitter = process2.__signal_exit_emitter__;
      } else {
        emitter = process2.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(global.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        };
        emitter.on(ev, cb);
        return remove;
      };
      unload = function unload2() {
        if (!loaded || !processOk(global.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process2.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process2.emit = originalProcessEmit;
        process2.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      };
      module.exports.unload = unload;
      emit = function emit2(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      };
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = function listener() {
          if (!processOk(global.process)) {
            return;
          }
          var listeners = process2.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit("exit", null, sig);
            emit("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process2.kill(process2.pid, sig);
          }
        };
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = function load2() {
        if (loaded || !processOk(global.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process2.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process2.emit = processEmit;
        process2.reallyExit = processReallyExit;
      };
      module.exports.load = load;
      originalProcessReallyExit = process2.reallyExit;
      processReallyExit = function processReallyExit2(code) {
        if (!processOk(global.process)) {
          return;
        }
        process2.exitCode = code || /* istanbul ignore next */
        0;
        emit("exit", process2.exitCode, null);
        emit("afterexit", process2.exitCode, null);
        originalProcessReallyExit.call(process2, process2.exitCode);
      };
      originalProcessEmit = process2.emit;
      processEmit = function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(global.process)) {
          if (arg !== void 0) {
            process2.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit("exit", process2.exitCode, null);
          emit("afterexit", process2.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      };
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS({
  "node_modules/proper-lockfile/lib/mtime-precision.js"(exports, module) {
    "use strict";
    var cacheSymbol = Symbol();
    function probe(file, fs, callback) {
      const cachedPrecision = fs[cacheSymbol];
      if (cachedPrecision) {
        return fs.stat(file, (err, stat) => {
          if (err) {
            return callback(err);
          }
          callback(null, stat.mtime, cachedPrecision);
        });
      }
      const mtime = new Date(Math.ceil(Date.now() / 1e3) * 1e3 + 5);
      fs.utimes(file, mtime, mtime, (err) => {
        if (err) {
          return callback(err);
        }
        fs.stat(file, (err2, stat) => {
          if (err2) {
            return callback(err2);
          }
          const precision = stat.mtime.getTime() % 1e3 === 0 ? "s" : "ms";
          Object.defineProperty(fs, cacheSymbol, { value: precision });
          callback(null, stat.mtime, precision);
        });
      });
    }
    function getMtime(precision) {
      let now = Date.now();
      if (precision === "s") {
        now = Math.ceil(now / 1e3) * 1e3;
      }
      return new Date(now);
    }
    module.exports.probe = probe;
    module.exports.getMtime = getMtime;
  }
});

// node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS({
  "node_modules/proper-lockfile/lib/lockfile.js"(exports, module) {
    "use strict";
    var path = __require("path");
    var fs = require_graceful_fs();
    var retry = require_retry2();
    var onExit = require_signal_exit();
    var mtimePrecision = require_mtime_precision();
    var locks = {};
    function getLockFile(file, options) {
      return options.lockfilePath || `${file}.lock`;
    }
    function resolveCanonicalPath(file, options, callback) {
      if (!options.realpath) {
        return callback(null, path.resolve(file));
      }
      options.fs.realpath(file, callback);
    }
    function acquireLock(file, options, callback) {
      const lockfilePath = getLockFile(file, options);
      options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
          return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
            if (err2) {
              options.fs.rmdir(lockfilePath, () => {
              });
              return callback(err2);
            }
            callback(null, mtime, mtimePrecision2);
          });
        }
        if (err.code !== "EEXIST") {
          return callback(err);
        }
        if (options.stale <= 0) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        options.fs.stat(lockfilePath, (err2, stat) => {
          if (err2) {
            if (err2.code === "ENOENT") {
              return acquireLock(file, { ...options, stale: 0 }, callback);
            }
            return callback(err2);
          }
          if (!isLockStale(stat, options)) {
            return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
          }
          removeLock(file, options, (err3) => {
            if (err3) {
              return callback(err3);
            }
            acquireLock(file, { ...options, stale: 0 }, callback);
          });
        });
      });
    }
    function isLockStale(stat, options) {
      return stat.mtime.getTime() < Date.now() - options.stale;
    }
    function removeLock(file, options, callback) {
      options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== "ENOENT") {
          return callback(err);
        }
        callback();
      });
    }
    function updateLock(file, options) {
      const lock2 = locks[file];
      if (lock2.updateTimeout) {
        return;
      }
      lock2.updateDelay = lock2.updateDelay || options.update;
      lock2.updateTimeout = setTimeout(() => {
        lock2.updateTimeout = null;
        options.fs.stat(lock2.lockfilePath, (err, stat) => {
          const isOverThreshold = lock2.lastUpdate + options.stale < Date.now();
          if (err) {
            if (err.code === "ENOENT" || isOverThreshold) {
              return setLockAsCompromised(file, lock2, Object.assign(err, { code: "ECOMPROMISED" }));
            }
            lock2.updateDelay = 1e3;
            return updateLock(file, options);
          }
          const isMtimeOurs = lock2.mtime.getTime() === stat.mtime.getTime();
          if (!isMtimeOurs) {
            return setLockAsCompromised(
              file,
              lock2,
              Object.assign(
                new Error("Unable to update lock within the stale threshold"),
                { code: "ECOMPROMISED" }
              )
            );
          }
          const mtime = mtimePrecision.getMtime(lock2.mtimePrecision);
          options.fs.utimes(lock2.lockfilePath, mtime, mtime, (err2) => {
            const isOverThreshold2 = lock2.lastUpdate + options.stale < Date.now();
            if (lock2.released) {
              return;
            }
            if (err2) {
              if (err2.code === "ENOENT" || isOverThreshold2) {
                return setLockAsCompromised(file, lock2, Object.assign(err2, { code: "ECOMPROMISED" }));
              }
              lock2.updateDelay = 1e3;
              return updateLock(file, options);
            }
            lock2.mtime = mtime;
            lock2.lastUpdate = Date.now();
            lock2.updateDelay = null;
            updateLock(file, options);
          });
        });
      }, lock2.updateDelay);
      if (lock2.updateTimeout.unref) {
        lock2.updateTimeout.unref();
      }
    }
    function setLockAsCompromised(file, lock2, err) {
      lock2.released = true;
      if (lock2.updateTimeout) {
        clearTimeout(lock2.updateTimeout);
      }
      if (locks[file] === lock2) {
        delete locks[file];
      }
      lock2.options.onCompromised(err);
    }
    function lock(file, options, callback) {
      options = {
        stale: 1e4,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => {
          throw err;
        },
        ...options
      };
      options.retries = options.retries || 0;
      options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
      options.stale = Math.max(options.stale || 0, 2e3);
      options.update = options.update == null ? options.stale / 2 : options.update || 0;
      options.update = Math.max(Math.min(options.update, options.stale / 2), 1e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const operation = retry.operation(options.retries);
        operation.attempt(() => {
          acquireLock(file2, options, (err2, mtime, mtimePrecision2) => {
            if (operation.retry(err2)) {
              return;
            }
            if (err2) {
              return callback(operation.mainError());
            }
            const lock2 = locks[file2] = {
              lockfilePath: getLockFile(file2, options),
              mtime,
              mtimePrecision: mtimePrecision2,
              options,
              lastUpdate: Date.now()
            };
            updateLock(file2, options);
            callback(null, (releasedCallback) => {
              if (lock2.released) {
                return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
              }
              unlock(file2, { ...options, realpath: false }, releasedCallback);
            });
          });
        });
      });
    }
    function unlock(file, options, callback) {
      options = {
        fs,
        realpath: true,
        ...options
      };
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const lock2 = locks[file2];
        if (!lock2) {
          return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
        }
        lock2.updateTimeout && clearTimeout(lock2.updateTimeout);
        lock2.released = true;
        delete locks[file2];
        removeLock(file2, options, callback);
      });
    }
    function check(file, options, callback) {
      options = {
        stale: 1e4,
        realpath: true,
        fs,
        ...options
      };
      options.stale = Math.max(options.stale || 0, 2e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        options.fs.stat(getLockFile(file2, options), (err2, stat) => {
          if (err2) {
            return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
          }
          return callback(null, !isLockStale(stat, options));
        });
      });
    }
    function getLocks() {
      return locks;
    }
    onExit(() => {
      for (const file in locks) {
        const options = locks[file].options;
        try {
          options.fs.rmdirSync(getLockFile(file, options));
        } catch (e) {
        }
      }
    });
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.check = check;
    module.exports.getLocks = getLocks;
  }
});

// node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS({
  "node_modules/proper-lockfile/lib/adapter.js"(exports, module) {
    "use strict";
    var fs = require_graceful_fs();
    function createSyncFs(fs2) {
      const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
      const newFs = { ...fs2 };
      methods.forEach((method) => {
        newFs[method] = (...args) => {
          const callback = args.pop();
          let ret;
          try {
            ret = fs2[`${method}Sync`](...args);
          } catch (err) {
            return callback(err);
          }
          callback(null, ret);
        };
      });
      return newFs;
    }
    function toPromise(method) {
      return (...args) => new Promise((resolve3, reject) => {
        args.push((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve3(result);
          }
        });
        method(...args);
      });
    }
    function toSync(method) {
      return (...args) => {
        let err;
        let result;
        args.push((_err, _result) => {
          err = _err;
          result = _result;
        });
        method(...args);
        if (err) {
          throw err;
        }
        return result;
      };
    }
    function toSyncOptions(options) {
      options = { ...options };
      options.fs = createSyncFs(options.fs || fs);
      if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
        throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
      }
      return options;
    }
    module.exports = {
      toPromise,
      toSync,
      toSyncOptions
    };
  }
});

// node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS({
  "node_modules/proper-lockfile/index.js"(exports, module) {
    "use strict";
    var lockfile = require_lockfile();
    var { toPromise, toSync, toSyncOptions } = require_adapter();
    async function lock(file, options) {
      const release = await toPromise(lockfile.lock)(file, options);
      return toPromise(release);
    }
    function lockSync(file, options) {
      const release = toSync(lockfile.lock)(file, toSyncOptions(options));
      return toSync(release);
    }
    function unlock(file, options) {
      return toPromise(lockfile.unlock)(file, options);
    }
    function unlockSync(file, options) {
      return toSync(lockfile.unlock)(file, toSyncOptions(options));
    }
    function check(file, options) {
      return toPromise(lockfile.check)(file, options);
    }
    function checkSync(file, options) {
      return toSync(lockfile.check)(file, toSyncOptions(options));
    }
    module.exports = lock;
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.lockSync = lockSync;
    module.exports.unlockSync = unlockSync;
    module.exports.check = check;
    module.exports.checkSync = checkSync;
  }
});

// src/cli/index.ts
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { resolve as resolve2 } from "node:path";

// src/journal/index.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  fsyncSync
} from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// src/protocol/hash.ts
import { createHash } from "node:crypto";
function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 55296 && codeUnit <= 56319) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 56320 || nextCodeUnit > 57343) {
        throw new TypeError("JCS \u8F93\u5165\u5305\u542B\u672A\u914D\u5BF9\u7684 Unicode surrogate\u3002");
      }
      index += 1;
    } else if (codeUnit >= 56320 && codeUnit <= 57343) {
      throw new TypeError("JCS \u8F93\u5165\u5305\u542B\u672A\u914D\u5BF9\u7684 Unicode surrogate\u3002");
    }
  }
}
function serializeString(value) {
  assertValidUnicode(value);
  return JSON.stringify(value);
}
function canonicalize(value) {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return serializeString(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS \u8F93\u5165\u5305\u542B\u975E\u6709\u9650\u6570\u503C\u3002");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS \u8F93\u5165\u53EA\u80FD\u5305\u542B\u666E\u901A JSON \u5BF9\u8C61\u3002");
    }
    const object = value;
    const properties = Object.keys(object).sort().map((key) => `${serializeString(key)}:${canonicalize(object[key])}`);
    return `{${properties.join(",")}}`;
  }
  throw new TypeError(`JCS \u8F93\u5165\u5305\u542B\u4E0D\u652F\u6301\u7684\u7C7B\u578B\uFF1A${typeof value}\u3002`);
}
function sha256Jcs(value) {
  const canonicalJson = canonicalize(value);
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
function computeTargetFingerprint(evidence) {
  return sha256Jcs(evidence);
}

// src/protocol/index.ts
var ExitCode = {
  Success: 0,
  ParamError: 2,
  NeedsUser: 10,
  PlanInvalid: 20,
  IdentityConflict: 30,
  ActionFailed: 40,
  VerifyDrift: 50,
  LockConflict: 60
};

// src/journal/index.ts
var JournalConsistencyError = class extends Error {
  exitCode = ExitCode.ParamError;
  constructor(message) {
    super(`Journal \u4E0E snapshot \u4E0D\u4E00\u81F4\uFF1A${message}`);
    this.name = "JournalConsistencyError";
  }
};
var InvalidRunIdError = class extends Error {
  exitCode = ExitCode.ParamError;
  constructor(runId) {
    super(`runId \u65E0\u6548\uFF1A${runId}`);
    this.name = "InvalidRunIdError";
  }
};
function validateRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new InvalidRunIdError(runId);
  }
}
function getRunDirectory(runId, options) {
  validateRunId(runId);
  const runsDirectory = options?.runsDirectory ?? join(homedir(), ".dawn-forge", "runs");
  return join(runsDirectory, runId);
}
function parsePendingCommit(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return void 0;
    }
    throw new JournalConsistencyError("commit.pending \u4E0D\u662F\u5408\u6CD5 JSON\u3002");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.startOffset) || value.startOffset < 0 || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new JournalConsistencyError("commit.pending \u7ED3\u6784\u65E0\u6548\u3002");
  }
  return value;
}
function visibleJournalBytes(journal, pendingCommitPath) {
  const pendingCommit = parsePendingCommit(pendingCommitPath);
  if (!pendingCommit) {
    return journal;
  }
  const expectedEnd = pendingCommit.startOffset + pendingCommit.byteLength;
  if (pendingCommit.startOffset > journal.length || journal.length > expectedEnd) {
    throw new JournalConsistencyError(
      "commit.pending \u7684 Journal offset \u4E0E\u5B9E\u9645\u6587\u4EF6\u4E0D\u4E00\u81F4\u3002"
    );
  }
  if (journal.length < expectedEnd) {
    return journal.subarray(0, pendingCommit.startOffset);
  }
  const committedBytes = journal.subarray(pendingCommit.startOffset);
  const actualHash = createHash2("sha256").update(committedBytes).digest("hex");
  if (actualHash !== pendingCommit.sha256) {
    throw new JournalConsistencyError(
      "commit.pending \u8BB0\u5F55\u7684 Journal \u5185\u5BB9 hash \u4E0D\u5339\u914D\u3002"
    );
  }
  return journal;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isActionState(value) {
  return typeof value === "string" && [
    "pending",
    "blocked",
    "running",
    "succeeded",
    "skipped",
    "failed",
    "needs_user"
  ].includes(value);
}
function parseSnapshot(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new JournalConsistencyError("snapshot \u4E0D\u662F\u5408\u6CD5 JSON\u3002");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runId !== "string" || typeof value.planHash !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.actions) || !value.actions.every(
    (action) => isRecord(action) && typeof action.actionId === "string" && isActionState(action.state) && (action.startedAt === void 0 || typeof action.startedAt === "string") && (action.finishedAt === void 0 || typeof action.finishedAt === "string") && (action.error === void 0 || typeof action.error === "string")
  ) || value.outcome !== void 0 && !["completed", "stopped", "in-progress"].includes(
    value.outcome
  )) {
    throw new JournalConsistencyError("snapshot \u7ED3\u6784\u65E0\u6548\u3002");
  }
  const actionIds = value.actions.map(
    (action) => action.actionId
  );
  if (new Set(actionIds).size !== actionIds.length) {
    throw new JournalConsistencyError("snapshot \u5305\u542B\u91CD\u590D\u7684 actionId\u3002");
  }
  return value;
}
function parseEvent(value, lineNumber) {
  if (!isRecord(value) || typeof value.timestamp !== "string" || typeof value.runId !== "string" || !isRecord(value.event) || typeof value.event.type !== "string") {
    throw new JournalConsistencyError(
      `journal \u7B2C ${lineNumber} \u884C\u7ED3\u6784\u65E0\u6548\u3002`
    );
  }
  const event = value.event;
  const eventType = event.type;
  const hasActionMessage = typeof event.actionId === "string" && typeof event.message === "string";
  const valid = eventType === "run-started" || ["action-started", "action-succeeded", "action-skipped"].includes(
    eventType
  ) && hasActionMessage || eventType === "action-failed" && hasActionMessage && typeof event.critical === "boolean" || eventType === "action-blocked" && typeof event.actionId === "string" && typeof event.reason === "string" || eventType === "needs-user" && typeof event.actionId === "string" && typeof event.instruction === "string" || eventType === "run-completed" && typeof event.summary === "string" || eventType === "run-stopped" && typeof event.reason === "string";
  if (!valid) {
    throw new JournalConsistencyError(
      `journal \u7B2C ${lineNumber} \u884C\u4E8B\u4EF6\u65E0\u6548\u3002`
    );
  }
  return value;
}
function parseCommittedEvents(journal) {
  const committedLength = journal.length === 0 || journal[journal.length - 1] === 10 ? journal.length : journal.lastIndexOf(10) + 1;
  if (committedLength === 0) {
    return [];
  }
  return journal.subarray(0, committedLength).toString("utf8").split("\n").filter((line) => line.length > 0).map((line, index) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new JournalConsistencyError(
        `journal \u7B2C ${index + 1} \u884C\u4E0D\u662F\u5408\u6CD5 JSON\u3002`
      );
    }
    return parseEvent(value, index + 1);
  });
}
function verifySnapshot(runId, snapshot, events) {
  if (snapshot.runId !== runId) {
    throw new JournalConsistencyError(
      `snapshot runId ${snapshot.runId} \u4E0E\u76EE\u5F55 ${runId} \u4E0D\u540C\u3002`
    );
  }
  const replayedStates = /* @__PURE__ */ new Map();
  let replayedOutcome;
  let waitingForCriticalStop = false;
  function transition(actionId, nextState, allowedStates) {
    const currentState = replayedStates.get(actionId) ?? "pending";
    if (!allowedStates.includes(currentState)) {
      throw new JournalConsistencyError(
        `Action ${actionId} \u4E0D\u80FD\u4ECE ${currentState} \u8F6C\u4E3A ${nextState}\u3002`
      );
    }
    replayedStates.set(actionId, nextState);
  }
  for (const item of events) {
    if (item.runId !== runId) {
      throw new JournalConsistencyError(
        `\u4E8B\u4EF6 runId ${item.runId} \u4E0E\u76EE\u5F55 ${runId} \u4E0D\u540C\u3002`
      );
    }
    if (replayedOutcome) {
      if (replayedOutcome === "stopped" && item.event.type === "run-started") {
        replayedOutcome = void 0;
        continue;
      }
      throw new JournalConsistencyError(
        `Run \u5DF2\u8FDB\u5165 ${replayedOutcome}\uFF0C\u53EA\u80FD\u4ECE stopped \u6062\u590D\u3002`
      );
    }
    if (waitingForCriticalStop && item.event.type !== "run-stopped") {
      throw new JournalConsistencyError(
        "critical \u5931\u8D25\u540E\u5FC5\u987B\u7ACB\u5373\u505C\u6B62 Run\u3002"
      );
    }
    switch (item.event.type) {
      case "action-started":
        transition(item.event.actionId, "running", [
          "pending",
          "failed",
          "blocked"
        ]);
        break;
      case "action-succeeded":
        transition(item.event.actionId, "succeeded", [
          "running",
          "needs_user",
          "succeeded"
        ]);
        break;
      case "action-skipped":
        transition(item.event.actionId, "skipped", ["running"]);
        break;
      case "action-failed":
        transition(item.event.actionId, "failed", ["running", "succeeded"]);
        waitingForCriticalStop = item.event.critical;
        break;
      case "action-blocked":
        transition(item.event.actionId, "blocked", ["pending"]);
        break;
      case "needs-user":
        transition(item.event.actionId, "needs_user", [
          "running",
          "needs_user"
        ]);
        break;
      case "run-completed":
        if (replayedOutcome) {
          throw new JournalConsistencyError("Run \u5B58\u5728\u591A\u4E2A\u7EC8\u6001\u4E8B\u4EF6\u3002");
        }
        replayedOutcome = "completed";
        break;
      case "run-stopped":
        if (replayedOutcome) {
          throw new JournalConsistencyError("Run \u5B58\u5728\u591A\u4E2A\u7EC8\u6001\u4E8B\u4EF6\u3002");
        }
        waitingForCriticalStop = false;
        replayedOutcome = "stopped";
        break;
      case "run-started":
        break;
    }
  }
  if (waitingForCriticalStop) {
    throw new JournalConsistencyError("critical \u5931\u8D25\u540E\u5FC5\u987B\u7ACB\u5373\u505C\u6B62 Run\u3002");
  }
  const snapshotStates = new Map(
    snapshot.actions.map((action) => [action.actionId, action.state])
  );
  for (const [actionId, state] of replayedStates) {
    if (snapshotStates.get(actionId) !== state) {
      throw new JournalConsistencyError(
        `Action ${actionId} \u91CD\u653E\u4E3A ${state}\uFF0Csnapshot \u4E3A ${snapshotStates.get(actionId) ?? "missing"}\u3002`
      );
    }
  }
  for (const action of snapshot.actions) {
    if (!replayedStates.has(action.actionId) && action.state !== "pending") {
      throw new JournalConsistencyError(
        `Action ${action.actionId} \u5728 Journal \u4E2D\u6CA1\u6709\u72B6\u6001\u4E8B\u4EF6\uFF0Csnapshot \u4E3A ${action.state}\u3002`
      );
    }
  }
  if (replayedOutcome && snapshot.outcome !== replayedOutcome) {
    throw new JournalConsistencyError(
      `Run \u91CD\u653E\u4E3A ${replayedOutcome}\uFF0Csnapshot \u4E3A ${snapshot.outcome ?? "missing"}\u3002`
    );
  }
  if (!replayedOutcome && snapshot.outcome !== void 0 && snapshot.outcome !== "in-progress") {
    throw new JournalConsistencyError(
      `Journal \u4E2D\u6CA1\u6709\u7EC8\u6001\u4E8B\u4EF6\uFF0Csnapshot \u4E3A ${snapshot.outcome}\u3002`
    );
  }
}
function readSnapshotCandidate(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  try {
    return { exists: true, snapshot: parseSnapshot(content) };
  } catch (error) {
    if (error instanceof JournalConsistencyError) {
      return { exists: true, error };
    }
    throw error;
  }
}
function snapshotMatchesJournal(runId, snapshot, events) {
  try {
    verifySnapshot(runId, snapshot, events);
    return true;
  } catch (error) {
    if (error instanceof JournalConsistencyError) {
      return false;
    }
    throw error;
  }
}
function selectConsistentSnapshot(runId, snapshotPath, pendingSnapshotPath, events) {
  const pending = readSnapshotCandidate(pendingSnapshotPath);
  const current = readSnapshotCandidate(snapshotPath);
  if (pending.snapshot && snapshotMatchesJournal(runId, pending.snapshot, events)) {
    return {
      source: "pending",
      snapshot: pending.snapshot,
      pendingExists: true
    };
  }
  if (current.snapshot && snapshotMatchesJournal(runId, current.snapshot, events)) {
    return {
      source: "current",
      snapshot: current.snapshot,
      pendingExists: pending.exists
    };
  }
  if (!current.exists && !pending.exists && events.length === 0) {
    return void 0;
  }
  throw pending.error ?? current.error ?? new JournalConsistencyError(
    "current \u548C pending snapshot \u5747\u65E0\u6CD5\u5339\u914D Journal\u3002"
  );
}
function readRun(runId, options) {
  const runDirectory = getRunDirectory(runId, options);
  const snapshotPath = join(runDirectory, "snapshot.json");
  const pendingSnapshotPath = join(runDirectory, "snapshot.pending");
  const journalPath = join(runDirectory, "journal.jsonl");
  const pendingCommitPath = join(runDirectory, "commit.pending");
  let lastConsistencyError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const journalBefore = readFileSync(journalPath);
    const events = parseCommittedEvents(
      visibleJournalBytes(journalBefore, pendingCommitPath)
    );
    try {
      const selected = selectConsistentSnapshot(
        runId,
        snapshotPath,
        pendingSnapshotPath,
        events
      );
      const journalAfter = readFileSync(journalPath);
      if (!journalBefore.equals(journalAfter)) {
        continue;
      }
      if (!selected) {
        throw new JournalConsistencyError("Run \u5C1A\u65E0\u5DF2\u63D0\u4EA4\u7684 snapshot\u3002");
      }
      return { snapshot: selected.snapshot, events };
    } catch (error) {
      if (!(error instanceof JournalConsistencyError)) {
        throw error;
      }
      lastConsistencyError = error;
      const journalAfter = readFileSync(journalPath);
      if (!journalBefore.equals(journalAfter)) {
        continue;
      }
    }
  }
  throw lastConsistencyError ?? new JournalConsistencyError("\u65E0\u6CD5\u8BFB\u53D6\u7A33\u5B9A\u7684 Journal \u4E0E snapshot \u89C6\u56FE\u3002");
}

// src/target/index.ts
var import_proper_lockfile2 = __toESM(require_proper_lockfile(), 1);
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync as closeSync2,
  constants as constants2,
  existsSync,
  fsyncSync as fsyncSync2,
  lstatSync,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync as readFileSync2,
  readdirSync,
  renameSync as renameSync2,
  rmSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir as homedir2, hostname } from "node:os";
import { isIP } from "node:net";
import { dirname, join as join2, resolve } from "node:path";
var IdentityConflictError = class extends Error {
  exitCode = ExitCode.IdentityConflict;
  constructor(fields) {
    super(`\u76EE\u6807\u8EAB\u4EFD\u51B2\u7A81\uFF1A${fields.join(", ")} \u5DF2\u53D8\u5316\u3002`);
    this.name = "IdentityConflictError";
  }
};
var TargetInputError = class extends Error {
  exitCode = ExitCode.ParamError;
  constructor(message) {
    super(message);
    this.name = "TargetInputError";
  }
};
var TargetNeedsUserError = class extends Error {
  exitCode = ExitCode.NeedsUser;
  constructor() {
    super("\u5C1A\u672A\u786E\u8BA4 authorized_keys \u5DF2\u5B89\u88C5\u3002");
    this.name = "TargetNeedsUserError";
  }
};
var TargetRollbackError = class extends Error {
  exitCode = ExitCode.ActionFailed;
  constructor(originalError, rollbackError, recoveryDirectory) {
    const original = originalError instanceof Error ? originalError.message : String(originalError);
    const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    super(
      `Target bootstrap \u5931\u8D25\u4E14\u8FDC\u7AEF\u516C\u94A5\u56DE\u6EDA\u5931\u8D25\uFF1A${original}\uFF1B\u56DE\u6EDA\u9519\u8BEF\uFF1A${rollback}\u3002\u6062\u590D\u8BC1\u636E\u4FDD\u7559\u5728 ${recoveryDirectory}`
    );
    this.name = "TargetRollbackError";
  }
};
var TargetLockError = class extends Error {
  exitCode = ExitCode.LockConflict;
  constructor(targetId) {
    super(`Target lifecycle \u5DF2\u88AB\u5176\u4ED6\u8FDB\u7A0B\u9501\u5B9A\uFF1A${targetId}`);
    this.name = "TargetLockError";
  }
};
function assertSafeValue(value, label) {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized) || /\s/.test(normalized)) {
    throw new TargetInputError(`${label} \u65E0\u6548\u3002`);
  }
  return normalized;
}
function isTrustedLanHost(host) {
  const normalized = host.toLowerCase();
  if (normalized.endsWith(".local") || normalized.endsWith(".home.arpa")) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map((part) => Number.parseInt(part, 10));
    return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 169 && second === 254;
  }
  const unbracketed = normalized.replace(/^\[|\]$/g, "");
  const [address, zone] = unbracketed.split("%", 2);
  if (isIP(address) !== 6) {
    return false;
  }
  return address.startsWith("fc") || address.startsWith("fd") || /^fe[89ab]/.test(address) && Boolean(zone);
}
function targetIdFromName(name) {
  const targetId = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)) {
    throw new TargetInputError("--name \u65E0\u6CD5\u8F6C\u6362\u4E3A\u6709\u6548 targetId\u3002");
  }
  return targetId;
}
function validateTargetId(targetId) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId)) {
    throw new TargetInputError(`targetId \u65E0\u6548\uFF1A${targetId}`);
  }
}
function quoteSshConfig(value) {
  return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}
function renderSshConfig(connection) {
  return [
    `Host ${connection.alias}`,
    `  HostName ${connection.host}`,
    `  User ${connection.user}`,
    `  IdentityFile ${quoteSshConfig(connection.identityFile)}`,
    "  IdentitiesOnly yes",
    "  ClearAllForwardings yes",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  PermitLocalCommand no",
    "  ControlMaster no",
    "  ControlPath none",
    "  ControlPersist no",
    "  CanonicalizeHostname no",
    "  ForkAfterAuthentication no",
    "  StdinNull no",
    "  RequestTTY no",
    "  Tunnel no",
    "  RemoteCommand none",
    "  ProxyCommand none",
    "  ProxyJump none",
    "  KnownHostsCommand none",
    "  IdentityAgent none",
    "  AddKeysToAgent no",
    "  UpdateHostKeys no",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  PreferredAuthentications publickey",
    "  PubkeyAuthentication yes",
    "  HostbasedAuthentication no",
    "  GSSAPIAuthentication no",
    "  StrictHostKeyChecking yes",
    "  ConnectTimeout 8",
    "  ConnectionAttempts 1",
    `  UserKnownHostsFile ${quoteSshConfig(connection.knownHostsPath)}`,
    "  GlobalKnownHostsFile none",
    ""
  ].join("\n");
}
function buildAuthorizedKeyLine(publicKeyLine, controllerName = hostname()) {
  const normalized = publicKeyLine.trim();
  const publicKeyBlob = normalized.match(
    /^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/
  )?.[1];
  if (!publicKeyBlob) {
    throw new TargetInputError("\u63A7\u5236\u673A\u516C\u94A5\u4E0D\u662F\u5408\u6CD5\u7684 ED25519 public key\u3002");
  }
  const comment = assertSafeValue(controllerName, "\u63A7\u5236\u673A hostname");
  return `no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 ${publicKeyBlob} ${comment}`;
}
function writeFileAtomic(path, content, mode = 384) {
  assertRegularDirectory(dirname(path), "\u539F\u5B50\u5199\u5165\u76EE\u5F55");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync2(
    temporaryPath,
    constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY,
    mode
  );
  try {
    writeFileSync2(descriptor, content);
    fsyncSync2(descriptor);
  } finally {
    closeSync2(descriptor);
  }
  renameSync2(temporaryPath, path);
}
function assertRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new TargetInputError(`${label} \u4E0D\u5B58\u5728\u3002`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TargetInputError(`${label} \u5FC5\u987B\u662F regular file\uFF0C\u4E0D\u80FD\u662F symlink\u3002`);
  }
}
function assertRegularDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TargetInputError(`${label} \u5FC5\u987B\u662F directory\uFF0C\u4E0D\u80FD\u662F symlink\u3002`);
  }
}
function identityDifferences(expected, actual) {
  return [
    "sshHostKeyFingerprint",
    "machineId",
    "architecture",
    "remoteUser"
  ].filter((field) => expected[field] !== actual[field]);
}
function validateProbe(probe, expectedPlatform, expectedUser) {
  if (probe.platform !== expectedPlatform) {
    throw new IdentityConflictError(["platform"]);
  }
  for (const [field, value] of Object.entries(probe.identityEvidence)) {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TargetInputError(`identityEvidence.${field} \u65E0\u6548\u3002`);
    }
  }
  if (probe.identityEvidence.remoteUser.toLowerCase() !== expectedUser.toLowerCase()) {
    throw new IdentityConflictError(["remoteUser"]);
  }
}
function storedTargetConnection(target, targetDirectory) {
  return {
    targetId: target.targetId,
    alias: target.locators.sshAlias,
    host: assertSafeValue(target.connection.host, "\u5B58\u50A8\u7684 host"),
    user: assertSafeValue(target.connection.user, "\u5B58\u50A8\u7684 user"),
    platform: target.platform,
    configPath: join2(targetDirectory, "ssh_config"),
    knownHostsPath: join2(targetDirectory, "known_hosts"),
    identityFile: target.connection.identityFile
  };
}
function parseStoredTarget(content, expectedTargetId) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TargetInputError("target.json \u4E0D\u662F\u5408\u6CD5 JSON\u3002");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TargetInputError("target.json \u7ED3\u6784\u65E0\u6548\u3002");
  }
  const target = value;
  if (target.targetId !== expectedTargetId || typeof target.displayName !== "string" || target.platform !== "macos" || target.locators?.sshAlias !== `dawn-${expectedTargetId}` || typeof target.identityEvidence?.sshHostKeyFingerprint !== "string" || typeof target.identityEvidence.machineId !== "string" || typeof target.identityEvidence.architecture !== "string" || typeof target.identityEvidence.remoteUser !== "string" || typeof target.targetFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(target.targetFingerprint) || typeof target.registeredAt !== "string" || typeof target.connection?.host !== "string" || typeof target.connection.user !== "string" || typeof target.connection.identityFile !== "string" || typeof target.controllerPublicKeyBlob !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(target.controllerPublicKeyBlob)) {
    throw new TargetInputError("target.json \u7ED3\u6784\u65E0\u6548\u3002");
  }
  if (computeTargetFingerprint(target.identityEvidence) !== target.targetFingerprint) {
    throw new TargetInputError("target.json \u7684 targetFingerprint \u4E0D\u4E00\u81F4\u3002");
  }
  return target;
}
var TargetManager = class {
  #options;
  #stateDirectory;
  #targetsDirectory;
  constructor(options) {
    this.#options = options;
    this.#stateDirectory = join2(options.homeDirectory, ".dawn-forge");
    this.#targetsDirectory = join2(this.#stateDirectory, "targets");
  }
  async bootstrap(input) {
    const host = assertSafeValue(input.host, "--host");
    const user = assertSafeValue(input.user, "--user");
    if (host.length > 253 || !/^[A-Za-z0-9._:%[\]-]+$/.test(host) || !isTrustedLanHost(host)) {
      throw new TargetInputError("--host \u5FC5\u987B\u662F\u53D7\u4FE1\u4EFB\u7684\u5C40\u57DF\u7F51\u5730\u5740\u3002");
    }
    if (user.length > 128 || !/^[A-Za-z0-9._@\\-]+$/.test(user)) {
      throw new TargetInputError("--user \u65E0\u6548\u3002");
    }
    const displayName = input.name.trim();
    if (!displayName || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new TargetInputError("--name \u65E0\u6548\u3002");
    }
    const platform = "macos";
    const targetId = targetIdFromName(displayName);
    const alias = `dawn-${targetId}`;
    this.#ensureStateDirectories();
    const releaseLock = this.#acquireTargetLock(targetId);
    try {
      const finalDirectory = join2(this.#targetsDirectory, targetId);
      const stagingDirectory = join2(
        this.#targetsDirectory,
        `.${targetId}.bootstrap-${randomUUID()}`
      );
      if (existsSync(join2(finalDirectory, "target.json"))) {
        const existing = this.#readTarget(targetId);
        const inputDifferences = [
          ...existing.connection.host !== host ? ["host"] : [],
          ...existing.connection.user.toLowerCase() !== user.toLowerCase() ? ["remoteUser"] : []
        ];
        if (inputDifferences.length > 0) {
          throw new IdentityConflictError(inputDifferences);
        }
        await this.#verifyCurrentIdentity(existing, finalDirectory);
        const completedBootstrapPath = join2(
          finalDirectory,
          "bootstrap.json"
        );
        if (existsSync(completedBootstrapPath)) {
          assertRegularFile(
            completedBootstrapPath,
            "\u5DF2\u5B8C\u6210\u7684 bootstrap pending state"
          );
          rmSync(completedBootstrapPath, { force: false });
        }
        return existing;
      }
      this.#assertNoPendingBootstrap();
      this.#assertUniqueLocator(host, targetId);
      const key = await this.#options.keyProvider.ensure();
      mkdirSync2(stagingDirectory, { mode: 448 });
      let authorized = false;
      let published = false;
      let preserveStaging = false;
      let stagingConnection;
      let authorizedKeyLine;
      try {
        stagingConnection = {
          targetId,
          alias,
          host,
          user,
          platform,
          configPath: join2(stagingDirectory, "ssh_config"),
          knownHostsPath: join2(stagingDirectory, "known_hosts"),
          identityFile: key.privateKeyPath
        };
        writeFileAtomic(
          stagingConnection.configPath,
          renderSshConfig(stagingConnection)
        );
        authorizedKeyLine = buildAuthorizedKeyLine(
          key.publicKeyLine,
          `${hostname()}-dawn-${randomUUID()}`
        );
        writeFileAtomic(
          join2(stagingDirectory, "bootstrap.json"),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              targetId,
              host,
              user,
              controllerPublicKeyBlob: key.publicKeyBlob,
              authorizedKeyLine,
              startedAt: this.#options.now().toISOString()
            },
            null,
            2
          )}
`
        );
        const command = this.#options.ssh.authorizationCommand(
          stagingConnection,
          authorizedKeyLine
        );
        if (!await this.#options.authorize(command)) {
          throw new TargetNeedsUserError();
        }
        authorized = true;
        await this.#options.ssh.verifyAuthorization(
          stagingConnection,
          authorizedKeyLine
        );
        const probe = await this.#options.ssh.probe(stagingConnection);
        validateProbe(probe, platform, user);
        this.#assertUniqueIdentity(probe.identityEvidence, targetId);
        assertRegularFile(
          stagingConnection.knownHostsPath,
          "\u53D7\u63A7 known_hosts"
        );
        const targetFingerprint = computeTargetFingerprint(
          probe.identityEvidence
        );
        const finalConnection = {
          ...stagingConnection,
          platform,
          configPath: join2(finalDirectory, "ssh_config"),
          knownHostsPath: join2(finalDirectory, "known_hosts")
        };
        const target = {
          targetId,
          displayName,
          platform,
          locators: { sshAlias: alias },
          identityEvidence: probe.identityEvidence,
          targetFingerprint,
          registeredAt: this.#options.now().toISOString(),
          connection: {
            host,
            user,
            identityFile: key.privateKeyPath
          },
          controllerPublicKeyBlob: key.publicKeyBlob
        };
        writeFileAtomic(
          stagingConnection.configPath,
          renderSshConfig(finalConnection)
        );
        writeFileAtomic(
          join2(stagingDirectory, "target.json"),
          `${JSON.stringify(target, null, 2)}
`
        );
        renameSync2(stagingDirectory, finalDirectory);
        published = true;
        rmSync(join2(finalDirectory, "bootstrap.json"), { force: false });
        return target;
      } catch (error) {
        if (authorized && !published && stagingConnection && authorizedKeyLine) {
          try {
            writeFileAtomic(
              stagingConnection.configPath,
              renderSshConfig(stagingConnection)
            );
            await this.#options.ssh.rollbackAuthorization(
              stagingConnection,
              authorizedKeyLine
            );
          } catch (rollbackError) {
            preserveStaging = true;
            throw new TargetRollbackError(
              error,
              rollbackError,
              stagingDirectory
            );
          }
        }
        throw error;
      } finally {
        if (!preserveStaging && existsSync(stagingDirectory)) {
          rmSync(stagingDirectory, { recursive: true, force: true });
        }
      }
    } finally {
      releaseLock();
    }
  }
  async inspect(targetId) {
    validateTargetId(targetId);
    this.#assertTargetStateAvailable(targetId);
    const releaseLock = this.#acquireTargetLock(targetId);
    try {
      const target = this.#readTarget(targetId);
      const targetDirectory = join2(this.#targetsDirectory, targetId);
      await this.#verifyCurrentIdentity(target, targetDirectory);
      return target;
    } finally {
      releaseLock();
    }
  }
  async revoke(targetId) {
    validateTargetId(targetId);
    this.#assertTargetStateAvailable(targetId);
    const releaseLock = this.#acquireTargetLock(targetId);
    try {
      const targetDirectory = join2(this.#targetsDirectory, targetId);
      const target = this.#readTarget(targetId);
      const revokePath = join2(targetDirectory, "revoke.json");
      if (existsSync(revokePath)) {
        assertRegularFile(revokePath, "revoke pending state");
        throw new TargetInputError(
          `Target ${targetId} \u5B58\u5728\u672A\u5B8C\u6210\u7684 revoke\uFF1B\u5DF2\u4FDD\u7559\u6062\u590D\u8BC1\u636E\uFF0C\u4E0D\u80FD\u81EA\u52A8\u91CD\u8BD5\u6216\u5220\u9664\u3002`
        );
      }
      await this.#verifyCurrentIdentity(target, targetDirectory);
      writeFileAtomic(
        revokePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            targetId,
            startedAt: this.#options.now().toISOString()
          },
          null,
          2
        )}
`
      );
      await this.#options.ssh.revoke(
        storedTargetConnection(target, targetDirectory),
        target.controllerPublicKeyBlob
      );
      rmSync(targetDirectory, { recursive: true, force: false });
    } finally {
      releaseLock();
    }
  }
  #readTarget(targetId) {
    const targetDirectory = join2(this.#targetsDirectory, targetId);
    const targetPath = join2(targetDirectory, "target.json");
    try {
      this.#assertExistingStateDirectories();
      assertRegularDirectory(targetDirectory, "Target \u76EE\u5F55");
      assertRegularFile(targetPath, "target.json");
      return parseStoredTarget(readFileSync2(targetPath, "utf8"), targetId);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new TargetInputError(`\u627E\u4E0D\u5230 Target\uFF1A${targetId}`);
      }
      throw error;
    }
  }
  async #verifyCurrentIdentity(target, targetDirectory) {
    const key = await this.#options.keyProvider.load();
    if (key.publicKeyBlob !== target.controllerPublicKeyBlob) {
      throw new IdentityConflictError(["controllerPublicKey"]);
    }
    if (key.privateKeyPath !== target.connection.identityFile) {
      throw new IdentityConflictError(["controllerIdentityFile"]);
    }
    const connection = storedTargetConnection(target, targetDirectory);
    assertRegularFile(connection.configPath, "Target SSH config");
    assertRegularFile(connection.knownHostsPath, "\u53D7\u63A7 known_hosts");
    if (readFileSync2(connection.configPath, "utf8") !== renderSshConfig(connection)) {
      throw new TargetInputError("Target SSH config \u5DF2\u6F02\u79FB\u3002");
    }
    const probe = await this.#options.ssh.probe(connection);
    validateProbe(probe, target.platform, target.connection.user);
    const differences = identityDifferences(
      target.identityEvidence,
      probe.identityEvidence
    );
    if (differences.length > 0 || computeTargetFingerprint(probe.identityEvidence) !== target.targetFingerprint) {
      throw new IdentityConflictError(
        differences.length > 0 ? differences : ["targetFingerprint"]
      );
    }
  }
  #ensureStateDirectories() {
    assertRegularDirectory(this.#options.homeDirectory, "\u63A7\u5236\u673A home \u76EE\u5F55");
    if (!existsSync(this.#stateDirectory)) {
      mkdirSync2(this.#stateDirectory, { mode: 448 });
    }
    assertRegularDirectory(this.#stateDirectory, "Dawn Forge \u72B6\u6001\u76EE\u5F55");
    if (!existsSync(this.#targetsDirectory)) {
      mkdirSync2(this.#targetsDirectory, { mode: 448 });
    }
    assertRegularDirectory(this.#targetsDirectory, "Target \u6839\u76EE\u5F55");
  }
  #assertExistingStateDirectories() {
    assertRegularDirectory(this.#options.homeDirectory, "\u63A7\u5236\u673A home \u76EE\u5F55");
    assertRegularDirectory(this.#stateDirectory, "Dawn Forge \u72B6\u6001\u76EE\u5F55");
    assertRegularDirectory(this.#targetsDirectory, "Target \u6839\u76EE\u5F55");
  }
  #assertTargetStateAvailable(targetId) {
    try {
      this.#assertExistingStateDirectories();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new TargetInputError(`\u627E\u4E0D\u5230 Target\uFF1A${targetId}`);
      }
      throw error;
    }
  }
  #acquireTargetLock(targetId) {
    try {
      return import_proper_lockfile2.default.lockSync(this.#targetsDirectory, {
        lockfilePath: join2(this.#targetsDirectory, ".registry.lock"),
        realpath: false,
        retries: 0,
        // 同步 SSH 最坏连续阻塞约 55 秒；stale 必须留出显著余量。
        stale: 12e4,
        update: 1e4
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
        throw new TargetLockError(targetId);
      }
      throw error;
    }
  }
  #storedTargets(excludingTargetId) {
    const targets = [];
    for (const entry of readdirSync(this.#targetsDirectory, {
      withFileTypes: true
    })) {
      if (entry.name.startsWith(".") || entry.name === excludingTargetId) {
        continue;
      }
      validateTargetId(entry.name);
      if (!entry.isDirectory()) {
        throw new TargetInputError(
          `Target \u6839\u76EE\u5F55\u5305\u542B\u975E directory \u6761\u76EE\uFF1A${entry.name}`
        );
      }
      targets.push(this.#readTarget(entry.name));
    }
    return targets;
  }
  #assertNoPendingBootstrap() {
    for (const entry of readdirSync(this.#targetsDirectory, {
      withFileTypes: true
    })) {
      if (!entry.name.startsWith(".") || !entry.name.includes(".bootstrap-") || !entry.isDirectory()) {
        continue;
      }
      const pendingPath = join2(
        this.#targetsDirectory,
        entry.name,
        "bootstrap.json"
      );
      if (existsSync(pendingPath)) {
        assertRegularFile(pendingPath, "bootstrap pending state");
        throw new TargetInputError(
          `\u53D1\u73B0\u672A\u5B8C\u6210\u7684 Target bootstrap\uFF1A${pendingPath}\u3002\u5DF2\u4FDD\u7559\u6062\u590D\u8BC1\u636E\uFF0C\u4E0D\u80FD\u901A\u8FC7\u65B0 name \u7ED5\u8FC7\u3002`
        );
      }
    }
  }
  #assertUniqueLocator(host, targetId) {
    const duplicate = this.#storedTargets(targetId).find(
      (target) => target.connection.host.toLowerCase() === host.toLowerCase()
    );
    if (duplicate) {
      throw new IdentityConflictError([
        `host \u5DF2\u7531 ${duplicate.targetId} \u6CE8\u518C`
      ]);
    }
  }
  #assertUniqueIdentity(identity, targetId) {
    const duplicate = this.#storedTargets(targetId).find(
      (target) => target.identityEvidence.machineId === identity.machineId || target.identityEvidence.sshHostKeyFingerprint === identity.sshHostKeyFingerprint
    );
    if (duplicate) {
      throw new IdentityConflictError([
        `\u673A\u5668\u8EAB\u4EFD\u5DF2\u7531 ${duplicate.targetId} \u6CE8\u518C`
      ]);
    }
  }
};
function defaultProcessRunner(command, args, timeout) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}
var NodeControllerKeyProvider = class {
  #homeDirectory;
  #sshKeygen;
  #run;
  constructor(homeDirectory, sshKeygen = "ssh-keygen", run = defaultProcessRunner) {
    this.#homeDirectory = homeDirectory;
    this.#sshKeygen = sshKeygen;
    this.#run = run;
  }
  async load() {
    return this.#read(false);
  }
  async ensure() {
    return this.#read(true);
  }
  #read(createIfMissing) {
    assertRegularDirectory(this.#homeDirectory, "\u63A7\u5236\u673A home \u76EE\u5F55");
    const privateKeyPath = resolve(
      this.#homeDirectory,
      ".ssh",
      "id_ed25519"
    );
    const publicKeyPath = `${privateKeyPath}.pub`;
    const sshDirectory = dirname(privateKeyPath);
    if (!existsSync(sshDirectory)) {
      if (!createIfMissing) {
        throw new TargetInputError(
          "SSH key pair \u4E0D\u5B58\u5728\uFF1B\u5DF2\u6709 Target \u4E0D\u5141\u8BB8\u81EA\u52A8\u6362 key\u3002"
        );
      }
      mkdirSync2(sshDirectory, { mode: 448 });
    }
    assertRegularDirectory(sshDirectory, "\u63A7\u5236\u673A .ssh \u76EE\u5F55");
    const privateExists = existsSync(privateKeyPath);
    const publicExists = existsSync(publicKeyPath);
    if (privateExists !== publicExists) {
      throw new TargetInputError(
        "SSH key pair \u4E0D\u5B8C\u6574\uFF1B\u4E3A\u907F\u514D\u8986\u76D6\uFF0C\u5DF2\u505C\u6B62 bootstrap\u3002"
      );
    }
    if (!privateExists && !createIfMissing) {
      throw new TargetInputError(
        "SSH key pair \u4E0D\u5B58\u5728\uFF1B\u5DF2\u6709 Target \u4E0D\u5141\u8BB8\u81EA\u52A8\u6362 key\u3002"
      );
    }
    if (!privateExists) {
      const result = this.#run(
        this.#sshKeygen,
        [
          "-t",
          "ed25519",
          "-f",
          privateKeyPath,
          "-N",
          "",
          "-C",
          `dawn-forge@${hostname()}`
        ],
        1e4
      );
      if (result.error || result.status !== 0) {
        throw new TargetInputError(
          result.stderr.trim() || result.error?.message || "\u65E0\u6CD5\u521B\u5EFA SSH key\u3002"
        );
      }
    }
    assertRegularFile(privateKeyPath, "SSH private key");
    assertRegularFile(publicKeyPath, "SSH public key");
    if (process.platform !== "win32") {
      chmodSync(privateKeyPath, 384);
      chmodSync(publicKeyPath, 420);
    }
    const publicKeyLine = readFileSync2(publicKeyPath, "utf8").trim();
    const match = publicKeyLine.match(
      /^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/
    );
    if (!match) {
      throw new TargetInputError("\u9ED8\u8BA4 SSH public key \u4E0D\u662F ED25519\u3002");
    }
    const derived = this.#run(
      this.#sshKeygen,
      ["-y", "-P", "", "-f", privateKeyPath],
      1e4
    );
    const derivedBlob = derived.stdout.trim().match(/^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/)?.[1];
    if (derived.error || derived.status !== 0 || !derivedBlob || derivedBlob !== match[1]) {
      throw new TargetInputError(
        "SSH private key \u65E0\u6548\u3001\u9700\u8981 passphrase\uFF0C\u6216\u4E0E public key \u4E0D\u5339\u914D\u3002"
      );
    }
    return {
      privateKeyPath,
      publicKeyPath,
      publicKeyLine,
      publicKeyBlob: match[1]
    };
  }
};
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function windowsControllerCommand(executable, args) {
  const script = [
    `$dawnArguments=@(${args.map(powershellQuote).join(",")})`,
    `& ${powershellQuote(executable)} @dawnArguments`,
    "exit $LASTEXITCODE"
  ].join("; ");
  return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(
    script,
    "utf16le"
  ).toString("base64")}`;
}
function macosAuthorizeScript(authorizedKeyLine, publicKeyBlob) {
  const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
  return [
    "set -e",
    `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
    `BLOB='${publicKeyBlob}'`,
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'AUTH="$HOME/.ssh/authorized_keys"',
    'TMP="$AUTH.dawn-forge.$$"',
    `trap 'rm -f "$TMP"' EXIT`,
    'touch "$AUTH"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$AUTH"',
    `if awk -v blob="$BLOB" '{ for (i=1; i<=NF; i++) if ($i == blob) found=1 } END { exit found ? 0 : 1 }' "$AUTH"; then printf '%s\\n' 'authorized_keys already contains controller key' >&2; exit 65; fi`,
    'cp "$AUTH" "$TMP"',
    `printf '%s\\n' "$KEY" >> "$TMP"`,
    'mv "$TMP" "$AUTH"',
    'chmod 600 "$AUTH"'
  ].join("; ");
}
function windowsRemoteCommand(script) {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
    script,
    "utf16le"
  ).toString("base64")}`;
}
function windowsAuthorizeScript(authorizedKeyLine, publicKeyBlob) {
  const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    "$d=Join-Path $HOME '.ssh'",
    "New-Item -ItemType Directory -Force -Path $d | Out-Null",
    "$f=Join-Path $d 'authorized_keys'",
    `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
    `$b='${publicKeyBlob}'`,
    "$lines=if(Test-Path -LiteralPath $f){[IO.File]::ReadAllLines($f)}else{@()}",
    "if(@($lines|Where-Object{($_ -split '\\s+') -contains $b}).Count -gt 0){throw 'authorized_keys already contains controller key'}",
    '[IO.File]::WriteAllText($f,((@($lines+$k)-join "`n")+"`n"),[Text.UTF8Encoding]::new($false))',
    '& icacls.exe $f /inheritance:r /grant:r "${env:USERNAME}:F" "SYSTEM:F" | Out-Null',
    "if($LASTEXITCODE -ne 0){throw 'authorized_keys ACL update failed'}"
  ].join("; ");
}
function macosProbeCommand() {
  return [
    "set -e",
    "printf '%s\\n' __DAWN_FORGE_MACOS_V1__",
    "id -un",
    "uname -s",
    "uname -m",
    "sw_vers -productVersion",
    "scutil --get LocalHostName 2>/dev/null || printf '\\n'",
    "scutil --get ComputerName 2>/dev/null || printf '\\n'",
    "scutil --get HostName 2>/dev/null || printf '\\n'",
    "ioreg -rd1 -c IOPlatformExpertDevice"
  ].join("; ");
}
function windowsProbeCommand() {
  return windowsRemoteCommand(
    [
      "$ErrorActionPreference='Stop'",
      "$machineId=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
      "$value=[ordered]@{marker='__DAWN_FORGE_WINDOWS_V1__';user=[Environment]::UserName;os='Windows';architecture=$env:PROCESSOR_ARCHITECTURE;version=[Environment]::OSVersion.Version.ToString();machineId=$machineId;computerName=$env:COMPUTERNAME}",
      "$value | ConvertTo-Json -Compress"
    ].join("; ")
  );
}
function parseMacosProbe(output) {
  const lines = output.replaceAll("\r", "").split("\n");
  const machineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  if (lines[0] !== "__DAWN_FORGE_MACOS_V1__" || !lines[1] || lines[2] !== "Darwin" || !lines[3] || !machineId) {
    throw new TargetInputError("\u65E0\u6CD5\u89E3\u6790 macOS identity probe\u3002");
  }
  return {
    identityEvidence: {
      sshHostKeyFingerprint: "",
      machineId,
      architecture: lines[3],
      remoteUser: lines[1]
    }
  };
}
function parseWindowsProbe(output) {
  let value;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new TargetInputError("\u65E0\u6CD5\u89E3\u6790 Windows identity probe\u3002");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TargetInputError("\u65E0\u6CD5\u89E3\u6790 Windows identity probe\u3002");
  }
  const record = value;
  if (record.marker !== "__DAWN_FORGE_WINDOWS_V1__" || typeof record.user !== "string" || typeof record.architecture !== "string" || typeof record.machineId !== "string") {
    throw new TargetInputError("\u65E0\u6CD5\u89E3\u6790 Windows identity probe\u3002");
  }
  return {
    identityEvidence: {
      sshHostKeyFingerprint: "",
      machineId: record.machineId,
      architecture: record.architecture,
      remoteUser: record.user
    }
  };
}
var NodeSshTargetAdapter = class {
  #ssh;
  #sshKeygen;
  #run;
  constructor(ssh = "ssh", sshKeygen = "ssh-keygen", run = defaultProcessRunner) {
    this.#ssh = ssh;
    this.#sshKeygen = sshKeygen;
    this.#run = run;
  }
  authorizationCommand(connection, authorizedKeyLine) {
    const publicKeyBlob = authorizedKeyLine.match(
      /\bssh-ed25519 ([A-Za-z0-9+/=]+)(?:\s|$)/
    )?.[1];
    if (!publicKeyBlob) {
      throw new TargetInputError("\u65E0\u6CD5\u89E3\u6790 authorized_keys public key\u3002");
    }
    const remoteCommand = connection.platform === "windows" ? windowsRemoteCommand(
      windowsAuthorizeScript(authorizedKeyLine, publicKeyBlob)
    ) : macosAuthorizeScript(authorizedKeyLine, publicKeyBlob);
    const args = [
      "-F",
      "none",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "IdentityAgent=none",
      "-o",
      `UserKnownHostsFile=${connection.knownHostsPath}`,
      "-o",
      "GlobalKnownHostsFile=none",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-l",
      connection.user,
      connection.host,
      remoteCommand
    ];
    return process.platform === "win32" ? windowsControllerCommand(this.#ssh, args) : [this.#ssh, ...args].map(shellQuote).join(" ");
  }
  async probe(connection) {
    const result = this.#run(
      this.#ssh,
      [
        "-F",
        connection.configPath,
        connection.alias,
        connection.platform === "windows" ? windowsProbeCommand() : macosProbeCommand()
      ],
      15e3
    );
    this.#assertSshSucceeded(result);
    const parsed = connection.platform === "windows" ? parseWindowsProbe(result.stdout) : parseMacosProbe(result.stdout);
    return {
      platform: connection.platform,
      identityEvidence: {
        ...parsed.identityEvidence,
        sshHostKeyFingerprint: this.#hostKeyFingerprint(
          connection.knownHostsPath
        )
      }
    };
  }
  async verifyAuthorization(connection, authorizedKeyLine) {
    const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
    const remoteCommand = connection.platform === "windows" ? windowsRemoteCommand(
      [
        "$ErrorActionPreference='Stop'",
        "$f=Join-Path (Join-Path $HOME '.ssh') 'authorized_keys'",
        `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
        "if(-not(Test-Path -LiteralPath $f)){throw 'authorized_keys missing'}",
        "if(-not([IO.File]::ReadAllLines($f) -ccontains $k)){throw 'controlled authorized_keys entry missing'}"
      ].join("; ")
    ) : [
      "set -e",
      `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
      'AUTH="$HOME/.ssh/authorized_keys"',
      'grep -Fqx -- "$KEY" "$AUTH"'
    ].join("; ");
    const result = this.#run(
      this.#ssh,
      ["-F", connection.configPath, connection.alias, remoteCommand],
      15e3
    );
    this.#assertSshSucceeded(result);
  }
  async rollbackAuthorization(connection, authorizedKeyLine) {
    const encodedLine = Buffer.from(authorizedKeyLine).toString("base64");
    const remoteCommand = connection.platform === "windows" ? windowsRemoteCommand(
      [
        "$ErrorActionPreference='Stop'",
        "$f=Join-Path (Join-Path $HOME '.ssh') 'authorized_keys'",
        `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedLine}'))`,
        'if(Test-Path -LiteralPath $f){$lines=@([IO.File]::ReadAllLines($f)|Where-Object{$_ -cne $k});$text=if($lines.Count -gt 0){($lines -join "`n")+"`n"}else{\'\'};[IO.File]::WriteAllText($f,$text,[Text.UTF8Encoding]::new($false))}'
      ].join("; ")
    ) : [
      "set -e",
      `KEY="$(printf %s '${encodedLine}' | base64 -D)"`,
      'AUTH="$HOME/.ssh/authorized_keys"',
      `[ ! -f "$AUTH" ] || { TMP="$AUTH.dawn-forge.$$"; trap 'rm -f "$TMP"' EXIT; awk -v key="$KEY" '$0 != key { print }' "$AUTH" > "$TMP"; mv "$TMP" "$AUTH"; chmod 600 "$AUTH"; }`
    ].join("; ");
    const result = this.#run(
      this.#ssh,
      ["-F", connection.configPath, connection.alias, remoteCommand],
      15e3
    );
    this.#assertSshSucceeded(result);
  }
  async revoke(connection, publicKeyBlob) {
    const remoteCommand = connection.platform === "windows" ? windowsRemoteCommand(
      [
        "$ErrorActionPreference='Stop'",
        "$f=Join-Path (Join-Path $HOME '.ssh') 'authorized_keys'",
        `if(Test-Path -LiteralPath $f){$b='${publicKeyBlob}';$lines=@([IO.File]::ReadAllLines($f)|Where-Object{-not(($_ -split '\\s+') -contains $b)});$text=if($lines.Count -gt 0){($lines -join "\`n")+"\`n"}else{''};[IO.File]::WriteAllText($f,$text,[Text.UTF8Encoding]::new($false))}`
      ].join("; ")
    ) : [
      "set -e",
      `BLOB='${publicKeyBlob}'`,
      'AUTH="$HOME/.ssh/authorized_keys"',
      `[ ! -f "$AUTH" ] || { TMP="$AUTH.dawn-forge.$$"; trap 'rm -f "$TMP"' EXIT; awk -v blob="$BLOB" '{ keep=1; for (i=1; i<=NF; i++) if ($i == blob) keep=0; if (keep) print }' "$AUTH" > "$TMP"; mv "$TMP" "$AUTH"; chmod 600 "$AUTH"; }`
    ].join("; ");
    const result = this.#run(
      this.#ssh,
      ["-F", connection.configPath, connection.alias, remoteCommand],
      15e3
    );
    this.#assertSshSucceeded(result);
  }
  #hostKeyFingerprint(knownHostsPath) {
    const result = this.#run(
      this.#sshKeygen,
      ["-lf", knownHostsPath],
      1e4
    );
    if (result.error || result.status !== 0) {
      throw new TargetInputError(
        result.stderr.trim() || result.error?.message || "\u65E0\u6CD5\u8BFB\u53D6 SSH host key fingerprint\u3002"
      );
    }
    const fingerprints = [
      ...new Set(result.stdout.match(/\bSHA256:[A-Za-z0-9+/=]+\b/g) ?? [])
    ].sort();
    if (fingerprints.length === 0) {
      throw new TargetInputError("known_hosts \u4E2D\u6CA1\u6709 SSH host key fingerprint\u3002");
    }
    return fingerprints.join(",");
  }
  #assertSshSucceeded(result) {
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(
      `${result.stderr}
${result.stdout}`
    )) {
      throw new IdentityConflictError(["sshHostKeyFingerprint"]);
    }
    if (result.error || result.status !== 0) {
      throw new TargetInputError(
        result.stderr.trim() || result.stdout.trim() || result.error?.message || `SSH \u5931\u8D25\uFF0C\u9000\u51FA\u7801 ${result.status ?? "unknown"}\u3002`
      );
    }
  }
};
function createTargetManager(options) {
  if (process.platform !== "win32") {
    throw new TargetInputError(
      "Dawn Engine V1 \u4EC5\u652F\u6301 Windows \u63A7\u5236\u673A\u3002"
    );
  }
  const homeDirectory = options?.homeDirectory ?? homedir2();
  return new TargetManager({
    homeDirectory,
    now: () => /* @__PURE__ */ new Date(),
    keyProvider: new NodeControllerKeyProvider(
      homeDirectory,
      process.env.DAWN_SSH_KEYGEN ?? "ssh-keygen"
    ),
    ssh: new NodeSshTargetAdapter(
      process.env.DAWN_SSH ?? "ssh",
      process.env.DAWN_SSH_KEYGEN ?? "ssh-keygen"
    ),
    authorize: options?.authorize ?? (async () => {
      throw new TargetNeedsUserError();
    })
  });
}

// src/cli/index.ts
var usage = `\u7528\u6CD5\uFF1Adawn <command>

\u547D\u4EE4\uFF1A
  target bootstrap --host <host> --user <user> --name <name>
  target inspect --target <id>
  target revoke --target <id>
  plan
  apply
  run show --run <runId>
  resume
  verify`;
var stateMarkers = {
  succeeded: "\u2713",
  skipped: "-",
  failed: "\u2717",
  blocked: "~",
  pending: " ",
  running: ">",
  needs_user: "?"
};
function parseOptions(args, allowed) {
  const options = /* @__PURE__ */ new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || !allowed.has(option) || !value || value.startsWith("--") || options.has(option)) {
      throw new Error("\u53C2\u6570\u65E0\u6548\u3002");
    }
    options.set(option, value);
  }
  return options;
}
function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) {
    throw new Error(`\u7F3A\u5C11\u53C2\u6570\uFF1A${name}`);
  }
  return value;
}
function showRun(args, stdout) {
  const options = parseOptions(args, /* @__PURE__ */ new Set(["--run"]));
  const runId = requiredOption(options, "--run");
  const { snapshot } = readRun(runId);
  stdout(`Run ${runId}`);
  stdout(`Outcome: ${snapshot.outcome ?? "in-progress"}`);
  stdout("\nActions:");
  for (const action of snapshot.actions) {
    const error = action.state === "failed" && action.error ? `\uFF1A${action.error}` : "";
    stdout(
      `  [${stateMarkers[action.state]}] ${action.actionId}  ${action.state}${error}`
    );
  }
}
function targetSummary(target) {
  return [
    `Target ${target.targetId}`,
    `  name: ${target.displayName}`,
    `  platform: ${target.platform}`,
    `  machineId: ${target.identityEvidence.machineId}`,
    `  architecture: ${target.identityEvidence.architecture}`,
    `  remoteUser: ${target.identityEvidence.remoteUser}`,
    `  hostKey: ${target.identityEvidence.sshHostKeyFingerprint}`,
    `  targetFingerprint: ${target.targetFingerprint}`
  ].join("\n");
}
async function confirmAuthorizationCommand(command, stdout) {
  stdout("\u8BF7\u5728\u63A7\u5236\u673A\u7EC8\u7AEF\u6267\u884C\u4EE5\u4E0B\u547D\u4EE4\uFF0C\u5C06\u53D7\u9650\u516C\u94A5\u5199\u5165\u76EE\u6807\u673A\uFF1A");
  stdout(command);
  if (process.env.DAWN_AUTO_CONFIRM === "1") {
    return true;
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await readline.question(
      "\u547D\u4EE4\u6210\u529F\u5B8C\u6210\u540E\u8F93\u5165 yes \u7EE7\u7EED\uFF1A"
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
function defaultTargetManager(stdout) {
  return createTargetManager({
    authorize: (command) => confirmAuthorizationCommand(command, stdout)
  });
}
async function runCli(args, dependencies = {}) {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      stdout(usage);
      return ExitCode.Success;
    }
    const command = args[0] === "target" || args[0] === "run" ? `${args[0]} ${args[1] ?? ""}`.trim() : args[0];
    const knownCommands = /* @__PURE__ */ new Set([
      "target bootstrap",
      "target inspect",
      "target revoke",
      "plan",
      "apply",
      "run show",
      "resume",
      "verify"
    ]);
    if (!knownCommands.has(command)) {
      stderr(`\u672A\u77E5\u547D\u4EE4\uFF1A${command}`);
      return ExitCode.ParamError;
    }
    if (command === "run show") {
      try {
        showRun(args.slice(2), stdout);
        return ExitCode.Success;
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof Error && "code" in error && error.code === "ENOENT") {
          stderr(
            `\u627E\u4E0D\u5230\u6216\u65E0\u6CD5\u8BFB\u53D6 Run\uFF1A${args[args.indexOf("--run") + 1] ?? ""}`
          );
          return ExitCode.ParamError;
        }
        throw error;
      }
    }
    if (command.startsWith("target ")) {
      const targetManager = dependencies.targetManager ?? defaultTargetManager(stdout);
      if (command === "target bootstrap") {
        const options2 = parseOptions(
          args.slice(2),
          /* @__PURE__ */ new Set(["--host", "--user", "--name"])
        );
        const target = await targetManager.bootstrap({
          host: requiredOption(options2, "--host"),
          user: requiredOption(options2, "--user"),
          name: requiredOption(options2, "--name")
        });
        stdout(targetSummary(target));
        return ExitCode.Success;
      }
      const options = parseOptions(args.slice(2), /* @__PURE__ */ new Set(["--target"]));
      const targetId = requiredOption(options, "--target");
      if (command === "target inspect") {
        stdout(targetSummary(await targetManager.inspect(targetId)));
      } else {
        await targetManager.revoke(targetId);
        stdout(`\u5DF2\u64A4\u9500 Target ${targetId}\uFF1A\u8FDC\u7AEF\u516C\u94A5\u548C\u672C\u5730\u8BB0\u5F55\u5747\u5DF2\u5220\u9664\u3002`);
      }
      return ExitCode.Success;
    }
    stderr(`\u5C1A\u672A\u5B9E\u73B0\uFF1A${command}`);
    return ExitCode.ParamError;
  } catch (error) {
    if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number") {
      stderr(error.message);
      return error.exitCode;
    }
    if (error instanceof Error) {
      stderr(error.message);
      return ExitCode.ParamError;
    }
    throw error;
  }
}
var entryPath = process.argv[1] ? pathToFileURL(resolveEntryPath(process.argv[1])).href : void 0;
if (entryPath === import.meta.url) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
function resolveEntryPath(path) {
  return resolve2(path);
}
export {
  runCli
};
