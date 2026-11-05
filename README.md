## Build Action for AVADO Packages

### Usage

Put the content below into `.github/workflows` directory

```yaml
name: Build
on: pull_request
jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: AvadoDServer/ci-build-action@main
```

This works for public and private package repositories.

### Private repositories

A public repository is cloned without a token, as it always was. A private
repository is cloned with the workflow's own token (`github.token`), sent as
an HTTP header through git's environment: it is never on a command line,
never written to `.git/config` and never in the uploaded diff, and the runner
masks it in the log. The workflow token can read the repository with the
default workflow permissions. If a workflow sets its own `permissions:`, it
must keep `contents: read`.

To use another token (for example one that can also read other private
repositories), pass it:

```yaml
      - uses: AvadoDServer/ci-build-action@main
        with:
          token: ${{ secrets.SOME_TOKEN }}
```

### Software bill of materials (SBOM)

After the build, the action lists everything inside the package image
(`<name>:<version>`) with [Syft](https://github.com/anchore/syft) and uploads
it as the artifact `sbom-<name>_<version>-<commit>`, in SPDX and CycloneDX
JSON. This runs after the release diff is uploaded and never fails the build:
any problem is only a warning. Turn it off with `sbom: 'false'`.
