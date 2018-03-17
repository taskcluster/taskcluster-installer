const _ = require('lodash');
const util = require('util');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {PassThrough} = require('stream');
const split = require('split');
const {spawn} = require('child_process'); 
const rimraf = util.promisify(require('rimraf'));
const git = require('simple-git/promise');
const Docker = require('dockerode');
const doT = require('dot');
const {quote} = require('shell-quote');
const Observable = require('zen-observable');
const tar = require('tar-fs');
const yaml = require('js-yaml');
const got = require('got');

doT.templateSettings.strip = false;
const ENTRYPOINT_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'entrypoint.dot')));
const DOCKERFILE_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'dockerfile.dot')));

const serviceTasks = ({baseDir, spec, cfg, name, cmdOptions}) => {
  const service = _.find(spec.build.services, {name});
  const workDir = path.join(baseDir, `service-${name}`);
  const appDir = path.join(workDir, 'app');
  const buildpackDir = path.join(workDir, 'buildpack');

  const tasks = [];
  let docker, dockerRunOpts;

  const cleanup = async () => {
    await Promise.all([
      'app',
      'buildpack',
      'slug',
      'docker',
      // cache is left in place
    ].map(dir => rimraf(path.join(workDir, dir))));
  };

  const gitClone = async ({dir, url, sha, utils}) => {
    const [source, ref] = url.split('#');

    utils.status({message: `Cloning ${source}`});
    // TODO: update if already exists, and remove from clean step
    if (!fs.existsSync(path.join(workDir, dir))) {
      await git(workDir).clone(source, dir, ['--depth=1', `-b${ref || 'master'}`]);
    }
    // TODO: if sha is specified, reset to it
  };

  const dockerRun = async ({logfile, command, image, utils}) => {
    const output = new PassThrough();
    if (logfile) {
      output.pipe(fs.createWriteStream(path.join(workDir, logfile)));
    }

    const runPromise = docker.run(
      image,
      command,
      output,
      dockerRunOpts,
    );

    await utils.waitFor(output);
    await utils.waitFor(runPromise);
  };

  const dockerPull = async ({image, utils}) => {
    utils.status({message: `docker pull ${image}`});
    const dockerStream = await new Promise(
      (resolve, reject) => docker.pull(image, (err, stream) => err ? reject(err) : resolve(stream)));

    await utils.waitFor(new Observable(observer => {
      let downloading = {}, extracting = {}, totals = {};
      docker.modem.followProgress(dockerStream,
        err => err ? observer.error(err) : observer.complete(),
        update => {
          // The format of this stream appears undocumented, but we can fake it based on observations..
          // general messages seem to lack progressDetail
          if (!update.progressDetail) {
            return;
          }

          let progressed = false;
          if (update.status === 'Waiting') {
            totals[update.id] = 104857600; // a guess: 100MB
            progressed = true;
          } else if (update.status === 'Downloading') {
            downloading[update.id] = update.progressDetail.current;
            totals[update.id] = update.progressDetail.total;
            progressed = true;
          } else if (update.status === 'Extracting') {
            extracting[update.id] = update.progressDetail.current;
            totals[update.id] = update.progressDetail.total;
            progressed = true;
          }

          if (progressed) {
            // calculate overall progress by assuming that every image must be
            // downloaded and extracted, and that those both take the same amount
            // of time per byte.
            total = _.sum(Object.values(totals)) * 2;
            current = _.sum(Object.values(downloading)) + _.sum(Object.values(extracting));
            utils.status({progress: current * 100 / total});
          }
        });
    }));
  };

  const writeEntrypointScript = () => {
    const procfilePath = path.join(appDir, 'Procfile');
    if (!fs.existsSync(procfilePath)) {
      throw new Error(`Service ${name} has no Procfile`);
    }
    const Procfile = fs.readFileSync(procfilePath).toString();
    const procs = Procfile.split('\n').map(line => {
      if (!line || line.startsWith('#')) {
        return null;
      }
      const parts = /^([^:]+):?\s+(.*)$/.exec(line.trim());
      if (!parts) {
        throw new Error(`unexpected line in Procfile: ${line}`);
      }
      return {name: parts[1], command: quote([parts[2]])};
    }).filter(l => l !== null);
    const entrypoint = ENTRYPOINT_TEMPLATE({procs});
    fs.writeFileSync(path.join(workDir, 'entrypoint'), entrypoint, {mode: 0o777});
  };

  tasks.push({
    title: `Service ${name} - Preflight`,
    requires: [],
    provides: [
      `service-${name}-docker-image`, // docker image tag
      `service-${name}-exact-source`, // exact source URL
      `service-${name}-image-exists`, // true if the image already exists
    ],
    run: async (requirements, utils) => {
      utils.step({title: 'Clean'});
      await cleanup();

      utils.step({title: 'Set Up'});

      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir);
      }

      ['cache', 'env', 'slug', 'docker'].forEach(dir => {
        if (!fs.existsSync(path.join(workDir, dir))) {
          fs.mkdirSync(path.join(workDir, dir));
        }
      });

      docker = new Docker();
      // when running a docker container, always remove the container when finished, 
      // mount the workdir at /workdir, and run as the current (non-container) user
      // so that file ownership remains as expected.  Set up /etc/passwd and /etc/group
      // to define names for those uid/gid, too.
      const {uid, gid} = os.userInfo();
      fs.writeFileSync(path.join(workDir, 'passwd'),
        `root:x:0:0:root:/root:/bin/bash\nbuilder:x:${uid}:${gid}:builder:/:/bin/bash\n`);
      fs.writeFileSync(path.join(workDir, 'group'),
        `root:x:0:\nbuilder:x:${gid}:\n`);
      dockerRunOpts = {
        AutoRemove: true,
        User: `${uid}:${gid}`,
        Binds: [
          `${workDir}/passwd:/etc/passwd:ro`,
          `${workDir}/group:/etc/group:ro`,
          `${workDir}:/workdir`,
        ],
      };

      utils.step({title: 'Check for Existing Image'});
      const [source, ref] = service.source.split('#');
      const head = (await git(workDir).listRemote([source, ref])).split(/\s+/)[0];
      const tag = `${cfg.docker.repositoryPrefix}${name}:${head}`;

      // set up to skip other tasks if this tag already exists locally
      const dockerImages = await docker.listImages();
      // TODO: need docker image sha, if it exists (or set it later)
      const dockerImageExists = dockerImages.some(image => image.RepoTags.indexOf(tag) !== -1);

      // TODO: if not found locally, try to pull it

      return {
        [`service-${name}-docker-image`]: tag,
        [`service-${name}-exact-source`]: `${source}#${head}`,
        [`service-${name}-image-exists`]: dockerImageExists,
      };
    },
  });

  tasks.push({
    title: `Service ${name} - Compile`,
    requires: [
      `service-${name}-docker-image`,
      `service-${name}-image-exists`,
      `service-${name}-exact-source`,
    ],
    provides: [
      `service-${name}-built-app-dir`,
    ],
    run: async (requirements, utils) => {
      const provides = {
        [`service-${name}-built-app-dir`]: appDir,
      };

      // bail out early if we can skip this..
      if (requirements[`service-${name}-image-exists`]) {
        return utils.skip(provides);
      }

      utils.step({title: 'Check out Service Repo'});

      await gitClone({
        dir: 'app',
        url: service.source,
        utils,
      });

      utils.step({title: 'Read Build Config'});

      // default buildConfig
      buildConfig = {
        buildType: 'heroku-buildpack',
        stack: 'heroku-16',
        buildpack: 'https://github.com/heroku/heroku-buildpack-nodejs',
      };

      const buildConfigFile = path.join(appDir, '.build-config.yml');
      if (fs.existsSync(buildConfigFile)) {
        const config = yaml.safeLoad(buildConfigFile);
        Object.assign(buildConfig, config);
      }

      utils.step({title: 'Check out Buildpack Repo'});

      await gitClone({
        dir: 'buildpack',
        url: buildConfig.buildpack,
        utils,
      });

      utils.step({title: 'Pull Stack Image'});

      stackImage = `heroku/${buildConfig.stack.replace('-', ':')}`;
      await dockerPull({image: stackImage, utils});

      utils.step({title: 'Pull Build Image'});

      buildImage = `heroku/${buildConfig.stack.replace('-', ':')}-build`;
      await dockerPull({image: buildImage, utils});

      utils.step({title: 'Buildpack Detect'});

      await dockerRun({
        image: buildImage,
        command: ['workdir/buildpack/bin/detect', '/workdir/app'],
        logfile: 'detect.log',
        utils,
      });

      utils.step({title: 'Buildpack Compile'});

      await dockerRun({
        image: buildImage,
        command: ['workdir/buildpack/bin/compile', '/workdir/app', '/workdir/cache', '/workdir/env'],
        logfile: 'compile.log',
        utils,
      });

      return provides;
    },
  });

  tasks.push({
    title: `Service ${name} - Build Image`,
    requires: [
      `service-${name}-docker-image`,
      `service-${name}-image-exists`,
      `service-${name}-exact-source`,
      `service-${name}-built-app-dir`,
    ],
    provides: [
      `service-${name}-image-built`,
    ],
    run: async (requirements, utils) => {
      const provides = {
        [`service-${name}-image-built`]: true,
      };

      // bail out early if we can skip this..
      if (requirements[`service-${name}-image-exists`]) {
        return utils.skip(provides);
      }

      utils.step({title: 'Create Entrypoint Script'});

      writeEntrypointScript();

      utils.step({title: 'Build Final Image'});

      // TODO: omit git dir, but not node_modules
      // TODO: no need to rename, just include in tarball
      fs.renameSync(appDir, path.join(workDir, 'docker', 'app'));
      fs.renameSync(path.join(workDir, 'entrypoint'), path.join(workDir, 'docker', 'entrypoint'));

      const dockerfile = DOCKERFILE_TEMPLATE({buildImage});
      fs.writeFileSync(path.join(workDir, 'docker', 'Dockerfile'), dockerfile);

      const log = path.join(workDir, 'build.log');
      const tag = requirements[`service-${name}-docker-image`];
      utils.status({progress: 0, message: `Building ${tag}`});
      const buildStream = await docker.buildImage(
        tar.pack(path.join(workDir, 'docker')),
        {t: tag});
      buildStream.pipe(fs.createWriteStream(log));
      await utils.waitFor(new Observable(observer => {
        docker.modem.followProgress(buildStream,
          err => err ? observer.error(err) : observer.complete(),
          update => {
            if (!update.stream) {
              return;
            }
            observer.next(update.stream);
            const parts = /^Step (\d+)\/(\d+)/.exec(update.stream);
            if (parts) {
              utils.status({progress: 100 * parseInt(parts[1], 10) / (parseInt(parts[2], 10) + 1)});
            }
          });
      }));

      return provides;
    },
  });

  tasks.push({
    title: `Service ${name} - Push Image`,
    requires: [
      `service-${name}-docker-image`,
      `service-${name}-image-built`,
      `service-${name}-image-exists`,
    ],
    provides: [
    ],
    run: async (requirements, utils) => {
      const provides = {
      };

      // bail out early if we can skip this..
      if (requirements[`service-${name}-image-exists`] || !cmdOptions.push) {
        return utils.skip(provides);
      }

      const dockerImage = requirements[`service-${name}-docker-image`];
      const repoImage = dockerImage.split(':');
      try {
        const res = await got(`https://index.docker.io/v1/repositories/${repoImage[0]}/tags`, {json: true}); // Sad hack
        if (res.body && _.includes(res.body.map(l => l.name), repoImage[1])) {
          utils.status({message: `${dockerImage} already exists on dockerhub`});
          return utils.skip(provides);
        }
      } catch (err) {
        if (err.statusCode !== 404) {
          throw err;
        }
      }
      const log = path.join(workDir, 'push.log');
      const logFile = fs.createWriteStream(log);
      await utils.waitFor(new Observable(observer => {
        const push = spawn('docker', ['push', dockerImage]);
        push.on('error', observer.error);
        push.stdout.pipe(logFile);
        push.stderr.pipe(logFile);
        push.stdout.pipe(split(/\r?\n/, null, {trailing: false})).on('data', d => observer.next(d.toString()));
        push.stderr.pipe(split(/\r?\n/, null, {trailing: false})).on('data', d => observer.next(d.toString()));
        push.on('exit', (code, signal) => {
          if (code !== 0) {
            observer.error(new Error(`push failed! check ${log} for reason`));
          } else {
            observer.complete();
          }
        });
      }));

      return provides;
    },
  });

  return tasks;
};

exports.serviceTasks = serviceTasks;
