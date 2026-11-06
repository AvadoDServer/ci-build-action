const core = require('@actions/core');
const artifact = require('@actions/artifact');
const artifactClient = new artifact.DefaultArtifactClient()
const exec = require('@actions/exec');
const github = require('@actions/github');
const { context } = github;
const fs = require('fs');
const { gitReadOptions } = require('./gitAuth');
const { uploadSbom } = require('./sbom');

// Read a JSON manifest file, handling the case where git stores a symlink
// whose target is the JSON content itself (instead of a file path).
// This happens when a symlink file is replaced with inline content without
// first deleting the symlink, causing git to keep the symlink mode.
function readManifest(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        if (e.code === 'ENAMETOOLONG') {
            const content = fs.readlinkSync(filePath);
            return JSON.parse(content);
        }
        throw e;
    }
}

// Check if a manifest file exists, using lstatSync so that symlinks
// (even broken ones) are detected rather than silently skipped.
function manifestExists(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

async function run() {
    try {
        const payload = context.payload;

        // The pull request to build: the one of a pull_request event, or the
        // `pr` input of a workflow_dispatch run. Update bots open their pull
        // requests with the workflow token, which starts no pull_request
        // workflow, so they start the Build by dispatch instead.
        let pullRequest = payload.pull_request;
        if (!pullRequest) {
            const number = Number(core.getInput('pr'));
            if (!number) {
                throw new Error('No pull request to build: run this on pull_request, or pass the "pr" input.');
            }
            const [owner, repo] = payload.repository.full_name.split('/');
            const octokit = github.getOctokit(core.getInput('token'));
            pullRequest = (await octokit.rest.pulls.get({ owner, repo, pull_number: number })).data;
            if (pullRequest.state !== 'open') {
                throw new Error(`Pull request #${number} is ${pullRequest.state}.`);
            }
        }
        const npmGlobalPath = '/home/runner/.npm-global';
        const avadoSdkPath = `${npmGlobalPath}/bin/avadosdk`;
        core.exportVariable('NPM_CONFIG_PREFIX', npmGlobalPath);

        await exec.exec('npm i -g git+https://github.com/AvadoDServer/AVADOSDK.git');

        // Public repositories are cloned anonymously, exactly as before.
        // Private ones need the token; see gitAuth.js.
        const gitOptions = gitReadOptions(payload.repository, core.getInput('token'));

        await exec.exec(`git clone https://github.com/${payload.repository.full_name}.git .`, undefined, gitOptions);
        const manifestFilePath = './dappnode_package.json';
        let masterManifest = null;

        if (manifestExists(manifestFilePath)) {
            masterManifest = readManifest(manifestFilePath);
        }

        await exec.exec(`git fetch origin pull/${pullRequest.number}/head:pr`, undefined, gitOptions);
        await exec.exec(`git checkout pr`);
        const prManifest = readManifest(manifestFilePath);

        // Execute `avadosdk increase patch` when upstream version is increased, but package version is not
        if (masterManifest && masterManifest.upstream != prManifest.upstream && masterManifest.version == prManifest.version) {
            await exec.exec(`"${avadoSdkPath}"`, ['increase', 'patch']);
        }

        await exec.exec(`"${avadoSdkPath}"`, ['build', '--provider', 'https://ipfs-upload.ava.do:443']);

        // Add releases.json, this is required for releasing later`
        await exec.exec(`git add --force --intent-to-add releases.json`);

        const filenameToStoreGitDiff = `asset-${pullRequest.head.sha}-diff`;

        await exec.exec(`/bin/bash -c "git diff >> ${filenameToStoreGitDiff}"`);

        const artifactName = `asset-${pullRequest.head.sha}-diff`;
        const files = [filenameToStoreGitDiff];
        const rootDirectory = '.';

        const uploadResult = await artifactClient.uploadArtifact(artifactName, files, rootDirectory);

        console.log(uploadResult);

        // Software bill of materials of the built image, as a separate
        // artifact. Runs after the release diff is safely uploaded and never
        // fails the build (see sbom.js).
        if (core.getInput('sbom') !== 'false') {
            await uploadSbom({
                artifactClient,
                loadManifest: () => readManifest(manifestFilePath),
                sha: pullRequest.head.sha,
            });
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
