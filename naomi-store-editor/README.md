# Naomi Store Editor

This folder is ready for GitHub Pages.

## Publish

1. Create a new GitHub repository.
2. Upload the files from this folder.
3. In the repository, go to Settings -> Pages.
4. Choose Deploy from a branch.
5. Select branch `main` and folder `/root`.
6. Open the GitHub Pages URL. It will load `index.html`.

## Direct Save

Direct saving into the real local store file uses the local helper server on the same computer:

```bash
node naomi-save-server.js
```

The hosted editor can open from GitHub Pages, but saving to the local real store still needs that server running.
