# DBX Store submission draft

This directory is a local staging area for an official DBX Store submission.
It is not a pull request and must not be submitted until the source repository
has an immutable release tag with the matching assets.

## Before submitting

1. Commit all source and documentation changes.
2. Run the complete test suite.
3. Run `npm run package:dbx`.
4. Run `node scripts/prepare-store-submission.mjs v0.4.1`.
5. Create the immutable `v0.4.1` tag from the reviewed commit.
6. Publish a GitHub Release from that tag.
7. Wait for the release workflow to upload:
   - the unsigned universal `.dbxp`;
   - its `.artifact.json`;
   - `release-candidates.json`.
8. Verify every HTTPS asset URL and re-run the preparation script using the
   final package hashes.
9. Fork `t8y2/dbx-store`, copy the relevant files into its root, open one
   catalog PR, and complete the disclosures in `PR-BODY.md`.

Suggested release commands:

```bash
git tag v0.4.1
git push origin v0.4.1
gh release create v0.4.1 \
  --title "DBX Mini Games 0.4.1" \
  --notes-file RELEASE_NOTES.md
```

After the release workflow finishes:

```bash
npm run verify:release -- --check-urls
```

The URL check must pass before copying `store-submission/publishers/` and
`store-submission/candidates/` into a `t8y2/dbx-store` fork. Add every screenshot
link and the privacy/support links to the catalog PR description.

Do not:

- submit a self-signed or store-signed package as the candidate;
- add `signature.json` or `signingKeyId`;
- edit upstream `plugins/` or `catalog/index.json`;
- include credentials, private keys, or access tokens;
- submit before the release artifact URLs are publicly reachable.
