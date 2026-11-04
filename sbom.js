const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Syft v1.55.0 (2026-10-19), pinned by digest so the SBOM tool cannot change
// under us. It runs as a container that reads the image from the runner's
// Docker daemon, so nothing has to be installed on the runner.
const SYFT_IMAGE = 'anchore/syft:v1.55.0@sha256:4cc92b64ca74ffca4c94d4c8fcc01f217731375300be14d0b6eeb2e82eaa110a';

// Never let the SBOM step hold the build up for long (15 minutes; the
// environment variable is only there to test the timeout).
const SYFT_TIMEOUT_SECONDS = parseInt(process.env.AVADO_SBOM_TIMEOUT_SECONDS || '', 10) || 900;

// Characters GitHub does not allow in artifact names.
function safeName(value) {
    return String(value).replace(/["':<>|*?\\/\r\n]/g, '_');
}

// Make a software bill of materials (SBOM) of the package image that
// `avadosdk build` just built (`<name>:<version>`, the image that goes into
// the release) and upload it as an artifact called `sbom-<name>_<version>-<sha>`.
//
// This is a side job: it runs after the release diff has been uploaded, it
// writes only outside the package checkout, and any problem is logged as a
// warning. It never throws, so it can never fail the build.
async function uploadSbom({ artifactClient, loadManifest, sha }) {
    const containerName = `avado-sbom-${safeName(sha).slice(0, 12)}-${process.pid}`;
    try {
        const manifest = loadManifest();
        if (!manifest || !manifest.name || !manifest.version) {
            core.warning('SBOM skipped: the manifest has no name or version.');
            return;
        }

        const imageTag = `${manifest.name}:${manifest.version}`;
        const baseName = safeName(`${manifest.name}_${manifest.version}`);
        const outDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'avado-sbom-'));
        fs.chmodSync(outDir, 0o777);

        core.startGroup(`SBOM for ${imageTag}`);
        let exitCode;
        let timer;
        try {
            const scan = exec.exec('docker', [
                'run', '--rm',
                '--name', containerName,
                '-e', 'SYFT_CHECK_FOR_APP_UPDATE=false',
                '-v', '/var/run/docker.sock:/var/run/docker.sock',
                '-v', `${outDir}:/out`,
                SYFT_IMAGE,
                'scan', `docker:${imageTag}`,
                '-o', `spdx-json=/out/${baseName}.spdx.json`,
                '-o', `cyclonedx-json=/out/${baseName}.cdx.json`,
            ], { ignoreReturnCode: true });
            const timeout = new Promise(resolve => {
                timer = setTimeout(() => resolve('timeout'), SYFT_TIMEOUT_SECONDS * 1000);
            });
            exitCode = await Promise.race([scan, timeout]);
            if (exitCode === 'timeout') {
                // Stopping the container makes `docker run` return.
                await exec.exec('docker', ['rm', '-f', containerName], { silent: true, ignoreReturnCode: true });
                await scan.catch(() => undefined);
            }
        } finally {
            clearTimeout(timer);
            core.endGroup();
        }

        if (exitCode === 'timeout') {
            core.warning(`SBOM skipped: the SBOM tool took longer than ${SYFT_TIMEOUT_SECONDS} seconds. The package build itself is fine.`);
            return;
        }
        if (exitCode !== 0) {
            core.warning(`SBOM skipped: the SBOM tool stopped with exit code ${exitCode}. The package build itself is fine.`);
            return;
        }

        const files = fs.readdirSync(outDir)
            .filter(file => file.endsWith('.json'))
            .map(file => path.join(outDir, file));
        if (!files.length) {
            core.warning('SBOM skipped: the SBOM tool wrote no files. The package build itself is fine.');
            return;
        }

        try {
            const spdx = JSON.parse(fs.readFileSync(path.join(outDir, `${baseName}.spdx.json`), 'utf8'));
            core.info(`SBOM lists ${(spdx.packages || []).length} packages in ${imageTag}.`);
        } catch (e) {
            // Only used for the log line above.
        }

        const artifactName = `sbom-${baseName}-${safeName(sha)}`;
        await artifactClient.uploadArtifact(artifactName, files, outDir);
        core.info(`SBOM uploaded as the artifact ${artifactName}.`);
    } catch (error) {
        core.warning(`SBOM skipped: ${error && error.message ? error.message : error}. The package build itself is fine.`);
    } finally {
        // Leave no SBOM container behind, whatever happened above.
        try {
            await exec.exec('docker', ['rm', '-f', containerName], { silent: true, ignoreReturnCode: true });
        } catch (e) {
            // Nothing to clean up.
        }
    }
}

module.exports = { uploadSbom, SYFT_IMAGE };
