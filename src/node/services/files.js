'use strict';

const _ = require('lodash'),
  bluebird = require('bluebird'),
  chokidar = require('chokidar'),
  fs = require('fs'),
  path = require('path'),
  log = require('./log').asInternal(__filename),
  temp = require('temp'),
  fileWatchers = {};

temp.track();

/**
 * @param {string} filePath
 * @returns {object}
 */
function getJSONFileSafeSync(filePath) {
  let contents,
    result = null;

  try {
    contents = fs.readFileSync(filePath, {encoding: 'UTF8'});

    try {
      result = JSON.parse(contents);
    } catch (e) {
      log('warn', filePath, 'is not valid JSON', e);
    }
  } catch (ex) {
    // deliberately no warning, thus "safe".
  }

  return result;
}

/**
 * @param {string} dirPath
 * @returns {Promise<[{path: string, filename: string, isDirectory: boolean}]>}
 */
function readDirectory(dirPath) {
  const read = bluebird.promisify(fs.readdir);

  dirPath = resolveHomeDirectory(dirPath);

  return read(dirPath).map(function (filename) {
    const fullPath = path.join(dirPath, filename);

    return getStats(fullPath).then(function (fileStats) {
      fileStats.path = fullPath;
      _.assign(fileStats, path.posix.parse(fullPath));

      return fileStats;
    }).catch(function (statEx) {
      log('warn', 'getStats failed', filename, statEx);
      return undefined;
    });
  }).then(list => _.compact(list));
}

/**
 * @param {string} suffix
 * @param {string|Buffer} data
 * @returns {Promise<string>}
 */
function saveToTemporaryFile(suffix, data) {
  return new bluebird(function (resolve) {
    const stream = temp.createWriteStream({suffix});

    stream.write(data);
    stream.end();

    resolve(stream.path);
  }).timeout(10000, 'Timed out trying to save temporary file with extension', suffix);
}

/**
 * @param {string} str
 * @returns {string}
 */
function resolveHomeDirectory(str) {
  if (_.startsWith(str, '~') || _.startsWith(str, '%HOME%')) {
    const home = require('os').homedir();

    str = str.replace(/^~/, home).replace(/^%HOME%/, home);
  }

  return str;
}

/**
 * Convert /Users/somename/file.txt to ~/file.txt
 * @param {string} str
 * @returns {string}
 */
function getWithHomeDirectoryShortName(str) {
  const home = require('os').homedir();

  if (_.startsWith(str, home)) {
    str = path.join('~', str.substr(home.length));
  }

  return str;
}

function getStats(filename) {
  filename = resolveHomeDirectory(filename);
  const lstat = bluebird.promisify(fs.lstat);

  return lstat(filename)
    .catch(function (lstatEx) {
      log('warn', 'lstat failed', filename, lstatEx);
      const stat = bluebird.promisify(fs.stat);

      return stat(filename);
    })
    .then(normalizeStats);
}

function close(fd) {
  return new bluebird(function (resolve, reject) {
    log('info', 'closing', {fd});
    fs.close(fd, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function open(filename, flags) {
  return new bluebird(function (resolve, reject) {
    log('info', 'opening', {filename, flags});
    fs.open(filename, flags, function (err, fd) {
      log('info', 'opened', {filename, err, fd});
      if (err) {
        reject(err);
      } else {
        resolve(fd);
      }
    });
  }).disposer(function (fd) {
    log('info', 'open disposer', {filename, fd});
    return close(fd);
  });
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<undefined>}
 */
function copy(src, dest) {
  log('info', 'copy', {src, dest});

  return bluebird.using(open(src, 'r'), open(dest, 'w'), function (readFd, writeFd) {
    return new bluebird(function (resolve, reject) {
      log('info', 'starting copy', {readFd, writeFd});
      const done = _.once(function (error, result) {
        log('info', 'copy', 'done', {readFd, writeFd});

        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
      let readStream, writeStream;

      readStream = fs.createReadStream(src, {fd: readFd, autoClose: false})
        .on('error', done)
        .on('end', () => log('info', 'copy', 'readEnd'));

      writeStream = fs.createWriteStream(dest, {fd: writeFd, autoClose: false})
        .on('error', done)
        .on('finish', () => {
          log('info', 'copy', 'writeFinish');
          done();
        });

      readStream.pipe(writeStream);
    });
  });
}

function dispatch(ipcEmitter, data) {
  ipcEmitter.send('dispatch', 'files', data);
}

/**
 * We can't send functions across a network, so convert these functions into their results immediately
 * @param {fs.Stats} stats
 * @returns {object}
 */
function normalizeStats(stats) {
  if (stats) {
    stats.isDirectory = _.result(stats, 'isDirectory', false);
    stats.isFile = _.result(stats, 'isFile', false);
    stats.isSymbolicLink = _.result(stats, 'isSymbolicLink', false);
  }

  return stats;
}

function getFileSystemChangeToken(eventType, filePath, details) {
  details = normalizeStats(details);
  const event = {
    type: 'FILE_SYSTEM_CHANGED',
    eventType,
    path: filePath
  };

  // duck-typing: if details exists and has a property with this name
  if (details && details.isDirectory !== undefined) {
    details = normalizeStats(details);
    details.path = filePath;
    _.assign(details, path.posix.parse(filePath));
    event.details = details;
  } else {
    log('info', 'HEEEEEY', eventType, filePath, details);
  }

  return event;
}

/**
 *
 * @param {object} ipcEmitter
 * @param {string} requesterId
 * @param {string|Array} fileTarget
 */
function startWatching(ipcEmitter, requesterId, fileTarget) {
  if (_.isArray(fileTarget)) {
    fileTarget = _.map(fileTarget, str => resolveHomeDirectory(str));
  } else if (_.isString(fileTarget)) {
    fileTarget = resolveHomeDirectory(fileTarget);
  }

  log('info', 'startWatching', requesterId, fileTarget);

  const watcher = chokidar.watch(fileTarget, {
    awaitWriteFinish: true,
    persistent: true,
    followSymlinks: false,
    usePolling: false,
    depth: 1, // graphics beyond this get weird,
    ignorePermissionErrors: false,
    ignored: [/[\/\\]\./, /rodeo.log/],
    ignoreInitial: true
  });

  watcher
    .on('add', (path, stats) => log('info', `File ${path} has been added`, stats))
    .on('change', (path, stats) => log('info', `File ${path} has been changed`, stats))
    .on('unlink', path => log('info', `File ${path} has been removed`))
    .on('addDir', (path, stats) => log('info', `Directory ${path} has been added`, stats))
    .on('unlinkDir', path => log('info', `Directory ${path} has been removed`))
    .on('error', error => log('info', `Watcher error: ${error}`))
    .on('ready', () => log('info', 'Initial scan complete. Ready for changes'))
    .on('all', (eventType, path, details) => {
      const event = getFileSystemChangeToken(eventType, path, details);

      log('info', 'All event info:', event);

      dispatch(ipcEmitter, event);
    });

  if (fileWatchers[requesterId]) {
    stopWatching(requesterId);
  }

  fileWatchers[requesterId] = watcher;
}

/**
 * @param {string} requesterId
 */
function stopWatching(requesterId) {
  if (requesterId) {
    fileWatchers[requesterId].close();
    delete fileWatchers[requesterId];
  } else {
    _.each(fileWatchers, watcher => watcher.close());
  }
}

/**
 * @param {string} requesterId
 * @param {string|Array} fileTarget
 */
function addWatching(requesterId, fileTarget) {
  if (_.isArray(fileTarget)) {
    fileTarget = _.map(fileTarget, str => resolveHomeDirectory(str));
  } else if (_.isString(fileTarget)) {
    fileTarget = resolveHomeDirectory(fileTarget);
  }

  log('info', 'addWatching', requesterId, fileTarget);

  if (fileWatchers[requesterId]) {
    fileWatchers[requesterId].add(fileTarget);
  }
}

module.exports.getJSONFileSafeSync = getJSONFileSafeSync;
module.exports.readFile = _.partialRight(bluebird.promisify(fs.readFile), 'utf8');
module.exports.writeFile = bluebird.promisify(fs.writeFile);
module.exports.readDirectory = readDirectory;
module.exports.makeDirectory = bluebird.promisify(fs.mkdir);
module.exports.getStats = getStats;
module.exports.exists = bluebird.promisify(fs.exists);
module.exports.unlink = bluebird.promisify(fs.unlink);
module.exports.saveToTemporaryFile = saveToTemporaryFile;
module.exports.resolveHomeDirectory = resolveHomeDirectory;
module.exports.getWithHomeDirectoryShortName = getWithHomeDirectoryShortName;
module.exports.copy = copy;
module.exports.startWatching = startWatching;
module.exports.stopWatching = stopWatching;
module.exports.addWatching = addWatching;
