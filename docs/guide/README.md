# Lazy Jira Timelog guide

`index.html` is the user guide: how the extension works, with screenshots and step-by-step instructions for each use case. Open it in a browser straight from a clone, or read the [hosted copy](https://claude.ai/artifact/AQuR7pCBUjzMgeiXvKMu5h).

## How it stays up to date

- **Screenshots** are retaken after every merge to `main` that touches `browser-extension/`. The [Guide screenshots](../../.github/workflows/guide.yml) workflow builds the extension, runs `npm run e2e` with a screenshot folder, crops the images with `tools/crop_screenshots.py` and commits any that changed to `img/`. Run it by hand from the Actions tab if needed.
- **Text** is updated by a scheduled Claude task. It compares `COVERED_COMMIT` (the last `main` commit the text describes) with `main`, rewrites the sections the merged changes affect, and opens a pull request that also bumps `COVERED_COMMIT`. It republishes the hosted copy once that pull request is merged.

## Updating it yourself

```sh
cd browser-extension
npm ci
npm run e2e -- /tmp/shots
python ../docs/guide/tools/crop_screenshots.py /tmp/shots ../docs/guide/img
```

A new screenshot needs a `screenshot()` call in `browser-extension/scripts/e2e.mjs` and an entry in `IMAGES` in `tools/crop_screenshots.py`.
