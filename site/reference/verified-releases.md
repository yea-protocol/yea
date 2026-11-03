# Verified releases

YEA is software that holds authority over your money and calendar, so you should be able to check that what you install is what this repository built. Every release is built and published by GitHub Actions ([`release.yml`](https://github.com/yea-protocol/yea/blob/main/.github/workflows/release.yml), [`docker.yml`](https://github.com/yea-protocol/yea/blob/main/.github/workflows/docker.yml)) from a tagged commit:

| Artifact | How it's published | Provenance |
|---|---|---|
| npm `@yea-protocol/sdk` and `@yea-protocol/cli` | npm trusted publishing (OIDC), except the first release; see below | npm provenance (`--provenance`) plus a GitHub build attestation of each `.tgz` |
| PyPI `yea-sdk` and `yea-mcp` | PyPI trusted publishing, from the first release | GitHub build attestations of each wheel and sdist |
| `ghcr.io/yea-protocol/yea` | Docker build on release tags | GitHub build attestation of the image |
| GitHub release | The npm and PyPI artifacts, plus `SHA256SUMS` | |

**The first npm release uses a token.** npm only lets a trusted publisher be added to a package that already exists, so v0.1.0 of the two npm packages is published with a scoped automation token stored as a repository secret. Once both packages exist, trusted publishing takes over and the token is revoked ([#31](https://github.com/yea-protocol/yea/issues/31)). Provenance and build attestations apply to every release either way, so the checks below work for v0.1.0 too.

## Verify

npm, including provenance:

```sh
npm audit signatures
```

A downloaded artifact, against this repository's workflow:

```sh
gh attestation verify yea-protocol-sdk-0.1.0.tgz --repo yea-protocol/yea
gh attestation verify yea-protocol-cli-0.1.0.tgz --repo yea-protocol/yea
gh attestation verify yea_sdk-0.1.0-py3-none-any.whl --repo yea-protocol/yea
gh attestation verify yea_mcp-0.1.0-py3-none-any.whl --repo yea-protocol/yea
```

The container image:

```sh
gh attestation verify oci://ghcr.io/yea-protocol/yea:0.1.0 --repo yea-protocol/yea
```

Checksums, from the release page:

```sh
sha256sum -c SHA256SUMS
```

A verified attestation tells you the artifact was built by this repository's workflow, from the commit it names. It doesn't tell you the code is correct: for that, there's the [conformance suite](https://github.com/yea-protocol/yea/tree/main/conformance), the tests and the [security model](/guide/security).
