const _ = require('lodash');
const util = require('util');
const fs = require('fs');
const path = require('path');
const split = require('split');
const rimraf = util.promisify(require('rimraf'));
const git = require('simple-git/promise');
const doT = require('dot');
const {quote} = require('shell-quote');
const yaml = require('js-yaml');
const {gitClone, dockerRun, dockerPull, dockerImages, dockerBuild, dockerRegistryCheck,
  dockerPush} = require('./utils');

doT.templateSettings.strip = false;
const ENTRYPOINT_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'entrypoint.dot')));
const DOCKERFILE_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'dockerfile.dot')));

const serviceTasks = ({baseDir, spec, cfg, name, cmdOptions}) => {
  const service = _.find(spec.build.services, {name});
  const workDir = path.join(baseDir, `service-${name}`);
  const appDir = path.join(workDir, 'app');
  const buildpackDir = path.join(workDir, 'buildpack');

  const tasks = [];

  const cleanup = async () => {
    await Promise.all([
      'app',
      'buildpack',
      'slug',
      'docker',
      // cache is left in place
    ].map(dir => rimraf(path.join(workDir, dir))));
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
      `service-${name}-image-on-registry`, // true if the image already exists
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

      utils.step({title: 'Check for Existing Image'});

      const [source, ref] = service.source.split('#');
      const head = (await git(workDir).listRemote([source, ref])).split(/\s+/)[0];
      const tag = `${cfg.docker.repositoryPrefix}${name}:${head}`;

      // set up to skip other tasks if this tag already exists locally
      const localDockerImages = await dockerImages({workDir});
      // TODO: need docker image sha, if it exists (or set it later)
      const dockerImageExists = localDockerImages.some(image => image.RepoTags && image.RepoTags.indexOf(tag) !== -1);

      utils.step({title: 'Check for Existing Image on Registry'});

      // check whether it's on the registry, too
      const onRegistry = await dockerRegistryCheck({tag});

      return {
        [`service-${name}-docker-image`]: tag,
        [`service-${name}-exact-source`]: `${source}#${head}`,
        [`service-${name}-image-exists`]: dockerImageExists,
        [`service-${name}-image-on-registry`]: onRegistry,
      };
    },
  });

  tasks.push({
    title: `Service ${name} - Compile`,
    requires: [
      `service-${name}-docker-image`,
      `service-${name}-image-exists`,
      `service-${name}-image-on-registry`,
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
      if (requirements[`service-${name}-image-exists`] || requirements[`service-${name}-image-on-registry`]) {
        // TODO: need to get app dir from that image..
        return utils.skip(provides);
      }

      utils.step({title: 'Check out Service Repo'});

      await gitClone({
        dir: 'app',
        url: service.source,
        utils,
        workDir,
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
        workDir,
      });

      utils.step({title: 'Pull Stack Image'});

      stackImage = `heroku/${buildConfig.stack.replace('-', ':')}`;
      await dockerPull({image: stackImage, utils, workDir});

      utils.step({title: 'Pull Build Image'});

      buildImage = `heroku/${buildConfig.stack.replace('-', ':')}-build`;
      await dockerPull({image: buildImage, utils, workDir});

      utils.step({title: 'Buildpack Detect'});

      await dockerRun({
        image: buildImage,
        command: ['workdir/buildpack/bin/detect', '/workdir/app'],
        logfile: 'detect.log',
        utils,
        workDir,
      });

      utils.step({title: 'Buildpack Compile'});

      await dockerRun({
        image: buildImage,
        command: ['workdir/buildpack/bin/compile', '/workdir/app', '/workdir/cache', '/workdir/env'],
        logfile: 'compile.log',
        utils,
        workDir,
      });

      return provides;
    },
  });

  tasks.push({
    title: `Service ${name} - Build Image`,
    requires: [
      `service-${name}-docker-image`,
      `service-${name}-image-exists`,
      `service-${name}-image-on-registry`,
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
      if (requirements[`service-${name}-image-exists`] || requirements[`service-${name}-image-on-registry`]) {
        return utils.skip(provides);
      }

      utils.step({title: 'Create Entrypoint Script'});

      writeEntrypointScript();

      utils.step({title: 'Build Final Image'});

      // TODO: omit git dir, but not node_modules
      // TODO: no need to rename, just include in tarball
      fs.renameSync(appDir, path.join(workDir, 'docker', 'app'));
      fs.renameSync(path.join(workDir, 'entrypoint'), path.join(workDir, 'docker', 'entrypoint'));

      const dockerfile = DOCKERFILE_TEMPLATE({stackImage});
      fs.writeFileSync(path.join(workDir, 'docker', 'Dockerfile'), dockerfile);

      await dockerBuild({
        dir: path.join(workDir, 'docker'),
        logfile: 'docker-build.log',
        tag: requirements[`service-${name}-docker-image`],
        utils,
        workDir,
      });

      return provides;
    },
  });

  tasks.push({
    title: `Service ${name} - Push Image`,
    requires: [
      `service-${name}-docker-image`,
      `service-${name}-image-built`,
      `service-${name}-image-exists`,
      `service-${name}-image-on-registry`,
    ],
    provides: [
    ],
    run: async (requirements, utils) => {
      const tag = requirements[`service-${name}-docker-image`];
      const provides = {
      };

      if (!cmdOptions.push) {
        return utils.skip(provides);
      }

      if (requirements[`service-${name}-image-on-registry`]) {
        throw new Error(`Image ${tag} already exists on the registry; not pushing`);
      }

      await dockerPush({
        logfile: 'docker-push.log',
        tag,
        utils,
        workDir,
      });

      return provides;
    },
  });

  return tasks;
};

exports.serviceTasks = serviceTasks;
