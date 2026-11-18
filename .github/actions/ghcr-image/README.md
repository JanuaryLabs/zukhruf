# ghcr-image

Builds a Dockerfile with Buildx and pushes it to `ghcr.io/<owner>/<image>:<sha>`. It reads and writes a registry build cache at `:buildcache`, so a runner with an empty Docker cache still reuses the layers of the last build. The owner is the repository owner in lowercase, as GHCR requires. [`ghcr-promote`](../ghcr-promote) moves `:latest` to the image after every image of the commit is built.

```yaml
images:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    packages: write
  strategy:
    matrix:
      include:
        - { image: shop-api, dockerfile: apps/api/Dockerfile }
        - { image: shop-migrate, dockerfile: libs/db/Dockerfile.migration }
  steps:
    - uses: actions/checkout@v7
    - uses: JanuaryLabs/zukhruf/.github/actions/ghcr-image@main
      with:
        image: ${{ matrix.image }}
        dockerfile: ${{ matrix.dockerfile }}
        build-args: |
          BUILD_SHA=${{ github.sha }}
```

| Input        | Default               | Meaning                                    |
| ------------ | --------------------- | ------------------------------------------ |
| `image`      |                       | The image name under `ghcr.io/<owner>/`.   |
| `dockerfile` |                       | The Dockerfile.                            |
| `context`    | `.`                   | The build context.                         |
| `target`     | `''`                  | The stage to build; empty is the last one. |
| `platforms`  | `linux/amd64`         | The platforms, separated by commas.        |
| `build-args` | `''`                  | One `NAME=value` per line.                 |
| `sha`        | `${{ github.sha }}`   | The tag the image is pushed under.         |
| `token`      | `${{ github.token }}` | The token that logs in to `ghcr.io`.       |

| Output   | Meaning                          |
| -------- | -------------------------------- |
| `ref`    | `ghcr.io/<owner>/<image>:<sha>`. |
| `digest` | The digest of the pushed image.  |

A private package that is not linked to the repository needs Actions write access in its package settings, or the push is refused. Pin `@main`, as with `setup-workspace`.
