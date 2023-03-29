const core = require('@actions/core');
const artifact = require('@actions/artifact');
const artifactClient = artifact.create();
const exec = require('@actions/exec');
const { context } = require('@actions/github');
const fs = require('fs');

async function run() {
    try {
        const payload = context.payload;
        const npmGlobalPath = '/home/runner/.npm-global';
        const avadoSdkPath = `${npmGlobalPath}/bin/avadosdk`;
        core.exportVariable('NPM_CONFIG_PREFIX', npmGlobalPath);

        await exec.exec('/bin/bash -c "npm i -g git+https://github.com/AvadoDServer/AVADOSDK.git"');
        
        await exec.exec('/bin/bash -c "avadosdk --version"')

        await exec.exec(`git clone https://github.com/${payload.repository.full_name}.git .`);
        const manifestFilePath = './dappnode_package.json';
        let masterManifest = null;

        if (fs.existsSync(manifestFilePath)) {
            masterManifest = JSON.parse(fs.readFileSync(manifestFilePath));
        }

        await exec.exec(`git fetch origin pull/${payload.pull_request.number}/head:pr`);
        await exec.exec(`git checkout pr`);
        const prManifest = JSON.parse(fs.readFileSync(manifestFilePath));

        // Execute `avadosdk increase patch` when upstream version is increased, but package version is not
        if (masterManifest && masterManifest.upstream != prManifest.upstream && masterManifest.version == prManifest.version) {
            await exec.exec(`"${avadoSdkPath}"`, ['increase', 'patch']);
        }

        await exec.exec(`/bin/bash -c "${avadoSdkPath} build --provider http://80.208.229.228:5001"`);

        // Add releases.json, this is required for releasing later`
        await exec.exec(`git add --force --intent-to-add releases.json`);

        const filenameToStoreGitDiff = `${payload.pull_request.head.sha}.diff`;

        await exec.exec(`/bin/bash -c "git diff >> ${filenameToStoreGitDiff}"`);

        const files = [
            filenameToStoreGitDiff,
        ]
        const rootDirectory = '.'

        const uploadResult = await artifactClient.uploadArtifact(filenameToStoreGitDiff, files, rootDirectory);

        console.log(uploadResult);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
