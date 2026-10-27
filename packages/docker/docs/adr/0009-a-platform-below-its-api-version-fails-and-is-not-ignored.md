# A platform below its API version fails, and is not ignored

`images.inspect()`, `images.save()` and `images.load()` take a platform (zukhruf backlog #3178, gap G5; text2sql #2756). The Engine API added the `platform` query parameter to their requests after API 1.44, the lowest version of the package ([Engine API version history](https://docs.docker.com/reference/api/engine/version-history/)):

- API 1.48: `GET /images/get` and `POST /images/load` take one `platform`, a "JSON encoded OCI platform", such as `{"os": "linux", "architecture": "arm", "variant": "v5"}`.
- API 1.49: `GET /images/{name}/json` takes one `platform` in the same form.
- API 1.52: `GET /images/get` and `POST /images/load` take more than one `platform`, each one a parameter of its own.

An engine does not refuse a parameter that is newer than the API version of the request. It ignores it. A probe on 2026-10-27 on Docker Desktop (Docker image store on containerd, an arm64 host) sent each request with a lower version in the path:

- `GET /v1.47/images/get?names=hello-world&platform={linux/amd64}` gave the archive of each platform of the image, not only `amd64`.
- `GET /v1.48/images/hello-world/json?platform={linux/amd64}` gave the `arm64` image, the platform of the host.
- `GET /v1.51/images/get` with two platforms got 400: "multiple platform parameters are not supported in this API version; use API version 1.52 or later".

A platform in the form `linux/amd64` got 400: "failed to parse platform".

The Go client of Moby checks the version before it sends the request: `requiresVersion(ctx, "1.48", "platform")` in [`client/image_save.go`](https://github.com/moby/moby/blob/master/client/image_save.go) and `image_load.go`, and `"1.49"` in `image_inspect.go`. Its error is `"platform" requires API version 1.48, but the Docker daemon API version is 1.47`.

## Considered Options

- **Send the platform at each version.** Below the version, a save writes each platform, and an inspect gives the platform of the host. The caller gets an answer for another platform, and no error tells it.
- **Leave out the platform below the version.** The result is the same.
- **Reject the call before the request.** This option was selected.

## Consequences

- When the API version of the client is lower than the version that the call needs, the call rejects with `UnsupportedEngineError` before the request. `minimumVersion` is the version of the call, and the message names the call. A new class would not change what the caller does next: update Docker, as for an engine below the lowest version ([ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md)).
- `save()` and `load()` need 1.48 for one platform and 1.52 for more than one. The engine refuses more than one platform below 1.52 itself, but the package rejects it first with the same class, so each version gap gives one error.
- The platform of these three calls is an `EngineApi.OCIPlatform` object, with the field names of the OCI image index: `os`, `architecture`, `variant`. The package encodes it as JSON. `pull()` and `containers.create()` keep the text form `'linux/amd64'`, because their requests take that form.
- The two image stores of the engine handle a load with a platform that the archive does not have differently. The containerd image store reports an error in the progress: "image … was loaded, but doesn't provide the requested platform". The classic image store skips the image and reports no error (`platformMatcher` in [`image/tarexport/load.go`](https://github.com/moby/moby/blob/v28.5.0/image/tarexport/load.go)). The package does not change either answer.
