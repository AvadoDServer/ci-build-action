## Build Action for AVADO Packages

### Usage

Put the content below into `.github/workflows` directory

```yaml
name: Build
on: pull_request
jobs:
  build:
    runs-on: ubuntu-18.04
    steps:
      - uses: AvadoDServer/ci-build-action@main
```