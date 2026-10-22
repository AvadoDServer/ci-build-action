const core = require('@actions/core');
const artifact = require('@actions/artifact');
const artifactClient = new artifact.DefaultArtifactClient()
const exec = require('@actions/exec');
const { context } = require('@actions/github');
const fs = require('fs');

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
        const npmGlobalPath = '/home/runner/.npm-global';
        const avadoSdkPath = `${npmGlobalPath}/bin/avadosdk`;
        core.exportVariable('NPM_CONFIG_PREFIX', npmGlobalPath);

        await exec.exec('npm i -g git+https://github.com/AvadoDServer/AVADOSDK.git');

        await exec.exec(`git clone https://github.com/${payload.repository.full_name}.git .`);
        const manifestFilePath = './dappnode_package.json';
        let masterManifest = null;

        if (manifestExists(manifestFilePath)) {
            masterManifest = readManifest(manifestFilePath);
        }

        await exec.exec(`git fetch origin pull/${payload.pull_request.number}/head:pr`);
        await exec.exec(`git checkout pr`);
        const prManifest = readManifest(manifestFilePath);

        // Execute `avadosdk increase patch` when upstream version is increased, but package version is not
        if (masterManifest && masterManifest.upstream != prManifest.upstream && masterManifest.version == prManifest.version) {
            await exec.exec(`"${avadoSdkPath}"`, ['increase', 'patch']);
        }

        await exec.exec(`"${avadoSdkPath}"`, ['build', '--provider', 'https://ipfs-upload.ava.do:443']);

        // Add releases.json, this is required for releasing later`
        await exec.exec(`git add --force --intent-to-add releases.json`);

        const filenameToStoreGitDiff = `asset-${payload.pull_request.head.sha}-diff`;

        await exec.exec(`/bin/bash -c "git diff >> ${filenameToStoreGitDiff}"`);

        const artifactName = `asset-${payload.pull_request.head.sha}-diff`;
        const files = [filenameToStoreGitDiff];
        const rootDirectory = '.';

        const uploadResult = await artifactClient.uploadArtifact(artifactName, files, rootDirectory);

        console.log(uploadResult);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
