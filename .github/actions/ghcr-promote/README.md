# ghcr-promote

Points `ghcr.io/<owner>/<image>:<tag>` at the image of `ghcr.io/<owner>/<image>:<from>` with `docker buildx imagetools create`. The copy happens in the registry, so no layers are pulled. Run it in a job after every image of the commit is built: a compose that runs `:latest` then never mixes the images of two commits.

```yaml
promote:
  needs: images
  runs-on: ubuntu-latest
  permissions:
    packages: write
  strategy:
    matrix:
      image: [shop-api, shop-migrate]
  steps:
    - uses: JanuaryLabs/zukhruf/.github/actions/ghcr-promote@main
      with:
        image: ${{ matrix.image }}
```

| Input   | Default               | Meaning                                  |
| ------- | --------------------- | ---------------------------------------- |
| `image` |                       | The image name under `ghcr.io/<owner>/`. |
| `from`  | `${{ github.sha }}`   | The tag of the image to promote.         |
| `tag`   | `latest`              | The tag to move.                         |
| `token` | `${{ github.token }}` | The token that logs in to `ghcr.io`.     |

The job needs no checkout. Pin `@main`, as with `setup-workspace`.
