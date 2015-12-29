var Promise = require('rsvp').Promise;
var asp = require('rsvp').denodeify;
var fs = require('graceful-fs');
var exec = require('child_process').exec;
var semver = require('semver');
var path = require('path');
var rimraf = require('rimraf');
var request = require('request');

var tar = require('tar');
var zlib = require('zlib');

function extend(a, b) {
  for (var p in b)
    a[p] = b[p];
  return a;
}

var defaultRepo = 'https://github.com/jspm/registry.git';

var registry = module.exports = function registry(options, ui) {
  this.ui = ui;
  this.registryPath = options.tmpDir;
  this.registryUpdated = false;
  this.repo = options.repo || defaultRepo;

  this.execOptions = {
    cwd: options.tmpDir,
    timeout: options.timeout * 1000,
    killSignal: 'SIGKILL'
  };

  this.username = options.username;
  this.password = options.password;
}

registry.configure = function(config, ui) {
  return ui.input('Enter the Artifactory path', config.repo || defaultRepo)
  .then(function(repo) {
    config.repo = repo;
    return config;
  });
}

registry.prototype.parse = function(name) {
  var parts = name.split('/');
  return {
    package: parts[0],
    path: parts.splice(1).join('/')
  };
}

registry.prototype.locate = function(repo) {
  return this.updateRegistry()
  .then(function(registry) {

    // NB support versioned redirects
    var registryEntry = registry[repo];

    if (!registryEntry)
      return { notfound: true };

    return { redirect: registryEntry };
  });
}


// registry endpoint is in charge of overrides, special hook
registry.prototype.getOverride = function(endpoint, repo, version, givenOverride) {
  // we get a folder listing for the right name
  // if we have a listing we filter to the override versions for that package
  // we take the highest override that creates a semver range we are compatible with
  var packageParts = repo.split('/');
  var overrideName = packageParts.pop();
  var overrideDir = path.resolve(this.registryPath, 'package-overrides', endpoint, packageParts.join('/'));

  var ui = this.ui;

  return this.updateRegistry()
  .then(function() {
    return asp(fs.readdir)(overrideDir);
  })
  .then(function(files) {
    var overrideFile = files
    // find the files for this override name
    .filter(function(file) {
      return file.substr(0, overrideName.length) == overrideName && file.substr(overrideName.length, 1) == '@';
    })
    // derive versions
    .map(function(file) {
      return {
        version: file.substr(overrideName.length + 1, file.length - overrideName.length - 6),
        file: file
      };
    })
    // filter to only semver compatible overrides
    .filter(function(item) {
      if (semver.valid(version))
        return semver.satisfies(version, '^' + item.version);
      else
        return version == item.version;
    })
    // sort to find latest
    .sort(function(a, b) {
      return semver.compare(a.version, b.version);
    })
    .map(function(item) {
      return item.file;
    })
    .pop();

    // return that loaded override
    if (!overrideFile)
      return;

    return asp(fs.readFile)(path.resolve(overrideDir, overrideFile))
    .then(function(pjson) {
      try {
        return JSON.parse(pjson);
      }
      catch(e) {
        return;
      }
    }, function(err) {
      if (err.code === 'ENOENT')
        return;
      ui.log('warn', 'Override file `' + overrideFile + '` found, but JSON is invalid');
    });
  }, function(err) {
    if (err.code === 'ENOENT')
      return;
    throw err;
  })
  .then(function(override) {
    // if an existing override, let it extend this override
    if (givenOverride)
      extend(override = (override || {}), givenOverride);

    return override;
  });
}

registry.prototype.createRegistry = function() {
  var ui = this.ui;
  ui.log('info', 'Creating registry cache...');

  var self = this;
  //var registryPath = this.registryPath;
  return asp(rimraf)(path.resolve(this.registryPath))
  .then(function() {
    return asp(fs.mkdir)(path.resolve(self.registryPath));
  })
  .then(function() {
      return new Promise(function(resolve, reject) {
        request({
          uri:self.repo,
          headers: { 'accept': 'application/octet-stream' }
        })
          .on('response', function(pkgRes) {
            if (pkgRes.statusCode != 200)
              return reject('Bad response code ' + pkgRes.statusCode);
            pkgRes.pause();
            var gzip = zlib.createGunzip();
            pkgRes
              .pipe(gzip)
              .pipe(tar.Extract({ path: self.registryPath, strip: 1 }))
              .on('error', reject)
              .on('end', resolve);
            pkgRes.resume();
            console.log(self.registryPath);
          })
          .on('error', reject);
      });
  })
  .catch(function(err) {
    ui.log('err', 'Error creating registry file\n' + (err.stack || err));
  });
}

registry.prototype.updateRegistry = function() {
  if (this.updatePromise_)
    return Promise.resolve(this.updatePromise_);

  var ui = this.ui;
  var registryPath = this.registryPath;
  var remoteString = this.repo;
  var execOptions = this.execOptions;
  var self = this;

  return this.updatePromise_ = asp(exec)('git remote show origin -n', execOptions)
  .then(function(output) {
    output = output.toString();

    //var curRepoMatch = output.match(/Fetch URL: ([^\n]+)/m);

    //if (!curRepoMatch || curRepoMatch[1] != self.repo)
      return self.createRegistry();
  }, function(err) {
    err = err.toString();

    // if the registry does not exist, do a git clone
    if (err.indexOf('Not a git repo') != -1)
      return self.createRegistry();
  })
  .then(function() {
    return asp(fs.readFile)(path.resolve(registryPath, 'registry.json'))
    .then(function(pjson) {
      try {
        return JSON.parse(pjson);
      }
      catch(e) {
        return {};
      }
    }, function(err) {
      if (err.code === 'ENOENT')
        return {};
      ui.log('warn', 'Registry file is invalid.');
    });
  })
  .then(function(json) {
    return json;
  });
}



