# ZIP to GitHub

A private Railway-hosted web app that accepts a ZIP file, extracts it safely, and commits the extracted files into a configured private GitHub repository.

## Features

- Password-protected web UI
- ZIP-only upload
- ZIP path traversal protection
- Configurable upload size limit
- Secure, server-side GitHub token
- One Git commit for the uploaded ZIP contents
- Railway-ready Node.js app
- No GitHub token exposed to the browser

## Railway setup

1. Create a Railway project and deploy this repository.
2. Add these environment variables in Railway:

```env
APP_PASSWORD=your-strong-private-password
GITHUB_TOKEN=your-github-token
GITHUB_OWNER=ansadser
GITHUB_REPO=your-target-private-repository
GITHUB_BRANCH=main
SESSION_SECRET=your-long-random-secret
```

3. Give the GitHub token only the repository permissions needed to write to the target repository.
4. Railway will run `npm start`.
5. Open the generated Railway domain and log in with `APP_PASSWORD`.

## Important

Do **not** put `GITHUB_TOKEN` in frontend JavaScript, commit it to Git, or send it through the browser. Keep it only in Railway environment variables.

The repository containing this uploader and the repository receiving ZIP contents can be separate private repositories.
